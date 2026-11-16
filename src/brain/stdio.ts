/**
 * 宿主大脑（零 key、零本地模型）。
 *
 * harness 把 DecideRequest 以一行 JSON 写到 stdout，然后从 stdin 读一行 Decision。
 * 谁在另一头都行：Qoder / Claude Code / Codex（M5 会包成 MCP），或者你自己手打。
 * 这就是"铲子不自带发动机，插上别人的发动机就能用"。
 *
 * 协议纪律：stdout 只走 JSON，人类日志一律 stderr。否则协议会被日志污染。
 * （MCP 的 stdio transport 也是这条规矩。）
 */
import { createInterface } from 'node:readline';
import { ErrCode, HarnessError } from '../errors.ts';
import { parseDecision } from '../parse.ts';
import type { Brain, Decision, DecideRequest } from '../types.ts';

export class StdioBrain implements Brain {
  readonly id = 'stdio:host';
  private readonly queue: string[] = [];
  private readonly waiters: ((line: string) => void)[] = [];
  private closed = false;
  private readonly timeoutMs: number;

  constructor(timeoutMs = 600_000) {
    this.timeoutMs = timeoutMs;
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      const w = this.waiters.shift();
      if (w) w(line);
      else this.queue.push(line);
    });
    rl.on('close', () => {
      this.closed = true;
      // 唤醒所有等待者，让它们拿到空串从而报错，而不是永久挂住
      while (this.waiters.length) this.waiters.shift()!('');
    });
  }

  private nextLine(): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve('');
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), this.timeoutMs);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  async decide(req: DecideRequest): Promise<Decision> {
    process.stdout.write(`${JSON.stringify({ type: 'decide', ...req })}\n`);
    const line = await this.nextLine();
    if (!line.trim()) {
      throw new HarnessError(
        ErrCode.BRAIN_PROTOCOL,
        this.closed ? '宿主输入已关闭（stdin EOF），无法继续决策' : `等待宿主决策超时（${this.timeoutMs}ms）`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch (e) {
      throw new HarnessError(ErrCode.BRAIN_PROTOCOL, `宿主返回的不是合法 JSON：${(e as Error).message}`, {
        line: line.slice(0, 240),
      });
    }
    // 允许宿主直接给 Decision，或包一层 {type:'decision', decision:{...}}
    const p = payload as Record<string, unknown>;
    const inner = p['decision'] ?? payload;
    if (typeof inner === 'string') return parseDecision(inner);
    return parseDecision(JSON.stringify(inner));
  }
}