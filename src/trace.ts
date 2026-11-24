/**
 * 无损证据日志。
 *
 * 铁律：证据由代码写，绝不交给模型总结。
 * 模型一压缩，seed / 初始状态 / 动作序列就可能失真，可复现性当场作废。
 * 所以这里逐条 append 原始 JSON，不做任何"摘要"。
 *
 * 产物：
 *   runs/<runId>/header.json   —— 重放三要素之二：seed + initialState
 *   runs/<runId>/trace.jsonl   —— 每步完整记录（想法/动作/结果/哈希/耗时）+ 事件行
 *
 * 事件行（{kind, at, payload}）与步记录（{index, ...}）混在同一个文件里，按时间顺序 append。
 * 为什么事件也要无损落盘：故障 #8/#11 的教训——「代码算了」不等于「能从证据里证明它送达了」。
 * 预测对照原文、假设板原文、被拒的写入、传输层重试，都必须留下原文，
 * 事后审计才有确定的判据，而不是靠"模型引用了它"去反推。
 *   runs/<runId>/result.json   —— 停止原因 + 完整动作序列（重放三要素之三）
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RunHeader, RunResult, StepRecord, ToolCall } from './types.ts';

export class TraceWriter {
  readonly runDir: string;
  private readonly tracePath: string;

  constructor(outDir: string, runId: string, opts: { append?: boolean } = {}) {
    this.runDir = join(outDir, runId);
    mkdirSync(this.runDir, { recursive: true });
    this.tracePath = join(this.runDir, 'trace.jsonl');
    if (!opts.append) writeFileSync(this.tracePath, '');
  }

  /**
   * 重开一份已存在的证据流。MCP 进程重启后靠显式 run id 恢复时，绝不能清空 trace；
   * 新事件必须 append 到旧证据后面，否则"可恢复"会把前半局证据抹掉。
   */
  static resume(runDir: string): TraceWriter {
    return new TraceWriter(dirname(runDir), basename(runDir), { append: true });
  }

  header(h: RunHeader): void {
    writeFileSync(join(this.runDir, 'header.json'), `${JSON.stringify(h, null, 2)}\n`);
  }

  step(s: StepRecord): void {
    appendFileSync(this.tracePath, `${JSON.stringify(s)}\n`);
  }

  /** 解析失败等"没走到工具"的事件也要留档，否则失败路径不可审计 */
  event(kind: string, payload: unknown): void {
    appendFileSync(this.tracePath, `${JSON.stringify({ kind, at: new Date().toISOString(), payload })}\n`);
  }

  result(r: RunResult): void {
    writeFileSync(join(this.runDir, 'result.json'), `${JSON.stringify(r, null, 2)}\n`);
  }
}

export function makeRunId(seed: number): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-s${seed}`;
}

/** 从步骤记录抽出纯动作序列——这就是可以脱离 harness 独立重放的那份证物 */
export function toActionSequence(steps: readonly StepRecord[]): ToolCall[] {
  return steps.map((s) => ({ name: s.decision.call.name, args: s.decision.call.args }));
}