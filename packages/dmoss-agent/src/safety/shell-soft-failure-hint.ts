/**
 * Shell soft failure hint — detects non-zero exit codes and stderr errors
 * in shell tool output, then appends orchestration hints to prevent the LLM
 * from prematurely ending the turn.
 */

const MARKER = '[编排提示 · 须继续]';

/** Tool names that participate in soft failure detection */
export const SHELL_SOFT_FAILURE_TOOL_NAMES = new Set(['exec', 'device_exec']);

export function shouldAppendShellContinueHint(result: string): boolean {
  if (!result || result.includes(MARKER)) return false;
  const exitNonZero = parseShellNonZeroExit(result);
  if (exitNonZero) return true;
  if (/\bNo such file or directory\b/i.test(result)) return true;
  if (/\[stderr\][\s\S]*\b(error|cannot|failed)\b/i.test(result)) return true;
  if (/\[STDERR\][\s\S]*\b(error|cannot|failed)\b/i.test(result)) return true;
  return false;
}

/** Remote SSH: `[exit code: n]`; Local exec: `[EXIT CODE] n` */
function parseShellNonZeroExit(result: string): boolean {
  const tail = result.trimEnd();
  const device = /\[exit code:\s*(\d+)\]\s*$/i.exec(tail);
  if (device) return Number(device[1]) !== 0;
  const local = /\[EXIT CODE\]\s*(\d+)/.exec(result);
  if (local) return Number(local[1]) !== 0;
  return false;
}

export function appendShellContinueHint(toolName: string, result: string): string {
  if (!shouldAppendShellContinueHint(result)) return result;
  const hint =
    toolName === 'device_exec'
      ? `\n\n${MARKER} 上条设备端命令**未成功**（非零退出或 stderr 报错）。你**必须**再调用工具：例如 \`ros2 pkg prefix <包名>\`、\`dpkg -L <包名>\`、\`device_file_list\` 查真实路径，或先 \`web_fetch\` 查阅对应官方文档/例程；直到定位资源或明确告知缺什么。**禁止**仅复述上述错误就结束回合。`
      : `\n\n${MARKER} 上条**本机**命令**未成功**（非零退出或 stderr 报错）。你**必须**再调用工具：核对 \`cwd\` 与工作区路径、依赖是否已装、命令是否适用于当前系统；可拆分步骤、\`read\`/\`list\` 相关文件、重试或换命令；直到有明确结论。**禁止**仅复述错误就结束回合。`;
  return result + hint;
}
