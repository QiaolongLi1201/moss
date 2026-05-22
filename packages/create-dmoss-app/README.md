# create-dmoss-app

Scaffold a new D-Moss agent project in seconds.

## Usage

```bash
npm install create-dmoss-app@latest
```

```bash
# Using npm create
npm create dmoss-app my-agent

# Using npx
npx create-dmoss-app my-agent

# With OpenAI template
npx create-dmoss-app my-agent --template openai
```

## Templates

| Template | Description |
|----------|-------------|
| `minimal` | Minimal agent with Anthropic provider (default) |
| `openai` | Agent with OpenAI-compatible provider (works with DeepSeek, Ollama, etc.) |

## What Gets Created

```
my-agent/
├── package.json
├── index.ts
└── README.md
```

The generated app includes local `tsx`, `typescript`, and Node type
dependencies, plus `start` and `typecheck` scripts.

Then:

```bash
cd my-agent
npm run typecheck
DMOSS_API_KEY=your-key npm start
```
