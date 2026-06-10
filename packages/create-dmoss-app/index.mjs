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
const DEFAULT_MOSS_VERSION_RANGE = '^0.3.32';
const WORKSPACE_PACKAGE_PATHS = new Map([
  ['@rdk-moss/core', path.join(__dirname, '../dmoss/package.json')],
  ['@rdk-moss/agent', path.join(__dirname, '../dmoss-agent/package.json')],
]);

function readPackageVersion(packageJsonPath) {
  if (!fs.existsSync(packageJsonPath)) return null;
  const json = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return typeof json.version === 'string' && json.version.trim() ? json.version : null;
}

function findInstalledPackageVersion(packageName) {
  const workspacePackagePath = WORKSPACE_PACKAGE_PATHS.get(packageName);
  if (workspacePackagePath) {
    const workspaceVersion = readPackageVersion(workspacePackagePath);
    if (workspaceVersion) return workspaceVersion;
  }

  const packageSegments = packageName.split('/');
  const startDirs = [process.cwd(), __dirname];

  for (const startDir of startDirs) {
    let current = path.resolve(startDir);
    while (true) {
      const candidate = path.join(current, 'node_modules', ...packageSegments, 'package.json');
      const installedVersion = readPackageVersion(candidate);
      if (installedVersion) return installedVersion;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return null;
}

function mossVersionRange(packageName) {
  const installedVersion = findInstalledPackageVersion(packageName);
  return installedVersion ? `^${installedVersion}` : DEFAULT_MOSS_VERSION_RANGE;
}

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
      'index.ts': `import { DmossAgent, InMemorySessionStore, AnthropicLLMProvider } from '@rdk-moss/agent';

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
// import { loadMcpConfig, connectMcpServers } from '@rdk-moss/agent';
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
      'index.ts': `import { DmossAgent, InMemorySessionStore, OpenAILLMProvider } from '@rdk-moss/agent';

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
    '@rdk-moss/core': mossVersionRange('@rdk-moss/core'),
    '@rdk-moss/agent': mossVersionRange('@rdk-moss/agent'),
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

## Prerequisites

- Node.js 22.16 or newer
- Optional for device tools: OpenSSH Client (ssh) on the host
- Optional for password-based SSH: sshpass on Unix-like hosts, or WSL on Windows. Key-based auth with DMOSS_DEVICE_KEY is recommended on Windows.

## Setup

\`\`\`sh
npm install
\`\`\`

## Run

\`\`\`sh
npm run typecheck
DMOSS_API_KEY=your-key npm start
\`\`\`

Windows PowerShell:

\`\`\`powershell
npm run typecheck
$env:DMOSS_API_KEY="your-key"; npm start
\`\`\`

Windows cmd.exe:

\`\`\`bat
npm run typecheck
set DMOSS_API_KEY=your-key && npm start
\`\`\`

## MCP (Model Context Protocol)

MCP lets your agent use external tools (filesystem, databases, APIs) via standardized servers.

1. Copy the example config:
   \`\`\`sh
   cp mcp.json.example mcp.json
   \`\`\`

   Windows PowerShell:
   \`\`\`powershell
   Copy-Item mcp.json.example mcp.json
   \`\`\`

   Windows cmd.exe:
   \`\`\`bat
   copy mcp.json.example mcp.json
   \`\`\`
2. Edit \`mcp.json\` to point to your desired directories or services.
3. Uncomment the MCP loading code in \`index.ts\` to connect MCP servers and register their tools with your agent.

See the [MCP documentation](https://modelcontextprotocol.io) for available servers and configuration options.

## Learn More

- [D-Moss Documentation](https://github.com/D-Robotics/moss)
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

Windows PowerShell:

  cd ${projectName}
  npm run typecheck
  $env:DMOSS_API_KEY="your-key"; npm start

Windows cmd.exe:

  cd ${projectName}
  npm run typecheck
  set DMOSS_API_KEY=your-key && npm start
`);
