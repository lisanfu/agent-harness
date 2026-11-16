/**
 * 错误分类。这一课是拿真实 bug 换来的：
 * 捕获 Python 内建 TimeoutError 永远捕不到 httpx 的超时——分支写了但从没执行过。
 * 所以这里每个分类都必须有对应测试真的跑过（见 test/errors.test.ts）。
 */
import type { ErrorInfo } from './types.ts';

export const ErrCode = {
  CONFIG: 'E_CONFIG',
  BRAIN_TIMEOUT: 'E_BRAIN_TIMEOUT',
  BRAIN_CONNECTION: 'E_BRAIN_CONNECTION',
  BRAIN_HTTP: 'E_BRAIN_HTTP',
  /**
   * 限流单独一个码，不混在 E_BRAIN_HTTP 里。
   * 真实故障换来的：免费额度 HTTP 429 被当成致命错误，整局在第 11 步被掐断。
   * 429 和 400 是两类东西——400 是"你话说错了"（重说一万遍也错），
   * 429 是"你说得对，但现在轮不到你"（等一会儿就好）。分类错了，重试策略就全错。
   */
  BRAIN_RATE_LIMIT: 'E_BRAIN_RATE_LIMIT',
  BRAIN_EMPTY: 'E_BRAIN_EMPTY',
  BRAIN_PARSE: 'E_BRAIN_PARSE',
  BRAIN_PROTOCOL: 'E_BRAIN_PROTOCOL',
  TOOL_UNKNOWN: 'E_TOOL_UNKNOWN',
  TOOL_ARGS: 'E_TOOL_ARGS',
  TOOL_DENIED: 'E_TOOL_DENIED',
  TOOL_RUNTIME: 'E_TOOL_RUNTIME',
  SANDBOX: 'E_SANDBOX',
} as const;

export type ErrCodeValue = (typeof ErrCode)[keyof typeof ErrCode];

export interface ErrorOptions {
  /**
   * 这个错误值不值得原地重试。
   * 刻意让错误自己携带这个事实，而不是让上层拿状态码去猜：
   * 上层一旦开始 `if (status === 429 || status >= 500)`，分类知识就散落到每个调用点，
   * 换个供应商（有的把限流写成 503）就要改一圈。事实归产生它的地方。
   */
  retryable?: boolean;
  /** 服务端 Retry-After 换算出的毫秒数。有就听它的，别自作聪明提前撞墙。 */
  retryAfterMs?: number;
}

export class HarnessError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(code: string, message: string, detail?: unknown, opts?: ErrorOptions) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.detail = detail;
    this.retryable = opts?.retryable ?? false;
    this.retryAfterMs = opts?.retryAfterMs;
  }
  toInfo(): ErrorInfo {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

/** 只有 HarnessError 才谈得上可重试；未知异常一律不重试（重试一个编程错误只会重复崩溃）。 */
export function isRetryable(e: unknown): boolean {
  return e instanceof HarnessError && e.retryable;
}

/**
 * Retry-After 有两种合法写法：延迟秒数（"120"）和 HTTP 日期（"Wed, 21 Oct 2015 07:28:00 GMT"）。
 * 只认前一种是常见半成品：碰到日期就 NaN，然后 backoff 算出 NaN，setTimeout(NaN) 立刻触发，
 * 于是"退避重试"退化成"贴着限流墙连撞"。所以两种都认，认不出就返回 undefined 走自己的退避。
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * HTTP 失败 → 分类。这里就是 429 那一课的落点。
 *
 * 分三类：
 *   429        限流，可重试，听 Retry-After
 *   5xx        服务端自己出问题，可重试（502/503/504 常是网关抖动）
 *   其余 4xx   请求本身错了（400 协议半套 / 401 key 不对 / 404 地址不对），重试无意义
 *
 * 408 是个例外：请求超时，语义上可重试，归到可重试一类。
 */
export function httpFailure(status: number, body: string, retryAfterMs?: number): HarnessError {
  const reason = body.replace(/\s+/g, ' ').slice(0, 220);
  const rateLimited = status === 429;
  const retryable = rateLimited || status === 408 || status >= 500;
  const code = rateLimited ? ErrCode.BRAIN_RATE_LIMIT : ErrCode.BRAIN_HTTP;
  const hint = rateLimited
    ? '（限流：可重试。若反复出现，多半是账号额度而非瞬时抖动，等额度恢复或换额度，别靠加长重试硬扛）'
    : retryable
      ? '（服务端错误：可重试）'
      : '（请求本身有问题：重试无用，请检查协议字段 / key / 地址）';
  return new HarnessError(
    code,
    `大脑返回 HTTP ${status}${reason ? `：${reason}` : ''}${hint}`,
    { status, body: body.slice(0, 1200), retryable },
    { retryable, retryAfterMs },
  );
}

/**
 * 把任意异常归一到 HarnessError。
 * 关键是认得真实的错误形状，而不是认得"名字看起来像"的错误：
 *  - AbortSignal.timeout 触发的是 DOMException，name === 'TimeoutError'
 *  - fetch 连不上是 TypeError('fetch failed')，真因在 .cause 里（ECONNREFUSED 等）
 *  - HTTP 4xx/5xx 根本不是异常，是 response.ok === false，必须单独判
 */
export function classify(e: unknown, fallbackCode: string = ErrCode.BRAIN_CONNECTION): HarnessError {
  if (e instanceof HarnessError) return e;

  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      // 超时同样可重试：它说的是"这次没赶上"，不是"这句话不该说"。
      return new HarnessError(ErrCode.BRAIN_TIMEOUT, `大脑响应超时：${e.message}`, { name: e.name }, { retryable: true });
    }
    const cause = (e as { cause?: unknown }).cause;
    const causeCode =
      cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code?: unknown }).code)
        : undefined;
    if (e.message.includes('fetch failed') || causeCode) {
      return new HarnessError(
        ErrCode.BRAIN_CONNECTION,
        `无法连接大脑服务：${causeCode ?? e.message}`,
        { causeCode, message: e.message },
        { retryable: true },
      );
    }
    return new HarnessError(fallbackCode, e.message, { name: e.name });
  }
  return new HarnessError(fallbackCode, String(e));
}

/** 给大脑看的拒绝理由必须可读、可行动。这是 ACI 设计的核心一课。 */
export function readable(code: string, message: string, hint?: string): ToolResultLike {
  return { ok: false, output: hint ? `${message} ${hint}` : message, error: { code, message } };
}

interface ToolResultLike {
  ok: boolean;
  output: string;
  error: ErrorInfo;
}