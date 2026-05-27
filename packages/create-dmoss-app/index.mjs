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
      'mcp.json.example': `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
      "env": {}
    }
  }
}
`,
      'index.ts': `import { DmossAgent, InMemorySessionStore, AnthropicLLMProvider } from '@dmoss/agent';

const API_KEY = process.env.DMOSS_API_KEY || '';
if (!API_KEY) {
  console.error('Set DMOSS_API_KEY first.');
  process.exit(1);
}

const provider = new AnthropicLLMProvider({ apiKey: API_KEY });

const agent = new DmossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  model: 'claude-sonnet-4-20250514',
});

// Load MCP servers from mcp.json (copy mcp.json.example to mcp.json and edit)
// import { loadMcpConfig, connectMcpServers } from '@dmoss/agent';
// const config = loadMcpConfig('./mcp.json');
// if (config) {
//   const connections = await connectMcpServers(config);
//   for (const conn of connections) {
//     for (const tool of conn.tools) {
//       agent.tools.register(tool);
//     }
//   }
// }

const result = await agent.chat('demo', 'Hello! What can you help me with?');
console.log('Agent:', result.response);
`,
    },
  },
  openai: {
    description: 'Agent with OpenAI-compatible provider',
    files: {
      'index.ts': `import { DmossAgent, InMemorySessionStore, OpenAILLMProvider } from '@dmoss/agent';

const API_KEY = process.env.OPENAI_API_KEY || process.env.DMOSS_API_KEY || '';
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MODEL = process.env.DMOSS_MODEL || 'gpt-4o';

if (!API_KEY) {
  console.error('Set OPENAI_API_KEY or DMOSS_API_KEY first.');
  process.exit(1);
}

const provider = new OpenAILLMProvider({ apiKey: API_KEY, baseUrl: BASE_URL });

const agent = new DmossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  model: MODEL,
});

console.log(\`Using OpenAI provider with model: \${MODEL}\`);
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

## MCP (Model Context Protocol)

MCP lets your agent use external tools (filesystem, databases, APIs) via standardized servers.

1. Copy the example config:
   \`\`\`bash
   cp mcp.json.example mcp.json
   \`\`\`
2. Edit \`mcp.json\` to point to your desired directories or services.
3. Uncomment the MCP loading code in \`index.ts\` to connect MCP servers and register their tools with your agent.

See the [MCP documentation](https://modelcontextprotocol.io) for available servers and configuration options.

## Learn More

- [D-Moss Documentation](https://github.com/D-Moss/dmoss-agent)
`;

fs.writeFileSync(path.join(targetDir, 'README.md'), readme);

console.log('  Created package.json');
console.log('  Created index.ts');
console.log('  Created mcp.json.example');
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
