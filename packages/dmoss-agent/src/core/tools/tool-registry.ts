/**
 * Tool Registry — pluggable tool registration and discovery for D-Moss Agent.
 *
 * Tools can be registered individually or in groups (e.g. "device tools", "web tools").
 * The registry supports:
 *  - Dynamic add/remove of tools at runtime
 *  - Tool groups for organized management
 *  - Tool discovery by name or group
 *  - Snapshot of all registered tools for LLM tool_use declarations
 */

import type { Tool } from './tool-types.js';

export interface ToolGroup {
  id: string;
  displayName: string;
  tools: Tool[];
}

export interface ToolRegistryOptions {
  onToolRegistered?: (tool: Tool, groupId?: string) => void;
  onToolRemoved?: (toolName: string, groupId?: string) => void;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private groups = new Map<string, ToolGroup>();
  private toolToGroup = new Map<string, string>();
  private opts: ToolRegistryOptions;

  constructor(opts?: ToolRegistryOptions) {
    this.opts = opts ?? {};
  }

  /** Register a single tool */
  register(tool: Tool, groupId?: string): void {
    this.tools.set(tool.name, tool);
    if (groupId) {
      this.toolToGroup.set(tool.name, groupId);
      const group = this.groups.get(groupId);
      if (group) {
        const idx = group.tools.findIndex((t) => t.name === tool.name);
        if (idx === -1) group.tools.push(tool);
        else group.tools[idx] = tool;
      }
    }
    this.opts.onToolRegistered?.(tool, groupId);
  }

  /** Register a group of tools */
  registerGroup(group: ToolGroup): void {
    this.groups.set(group.id, { ...group, tools: [...group.tools] });
    for (const tool of group.tools) {
      this.tools.set(tool.name, tool);
      this.toolToGroup.set(tool.name, group.id);
      this.opts.onToolRegistered?.(tool, group.id);
    }
  }

  /** Remove a tool by name */
  remove(toolName: string): boolean {
    const existed = this.tools.delete(toolName);
    const groupId = this.toolToGroup.get(toolName);
    if (groupId) {
      const group = this.groups.get(groupId);
      if (group) {
        group.tools = group.tools.filter((t) => t.name !== toolName);
      }
      this.toolToGroup.delete(toolName);
    }
    if (existed) {
      this.opts.onToolRemoved?.(toolName, groupId);
    }
    return existed;
  }

  /** Remove all tools in a group */
  removeGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    for (const tool of group.tools) {
      this.tools.delete(tool.name);
      this.toolToGroup.delete(tool.name);
      this.opts.onToolRemoved?.(tool.name, groupId);
    }
    this.groups.delete(groupId);
  }

  /** Get a tool by name */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool exists */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get all registered tools (for LLM tool declarations) */
  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  /** Get all tool names */
  getNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Get all registered groups */
  getGroups(): ToolGroup[] {
    return [...this.groups.values()];
  }

  /** Get the group a tool belongs to */
  getGroupForTool(toolName: string): string | undefined {
    return this.toolToGroup.get(toolName);
  }

  /** Get total count of registered tools */
  get size(): number {
    return this.tools.size;
  }

  /** Build LLM-compatible tool declarations */
  buildToolDeclarations(): Array<{
    name: string;
    description: string;
    input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  }> {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}
