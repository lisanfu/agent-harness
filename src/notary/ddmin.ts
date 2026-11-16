/**
 * 动作序列最小化（delta debugging / ddmin，Zeller 1999）。
 *
 * 为什么要它：找到分叉只说明"这 60 步里有问题"，没人愿意看 60 步。
 * 最小化把 60 步砍到 3 步仍能复现 → 这才是可提交的缺陷报告。
 *
 * 关键认知：分叉**不是单调的**。删掉某些动作可能让分叉消失
 * （比如删掉了"走到敌人旁边"那一步，接触伤害就永远不会触发）。
 * 所以不能简单二分，必须用 ddmin 的"子集 + 补集"双向试探。
 *
 * 局限（必须诚实报告）：ddmin 保证的是局部最小，不保证全局最小。
 * 而且它可能耗尽测试预算。这两点都要写进结果，不能假装拿到了最优解。
 */
import type { Action, Capabilities } from '../world/arena.ts';
import { runDifferential } from './diff.ts';

export interface MinimizeResult {
  minimized: Action[];
  originalLength: number;
  /** 实际调用谓词次数 */
  tests: number;
  /** 1-minimal：删掉任何一个动作都不再分叉 */
  oneMinimal: boolean;
  budgetExhausted: boolean;
  /** 空序列就分叉 → 缺陷在世界生成，不在动作序列 */
  emptyAlreadyDiverges: boolean;
}

export interface MinimizeOptions {
  maxTests?: number;
}

function split<T>(arr: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  const size = Math.ceil(arr.length / n);
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function minimize(
  seed: number,
  actions: readonly Action[],
  mutCaps: Capabilities,
  opts: MinimizeOptions = {},
): MinimizeResult {
  const maxTests = opts.maxTests ?? 400;
  let tests = 0;
  let budgetExhausted = false;

  // 谓词：这条子序列是否仍然分叉。关掉逐次确定性检查（顶层已验过），省时间。
  const fails = (seq: readonly Action[]): boolean => {
    if (tests >= maxTests) { budgetExhausted = true; return false; }
    tests++;
    return runDifferential(seed, seq, mutCaps, { runToEnd: false, verifyDeterminism: false }).diverged;
  };

  const emptyAlreadyDiverges = fails([]);
  if (emptyAlreadyDiverges) {
    return { minimized: [], originalLength: actions.length, tests, oneMinimal: true, budgetExhausted, emptyAlreadyDiverges };
  }

  let c: Action[] = [...actions];
  let n = 2;

  while (!budgetExhausted) {
    if (c.length <= 1) break;
    const subsets = split(c, n);
    let reduced = false;

    // 1) 试子集：某一段单独就能复现 → 直接缩到那一段
    for (const sub of subsets) {
      if (sub.length === 0 || sub.length === c.length) continue;
      if (fails(sub)) { c = sub; n = 2; reduced = true; break; }
    }
    if (reduced) continue;

    // 2) 试补集：去掉某一段仍能复现 → 删掉那一段
    if (!reduced) {
      for (let i = 0; i < subsets.length; i++) {
        const comp = subsets.filter((_, j) => j !== i).flat();
        if (comp.length === 0 || comp.length === c.length) continue;
        if (fails(comp)) { c = comp; n = Math.max(n - 1, 2); reduced = true; break; }
      }
    }
    if (reduced) continue;

    // 3) 都不行 → 加大粒度再试
    if (n < c.length) { n = Math.min(c.length, n * 2); continue; }
    break;
  }

  // 1-minimality 验证：删任何单个动作都不该再分叉
  let oneMinimal = true;
  if (!budgetExhausted && c.length > 0) {
    for (let i = 0; i < c.length; i++) {
      const without = c.filter((_, j) => j !== i);
      if (fails(without)) { oneMinimal = false; break; }
    }
  } else if (budgetExhausted) {
    oneMinimal = false;
  }

  return { minimized: c, originalLength: actions.length, tests, oneMinimal, budgetExhausted, emptyAlreadyDiverges };
}