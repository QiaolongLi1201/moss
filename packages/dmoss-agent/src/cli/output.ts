import type { DmossAgentEvent } from '../core/index.js';
import { redactSensitiveData } from '../observability/redact.js';
import { ui } from './ui.js';

export type CliDetailMode = 'quiet' | 'progress' | 'verbose';

interface CliOutputStreams {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

interface CliRunRendererOptions extends Partial<CliOutputStreams> {
  detailMode?: CliDetailMode;
  interactive?: boolean;
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

function progressToolLabel(toolName: string): string {
  if (toolName === 'read_file') return 'file read';
  if (
    toolName === 'write_file' ||
    toolName === 'edit_file' ||
    toolName === 'move_file' ||
    toolName === 'apply_patch'
  ) {
    return 'file update';
  }
  if (toolName === 'search_code' || toolName === 'search_files' || toolName === 'list_directory') {
    return 'workspace search';
  }
  if (toolName === 'exec' || toolName === 'exec_background') return 'command';
  if (toolName.startsWith('device_') || toolName.startsWith('ros2_')) return 'device command';
  if (toolName.startsWith('web_search')) return 'web search';
  if (toolName.startsWith('web_fetch')) return 'web fetch';
  if (toolName.startsWith('memory_read')) return 'memory read';
  if (toolName.startsWith('memory_write')) return 'memory write';
  if (toolName.includes('subagent')) return 'subagent';
  if (toolName.startsWith('browser_')) return 'browser';
  return 'tool';
}

export function createCliRunRenderer(options: CliRunRendererOptions = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const detailMode = options.detailMode ?? resolveCliDetailMode();
  const interactive = options.interactive ?? Boolean((stderr as NodeJS.WriteStream).isTTY);
  const state: RendererState = {
    answerOpen: false,
    thinkingOpen: false,
    thinkingNoted: false,
    toolStartTimes: new Map(),
  };

  const isQuiet = detailMode === 'quiet';
  const isVerbose = detailMode === 'verbose';

  function mark(kind: 'info' | 'ok' | 'fail' = 'info'): string {
    if (!interactive) {
      if (kind === 'ok') return 'ok';
      if (kind === 'fail') return 'err';
      return '-';
    }
    if (kind === 'ok') return ui.green('✓');
    if (kind === 'fail') return ui.yellow('!');
    return ui.cyan('•');
  }

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
          stderrLine(`${mark()} thinking ${ui.dim(`turn ${event.turn}`)}`);
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
          stderrLine(`${mark()} thinking ${ui.dim('reasoning')}`);
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
            stderrLine(input ? `${mark()} ${ui.bold(event.toolName)} ${ui.dim('input')} ${input}` : `${mark()} ${ui.bold(event.toolName)} ${ui.dim('running')}`);
          } else {
            stderrLine(`${mark()} ${ui.bold(progressToolLabel(event.toolName))} ${ui.dim('running')}`);
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
          const statusKind = event.isError || event.aborted ? 'fail' : 'ok';
          if (isVerbose) {
            const result = summarizeForCli(event.result);
            stderrLine(result ? `${mark(statusKind)} ${ui.bold(event.toolName)} ${status}${ui.dim(elapsed)} ${result}` : `${mark(statusKind)} ${ui.bold(event.toolName)} ${status}${ui.dim(elapsed)}`);
          } else {
            stderrLine(`${mark(statusKind)} ${ui.bold(progressToolLabel(event.toolName))} ${status}${ui.dim(elapsed)}`);
          }
        }
        break;
      case 'compaction':
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(`${mark()} context ${ui.dim(`compacted ${event.droppedMessages} messages into ${event.summaryChars} chars`)}`);
        }
        break;
      case 'working_context_checkpoint':
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(`${mark()} context ${event.status}: ${summarizeForCli(event.nextAction, 160)}`);
        }
        break;
      case 'microcompact':
        if (!isQuiet) {
          breakAnswerForStatus();
          stderrLine(`${mark()} context ${ui.dim(`compressed ${event.compressedCount} items, saved ~${event.savedTokens} tokens`)}`);
        }
        break;
      case 'turn_end':
        if (!isQuiet && (isVerbose || (event.totalToolCalls ?? 0) > 0)) {
          breakAnswerForStatus();
          const tools = event.totalToolCalls ? `, tools=${event.totalToolCalls}` : '';
          stderrLine(`${mark('ok')} turn ${event.turn} ${ui.dim(`finished: ${event.stopReason}${tools}`)}`);
        }
        break;
      case 'error':
        breakAnswerForStatus();
        stderrLine(`${mark('fail')} error ${event.retriable ? 'retryable ' : ''}${summarizeForCli(event.error, 400)}`);
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
