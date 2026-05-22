#!/usr/bin/env node

/**
 * create-dmoss-app — scaffold a new D-Moss agent project.
 *
 * Usage:
 *   npm create dmoss-app my-agent
 *   npx create-dmoss-app my-agent
 *   npx create-dmoss-app my-agent --template openai
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATES = {
  minimal: {
    description: 'Minimal agent with Anthropic provider (default)',
    files: {
      'index.ts': `import { DmossAgent, InMemorySessionStore } from '@dmoss/agent';
import type { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamEvent, LLMContentBlock } from '@dmoss/agent';

const API_KEY = process.env.DMOSS_API_KEY || '';
if (!API_KEY) {
  console.error('Set DMOSS_API_KEY first.');
  process.exit(1);
}

const provider: LLMProvider = {
  id: 'anthropic',
  displayName: 'Anthropic',

  async complete(opts: LLMRequestOptions): Promise<LLMResponse> {
    return this.stream(opts, () => {});
  },

  async stream(opts: LLMRequestOptions, _onEvent: (e: LLMStreamEvent) => void): Promise<LLMResponse> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: opts.systemPrompt,
        messages: opts.messages.map(m => ({ role: m.role, content: m.content })),
      }),
      signal: opts.abortSignal,
    });

    if (!res.ok) throw new Error(\`API \${res.status}: \${await res.text()}\`);
    const data = await res.json() as any;
    const content: LLMContentBlock[] = (data.content || []).map((b: any) =>
      b.type === 'text' ? { type: 'text' as const, text: b.text } : b
    );
    return { content, stopReason: data.stop_reason };
  },
};

const agent = new DmossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  model: 'claude-sonnet-4-20250514',
});

const result = await agent.chat('demo', 'Hello! What can you help me with?');
console.log('Agent:', result.response);
`,
    },
  },
  openai: {
    description: 'Agent with OpenAI-compatible provider',
    files: {
      'index.ts': `import { DmossAgent, InMemorySessionStore } from '@dmoss/agent';
import type { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamEvent, LLMContentBlock } from '@dmoss/agent';

const API_KEY = process.env.OPENAI_API_KEY || process.env.DMOSS_API_KEY || '';
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MODEL = process.env.DMOSS_MODEL || 'gpt-4o';

if (!API_KEY) {
  console.error('Set OPENAI_API_KEY or DMOSS_API_KEY first.');
  process.exit(1);
}

const provider: LLMProvider = {
  id: 'openai',
  displayName: \`OpenAI (\${new URL(BASE_URL).hostname})\`,

  async complete(opts: LLMRequestOptions): Promise<LLMResponse> {
    return this.stream(opts, () => {});
  },

  async stream(opts: LLMRequestOptions, _onEvent: (e: LLMStreamEvent) => void): Promise<LLMResponse> {
    const res = await fetch(\`\${BASE_URL}/v1/chat/completions\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${API_KEY}\` },
      body: JSON.stringify({
        model: opts.model || MODEL,
        max_tokens: opts.maxTokens || 4096,
        messages: [
          ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
          ...opts.messages.map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
        ],
      }),
      signal: opts.abortSignal,
    });

    if (!res.ok) throw new Error(\`API \${res.status}: \${await res.text()}\`);
    const data = await res.json() as any;
    const text = data.choices?.[0]?.message?.content || '';
    return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
  },
};

const agent = new DmossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  model: MODEL,
});

console.log(\`Using \${provider.displayName} with model: \${MODEL}\`);
const result = await agent.chat('demo', 'Hello! What can you help me with?');
console.log('Agent:', result.response);
`,
    },
  },
};

function printUsage() {
  console.log(`
  create-dmoss-app <project-name> [--template <name>] [--skip-install]

  Templates:
    minimal   ${TEMPLATES.minimal.description}
    openai    ${TEMPLATES.openai.description}

  Examples:
    npx create-dmoss-app my-agent
    npx create-dmoss-app my-agent --template openai
    npx create-dmoss-app my-agent --skip-install
    npm create dmoss-app my-agent
`);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

const projectName = path.basename(args[0]);
const templateIdx = args.indexOf('--template');
const templateName = templateIdx !== -1 ? args[templateIdx + 1] : 'minimal';
const skipInstall = args.includes('--skip-install');

if (!projectName || projectName.startsWith('-')) {
  console.error('Please provide a project name.');
  printUsage();
  process.exit(1);
}

const template = TEMPLATES[templateName];
if (!template) {
  console.error(`Unknown template: ${templateName}`);
  console.error(`Available: ${Object.keys(TEMPLATES).join(', ')}`);
  process.exit(1);
}

const targetDir = path.resolve(process.cwd(), projectName);

if (fs.existsSync(targetDir)) {
  console.error(`Directory '${projectName}' already exists.`);
  process.exit(1);
}

console.log(`\nCreating D-Moss project: ${projectName}`);
console.log(`Template: ${templateName}\n`);

fs.mkdirSync(targetDir, { recursive: true });

const packageJson = {
  name: projectName,
  private: true,
  type: 'module',
  scripts: {
    start: 'tsx index.ts',
    typecheck: 'tsc --noEmit --esModuleInterop --module ESNext --moduleResolution Bundler --target ES2022 --types node --strict --skipLibCheck index.ts',
  },
  dependencies: {
    '@dmoss/core': '^0.3.1',
    '@dmoss/agent': '^0.3.1',
  },
  devDependencies: {
    '@types/node': '^22.13.10',
    tsx: '^4.19.3',
    typescript: '^5.7.3',
  },
};

fs.writeFileSync(
  path.join(targetDir, 'package.json'),
  JSON.stringify(packageJson, null, 2) + '\n',
);

for (const [filename, content] of Object.entries(template.files)) {
  fs.writeFileSync(path.join(targetDir, filename), content);
}

const readme = `# ${projectName}

A D-Moss agent project.

## Setup

\`\`\`bash
npm install
\`\`\`

## Run

\`\`\`bash
npm run typecheck
DMOSS_API_KEY=your-key npm start
\`\`\`

## Learn More

- [D-Moss Documentation](https://github.com/D-Moss/dmoss-agent)
`;

fs.writeFileSync(path.join(targetDir, 'README.md'), readme);

console.log('  Created package.json');
console.log('  Created index.ts');
console.log('  Created README.md');

if (skipInstall) {
  console.log('\nSkipped dependency install.');
} else {
  try {
    console.log('\nInstalling dependencies...');
    execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
  } catch {
    console.log('\nnpm install failed — run it manually after packages are published.');
  }
}

console.log(`
Done! Next steps:

  cd ${projectName}
  npm run typecheck
  DMOSS_API_KEY=your-key npm start
`);
