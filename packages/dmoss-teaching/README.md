# @dmoss/teaching

Teach-while-solve annotation layer for the Moss agent runtime.

## Features

- **Pre-execution Annotations**: Explain tool intent before execution
- **Post-execution Reflection**: Verify results and suggest next steps
- **Dry-run Summaries**: Preview risky operations before execution
- **Confidence Assessment**: Evaluate operation success and rollback options
- **Failure Cards**: Structured error analysis with actionable recovery steps

## Installation

```bash
npm install @dmoss/teaching
```

## Usage

```typescript
import { TeachingLayer } from '@dmoss/teaching';

const teaching = new TeachingLayer({
  llmProvider: provider,
  depth: 'concise', // 'off' | 'concise' | 'detailed'
});

// Create teaching hooks for agent
const hooks = teaching.createHooks({
  deviceLabel: 'RDK X5',
  isMutation: (toolName) => toolName.startsWith('device_exec'),
});

// Register with agent
agent.registerHooks(hooks);
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
