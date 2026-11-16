/**
 * 远端大脑：任意 OpenAI 兼容 /chat/completions 端点。
 * 不使用任何本地模型。给 key 即用，换供应商只改环境变量。
 *
 * 刻意不依赖 function-calling：把工具契约写进 system、要求返回 JSON。
 * 理由是兼容性——不是所有兼容端点都支持 tools 字段，但都支持聊天。
 *
 * 地址纪律：baseUrl 只来自调用方（CLI 从 .env 读用户给的真实地址）。
 * 本文件不内置任何默认地址、不做任何代理替换——换地址是配置的事，不是代码偷偷做的事。
 */
import { ErrCode, HarnessError, classify, httpFailure, parseRetryAfter } from '../errors.ts';
import { parseDecision } from '../parse.ts';
import type { Brain, BrainRetryInfo, Decision, DecideRequest, Message } from '../types.ts';
import { goalsBlock, notesBlock } from './prompt.ts';

export interface OpenAIBrainOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature?: number;
  /** 可重试错误最多原地重试几次。默认 3。 */
  maxRetries?: number;
  /** 退避基数（毫秒），指数增长。默认 1000。 */
  backoffMs?: number;
  /**
   * 单次等待上限（毫秒）。默认 15000。
   * 服务端 Retry-After 超过这个上限时**不再等**，直接失败并把话说清楚：
   * 免费额度的限流常常是"今天没了"，睡 60 秒也救不回来，
   * 挂着不动只会把 maxWallMs 预算烧光，还让人以为程序卡死。
   */
  maxBackoffMs?: number;
  /**
   * 睡眠注入点。和 rng 注入、determinismProbe 注入同一条纪律：
   * 不留接缝，测试就只能真等 1+2+4 秒，或者干脆不测重试分支——
   * 而"没跑过的分支等于没写"正是本工程开头那一课。
   */
  sleep?: (ms: number) => Promise<void>;
  /** 抖动随机源注入点。世界层禁用 Math.random，但传输层不是世界，抖动只影响等待时长。 */
  random?: () => number;
}

/**
 * 内部消息 → 线上格式。
 *
 * 关键一课（真实 400 换来的）：`role:'tool'` 是 **function-calling 协议的一部分**，
 * 必须配 `tool_call_id`，且前一条 assistant 必须带 `tool_calls`。
 * 我们刻意不用 function-calling（兼容性优先），那就**不能只发半套协议**——
 * 只发 role:'tool' 而不发 tool_call_id，端点直接 400：
 *   messages[3]: missing field `tool_call_id`
 *
 * 所以工具结果在线上一律降级成 user 消息，并显式标注它来自哪个工具。
 * 内部契约（Message.role='tool'）保持不变：trace 与上下文仍需要区分"谁说的"。
 * 这就是适配器的职责——内部语义 ≠ 线上格式。
 */
export function toWireMessages(messages: readonly Message[]): { role: string; content: string }[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'user', content: `[工具返回${m.toolName ? ` ${m.toolName}` : ''}]\n${m.content}` };
    }
    return { role: m.role, content: m.content };
  });
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class OpenAIBrain implements Brain {
  readonly id: string;
  /** 见 types.ts Brain.onRetry：出声口在实例上，不进 DecideRequest（会被 stdio 的 JSON 静默丢掉）。 */
  onRetry?: (info: BrainRetryInfo) => void;
  private readonly opt: OpenAIBrainOptions;

  constructor(opt: OpenAIBrainOptions) {
    if (!opt.baseUrl) throw new HarnessError(ErrCode.CONFIG, '缺少 BRAIN_BASE_URL');
    if (!opt.model) throw new HarnessError(ErrCode.CONFIG, '缺少 BRAIN_MODEL');
    this.opt = opt;
    this.id = `openai:${opt.model}`;
  }

  async decide(req: DecideRequest): Promise<Decision> {
    // req.system 已由循环层装配好（含工具契约）。这里只负责搬运，不再二次拼装，
    // 否则 stdio 宿主和远端模型会看到两份不同的契约。
    const messages: Message[] = [{ role: 'system', content: req.system }];
    const nb = notesBlock(req.notes, req.hypotheses);
    if (nb) messages.push({ role: 'system', content: nb });
    // 目标板走同一个纯函数渲染（不是"再拼一遍"）：循环层落盘的那份原文与这里上线的
    // 必须逐字相同，"送达"才是可证的（故障 #11）。没立目标时整块不出现。
    const gb = goalsBlock(req.goals ?? []);
    if (gb) messages.push({ role: 'system', content: gb });
    // 过滤掉上下文里的 system：它要么是同一份契约（重复），要么是截断标记（单独提前补上）
    const truncation = req.messages.find((m) => m.role === 'system' && m.content.startsWith('[上下文已截断'));
    if (truncation) messages.push(truncation);
    messages.push(...req.messages.filter((m) => m.role !== 'system'));

    const url = `${this.opt.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    // ⚠️ payload 在重试循环**外面**装配一次。
    // 重试的定义是"同一句话再说一遍"，不是"换句话再说"。
    // 若每次重试重新装配，证据里"第 11 步"到底对应哪次请求就说不清了。
    const payload = JSON.stringify({
      model: this.opt.model,
      temperature: this.opt.temperature ?? 0.7,
      messages: toWireMessages(messages),
    });

    const maxRetries = this.opt.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(url, payload);
      } catch (e) {
        const he = classify(e);
        // 不可重试（400 协议错 / 401 key 错 / 解析错）立刻上抛，一次都不多撞。
        // 解析错不在这里回炉：那是循环层的事，它要往 history 里塞修复提示，
        // 传输层没有那个上下文。一个失败类别只有一个重试主人，别两层都重试。
        if (!he.retryable) throw he;
        if (attempt >= maxRetries) {
          throw new HarnessError(
            he.code,
            `${he.message}（已原地重试 ${attempt} 次仍失败，放弃。这不是程序卡死，是服务端持续拒绝）`,
            { ...(typeof he.detail === 'object' && he.detail !== null ? he.detail : {}), attempts: attempt + 1 },
            { retryable: false, retryAfterMs: he.retryAfterMs },
          );
        }
        const waitMs = this.backoffFor(attempt, he);
        this.onRetry?.({ attempt: attempt + 1, maxRetries, waitMs, error: he.toInfo() });
        await (this.opt.sleep ?? defaultSleep)(waitMs);
      }
    }
  }

  /**
   * 退避时长 = max(指数退避 + 抖动, 服务端 Retry-After)，再夹到上限。
   *
   * 为什么要抖动：将来多个 agent 同时跑（眼睛/手/记录/指挥），
   * 齐步走的退避会在同一毫秒一起再撞墙，限流永远解不开。抖开它们。
   */
  private backoffFor(attempt: number, he: HarnessError): number {
    const base = this.opt.backoffMs ?? 1000;
    const cap = this.opt.maxBackoffMs ?? 15_000;
    const exp = Math.min(cap, base * 2 ** attempt);
    const jitter = exp * 0.25 * (this.opt.random ?? Math.random)();
    const server = he.retryAfterMs ?? 0;
    return Math.min(cap, Math.max(Math.round(exp + jitter), server));
  }

  /** 一次真实 HTTP 往返。重试逻辑不在这里，这里只管"说一句话、听一句回话"。 */
  private async once(url: string, payload: string): Promise<Decision> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opt.apiKey}`,
        },
        body: payload,
        signal: AbortSignal.timeout(this.opt.timeoutMs),
      });
    } catch (e) {
      // 真实错误形状：DOMException(TimeoutError) / TypeError('fetch failed', {cause:{code:'ECONNREFUSED'}})
      throw classify(e);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 分类交给 httpFailure：429/5xx 可重试，其余 4xx 不可。
      // 理由必须直接出现在 message 里，不能只藏在 detail——ACI 对人类同样适用。
      throw httpFailure(res.status, body, parseRetryAfter(res.headers.get('retry-after')));
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new HarnessError(ErrCode.BRAIN_EMPTY, '大脑返回空内容', { data });
    }
    return parseDecision(content);
  }
}