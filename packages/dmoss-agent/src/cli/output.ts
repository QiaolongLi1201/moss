import type { DmossAgentEvent } from '../core/index.js';
import { redactSensitiveData } from '../observability/redact.js';

export type CliDetailMode = 'quiet' | 'progress' | 'verbose';

interface CliOutputStreams {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

interface CliRunRendererOptions extends Partial<CliOutputStreams> {
  detailMode?: CliDetailMode;
}

interface RendererState {
  answerOpen: boolean;
  thinkingOpen: boolean;
  thinkingNoted: boolean;
  toolStartTimes: Map<string, number>;
}

export function resolveCliDetailMode(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): CliDetailMode {
  const raw = (env.DMOSS_CLI_DETAIL || '').toLowerCase();
  if (argv.includes('--quiet') || raw === 'quiet' || raw === 'off' || raw === 'none') return 'quiet';
  if (!raw && (argv.includes('--json') || env.DMOSS_LOG_JSON === '1')) return 'quiet';
  if (
    raw === 'verbose' ||
    raw === 'debug' ||
    env.DMOSS_VERBOSE_CLI === 'true' ||
    env.DMOSS_VERBOSE_TOOLS === 'true' ||
    env.DMOSS_SHOW_THINKING === 'true'
  ) {
    return 'verbose';
  }
  return 'progress';
}

export function summarizeForCli(value: unknown, maxChars = 280): string {
  const redacted = redactSensitiveData(value);
  const raw =
    typeof redacted === 'string'
      ? redacted
      : JSON.stringify(redacted, null, 0);
  const oneLine = raw
    .replace(/\s+/g, ' ')
    .trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function createCliRunRenderer(options: CliRunRendererOptions = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const detailMode = options.detailMode ?? resolveCliDetailMode();
  const state: RendererState = {
    answerOpen: false,
    thinkingOpen: false,
    thinkingNoted: false,
    toolStartTimes: new Map(),
  };

  const isQuiet = detailMode === 'quiet';
  const isVerbose = detailMode === 'verbose';

  function stderrLine(line: string): void {
    stderr.write(`${line}\n`);
  }

  function breakAnswerForStatus(): void {
    if (state.answerOpen) {
      stderr.write('\n');
      state.answerOpen = false;
    }
    if (state.thinkingOpen) {
      stderr.write('\n');
      state.thinkingOpen = false;
    }
  }

  function handle(event: DmossAgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(`[thinking] planning turn ${event.turn}...`);
          state.thinkingNoted = true;
        }
        break;
      case 'thinking_delta':
        if (isQuiet) break;
        breakAnswerForStatus();
        if (isVerbose && process.env.DMOSS_SHOW_THINKING === 'true') {
          if (!state.thinkingOpen) {
            stderrLine('[thinking]');
            state.thinkingOpen = true;
          }
          stderr.write(String(redactSensitiveData(event.delta)));
        } else if (!state.thinkingNoted) {
          stderrLine('[thinking] reasoning...');
          state.thinkingNoted = true;
        }
        break;
      case 'text_delta':
        if (state.thinkingOpen) {
          stderr.write('\n');
          state.thinkingOpen = false;
        }
        stdout.write(event.delta);
        state.answerOpen = true;
        break;
      case 'tool_start':
        state.toolStartTimes.set(event.toolCallId, Date.now());
        if (!isQuiet) {
          breakAnswerForStatus();
          if (isVerbose) {
            const input = summarizeForCli(event.input);
            stderrLine(input ? `[tool] ${event.toolName} input ${input}` : `[tool] ${event.toolName} started`);
          } else {
            stderrLine(`[tool] ${event.toolName} started`);
          }
        }
        break;
      case 'tool_end':
        if (!isQuiet) {
          breakAnswerForStatus();
          const startedAt = state.toolStartTimes.get(event.toolCallId);
          state.toolStartTimes.delete(event.toolCallId);
          const elapsed = startedAt ? ` ${Date.now() - startedAt}ms` : '';
          const status = event.aborted
            ? `aborted:${event.aborted.by}`
            : event.isError
              ? 'failed'
              : 'ok';
          if (isVerbose) {
            const result = summarizeForCli(event.result);
            stderrLine(result ? `[tool] ${event.toolName} ${status}${elapsed} ${result}` : `[tool] ${event.toolName} ${status}${elapsed}`);
          } else {
            stderrLine(`[tool] ${event.toolName} ${status}${elapsed}`);
          }
        }
        break;
      case 'compaction':
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(`[context] compacted ${event.droppedMessages} messages into ${event.summaryChars} chars`);
        }
        break;
      case 'working_context_checkpoint':
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(`[context] ${event.status}: ${summarizeForCli(event.nextAction, 160)}`);
        }
        break;
      case 'microcompact':
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(`[context] compressed ${event.compressedCount} items, saved ~${event.savedTokens} tokens`);
        }
        break;
      case 'turn_end':
        if (!isQuiet && (isVerbose || (event.totalToolCalls ?? 0) > 0)) {
          breakAnswerForStatus();
          const tools = event.totalToolCalls ? `, tools=${event.totalToolCalls}` : '';
          stderrLine(`[turn] ${event.turn} finished: ${event.stopReason}${tools}`);
        }
        break;
      case 'error':
        breakAnswerForStatus();
        stderrLine(`[error] ${event.retriable ? 'retryable ' : ''}${summarizeForCli(event.error, 400)}`);
        break;
      case 'done':
        if (state.thinkingOpen) {
          stderr.write('\n');
          state.thinkingOpen = false;
        }
        if (state.answerOpen) {
          stdout.write('\n');
          state.answerOpen = false;
        }
        break;
    }
  }

  return { detailMode, handle };
}
