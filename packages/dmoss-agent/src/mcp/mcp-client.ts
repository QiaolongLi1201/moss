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
import type {
  StructuredToolResult,
  Tool,
  ToolContentBlock,
  ToolContext,
} from '../core/tools/tool-types.js';
import { DmossError, ErrorCode } from '../errors.js';
import { safeMcpChildEnv } from '../utils/safe-child-env.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  requestTimeoutMs?: number;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  alt?: string;
  uri?: string;
  name?: string;
  resource?: {
    uri?: string;
    name?: string;
    mimeType?: string;
    text?: string;
  };
}

interface McpCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
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
      env: safeMcpChildEnv(config.env),
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
      const sendCancellation = (reason: string) => {
        if (method === 'initialize') return;
        try {
          this.notify('notifications/cancelled', { requestId: id, reason });
        } catch {
          // Best-effort MCP cancellation; local request rejection still proceeds.
        }
      };
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          sendCancellation(`MCP request aborted: ${signal!.reason ?? 'aborted'}`);
          this.pending.delete(id);
          pending.reject(new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: `MCP request aborted: ${signal!.reason ?? 'aborted'}` }));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        sendCancellation(`MCP server ${this.serverName} request timeout after ${this.requestTimeoutMs}ms`);
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
      const callResult = result as McpCallResult;
      if (callResult.isError) {
        const errMsg = mcpContentToText(callResult.content) || 'MCP tool returned error';
        throw new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: errMsg });
      }
      return mcpContentToText(callResult.content) || JSON.stringify(callResult);
    },
    async executeStructured(input: Record<string, unknown>, ctx: ToolContext): Promise<StructuredToolResult> {
      const result = await conn.callTool(mcpTool.name, input, ctx.abortSignal);
      const callResult = result as McpCallResult;
      const content = mcpContentToToolContent(callResult.content);
      return {
        content: content.length > 0
          ? content
          : [{ type: 'text', text: JSON.stringify(callResult) }],
        ...(callResult.isError ? { isError: true } : {}),
      };
    },
  };
}

function mcpContentToText(content: McpContentBlock[] | undefined): string {
  return mcpContentToToolContent(content)
    .filter((block): block is Extract<ToolContentBlock, { type: 'text' }> | Extract<ToolContentBlock, { type: 'resource' }> =>
      block.type === 'text' || (block.type === 'resource' && typeof block.text === 'string'),
    )
    .map((block) => block.type === 'text' ? block.text : (block.text ?? ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

function mcpContentToToolContent(content: McpContentBlock[] | undefined): ToolContentBlock[] {
  const mapped: ToolContentBlock[] = [];
  for (const block of content ?? []) {
    if (block.type === 'text') {
      mapped.push({ type: 'text', text: block.text ?? '' });
    } else if (block.type === 'image' && block.data && block.mimeType) {
      mapped.push({
        type: 'image',
        data: block.data,
        mimeType: block.mimeType,
        ...(block.alt ? { alt: block.alt } : {}),
      });
    } else if (block.type === 'resource') {
      const resource = block.resource ?? block;
      if (resource.uri) {
        mapped.push({
          type: 'resource',
          uri: resource.uri,
          ...(resource.name ? { name: resource.name } : {}),
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          ...(resource.text ? { text: resource.text } : {}),
        });
      }
    }
  }
  return mapped;
}

export async function connectMcpServers(config: McpConfig): Promise<McpConnection[]> {
  const connections: McpConnection[] = [];

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    const conn = new McpServerConnection(serverName, serverConfig, serverConfig.requestTimeoutMs);
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
