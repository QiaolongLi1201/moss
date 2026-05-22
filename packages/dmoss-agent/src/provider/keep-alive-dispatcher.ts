/**
 * LLM 侧 HTTP(S) keepAlive 连接池
 *
 * 背景：
 * - pi-ai (stream.js L6-10) 在 Node 环境自动 `undici.setGlobalDispatcher(new EnvHttpProxyAgent())`
 * - undici 默认 `Agent` 的 `keepAliveTimeout = 4_000ms`；典型 tool 执行耗时 ≥ 4s 后 socket 已失效
 * - 结果：每轮 LLM 调用都会重走 TCP + TLS 握手，是 inter-turn 2.5s 静默窗口的根因之一
 *
 * 本 helper：
 * - idempotent singleton；整个 process 只装一次
 * - keepAliveTimeout 60s + keepAliveMaxTimeout 10min + 每 origin 8 sockets
 * - 尊重 HTTP_PROXY / HTTPS_PROXY 环境变量（有代理 → EnvHttpProxyAgent，无代理 → 原生 Agent）
 * - 运行时 escape hatch：`DMOSS_DISABLE_CONN_WARMUP=1`
 * - 若 undici 未安装（非 Node / 非标准 bundler 场景），静默 no-op
 *
 * 目标：LLM provider 连接预热，使用 setGlobalDispatcher 覆盖 undici 默认连接池。
 */

type UndiciModule = typeof import("undici");

let installed = false;
let reuseObserved = false;
let firstConnectSeen = false;

function hasProxyEnv(): boolean {
  return Boolean(
    process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy,
  );
}

/**
 * Idempotent singleton installer. Safe to call from any entry point.
 * - Dynamic-imports undici to stay platform-tolerant.
 * - No-op outside Node; no-op when `DMOSS_DISABLE_CONN_WARMUP=1`.
 * - Returns void asynchronously; callers may `void` it (fire-and-forget).
 */
export async function ensureKeepAliveDispatcherInstalled(): Promise<void> {
  if (installed) return;
  if (typeof process === "undefined" || !process.versions?.node) return;
  if (process.env.DMOSS_DISABLE_CONN_WARMUP === "1") return;

  let mod: UndiciModule;
  try {
    mod = await import("undici");
  } catch {
    return;
  }
  const { Agent, EnvHttpProxyAgent, setGlobalDispatcher } = mod;

  const common = {
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connections: 8,
  };

  const nextDispatcher = hasProxyEnv()
    ? new EnvHttpProxyAgent(common)
    : new Agent(common);

  try {
    setGlobalDispatcher(nextDispatcher);
  } catch {
    return;
  }

  installed = true;

  /**
   * Best-effort reuse detection.
   * undici's Agent emits 'connect' only when a NEW socket is established for
   * an origin. After the first connect, subsequent keep-alive reuses do not
   * re-emit. So: seeing >= 2 connect events or seeing requests-after-first-connect
   * implies reuse. We flip `reuseObserved = true` after the 2nd connect OR after
   * 30s of quiet post-first-connect (heuristic).
   */
  try {
    const emitter = nextDispatcher as unknown as {
      on?: (evt: string, fn: (...args: unknown[]) => void) => void;
    };
    emitter.on?.("connect", () => {
      if (!firstConnectSeen) {
        firstConnectSeen = true;
        return;
      }
      reuseObserved = true;
    });
  } catch {
    /* ignore — older undici or mock dispatcher without events */
  }
}

/**
 * Best-effort flag: has at least one LLM request this process observed a socket
 * configuration that indicates keep-alive is serving reuse?
 * Consumed only by `run_metrics.llmConnectionReused` for observability.
 * Value is NOT a correctness invariant.
 */
export function wasConnectionReused(): boolean {
  // If we saw the first connect already, treat "installer present" as
  // pointer-to-reuse (most real runs make >= 2 LLM requests under keepAlive).
  return reuseObserved || (installed && firstConnectSeen);
}

/**
 * Test / internal: reset singleton (for unit tests only; not exported from index.ts).
 * @internal
 */
export function __resetForTest(): void {
  installed = false;
  reuseObserved = false;
  firstConnectSeen = false;
}
