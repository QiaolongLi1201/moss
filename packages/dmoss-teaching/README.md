# @rdk-moss/teaching

Teach-while-solve annotation layer for the Moss agent runtime.

> **Dependency surface**: this package depends on `@rdk-moss/agent` only
> through its two stable public subpaths — `@rdk-moss/agent/core` (types) and
> `@rdk-moss/agent/safety` (`sanitizeSecrets`). It never imports agent
> internals, so agent-internal refactors cannot break the teaching layer.

## Features

- **Pre-execution Annotations**: Explain tool intent before execution
- **Post-execution Reflection**: Verify results and suggest next steps
- **Dry-run Summaries**: Preview risky operations before execution
- **Confidence Assessment**: Evaluate operation success and rollback options
- **Failure Cards**: Structured error analysis with actionable recovery steps

## Installation

```bash
npm install @rdk-moss/teaching
```

## Usage

```typescript
import { createTeachingHooks } from '@rdk-moss/teaching';

const { onBeforeToolExec, onToolResult } = createTeachingHooks({
  depth: 'concise', // 'off' | 'concise' | 'detailed'
  llmProvider: provider,
  modelId: 'claude-sonnet-4-20250514',
  deviceLabel: 'RDK X5',
  familyIsRdk: true,
  runId: 'run-123',
  sessionKey: 'session-456',
  teachingConfirmRequested: false,
  teachingConfirmInteractive: false,
  emitTeachingMeta: (meta) => console.log('Teaching meta:', meta),
  waitTeachingConfirm: async () => true,
  classifyPlanMutation: (toolName) => toolName.startsWith('device_exec'),
});

// Register with agent
agent.registerHook('onBeforeToolExec', onBeforeToolExec);
agent.registerHook('onToolResult', onToolResult);
```

## API

- `TeachingLayer`: Main teaching annotation layer
- `TeachingAnnotationCollector`: Collect and format annotations
- `TeachingToolDigest`: Generate tool execution digests

## Teaching Depth Levels

- **off**: No teaching annotations
- **concise**: Brief explanations for mutations only
- **detailed**: Comprehensive explanations for all operations

## License

MIT
