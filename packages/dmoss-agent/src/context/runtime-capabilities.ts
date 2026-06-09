import type { Tool } from '../core/tools/tool-types.js';

export interface RuntimeCapabilityTool {
  name: string;
}

export interface RuntimeCapabilitiesPromptOptions {
  tools: readonly RuntimeCapabilityTool[] | readonly Tool[];
  mcpEnabled?: boolean;
  mcpServerNames?: readonly string[];
  maxToolNames?: number;
}

const DEFAULT_MAX_TOOL_NAMES = 120;
const CODE_FALLBACK_TOOL_NAMES = ['search_code', 'search_files', 'list_directory', 'read_file'];

export function isCodeGraphToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name.startsWith('codegraph_') ||
    name.startsWith('codegraph__') ||
    name.includes('__codegraph_') ||
    name.includes('__codegraph__')
  );
}

function uniqueSortedToolNames(tools: RuntimeCapabilitiesPromptOptions['tools']): string[] {
  return [...new Set(tools.map((tool) => tool.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function formatToolList(toolNames: readonly string[], maxToolNames: number): string {
  if (toolNames.length <= maxToolNames) return toolNames.join(', ');
  const visible = toolNames.slice(0, maxToolNames);
  return `${visible.join(', ')} ... (${toolNames.length - maxToolNames} more registered tools; rely on the tool declarations for omitted names)`;
}

function formatCodeNavigationFallback(toolNames: readonly string[]): string {
  const fallbackToolNames = CODE_FALLBACK_TOOL_NAMES.filter((toolName) => toolNames.includes(toolName));
  if (fallbackToolNames.length > 0) {
    return `- Do not claim CodeGraph evidence for this run. For code navigation, fall back to available tools such as ${fallbackToolNames.join(', ')}.`;
  }
  return '- Do not claim CodeGraph evidence for this run. For code navigation, use only the listed non-CodeGraph tools available in this run.';
}

export function buildRuntimeCapabilitiesPrompt(options: RuntimeCapabilitiesPromptOptions): string {
  const maxToolNames = options.maxToolNames ?? DEFAULT_MAX_TOOL_NAMES;
  const toolNames = uniqueSortedToolNames(options.tools);
  const codeGraphToolNames = toolNames.filter(isCodeGraphToolName);
  const mcpServerNames = [...new Set(options.mcpServerNames ?? [])].sort((a, b) => a.localeCompare(b));
  const codeGraphAvailable = codeGraphToolNames.length > 0;
  const codeGraphStatus = codeGraphAvailable
    ? `available via ${codeGraphToolNames.join(', ')}`
    : 'unavailable';
  const mcpStatus = options.mcpEnabled
    ? mcpServerNames.length > 0
      ? `enabled; connected servers: ${mcpServerNames.join(', ')}`
      : 'enabled; no servers connected or no tools registered'
    : 'disabled';

  return [
    '## Runtime Capabilities',
    '',
    '- Use only the tool names that are actually registered for this run. Do not invent tool names; if a desired capability is not listed, say it is unavailable when relevant and use the closest listed fallback.',
    `- Available tools: ${toolNames.length > 0 ? formatToolList(toolNames, maxToolNames) : '(none registered)'}.`,
    `- MCP: ${mcpStatus}.`,
    `- CodeGraph: ${codeGraphStatus}.`,
    codeGraphAvailable
      ? '- For structural code questions, prefer the registered CodeGraph tools before literal text search.'
      : formatCodeNavigationFallback(toolNames),
  ].join('\n');
}
