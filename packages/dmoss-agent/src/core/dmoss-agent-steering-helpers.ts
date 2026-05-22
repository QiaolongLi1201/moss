import type { SteeringEngine } from './steering.js';
import type { DmossAgentConfig, InternalMessage } from './dmoss-agent-types.js';
import { toLLMMessages, toSessionMessages } from './dmoss-agent-types.js';
import { estimateMessagesTokens } from '../context/tokens.js';

export function evaluateSteering(
  steeringEngine: SteeringEngine | null,
  messages: InternalMessage[],
  turn: number,
  consecutiveToolErrors: number,
  totalToolCalls: number,
  contextWindowTokens: number,
): { guidances: string[]; firedRules: string[] } {
  if (!steeringEngine) return { guidances: [], firedRules: [] };

  const estTokens = estimateMessagesTokens(toSessionMessages(messages));
  const contextUsageRatio = estTokens / contextWindowTokens;

  const result = steeringEngine.evaluate({
    messages: toLLMMessages(messages),
    turn,
    consecutiveToolErrors,
    totalToolCalls,
    contextUsageRatio,
    sessionKey: '',
  });

  return { guidances: result.guidances, firedRules: result.firedRules };
}
