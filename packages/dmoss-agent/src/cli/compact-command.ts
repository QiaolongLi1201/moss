import type { DmossAgent } from '../core/index.js';

export function formatCompactSessionResult(result: Awaited<ReturnType<DmossAgent['compactSession']>>): string {
  if (!result.compacted) {
    return [
      'No compaction needed.',
      `  tokens after check: ~${result.tokensAfter.toLocaleString()}`,
      '  The current conversation still fits within the keep-recent window.',
    ].join('\n');
  }
  return [
    'Compacted conversation context.',
    `  dropped messages: ${result.droppedMessages}`,
    `  summary chars: ${result.summaryChars.toLocaleString()}`,
    `  tokens after: ~${result.tokensAfter.toLocaleString()}`,
  ].join('\n');
}

export async function handleCompactCommand(agent: DmossAgent, sessionKey: string): Promise<string> {
  const result = await agent.compactSession(sessionKey);
  return formatCompactSessionResult(result);
}
