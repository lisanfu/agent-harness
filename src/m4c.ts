#!/usr/bin/env node
/**
 * M4-c 双通道上限表：把差分公证器的分叉面从"屏幕"扩到"屏幕 + 声音"。
 *
 * 这一臂回答的问题只有一个，而且它和智能无关：
 *   **同一动作序列下，缺陷在屏幕上露过脸吗？在声流里露过脸吗？**
 *   两个布尔交叉出四格：两者都可见 / 仅眼可见 / **仅耳可见** / 两者都不可见。
 *
 * 为什么要单独量这一张表：M4-f 的上限表用屏幕当唯一分叉面，得到 `invisible=0`
 * （内部一旦分叉，屏幕必然逐字符不同）。那条结论的适用边界是**世界层缺陷**——
 * `step()` 里的能力被删。真实引擎里"算"和"播"是两条代码路径，音频层的 bug
 * 一个字节都不改状态：屏幕照常变化，声音缺了一记。只看屏幕的测试工具对这一族**结构性失明**。
 * 本表把"失明"变成可数的数字，同时用 M01–M09 走同一张表当**反向对照**：
 * 若表格只会输出"仅耳可见"，那是判据自己造的桶，不是世界的性质。
 *
 * 三条纪律（前几轮换来的）：
 *  1. **眼睛那一侧不许另写一套比对**：屏幕分叉一律走 M4-f 冻结的 `playSequence` + `diffScreens`，
 *     否则"屏幕分叉=0"是两段不同代码各说各话的结果（台账 #18：交叉核对的两侧必须是同一个量的两种算法）。
 *  2. 参考版 vs 参考版（R0）必须整表零分叉。这一格不是装饰：它把"仪器漏气"和"缺陷不可见"分开。
 *  3. 本文件只产**原始表**（逐案例 jsonl）与聚合，不做任何"所以模型行不行"的判断；
 *     判决与独立复核在 `verify/ear-audit.ts`，它自己重写一遍比对。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ALL_CAPS, DX, DY, randomActions, runSequence, type Action, type Capabilities, type DirValue, type WorldState,
} from './world/arena.ts';
import { diffScreens, playSequence } from './world/detect.ts';
import { ALL_SOUND, REFERENCE_SOUND, SOUND_MUTANTS, findMutant, findSoundMutant, type SoundMutant } from './world/mutants.ts';
import { ALL_SOUND_CAPS, REFERENCE_RIG, soundStream, type SoundEvent, type SoundRig } from './world/sound.ts';

const ROOT = resolve(import.meta.dirname, '..');
const log = (l: string): void => void process.stderr.write(`${l}\n`);

/** 一条通道的一次观测：谁的世界 + 谁的发声装置。 */
export interface ArmSpec { caps?: Capabilities; rig?: SoundRig }

export type Cell = '两者都可见' | '仅眼可见' | '仅耳可见' | '两者都不可见';

export interface ChannelCase {
  seed: number;
  steps: number;
  caseIndex: number;
  /** 发声侧变异体 id（R0 = 参考版发声） */
  sound: string;
  /** 世界层变异体 id（null = 参考版世界） */
  world: string | null;
  eye: { diverged: boolean; first: number | null; frames: number };
  ear: { diverged: boolean; first: number | null; frames: number };
  /** 参考版这一局一共响了几声。0 声 = 这个触发形状根本没达成，不可见是**前提问题**不是通道问题 */
  refSoundEvents: number;
  mutSoundEvents: number;
  /**
   * **这一记在世界那边到底该不该响**——从状态转移独立算出来的谓词，见 `cueFired`。
   * null = 这一格没有"该不该响"的问题（R0 阴性对照、世界层反向对照）。
   *
   * 为什么必须有这一列（§10.12：每个率都要说分母）：
   *   S06（拾取咔哒）在 160 条随机轨迹里只有 11 条落进"仅耳可见"。把它读成
   *   "耳朵通道只看得见 6.9% 的这类缺陷"是**错的**——剩下 149 条里玩家根本没拾取过东西。
   *   有了这一列，"前提达成率"和"达成前提时的耳分叉率"才分得开，两个数各自都有分母。
   */
  cueFired: boolean | null;
  cell: Cell;
  /** 首个人可读样本（人工复核用，最多两条） */
  sample: string[];
}

/** 声流按帧分组。声音是序列：同一帧内两句换了次序也算不同。 */
export function groupByTick(events: readonly SoundEvent[]): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const e of events) {
    const list = m.get(e.tick) ?? [];
    list.push(e.text);
    m.set(e.tick, list);
  }
  return m;
}

export interface SoundDivergence {
  diverged: boolean;
  /** 首个不同的**帧号**（不是下标）——错位的量只有靠帧号才量得出来 */
  first: number | null;
  /** 有多少帧的发声不同 */
  frames: number;
}

/**
 * 耳朵那一侧的分叉。
 *
 * 刻意与 `diffScreens` 同形（diverged / first / frames），但比的是**帧号 + 该帧的句子序列**：
 *  S10（整条晚一帧）在"只比内容不比时刻"的口径下零分叉，在"只数每帧几句"的口径下也零分叉——
 *  所以这个口径必须两样都比，这条本身就是测试里的一条断言。
 */
export function diffSounds(ref: readonly SoundEvent[], mut: readonly SoundEvent[]): SoundDivergence {
  const a = groupByTick(ref);
  const b = groupByTick(mut);
  const ticks = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y);
  let first: number | null = null;
  let frames = 0;
  for (const t of ticks) {
    const x = a.get(t) ?? [];
    const y = b.get(t) ?? [];
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      frames++;
      if (first === null) first = t;
    }
  }
  return { diverged: frames > 0, first, frames };
}

/**
 * 这一记在**世界那边**到底该不该响。
 *
 * 刻意**不 import 发声层**：这是判据侧的第二份算法，输入只有状态转移与动作。
 * 两边算法不同、结论却必须逐格一致（`twoChannelCase` 里对账，`main` 里整表核）——
 * 若两边都算出"没响"那是真没触发，若两边算出不同的东西就是有一边在撒谎（台账 #18：
 * 交叉核对的两侧必须是**同一个量的两种算法**，不是同一份代码跑两遍）。
 *
 * 与发声层同一条口径：死了以后玩家侧一律无声；按**画面上看得见的变化**分支，
 * 不按内部结算分支（所以"拾取回血"不构成这里的前提，"少了一个活敌人"才构成）。
 */
export type Cue = SoundMutant['cue'];

function aliveCount(s: WorldState): number {
  return s.enemies.filter((e) => e.alive).length;
}
function takenCount(s: WorldState): number {
  return s.pickups.filter((p) => p.taken).length;
}

/** 单帧：这一记该不该响。`cue` 是"要测哪个触发形状"，与变异体一一对应。 */
export function cueFiresThisFrame(cue: Cue, prev: WorldState, action: Action | null, next: WorldState): boolean {
  if (!prev.player.alive) return false; // 倒下之后玩家侧没有任何声音可丢
  const isMove = action?.kind === 'move';
  const movedPlayer = prev.player.x !== next.player.x || prev.player.y !== next.player.y;
  const targetOut = isMove
    && (next.player.x !== prev.player.x + DX[(action as { dir: DirValue }).dir]!
      || next.player.y !== prev.player.y + DY[(action as { dir: DirValue }).dir]!);
  const swung = action?.kind === 'attack' && prev.player.cooldown === 0;
  switch (cue) {
    case 'footstep': return isMove && movedPlayer;
    case 'wallBump': return isMove && !movedPlayer && targetOut;
    case 'swing': return swung;
    case 'killThud': return swung && aliveCount(prev) - aliveCount(next) > 0;
    case 'hurtGrunt': return next.player.hp < prev.player.hp;
    case 'pickupClick': return takenCount(next) > takenCount(prev);
    case 'deathThud': return next.player.alive === false;
    case 'enemyFootstep': return prev.enemies.some((e0) => {
      if (!e0.alive) return false;
      const e1 = next.enemies.find((e) => e.id === e0.id);
      return e1 !== undefined && e1.alive && (e1.x !== e0.x || e1.y !== e0.y);
    });
    // 误报型的前提宽得多：**正常移动**就该多出一记（这正是它和 wallBump 的区别）
    case 'misfire_bump_on_move': return isMove && movedPlayer;
    // 错位型不删内容，只是把已有的一记挪个帧号：前提是"这一帧本来就有声音"
    case 'shift_one_tick': return ANY_CUES.some((c) => cueFiresThisFrame(c, prev, action, next));
    case 'reference': return false;
  }
}

export const ANY_CUES: readonly Cue[] = [
  'footstep', 'wallBump', 'swing', 'killThud', 'hurtGrunt', 'pickupClick', 'deathThud', 'enemyFootstep',
] as const;

/** 整局：这一记有没有**至少响过一次**（= 这一格的前提达成）。 */
export function cueFired(cue: Cue, states: readonly WorldState[], actions: readonly (Action | null)[]): boolean {
  if (cue === 'reference') return false;
  if (states.length !== actions.length) throw new Error(`cueFired：状态数(${states.length}) 与动作数(${actions.length}) 不等`);
  for (let i = 1; i < states.length; i++) {
    if (cueFiresThisFrame(cue, states[i - 1]!, actions[i]!, states[i]!)) return true;
  }
  return false;
}

/** 跑一个案例：同一条动作序列，两个"版本"各跑一遍，两条通道分别比。 */
export async function twoChannelCase(
  seed: number, actions: readonly Action[], caseIndex: number,
  ref: ArmSpec = {}, mut: ArmSpec = {},
  opts: { sound?: string; world?: string | null } = {},
): Promise<ChannelCase> {
  const refCaps = ref.caps ?? ALL_CAPS;
  const mutCaps = mut.caps ?? ALL_CAPS;
  const refRig = ref.rig ?? REFERENCE_RIG;
  const mutRig = mut.rig ?? REFERENCE_RIG;

  // 眼睛：走 M4-f 冻结的那份重放与比对，不在此处重写
  const [refObs, mutObs] = [await playSequence(seed, refCaps, actions), await playSequence(seed, mutCaps, actions)];
  const eye = diffScreens(refObs, mutObs);

  // 耳朵：世界状态由 arena 的纯重放给出（与 GameSession 同一套 step，无副作用）
  const acts: (Action | null)[] = [null, ...actions];
  const refStates = statesOf(seed, refCaps, actions);
  const mutStates = statesOf(seed, mutCaps, actions);
  const refSound = soundStream(refStates, acts, refRig);
  const mutSound = soundStream(mutStates, acts, mutRig);
  const ear = diffSounds(refSound, mutSound);

  // 前提（世界侧独立算，见 cueFired）。R0 与世界层案例没有"该不该响"的问题 → null。
  // 只在**两侧世界相同**时才有意义：那时声流差异只可能来自发声装置，两个量才可比。
  const cue: Cue | null = opts.sound && opts.sound !== 'REF' ? findSoundMutant(opts.sound).cue : null;
  const sameWorld = JSON.stringify(refCaps) === JSON.stringify(mutCaps);
  const premise = cue === null || cue === 'reference' || !sameWorld ? null : cueFired(cue, refStates, acts);
  if (premise !== null && premise !== ear.diverged) {
    // 这条不是装饰：它意味着"世界说这记该响，耳朵却说两版一样"或反之——
    // 上限表的全部意义就是这两个量的比对，任一边单独说话都不算数。
    throw new Error(`前提对账失败：seed=${seed} ${opts.sound} cue=${cue} 世界侧=${premise} 耳朵侧=${ear.diverged}`);
  }

  // 参考版 vs 缺陷版的**屏幕**首分叉帧——字段名从 diffScreens 的 firstStep 搬过来，
  // 这里曾把 `eye.first`（不存在的字段）抄进案例，得到恒为 undefined 的 first（#8/#13 家族：写了、跑了、不起作用）。
  // test/m4c.test.ts 最后一条逐字段对账把它钉住了。
  const eyeDiff = { diverged: eye.diverged, first: eye.firstStep, frames: eye.frames };

  const cell: Cell = eyeDiff.diverged
    ? (ear.diverged ? '两者都可见' : '仅眼可见')
    : (ear.diverged ? '仅耳可见' : '两者都不可见');

  const sample: string[] = [];
  if (ear.diverged && ear.first !== null) {
    const g1 = groupByTick(refSound).get(ear.first) ?? [];
    const g2 = groupByTick(mutSound).get(ear.first) ?? [];
    sample.push(`第 ${ear.first} 帧 参考版发声：${g1.join(' ') || '（无）'}`);
    sample.push(`第 ${ear.first} 帧 缺陷版发声：${g2.join(' ') || '（无）'}`);
  }
  if (eyeDiff.diverged && eyeDiff.first !== null && sample.length === 0) {
    sample.push(`屏幕在第 ${eyeDiff.first} 帧分叉（耳朵侧无差异）`);
  }

  return {
    seed,
    steps: actions.length,
    caseIndex,
    sound: opts.sound ?? 'REF',
    world: opts.world ?? null,
    eye: eyeDiff,
    ear: { diverged: ear.diverged, first: ear.first, frames: ear.frames },
    refSoundEvents: refSound.length,
    mutSoundEvents: mutSound.length,
    cueFired: premise,
    cell,
    sample,
  };
}

function statesOf(seed: number, caps: Capabilities, actions: readonly Action[]): WorldState[] {
  // 只有 runSequence 一个主人：这里绝不另写一份步进逻辑（两处各写迟早漂移，见 #13/#18）
  return runSequence(seed, actions, caps).states;
}

/** 一格 = 一个变异体 × 一条随机轨迹。表按变异体聚合。 */
export interface CellTally {
  id: string; kind: CellTallyKind; label: string;
  cases: number; fired: number;
  /** 世界侧独立判定"这记该响"的轨迹数（前提达成的分母）；null = 这一行没有前提概念 */
  前提达成: number | null;
  两者都可见: number; 仅眼可见: number; 仅耳可见: number; 两者都不可见: number;
  /** 分母 = cases（对整张表而言） */
  仅耳可见率: string;
  /** 分母 = 前提达成（这类缺陷**真的有机会露脸**的那些局）——引用这一族数字时用这个 */
  耳分叉率: string;
  首耳分叉帧中位: number | null;
}

type CellTallyKind = 'sound' | 'world' | 'reference';

export function tally(cases: readonly ChannelCase[], meta: Map<string, { kind: CellTallyKind; label: string }>): CellTally[] {
  const byId = new Map<string, ChannelCase[]>();
  for (const c of cases) {
    // 世界层案例的 sound 恒为 'REF'，身份在 world 那一列；发声层案例反之。一格一个 id。
    const key = c.world ?? c.sound;
    const list = byId.get(key) ?? [];
    list.push(c);
    byId.set(key, list);
  }
  const out: CellTally[] = [];
  for (const [id, list] of [...byId.entries()].sort()) {
    const m = meta.get(id) ?? { kind: 'reference' as const, label: id };
    const firsts = list.filter((c) => c.ear.diverged).map((c) => c.ear.first!).sort((a, b) => a - b);
    const onlyEar = list.filter((c) => c.cell === '仅耳可见').length;
    // 前提达成只在**发声层**那些行有定义（其余行 cueFired=null）。这里刻意用
    // "null 就报 null"而不是"null 就当 0"：0 会被读成"这族缺陷从不触发"，那是假话。
    const premiseRows = list.filter((c) => c.cueFired !== null);
    const premise = premiseRows.length === 0 ? null : premiseRows.filter((c) => c.cueFired).length;
    out.push({
      id, kind: m.kind, label: m.label,
      cases: list.length,
      fired: list.filter((c) => c.ear.diverged || c.eye.diverged).length,
      前提达成: premise,
      两者都可见: list.filter((c) => c.cell === '两者都可见').length,
      仅眼可见: list.filter((c) => c.cell === '仅眼可见').length,
      仅耳可见: onlyEar,
      两者都不可见: list.filter((c) => c.cell === '两者都不可见').length,
      仅耳可见率: list.length ? `${((onlyEar / list.length) * 100).toFixed(1)}%` : '—',
      耳分叉率: premise ? `${((onlyEar / premise) * 100).toFixed(1)}%` : '—',
      首耳分叉帧中位: firsts.length ? firsts[Math.floor(firsts.length / 2)]! : null,
    });
  }
  return out;
}

/**
 * 这张表**能不能引用**的三道闸。返回空数组才许引用，非空就是整表作废的原因。
 *
 * 单独成一个纯函数，为的是让这三条本身有测试：闸门只在真跑时 executes 一次，
 * 一辈子不出问题 = 从没被验证过。测试里拿改过的表喂它，逐条要求它必须响。
 */
export function tableGuardProblems(table: readonly CellTally[]): string[] {
  const out: string[] = [];
  const r0 = table.filter((t) => t.kind === 'reference');
  // 对照**缺席**和对照**漏气**一样致命：少了一行，剩下所有行的"分叉"都没了参照系。
  if (!r0.length) out.push('表里没有阴性对照行（R0）：无法区分"仪器漏气"和"缺陷不可见"，本表不可引用');
  for (const t of r0) {
    const leaks = t.两者都可见 + t.仅眼可见 + t.仅耳可见;
    if (leaks) out.push(`阴性对照 ${t.id} 出现 ${leaks} 例分叉：仪器自己漏气，本表全部作废`);
  }
  // 反向对照：世界层缺陷**一列都不许**落进"仅耳可见"（那是判据在造桶，不是世界的性质）
  if (!table.some((t) => t.kind === 'world')) out.push('表里没有世界层反向对照行：无法证明"仅耳可见"不是判据自造的桶');
  for (const t of table.filter((x) => x.kind === 'world')) {
    if (t.仅耳可见) out.push(`世界层缺陷 ${t.id} 被算成"仅耳可见" ${t.仅耳可见} 例：分叉面判错，本表作废`);
  }
  // 「没触发就得出数字」必须出声（§10.13 同族）：某一格整表从没触发过，
  // 它在上限表里是**未测**，不是"耳朵也看不见"。
  for (const t of table.filter((x) => x.前提达成 !== null)) {
    if (t.前提达成 === 0) out.push(`${t.id} 整表从没触发过：这一格没被量过，不许当 0% 引用`);
  }
  return out;
}

function args(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i]!.startsWith('--')) continue;
    const k = argv[i]!.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = '1';
    else { out[k] = v; i++; }
  }
  return out;
}

export interface Ceiling {
  n: number;
  cases: ChannelCase[];
  table: CellTally[];
  /** 两份产物的**最终字节**。比对与落盘用同一份字符串，杜绝"比的是对象、写的是序列化"两套口径。 */
  jsonl: string;
  summaryText: string;
  onlyEarTotal: number;
  premiseTotal: number;
}

/** 跑全表。刻意与"写文件"分开：`--check` 要重算同一份字节而不覆盖已发布产物。 */
export async function buildCeiling(
  seeds: readonly number[], budgets: readonly number[], reps: number,
): Promise<Ceiling> {
  const meta = new Map<string, { kind: 'sound' | 'world' | 'reference'; label: string }>();
  meta.set(REFERENCE_SOUND.id, { kind: 'reference', label: REFERENCE_SOUND.label });
  for (const s of SOUND_MUTANTS) meta.set(s.id, { kind: 'sound', label: s.label });
  for (const m of ['M01', 'M02', 'M06', 'M08']) {
    const mm = findMutant(m);
    meta.set(m, { kind: 'world', label: `${mm.label}（世界层，反向对照）` });
  }

  const cases: ChannelCase[] = [];
  let n = 0;
  for (const budget of budgets) {
    for (const seed of seeds) {
      for (let r = 0; r < reps; r++) {
        n++;
        const actions = randomActions(seed, 4000 + r, budget);
        // 发声侧：R0 + S01..S10，世界一律参考版
        for (const s of ALL_SOUND) {
          cases.push(await twoChannelCase(seed, actions, n, {}, { rig: s.rig }, { sound: s.id }));
        }
        // 世界侧反向对照：缺陷在 step() 里，发声装置两侧都是参考版
        for (const id of ['M01', 'M02', 'M06', 'M08']) {
          cases.push(await twoChannelCase(
            seed, actions, n, {}, { caps: findMutant(id).caps }, { sound: 'REF', world: id },
          ));
        }
        if (n % 10 === 0) log(`… ${n} 条轨迹（${cases.length} 案例）`);
      }
    }
  }

  const table = tally(cases, meta);
  const onlyEarTotal = table.reduce((s, t) => s + t.仅耳可见, 0);
  const premiseTotal = table.reduce((s, t) => s + (t.前提达成 ?? 0), 0);
  const summary = {
    kind: 'm4c-ear-ceiling',
    generatedBy: 'src/m4c.ts',
    channels: { eye: 'diffScreens（M4-f 冻结口径）', ear: 'diffSounds（帧号 + 帧内句子序列）' },
    grid: { seeds, budgets, reps, trajectories: n, cases: cases.length },
    soundCaps: Object.keys(ALL_SOUND_CAPS),
    /** 分母口径，写进产物里，别让读表的人自己猜（§10.12）。 */
    denominators: {
      仅耳可见率: 'cases（该变异体跑过的轨迹数，含前提没达成的局）',
      耳分叉率: '前提达成（世界侧独立判定"这一记确实该响"的轨迹数）——引用这一族缺陷时用这个',
      前提达成: 'cueFired：纯状态转移谓词，与发声层无共享代码；两者不一致时 twoChannelCase 直接抛错',
    },
    table,
    totals: {
      仅耳可见: onlyEarTotal,
      仅眼可见: table.reduce((s, t) => s + t.仅眼可见, 0),
      前提达成: premiseTotal,
      前提未达成: table.filter((t) => t.前提达成 !== null).reduce((s, t) => s + (t.cases - (t.前提达成 ?? 0)), 0),
    },
  };
  return {
    n, cases, table,
    jsonl: cases.map((c) => JSON.stringify(c)).join('\n') + '\n',
    summaryText: `${JSON.stringify(summary, null, 2)}\n`,
    onlyEarTotal, premiseTotal,
  };
}

/**
 * 与已发布产物**逐字节**比对，返回分歧清单（空 = 一致）。
 *
 * 四条设计：
 *  1. **缺文件是失败，不是跳过**（§10.13 / A2）：证据目录路径写错时若"没有就算通过"，
 *     这条核对会永远绿着撒谎——它比没写更糟。
 *  2. 比的是**字节**而不是"聚合数字相同"：数字相同而行不同，说明有人重排或改了逐案例层，
 *     那种改动恰恰是对外引用时最容易漏说的。
 *  3. 第一处分歧给**行号 + 两边原文**，让人能直接定位，不用自己 diff。
 *  4. 比对读的是 **Buffer**，不是 `readFileSync(path, 'utf8')`。台账 #35：产物里有中文键名，
 *     字符串长度与磁盘字节数差 15 万（682198 字符 / 833586 字节）——照字符串写"字节"，
 *     这条守卫自己就成了它要防的那种事：宣称的口径和实际的口径不一致。
 *     比 Buffer 还多挡一手：同一段解码结果可以来自不同字节（非法 UTF-8 的替换符），
 *     那种产物逐字节看**就是不一样**，不该被"看起来一样"放过去。
 */
export function compareArtifacts(dir: string, got: { jsonl: string; summaryText: string }): string[] {
  const out: string[] = [];
  for (const [name, want] of [
    ['ear_ceiling.jsonl', got.jsonl] as const,
    ['ear_ceiling_summary.json', got.summaryText] as const,
  ]) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      out.push(`[证据缺失] ${path} 不存在——比对没有执行，这不是"通过"。检查 --check 指向的目录。`);
      continue;
    }
    const haveBuf = readFileSync(path);
    const wantBuf = Buffer.from(want, 'utf8');
    if (haveBuf.equals(wantBuf)) {
      out.push(`✅ ${name} 逐字节一致（${haveBuf.length} 字节）`);
      continue;
    }
    const have = haveBuf.toString('utf8');
    const hl = have.split('\n');
    const wl = want.split('\n');
    let at = 0;
    while (at < Math.max(hl.length, wl.length) && hl[at] === wl[at]) at++;
    out.push(
      `${name} 与已发布产物不一致：第 ${at + 1} 行起分叉（已发布 ${hl.length} 行 / 重算 ${wl.length} 行，字节 ${haveBuf.length} vs ${wantBuf.length}）`
      + `\n  已发布：${(hl[at] ?? '（无此行）').slice(0, 160)}`
      + `\n  重算出：${(wl[at] ?? '（无此行）').slice(0, 160)}`,
    );
  }
  return out;
}

/** 一致时返回的是 ✅ 行，分歧时是 ❌ 行；调用方只关心"有没有 ❌"。 */
export function artifactProblems(lines: readonly string[]): string[] {
  return lines.filter((l) => !l.startsWith('✅'));
}

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  const seeds = (a.seeds ?? '6,7,8,42').split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  const budgets = (a.budgets ?? '25,120').split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  const reps = Number(a.reps ?? 20);
  const checkDir = typeof a.check === 'string' ? resolve(ROOT, a.check) : null;
  if (!seeds.length || !budgets.length || !Number.isFinite(reps) || reps < 1) {
    log('用法: node src/m4c.ts [--seeds 6,7,8,42] [--budgets 25,120] [--reps 20] [--out runs/m4c-ear]');
    log('      node src/m4c.ts ... --check runs/m4c-ear   # 只重算、逐字节比对已发布产物，不落盘');
    return 2;
  }
  const built = await buildCeiling(seeds, budgets, reps);
  const { n, cases, table, jsonl, summaryText, onlyEarTotal, premiseTotal } = built;

  log('');
  log(`双通道分叉上限表（${n} 条轨迹 × ${ALL_SOUND.length + 4} 个版本 = ${cases.length} 案例）`);
  log('id    类  案例  前提达成  两者都可见 仅眼可见 仅耳可见 都不可见  耳分叉率   首耳分叉帧中位');
  for (const t of table) {
    log(
      `${t.id.padEnd(5)} ${t.kind === 'sound' ? '耳' : t.kind === 'world' ? '眼' : '照'}  ` +
      `${String(t.cases).padStart(4)}  ${(t.前提达成 ?? '—').toString().padStart(9)} ` +
      `${String(t.两者都可见).padStart(9)} ${String(t.仅眼可见).padStart(9)} ` +
      `${String(t.仅耳可见).padStart(9)} ${String(t.两者都不可见).padStart(8)}  ${t.耳分叉率.padStart(8)}  ` +
      `${String(t.首耳分叉帧中位 ?? '—').padStart(6)}`,
    );
  }
  const problems = tableGuardProblems(table);
  for (const p of problems) log(`❌ ${p}`);
  if (problems.length) return 1;

  if (checkDir !== null) {
    const lines = compareArtifacts(checkDir, built);
    const drift = artifactProblems(lines);
    for (const l of lines) log(drift.includes(l) ? `❌ ${l}` : l);
    if (drift.length) return 1;
    log(`\n✅ 与已发布产物逐字节一致：${checkDir}`);
    log('   （这一条就是"你能自己重算"的可执行版本：重算得到同一份字节，不是"看起来差不多"）');
  } else {
    const outDir = resolve(ROOT, a.out ?? 'runs/m4c-ear');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'ear_ceiling.jsonl'), jsonl);
    writeFileSync(join(outDir, 'ear_ceiling_summary.json'), summaryText);
    log(`表已落盘：${join(outDir, 'ear_ceiling.jsonl')}`);
  }

  log(`\n仅耳可见合计 ${onlyEarTotal} 例（这些缺陷对屏幕逐字节不可见，只有第二条通道看得见）`);
  log(`分母：发声层前提达成 ${premiseTotal} 例 / 该族案例 ${table.filter((t) => t.kind === 'sound').reduce((s, t) => s + t.cases, 0)} 例`);
  return 0;
}

// 只在作为脚本运行时执行；作为模块被 test/ 与 verify/ import 时不跑批（否则一 import 就重算全表）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().then((code) => void process.exit(code), (e) => {
    log(`❌ 运行失败：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    void process.exit(1);
  });
}

export type { SoundMutant };
