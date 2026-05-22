/**
 * Smooth streaming text deltas for SSE — breaks large model chunks into
 * consistent small pieces to avoid jarring "bursts" in the UI.
 */
export class TextDeltaSmoother {
  private buf = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 已吐出字符数，用于首 N 字符快速旁路判定 */
  private emittedTotal = 0;

  constructor(
    private readonly emitDelta: (chunk: string) => void,
    private readonly tickMs: number,
    private readonly minPerTick: number,
    /** 首 N 个字符直通（感知"打字开始"加速），0 或负表示禁用快速旁路 */
    private readonly fastPathFirstN: number = 30,
  ) {}

  static create(
    emitDelta: (chunk: string) => void,
    opts?: { tickMs?: number; minPerTick?: number; fastPathFirstN?: number },
  ): TextDeltaSmoother {
    // 放宽上下限：studio 档希望 tick 更短 / chunk 更大。以前卡在 [8,22] / [1,3]，
    // 导致外部即使传 4/12 也被截成 8/3，速度拉不起来。
    const tickMs = Math.max(4, Math.min(30, opts?.tickMs ?? 10));
    const minPerTick = Math.max(1, Math.min(24, opts?.minPerTick ?? 1));
    // fastPath 从 30 字加到 120 字：相当于一个短句子直接"瞬时呈现"，
    // 再进 smoother。UI 感知到的"第一屏出现延迟"几乎归零。
    const fastPathFirstN = Math.max(0, opts?.fastPathFirstN ?? 120);
    return new TextDeltaSmoother(emitDelta, tickMs, minPerTick, fastPathFirstN);
  }

  push(rawDelta: string) {
    if (!rawDelta) return;

    // 快速旁路：首 N 字符立即 emit，降低首字延迟（不依赖 timer）
    if (this.emittedTotal < this.fastPathFirstN) {
      const remaining = this.fastPathFirstN - this.emittedTotal;
      if (rawDelta.length <= remaining) {
        this.emitDelta(rawDelta);
        this.emittedTotal += rawDelta.length;
        return;
      }
      // 切分：前半直通，后半进 smooth buffer
      const direct = rawDelta.slice(0, remaining);
      const rest = rawDelta.slice(remaining);
      this.emitDelta(direct);
      this.emittedTotal += direct.length;
      rawDelta = rest;
      if (!rawDelta) return;
    }

    const wasIdle = !this.timer && this.buf.length === 0;
    this.buf += rawDelta;
    if (wasIdle) {
      this.pump();
    }
    this.ensureTimer();
  }

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), this.tickMs);
  }

  private stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private pump() {
    if (this.buf.length === 0) {
      this.stopTimer();
      return;
    }
    const len = this.buf.length;
    // Adaptive drain rates — buffer 越大，一次吐越多。这一轮进一步激进化：
    // 大积压直接 24 字/tick（≈ 4,000 字/秒），让"模型已经说完但 UI 在慢吞吞 replay"
    // 的场景立即追平。小缓冲（≤ 28）仍按 caller 的 minPerTick，保留轻度打字节奏。
    const adaptive =
      len > 520 ? 24 : len > 220 ? 14 : len > 80 ? 8 : len > 28 ? 5 : this.minPerTick;
    const take = Math.min(len, adaptive);
    const chunk = this.buf.slice(0, take);
    this.buf = this.buf.slice(take);
    this.emitDelta(chunk);
    this.emittedTotal += chunk.length;
  }

  flushSync() {
    this.stopTimer();
    if (!this.buf) return;
    const rest = this.buf;
    this.buf = '';
    this.emitDelta(rest);
    this.emittedTotal += rest.length;
  }

  dispose() {
    this.flushSync();
  }
}
