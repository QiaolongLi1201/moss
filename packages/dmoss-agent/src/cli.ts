#!/usr/bin/env node
// Old Node must produce ONE clear line, not a cryptic crash three imports
// deep (npm's EBADENGINE is only a warning, installs proceed anyway). The
// guard is imported alone and everything else loads dynamically AFTER it,
// so no other module evaluates on an unsupported runtime.
import { enforceNodeVersion } from './cli/node-version-check.js';

enforceNodeVersion();
const { installSafeProcessCwd } = await import('./utils/safe-cwd.js');
installSafeProcessCwd();
await import('./cli-main.js');
