/**
 * MCP (Model Context Protocol) client — reads mcp.json configuration
 * and bridges MCP server tools into the DmossAgent tool registry.
 *
 * mcp.json format:
 * {
 *   "mcpServers": {
 *     "server-name": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *       "env": { "KEY": "value" }
 *     }
 *   }
 * }
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { DmossError, ErrorCode } from '../errors.js';
import { safeChildEnv } from '../utils/safe-child-env.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function loadMcpConfig(configPath: string): McpConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') return null;
    return parsed as McpConfig;
  } catch {
    return null;
  }
}

class McpServerConnection {
  private process: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private closed = false;
  private requestTimeoutMs: number;

  constructor(
    public readonly serverName: string,
    config: McpServerConfig,
    requestTimeoutMs = 30_000,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.process = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeChildEnv(config.env),
    });

    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.processBuffer();
    });

    this.process.stderr!.on('data', () => {
      // drain stderr to prevent pipe buffer deadlock
    });

    this.process.on('error', (err) => {
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
    });

    this.process.on('exit', () => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: `MCP server ${serverName} exited` }));
      }
      this.pending.clear();
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && msg.id !== null) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            clearTimeout(pending.timer);
            if (msg.error) {
              pending.reject(new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: msg.error.message }));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: `MCP server ${this.serverName} is closed` });
    if (signal?.aborted) throw new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: `MCP request aborted: ${signal.reason ?? 'aborted'}` });
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: `MCP request aborted: ${signal!.reason ?? 'aborted'}` }));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: `MCP server ${this.serverName} request timeout after ${this.requestTimeoutMs}ms` }));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => { cleanup(); resolve(v); },
        reject: (e) => { cleanup(); reject(e); },
        timer,
      });
      this.process.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.process.stdin!.write(JSON.stringify(msg) + '\n');
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dmoss-agent', version: '0.3.1' },
    });
    this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list')) as { tools: McpTool[] };
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.process.stdin?.end();
    this.process.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process.kill('SIGKILL');
        resolve();
      }, 3000);
      this.process.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

export interface McpConnection {
  serverName: string;
  tools: Tool[];
  close(): Promise<void>;
}

function mcpToolToTool(
  mcpTool: McpTool,
  conn: McpServerConnection,
  serverName: string,
): Tool {
  const inputSchema = {
    type: 'object' as const,
    properties: (mcpTool.inputSchema.properties ?? {}) as Record<string, unknown>,
    required: (mcpTool.inputSchema.required as string[] | undefined) ?? [],
  };

  return {
    name: `${serverName}__${mcpTool.name}`,
    description: mcpTool.description || `MCP tool ${mcpTool.name} from ${serverName}`,
    inputSchema,
    metadata: {
      sideEffectClass: 'external_message',
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const result = await conn.callTool(mcpTool.name, input, ctx.abortSignal);
      const callResult = result as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      if (callResult.isError) {
        const errMsg =
          callResult.content
            ?.filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n') || 'MCP tool returned error';
        throw new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: errMsg });
      }
      const texts =
        callResult.content
          ?.filter((c) => c.type === 'text')
          .map((c) => c.text ?? '') ?? [];
      return texts.join('\n') || JSON.stringify(callResult);
    },
  };
}

export async function connectMcpServers(config: McpConfig): Promise<McpConnection[]> {
  const connections: McpConnection[] = [];

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    const conn = new McpServerConnection(serverName, serverConfig);
    try {
      await conn.initialize();
      const mcpTools = await conn.listTools();
      const tools = mcpTools.map((t) => mcpToolToTool(t, conn, serverName));
      connections.push({
        serverName,
        tools,
        close: () => conn.close(),
      });
    } catch (err) {
      await conn.close();
      // Close all previously successful connections before throwing
      await Promise.allSettled(connections.map((c) => c.close()));
      throw new DmossError({
        code: ErrorCode.MCP_CONNECTION_FAILED,
        message: `Failed to connect to MCP server "${serverName}": ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return connections;
}
