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
 *       "env": { "KEY": "value" },
 *       "cwd": "/path/to/workdir"
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
  cwd?: string;
  requestTimeoutMs?: number;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpConfigDiagnostic {
  serverName?: string;
  message: string;
}

export interface McpConfigLoadResult {
  config: McpConfig | null;
  diagnostics: McpConfigDiagnostic[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidMcpConfig(serverName: string, message: string): DmossError {
  return new DmossError({
    code: ErrorCode.MCP_CONNECTION_FAILED,
    message: `Invalid MCP server "${serverName}" config: ${message}`,
  });
}

function parseOptionalStringArray(
  serverName: string,
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw invalidMcpConfig(serverName, `${field} must be an array of strings`);
  }
  return value;
}

function parseOptionalStringRecord(
  serverName: string,
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw invalidMcpConfig(serverName, `${field} must be an object with string values`);
  }
  const parsed: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'string') {
      throw invalidMcpConfig(serverName, `${field}.${key} must be a string`);
    }
    parsed[key] = child;
  }
  return parsed;
}

function validateMcpServerConfig(serverName: string, raw: unknown): McpServerConfig {
  if (!isRecord(raw)) {
    throw invalidMcpConfig(serverName, 'server entry must be an object');
  }
  if (typeof raw.command !== 'string' || !raw.command.trim()) {
    throw invalidMcpConfig(serverName, 'command must be a non-empty string');
  }
  if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || !raw.cwd.trim())) {
    throw invalidMcpConfig(serverName, 'cwd must be a non-empty string when provided');
  }
  if (
    raw.requestTimeoutMs !== undefined &&
    (
      typeof raw.requestTimeoutMs !== 'number' ||
      !Number.isFinite(raw.requestTimeoutMs) ||
      raw.requestTimeoutMs <= 0
    )
  ) {
    throw invalidMcpConfig(serverName, 'requestTimeoutMs must be a positive number when provided');
  }
  return {
    command: raw.command,
    ...(raw.args !== undefined ? { args: parseOptionalStringArray(serverName, raw.args, 'args') } : {}),
    ...(raw.env !== undefined ? { env: parseOptionalStringRecord(serverName, raw.env, 'env') } : {}),
    ...(raw.cwd !== undefined ? { cwd: raw.cwd } : {}),
    ...(raw.requestTimeoutMs !== undefined ? { requestTimeoutMs: raw.requestTimeoutMs } : {}),
  };
}

function diagnosticMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function loadMcpConfigWithDiagnostics(configPath: string): McpConfigLoadResult {
  if (!existsSync(configPath)) {
    return {
      config: null,
      diagnostics: [{ message: 'config file does not exist' }],
    };
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {
        config: null,
        diagnostics: [{ message: 'config root must be an object' }],
      };
    }
    if (!isRecord(parsed.mcpServers)) {
      return {
        config: null,
        diagnostics: [{ message: 'mcpServers must be an object' }],
      };
    }

    const mcpServers: Record<string, McpServerConfig> = {};
    const diagnostics: McpConfigDiagnostic[] = [];
    for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers)) {
      try {
        mcpServers[serverName] = validateMcpServerConfig(serverName, serverConfig);
      } catch (err) {
        diagnostics.push({ serverName, message: diagnosticMessage(err) });
      }
    }
    if (diagnostics.length > 0) {
      return { config: null, diagnostics };
    }
    return { config: { mcpServers }, diagnostics: [] };
  } catch (err) {
    return {
      config: null,
      diagnostics: [{ message: diagnosticMessage(err) }],
    };
  }
}

export function loadMcpConfig(configPath: string): McpConfig | null {
  return loadMcpConfigWithDiagnostics(configPath).config;
}

class McpServerConnection {
  private process: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private MAX_REQUEST_ID = 2147483647; // ~2.1B, safe integer well below MAX_SAFE_INTEGER
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
      cwd: config.cwd,
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
        pending.reject(new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: `MCP server ${serverName} process error: ${err instanceof Error ? err.message : String(err)}` }));
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
      } catch (err) {
        console.warn(
          `[mcp:stdout] MCP server "${this.serverName}" emitted non-JSON line (skipped): ${
            trimmed.slice(0, 200)
          } | parseError: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: `MCP server ${this.serverName} is closed` });
    if (signal?.aborted) throw new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: `MCP request aborted: ${signal.reason ?? 'aborted'}` });
    const id = this.nextId++;
    if (this.nextId > this.MAX_REQUEST_ID) this.nextId = 1;
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
      try {
        this.process.stdin!.write(JSON.stringify(msg) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        reject(new DmossError({ code: ErrorCode.MCP_CONNECTION_FAILED, message: `MCP server ${this.serverName} stdin write failed: ${err instanceof Error ? err.message : String(err)}` }));
      }
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
      const onExit = () => {
        this.process.off('exit', onExit);
        clearTimeout(timeout);
        resolve();
      };
      this.process.once('exit', onExit);
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

export interface McpConnectionResult {
  connections: McpConnection[];
  failures: Array<{ serverName: string; error: Error }>;
}

export async function connectMcpServersWithFailures(config: McpConfig): Promise<McpConnectionResult> {
  const connections: McpConnection[] = [];
  const failures: Array<{ serverName: string; error: Error }> = [];

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    let conn: McpServerConnection | undefined;
    try {
      const validatedConfig = validateMcpServerConfig(serverName, serverConfig);
      conn = new McpServerConnection(serverName, validatedConfig, validatedConfig.requestTimeoutMs);
      await conn.initialize();
      const mcpTools = await conn.listTools();
      const activeConn = conn;
      const tools = mcpTools.map((t) => mcpToolToTool(t, activeConn, serverName));
      connections.push({
        serverName,
        tools,
        close: () => activeConn.close(),
      });
    } catch (err) {
      await conn?.close().catch(() => {});
      failures.push({
        serverName,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return { connections, failures };
}

export async function connectMcpServers(config: McpConfig): Promise<McpConnection[]> {
  const result = await connectMcpServersWithFailures(config);
  if (result.failures.length > 0 && result.connections.length === 0) {
    const first = result.failures[0];
    throw new DmossError({
      code: ErrorCode.MCP_CONNECTION_FAILED,
      message: `Failed to connect to MCP server "${first.serverName}": ${first.error.message}`,
    });
  }
  for (const f of result.failures) {
    console.warn(`[mcp:connect] MCP server "${f.serverName}" failed (skipped): ${f.error.message}`);
  }
  return result.connections;
}
