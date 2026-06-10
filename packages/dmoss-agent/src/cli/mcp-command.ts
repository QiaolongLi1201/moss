/**
 * `moss mcp <add|list|remove>` — manage MCP servers without hand-editing
 * mcp.json. Mirrors the runtime schema in mcp/mcp-client.ts:
 *   { "mcpServers": { "<name>": { command, args?, env?, cwd?, requestTimeoutMs? } } }
 *
 * Respects the same config-path resolution the runtime uses
 * (`mcp.configPath` / DMOSS config), so what you add here is what `moss` loads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadCliConfigFile, resolveCliConfig } from './config.js';
import { loadMcpConfigWithDiagnostics, type McpServerConfig } from '../mcp/index.js';

function print(line = ''): void {
  process.stderr.write(`${line}\n`);
}

function fail(message: string): void {
  print(`[mcp] ${message}`);
  process.exitCode = 1;
}

interface RawMcpFile {
  mcpServers: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

function readMcpFile(configPath: string): RawMcpFile {
  if (!fs.existsSync(configPath)) return { mcpServers: {} };
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config root must be an object: ${configPath}`);
  }
  const raw = parsed as Record<string, unknown>;
  const servers = raw.mcpServers;
  return {
    ...raw,
    mcpServers:
      typeof servers === 'object' && servers !== null && !Array.isArray(servers)
        ? (servers as Record<string, McpServerConfig>)
        : {},
  };
}

function writeMcpFile(configPath: string, file: RawMcpFile): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
}

function describeServer(name: string, server: McpServerConfig): string {
  const commandLine = [server.command, ...(server.args ?? [])].join(' ');
  const extras = [
    server.env && Object.keys(server.env).length ? `env ${Object.keys(server.env).join(',')}` : '',
    server.cwd ? `cwd ${server.cwd}` : '',
    server.requestTimeoutMs ? `timeout ${server.requestTimeoutMs}ms` : '',
  ].filter(Boolean);
  return `  ${name}  ${commandLine}${extras.length ? `  (${extras.join(' · ')})` : ''}`;
}

function renderMcpUsage(): string {
  return [
    'Usage:',
    '  moss mcp list',
    '  moss mcp add <name> <command> [args...] [--env KEY=VALUE]... [--cwd <dir>] [--timeout-ms <n>] [--force]',
    '  moss mcp remove <name>',
    '',
    'Examples:',
    '  moss mcp add fs npx -y @modelcontextprotocol/server-filesystem /data',
    '  moss mcp add ros-docs node ./mcp/ros-docs.js --env ROS_DISTRO=humble',
  ].join('\n');
}

export function runMcpCommand(args: string[], startDir = process.cwd()): void {
  const loaded = loadCliConfigFile(process.env, process.argv.slice(2), startDir);
  const resolved = resolveCliConfig(process.env, loaded.config, {}, loaded);
  const configPath = resolved.mcpConfigPath;
  const [sub, ...rest] = args;

  if (sub === 'list' || sub === undefined) {
    const { config, diagnostics } = loadMcpConfigWithDiagnostics(configPath);
    print(`[mcp] config: ${configPath}${resolved.mcpEnabled ? '' : '  (mcp disabled — run: moss config set mcp.enabled true)'}`);
    if (!config) {
      if (diagnostics.some((d) => /does not exist/.test(d.message))) {
        print('[mcp] no servers configured yet. Add one with: moss mcp add <name> <command> [args...]');
      } else {
        for (const d of diagnostics) print(`[mcp] invalid config${d.serverName ? ` (${d.serverName})` : ''}: ${d.message}`);
        process.exitCode = 1;
      }
      return;
    }
    const names = Object.keys(config.mcpServers);
    if (names.length === 0) {
      print('[mcp] no servers configured yet. Add one with: moss mcp add <name> <command> [args...]');
      return;
    }
    print(`[mcp] ${names.length} server${names.length === 1 ? '' : 's'}:`);
    for (const name of names) print(describeServer(name, config.mcpServers[name]));
    return;
  }

  if (sub === 'add') {
    const positional: string[] = [];
    const env: Record<string, string> = {};
    let cwd: string | undefined;
    let timeoutMs: number | undefined;
    let force = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--env') {
        const pair = rest[++i];
        const eq = pair?.indexOf('=') ?? -1;
        if (!pair || eq <= 0) return fail('--env expects KEY=VALUE');
        env[pair.slice(0, eq)] = pair.slice(eq + 1);
      } else if (arg === '--cwd') {
        cwd = rest[++i];
        if (!cwd) return fail('--cwd expects a directory');
      } else if (arg === '--timeout-ms') {
        timeoutMs = Number(rest[++i]);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fail('--timeout-ms expects a positive number');
      } else if (arg === '--force') {
        force = true;
      } else {
        positional.push(arg);
      }
    }
    const [name, command, ...commandArgs] = positional;
    if (!name || !command) {
      print(renderMcpUsage());
      process.exitCode = 1;
      return;
    }
    let file: RawMcpFile;
    try {
      file = readMcpFile(configPath);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (file.mcpServers[name] && !force) {
      return fail(`server "${name}" already exists (use --force to replace). Current: ${[file.mcpServers[name].command, ...(file.mcpServers[name].args ?? [])].join(' ')}`);
    }
    const server: McpServerConfig = {
      command,
      ...(commandArgs.length ? { args: commandArgs } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(cwd ? { cwd: path.resolve(cwd) } : {}),
      ...(timeoutMs ? { requestTimeoutMs: timeoutMs } : {}),
    };
    file.mcpServers = { ...file.mcpServers, [name]: server };
    writeMcpFile(configPath, file);
    print(`[mcp] added "${name}" → ${[command, ...commandArgs].join(' ')}`);
    print(`[mcp] config: ${configPath}`);
    if (!resolved.mcpEnabled) {
      print('[mcp] MCP is currently disabled. Activate with: moss config set mcp.enabled true');
    }
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const [name] = rest;
    if (!name) {
      print(renderMcpUsage());
      process.exitCode = 1;
      return;
    }
    let file: RawMcpFile;
    try {
      file = readMcpFile(configPath);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (!file.mcpServers[name]) {
      return fail(`server "${name}" is not configured in ${configPath}`);
    }
    const remaining = { ...file.mcpServers };
    delete remaining[name];
    file.mcpServers = remaining;
    writeMcpFile(configPath, file);
    print(`[mcp] removed "${name}" from ${configPath}`);
    return;
  }

  print(renderMcpUsage());
  process.exitCode = 1;
}
