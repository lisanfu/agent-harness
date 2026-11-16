/**
 * 差分公证器。
 *
 * 它只做一件事：参考版 vs 变异版 + **同一动作序列** → 第一个分叉点。
 *
 * 三个"不需要"，这是它比传统测试强的地方：
 *   - 不需要手写不变量（invariant）。没有 assert hp>=0 这类东西。
 *   - 不需要预知缺陷位置。变异体删了哪项能力，公证器完全不看。
 *   - 不需要模型宣布违规。裁判是代码，模型无权判定。
 *
 * 一个"必须"：
 *   - 必须先验确定性。参考版自己跑两遍若不一致，后面所有结论作废，直接报错。
 *     没有这一步，你会把"世界不确定"误当成"发现了缺陷"。
 */
import { ErrCode, HarnessError } from '../errors.ts';
import {
  createWorld, runSequence, step, worldHash,
  type Action, type Capabilities, type WorldState,
} from '../world/arena.ts';
import { ALL_CAPS } from '../world/arena.ts';

export interface FieldDiff { path: string; ref: unknown; mut: unknown }

export interface Divergence {
  /** 1-based：第几个动作之后分叉。0 表示初始状态就不同 */
  step: number;
  refHash: string;
  mutHash: string;
  /** 结构化字段差异，由代码算出，不是模型总结 */
  fields: FieldDiff[];
  refState: WorldState;
  mutState: WorldState;
}

export interface DiffResult {
  diverged: boolean;
  first: Divergence | null;
  /** 所有分叉帧。用来度量"掩蔽/再收敛"现象 */
  divergedSteps: number[];
  stepsRun: number;
  finalRefHash: string;
  finalMutHash: string;
  /** 中途分叉过但最终状态又相同 → 只比最终状态会漏检 */
  masked: boolean;
  /** 确定性前置检查是否通过 */
  determinismOk: boolean;
}

/** 结构化差异：递归比对，产出 player.hp / enemies[1].x 这样的路径。纯代码，无不变量。 */
export function diffFields(a: unknown, b: unknown, path = '', out: FieldDiff[] = []): FieldDiff[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diffFields(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort();
    for (const k of keys) diffFields(ao[k], bo[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  if (a !== b) out.push({ path: path || '(root)', ref: a, mut: b });
  return out;
}

/**
 * 确定性前置检查：同一 seed + 同一动作序列，参考版跑两遍必须逐帧一致。
 * 这是整个方法论的地基，必须先验。
 */
export function checkDeterminism(seed: number, actions: readonly Action[], caps: Capabilities = ALL_CAPS): boolean {
  const a = runSequence(seed, actions, caps);
  const b = runSequence(seed, actions, caps);
  if (a.hashes.length !== b.hashes.length) return false;
  for (let i = 0; i < a.hashes.length; i++) if (a.hashes[i] !== b.hashes[i]) return false;
  return true;
}

export interface DiffOptions {
  /** 是否在第一个分叉后继续跑到结尾（度量掩蔽现象需要）。默认 true */
  runToEnd?: boolean;
  /** 是否做确定性前置检查。默认 true。批量实验可关掉省时间，但正式报告必须开 */
  verifyDeterminism?: boolean;
  /**
   * 确定性探针，默认用 checkDeterminism。
   *
   * 为什么留这个注入点（和 rng 注入同一条纪律）：
   *  1. 不留接缝，"前置检查失败 → 抛 E_CONFIG"这条分支就永远执行不到。
   *     errors.ts 开头那一课（Python 里捕不到的 TimeoutError）说的就是这个：
   *     没跑过的错误分支等于没写。现在 test/notary.test.ts 真的把它跑了一遍。
   *  2. M2 接真实游戏世界时，确定性要验的是那个引擎，不是 arena，
   *     届时换探针即可，不必改公证器。
   */
  determinismProbe?: (seed: number, actions: readonly Action[]) => boolean;
}

export function runDifferential(
  seed: number,
  actions: readonly Action[],
  mutCaps: Capabilities,
  opts: DiffOptions = {},
): DiffResult {
  const runToEnd = opts.runToEnd ?? true;
  const verify = opts.verifyDeterminism ?? true;
  const probe = opts.determinismProbe ?? checkDeterminism;

  if (verify && !probe(seed, actions)) {
    throw new HarnessError(
      ErrCode.CONFIG,
      '确定性前置检查失败：参考版同种子同动作跑两遍结果不同。世界层可能偷读了时钟或用了 Math.random，差分结论不可信。',
      { seed, actions: actions.length },
    );
  }

  let ref = createWorld(seed);
  let mut = createWorld(seed);
  let refHash = worldHash(ref);
  let mutHash = worldHash(mut);

  const divergedSteps: number[] = [];
  let first: Divergence | null = null;

  // 初始状态就可能分叉（若变异影响世界生成）
  if (refHash !== mutHash) {
    divergedSteps.push(0);
    first = { step: 0, refHash, mutHash, fields: diffFields(ref, mut), refState: ref, mutState: mut };
  }

  for (let i = 0; i < actions.length; i++) {
    ref = step(ref, actions[i]!, ALL_CAPS, seed);
    mut = step(mut, actions[i]!, mutCaps, seed);
    refHash = worldHash(ref);
    mutHash = worldHash(mut);
    if (refHash !== mutHash) {
      divergedSteps.push(i + 1);
      if (!first) {
        first = { step: i + 1, refHash, mutHash, fields: diffFields(ref, mut), refState: ref, mutState: mut };
        if (!runToEnd) {
          return {
            diverged: true, first, divergedSteps, stepsRun: i + 1,
            finalRefHash: refHash, finalMutHash: mutHash, masked: false, determinismOk: true,
          };
        }
      }
    }
  }

  return {
    diverged: first !== null,
    first,
    divergedSteps,
    stepsRun: actions.length,
    finalRefHash: refHash,
    finalMutHash: mutHash,
    masked: first !== null && refHash === mutHash,
    determinismOk: true,
  };
}

/** 只比最终状态的"朴素做法"。用来对照：证明它会漏检。 */
export function finalStateOnly(seed: number, actions: readonly Action[], mutCaps: Capabilities): boolean {
  const r = runSequence(seed, actions, ALL_CAPS);
  const m = runSequence(seed, actions, mutCaps);
  return r.hashes[r.hashes.length - 1] !== m.hashes[m.hashes.length - 1];
}