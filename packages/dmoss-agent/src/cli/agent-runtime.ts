import type { DmossAgentConfig } from '../core/index.js';
import type { ResolvedCliConfig } from './config.js';

export function resolveCliAgentRuntimeOptions(
  config: ResolvedCliConfig,
): Pick<DmossAgentConfig, 'maxAgentTurns' | 'contextTokens' | 'compactionSettings' | 'promptCache'> {
  return {
    maxAgentTurns: config.maxAgentTurns,
    contextTokens: config.contextTokens,
    compactionSettings: config.compactionSettings,
    promptCache: {
      enabled: config.promptCacheEnabled,
      debug: config.promptCacheDebug,
    },
  };
}
