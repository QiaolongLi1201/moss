// Standalone welcome-screen preview — mirrors the real App startup composition
// (header + bordered input box + hint line) with real colors, no LLM needed.
//   FORCE_COLOR=3 node scripts/preview-welcome.mjs
// In an interactive terminal it stays alive so a screenshot tool can capture it;
// when stdout/stdin are not TTYs it prints a static frame and exits for CI/smoke.
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, renderToString, Box, Text } from 'ink';
import { SessionHeader, PromptEditor } from '../packages/dmoss-agent/dist/cli/tui.js';

const h = React.createElement;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentPackageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../packages/dmoss-agent/package.json'), 'utf8'),
);
const previewDevice = process.env.DMOSS_PREVIEW_DEVICE ?? 'no device';
const previewWorkspace = process.env.DMOSS_PREVIEW_WORKSPACE ?? process.cwd();
const previewModel = process.env.DMOSS_PREVIEW_MODEL ?? 'built-in model';
const previewVersion = process.env.DMOSS_PREVIEW_VERSION ?? `v${agentPackageJson.version}`;
const App = () =>
  h(Box, { flexDirection: 'column', paddingX: 1, paddingTop: 1 },
    h(SessionHeader, {
      state: 'ready', device: previewDevice,
      workspace: previewWorkspace,
      model: previewModel, version: previewVersion, mode: 'PC Host Agent',
    }),
    h(PromptEditor, {
      value: '', cursor: 0, onChange() {}, onCursorChange() {}, onSubmit() {},
      placeholder: 'Ask Moss for code, board, or ROS help', disabled: false,
      onHistoryPrevious() {}, onHistoryNext() {}, onShiftEnter() {},
    }),
    h(Text, { color: 'gray' }, '  /help for commands  ·  /status for device  ·  no board target'),
  );

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.log(renderToString(h(App)));
} else {
  render(h(App));
  setInterval(() => {}, 1 << 30);
}
