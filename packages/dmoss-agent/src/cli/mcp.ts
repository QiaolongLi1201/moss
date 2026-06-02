import type { DmossAgent } from '../core/index.js';
import type { ResolvedCliConfig } from './config.js';
import { connectMcpServers, loadMcpConfig, type McpConnection } from '../mcp/index.js';

export async function registerConfiguredMcpTools(
  agent: Pick<DmossAgent, 'tools'>,
  config: Pick<ResolvedCliConfig, 'mcpEnabled' | 'mcpConfigPath'>,
): Promise<McpConnection[]> {
  if (!config.mcpEnabled) return [];
  const mcpConfig = loadMcpConfig(config.mcpConfigPath);
  if (!mcpConfig) {
    console.warn(`[mcp:config] MCP is enabled but no valid config was found at ${config.mcpConfigPath}`);
    return [];
  }
  const connections = await connectMcpServers(mcpConfig);
  for (const connection of connections) {
    for (const tool of connection.tools) {
      agent.tools.register(tool, `mcp:${connection.serverName}`);
    }
  }
  return connections;
}
