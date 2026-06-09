#!/usr/bin/env node
import { installSafeProcessCwd } from './utils/safe-cwd.js';

installSafeProcessCwd();
await import('./cli-main.js');
