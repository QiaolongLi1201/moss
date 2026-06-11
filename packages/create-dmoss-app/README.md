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

# Skip dependency install during scaffolding
npx create-dmoss-app my-agent --skip-install
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
├── mcp.json.example
└── README.md
```

The generated app includes local `tsx`, `typescript`, and Node type
dependencies, plus `start` and `typecheck` scripts.

Then:

```bash
cd my-agent
npm run typecheck
ANTHROPIC_API_KEY=your-key npm start
```

The default template uses Anthropic and also accepts `DMOSS_API_KEY` as a
compatibility fallback. The OpenAI-compatible template uses `OPENAI_API_KEY`.
