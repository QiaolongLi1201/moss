# D-Moss Agent — Usage Guide

## Overview

D-Moss Agent is a vendor-neutral, open-source framework for building AI-powered robotics developer tools. It provides the complete runtime for creating agents that can interact with hardware devices, execute tools, and leverage domain knowledge.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Your Product (e.g. Jetson DevKit, Pi IDE, Robot Lab)        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Product Layer                                         │  │
│  │  • Custom tools (SSH, file upload, diagnostics)        │  │
│  │  • Custom persona (SOUL.md)                            │  │
│  │  • Product-specific UI & event handling                │  │
│  │  • Queue management, approval workflow                 │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        │ extends / consumes                   │
│  ┌─────────────────────▼──────────────────────────────────┐  │
│  │  @rdk-moss/agent (this package)                           │  │
│  │  • DmossAgent: chat() + streamChat()                   │  │
│  │  • ToolRegistry: register/discover tools               │  │
│  │  • KnowledgeModule: pluggable domain knowledge         │  │
│  │  • Context: pruning, compaction, token estimation      │  │
│  │  • Safety: command checking, secret sanitization       │  │
│  │  • Provider: error classification, retry               │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        │ depends on                           │
│  ┌─────────────────────▼──────────────────────────────────┐  │
│  │  @rdk-moss/core                                           │  │
│  │  • Contracts: KnowledgeModule, PlatformExtension       │  │
│  │  • Robotics engineering prompts (vendor-neutral)       │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install

```bash
npm install @rdk-moss/agent @rdk-moss/core
```

### LLM backends: minimal path vs optional `pi-ai`

- **Recommended for new integrations:** implement **`LLMProvider`** yourself (e.g. with `fetch()` to Anthropic, OpenAI-compatible, or local servers). This is the **smallest behavioral dependency** — you do not need pi-ai in your code. The `create-dmoss-app` package can scaffold minimal and OpenAI-compatible starter projects.
- **Optional:** **`PiAiLLMProvider`** — import from `@rdk-moss/agent` / `@rdk-moss/agent/provider` only if you already standardize on pi-ai-compatible streams inside your host. It is **not** required to use `DmossAgent`.

> **npm install note:** `@rdk-moss/agent` no longer installs deprecated pi-ai packages. `PiAiLLMProvider` keeps local compatibility types and accepts a compatible stream function; supply any `LLMProvider` implementation you prefer.

### 2. Create an Agent

```typescript
import { DmossAgent, InMemorySessionStore } from '@rdk-moss/agent';
import type { LLMProvider } from '@rdk-moss/agent';

// Implement your LLM provider (Anthropic, OpenAI, etc.)
const myProvider: LLMProvider = {
  id: 'my-provider',
  displayName: 'My LLM Provider',
  async complete(opts) { /* ... */ },
  async stream(opts, onEvent) { /* ... */ },
};

const agent = new DmossAgent({
  llmProvider: myProvider,
  sessionStore: new InMemorySessionStore(),
  model: 'claude-sonnet-4-20250514',
  hooks: {
    onBeforeToolExec: async (req) => ({ approved: true }),
    onStream: (event) => console.log(event),
  },
});
```

### 3. Register Tools

```typescript
agent.tools.register({
  name: 'device_exec',
  description: 'Execute a shell command on the connected device via SSH',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run' },
    },
    required: ['command'],
  },
  execute: async (input, ctx) => {
    // Your SSH implementation
    return await sshExec(input.command);
  },
});
```

### 4. Register Knowledge Module

```typescript
import type { KnowledgeModule } from '@rdk-moss/core';

const myKnowledge: KnowledgeModule = {
  id: 'jetson',
  name: 'NVIDIA Jetson',
  version: '1.0.0',
  description: 'Jetson developer kit knowledge',
  platforms: ['jetson-nano', 'jetson-orin-nano', 'jetson-agx-orin'],

  getDeviceProfiles: () => ({
    'jetson-orin-nano': {
      platform: 'jetson-orin-nano',
      displayName: 'Jetson Orin Nano',
      soc: 'Orin Nano',
      computeUnit: 'CUDA',
      computeTops: 40,
      cpu: '6-core Arm Cortex-A78AE',
      ramGb: 8,
      modelFormat: 'TensorRT Engine',
      diagnosticCommand: 'tegrastats',
      runtimeBasePath: '/usr/local/cuda',
      systemPython: '/usr/bin/python3',
      inferLibPackage: 'tensorrt',
      detectionPatterns: ['jetson', 'tegra', 'nvidia'],
      limitations: ['Power-limited for training workloads'],
      docBaseUrl: 'https://developer.nvidia.com/embedded/jetson-docs',
      capabilityNotes: ['CUDA 11.4+', 'cuDNN 8.x'],
    },
  }),

  getDocIndex: () => [],

  getPromptFragments: () => [
    {
      id: 'jetson-cuda-tips',
      section: 'reasoning',
      tier: 'all',
      mode: 'all',
      priority: 80,
      content: 'For Jetson: use tegrastats to check GPU/CPU utilization before profiling.',
    },
  ],

  getCommandPatterns: () => [
    { pattern: /tegrastats/i, category: 'diagnostics', description: 'GPU/CPU monitor', riskLevel: 'safe' },
    { pattern: /jetson_clocks/i, category: 'system', description: 'Max performance mode', riskLevel: 'moderate' },
  ],

  getFailureHints: () => [
    {
      errorPattern: /CUDA out of memory/i,
      suggestion: 'Reduce batch size or model precision (FP16/INT8). Check tegrastats for memory usage.',
    },
  ],

  getEcosystemPrompt: () => [
    '## NVIDIA Jetson Ecosystem',
    '- **JetPack SDK**: Complete developer kit with CUDA, cuDNN, TensorRT',
    '- **Jetson Documentation**: developer.nvidia.com/embedded/jetson-docs',
    '- **NVIDIA Developer Forums**: forums.developer.nvidia.com',
  ].join('\n'),
};

agent.registerKnowledge(myKnowledge);
```

### 5. Chat (Promise API)

```typescript
const result = await agent.chat('session-1', 'Check the camera status');
console.log(result.response);
console.log(`Used ${result.toolCalls.length} tools`);
```

### 6. Stream Chat (AsyncGenerator API)

For real-time UI integration:

```typescript
for await (const event of agent.streamChat('session-1', 'Deploy the model')) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'tool_start':
      console.log(`\n[Tool] Running: ${event.toolName}`);
      break;
    case 'tool_end':
      console.log(`[Tool] ${event.toolName}: ${event.isError ? 'FAILED' : 'OK'}`);
      break;
    case 'turn_start':
      console.log(`\n--- Turn ${event.turn + 1} ---`);
      break;
    case 'error':
      console.error(`Error: ${event.error} (retriable: ${event.retriable})`);
      break;
    case 'done':
      console.log(`\nCompleted: ${event.result.toolCalls.length} tool calls`);
      break;
  }
}
```

## Customization

### Protected Paths

Register product-specific paths that should never be deleted:

```typescript
import { registerProtectedPaths } from '@rdk-moss/agent/safety';

registerProtectedPaths(['/my-product', '/my-config', '/jetpack']);
```

### Tool Output Limits

Register custom truncation limits for your tools:

```typescript
import { registerToolOutputLimits } from '@rdk-moss/agent/context';

registerToolOutputLimits({
  my_custom_tool: 20_000,
  jetson_log_reader: 30_000,
});
```

### Hooks

```typescript
const hooks: AgentHooks = {
  // Tool approval (block dangerous operations)
  onBeforeToolExec: async (req) => {
    if (isDangerousCommand(req.input.command)) {
      return { approved: false, reason: 'Dangerous operation blocked' };
    }
    return { approved: true };
  },

  // Audit logging
  onToolResult: (call, result) => {
    auditLog({ tool: call.name, input: call.input, output: result.content });
  },

  // Raw provider stream telemetry. For product UI text, consume streamChat() events.
  onStream: (event) => {
    logger.debug({ eventType: event.type }, 'provider stream');
  },

  // Error handling
  onError: async (err, ctx) => {
    logger.warn(`Agent error on attempt ${ctx.attempt}`, err);
    return true; // retry
  },

  // Inject host-specific context into tool execution
  enrichToolContext: (ctx, sessionKey) => ({
    ...ctx,
    deviceId: getActiveDeviceId(sessionKey),
    sshConnection: getSSHPool(sessionKey),
  }),
};
```

## Extending DmossAgent

For products that need additional features (events, memory, etc.), extend DmossAgent:

```typescript
import { DmossAgent } from '@rdk-moss/agent';
import type { DmossAgentConfig, ChatResult, ChatOptions } from '@rdk-moss/agent';

class MyProductAgent extends DmossAgent {
  private listeners: Array<(event: any) => void> = [];

  subscribe(listener: (event: any) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  async run(sessionKey: string, message: string, options?: ChatOptions): Promise<ChatResult> {
    this.emit({ type: 'agent_start', sessionKey });

    for await (const event of this.streamChat(sessionKey, message, options)) {
      this.emit(event);
      if (event.type === 'done') return event.result;
    }

    return { response: '', toolCalls: [], toolResults: [] };
  }

  private emit(event: any) {
    for (const listener of this.listeners) listener(event);
  }
}
```

## Open Source Packages

| Package | Description | Open Source |
|---------|-------------|------------|
| `@rdk-moss/core` | Contracts (KnowledgeModule, PlatformExtension) | ✅ MIT |
| `@rdk-moss/agent` | Runtime (DmossAgent, ToolRegistry, Context, Safety) | ✅ MIT |
| Your knowledge module | Hardware-specific device knowledge | Product-specific |

## License

MIT — see [LICENSE](./LICENSE)
