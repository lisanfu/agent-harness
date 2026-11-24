/**
 * CLI / 远端大脑的完整循环门面。
 *
 * 状态机已经拆进 engine.ts：CLI 在这里连续向 brain 要决策，MCP 则把同一个
 * DecideRequest 交给宿主模型。两条入口共用执行、记账、停止条件和证据，不能各写一份。
 */
import { classify, ErrCode } from './errors.ts';
import { HarnessEngine, type EngineOptions } from './engine.ts';
import { repairHint } from './parse.ts';
import type { Brain, Decision, RunResult } from './types.ts';

export interface RunOptions extends Omit<EngineOptions, 'brainId' | 'restored' | 'runId' | 'writer'> {
  brain: Brain;
}

export async function runHarness(opts: RunOptions): Promise<RunResult> {
  const { brain, registry, config } = opts;
  const log = opts.log ?? (() => {});
  const engine = new HarnessEngine({ ...opts, brainId: brain.id, log });

  // 传输层重试不是"没发生"。完整事实仍进 trace，耗时与步数分开统计。
  brain.onRetry = (info) => engine.noteBrainRetry(info);

  while (!engine.stopped) {
    let req = engine.prepare();
    if (!req) break;
    let decision: Decision | undefined;
    let brainMs = 0;
    let attempt = 0;
    for (;;) {
      const t0 = Date.now();
      try {
        decision = await brain.decide(req);
        brainMs += Date.now() - t0;
        break;
      } catch (e) {
        brainMs += Date.now() - t0;
        const he = classify(e);
        engine.noteBrainError(attempt, he.toInfo());
        log(`[brain] 第${req.step}步 第${attempt + 1}次失败 ${he.code}: ${he.message}`);
        // 内容形状错误归循环层修：解析失败 + 空回复。传输层重试看不到 history，
        // 原样重发同一份 payload 治不了"模型没说话"。一个类别一个主人。
        const repairable = he.code === ErrCode.BRAIN_PARSE || he.code === ErrCode.BRAIN_EMPTY;
        if (repairable && attempt < config.maxParseRetry) {
          attempt++;
          req = engine.addRepair(repairHint(he, registry.names()));
          continue;
        }
        engine.failBrain();
        break;
      }
    }
    if (!decision) break;
    await engine.execute(decision, brainMs);
  }
  return engine.finalize();
}
