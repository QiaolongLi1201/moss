// Standalone welcome-screen preview — mirrors the real App startup composition
// (header + bordered input box + hint line) with real colors, no LLM needed.
//   FORCE_COLOR=3 node scripts/preview-welcome.mjs
// Stays alive so a screenshot tool can capture it; Ctrl-C to exit.
import React from 'react';
import { render, Box, Text } from 'ink';
import { SessionHeader, PromptEditor } from '../packages/dmoss-agent/dist/cli/tui.js';

const h = React.createElement;
const App = () =>
  h(Box, { flexDirection: 'column', paddingX: 1, paddingTop: 1 },
    h(SessionHeader, {
      state: 'ready', device: 'no device',
      workspace: '/Users/d-robotics/Desktop/RDK_Studio/rdstudio-web',
      model: 'deepseek-v4-pro', version: 'v0.3.7', mode: 'PC Host Agent',
    }),
    h(Box, { borderStyle: 'round', borderColor: '#9ca3af', paddingX: 1 },
      h(PromptEditor, {
        value: '', cursor: 0, onChange() {}, onCursorChange() {}, onSubmit() {},
        placeholder: 'Ask Moss for code, board, or ROS help', disabled: false,
        onHistoryPrevious() {}, onHistoryNext() {}, onShiftEnter() {}, boxed: true,
      })),
    h(Text, { color: 'gray' }, '  /help for commands  ·  /status for device  ·  no board target'),
  );

render(h(App));
setInterval(() => {}, 1 << 30);
