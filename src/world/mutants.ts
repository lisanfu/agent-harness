/**
 * 变异靶场：从可玩的参考版生成「语义变异体」——删掉一个必需能力。
 *
 * 为什么不用语法变异（改个符号、换个边界）：
 *   语法变异大量产生等价变异体（改了但行为不变），差分会静默漏检，
 *   而且"缺陷"往往一眼就能看出来，测不出真实发现能力。
 * 语义变异删的是**能力**，缺陷位置与类型对 agent 隐藏，更接近真实 bug。
 *
 * 铁律：公证器**不需要**手写不变量（invariant），也**不需要**预知缺陷位置。
 *   它只做一件事：参考版 vs 变异版 + 同一动作序列 → 第一个分叉点。
 *   本文件里的 label/expectedSymptom 只用于**实验度量**，绝不喂给公证器。
 */
import { ALL_CAPS, type Capabilities } from './arena.ts';
import type { SoundCaps, SoundRig } from './sound.ts';
import { ALL_SOUND_CAPS } from './sound.ts';

export interface Mutant {
  id: string;
  /** 被删掉的能力。实验度量用，公证器不看。 */
  removed: (keyof Capabilities)[];
  /** 人类可读标签。实验报告用，公证器不看。 */
  label: string;
  caps: Capabilities;
}

function without(...keys: (keyof Capabilities)[]): Capabilities {
  const c: Capabilities = { ...ALL_CAPS };
  for (const k of keys) c[k] = false;
  return c;
}

/** 九个单变异体，每个删一项能力 */
export const SINGLE_MUTANTS: Mutant[] = [
  { id: 'M01', removed: ['wallBlocks'],     label: '墙不再挡路（可穿墙）',       caps: without('wallBlocks') },
  { id: 'M02', removed: ['enemyPatrol'],    label: '敌人不再巡逻（静止）',       caps: without('enemyPatrol') },
  { id: 'M03', removed: ['contactDamage'],  label: '接触不再扣血',               caps: without('contactDamage') },
  { id: 'M04', removed: ['attackKills'],    label: '攻击不再杀死敌人',           caps: without('attackKills') },
  { id: 'M05', removed: ['attackCooldown'], label: '攻击没有冷却',               caps: without('attackCooldown') },
  { id: 'M06', removed: ['pickupHeals'],    label: '拾取不再回血',               caps: without('pickupHeals') },
  { id: 'M07', removed: ['deathAtZeroHp'],  label: '血量归零不再死亡',           caps: without('deathAtZeroHp') },
  { id: 'M08', removed: ['scoreOnKill'],    label: '击杀不再计分',               caps: without('scoreOnKill') },
  { id: 'M09', removed: ['hpClamp'],        label: '血量不再夹取（可超上限/负）', caps: without('hpClamp') },
];

/** 双变异体：测能力交互。差分能不能在两个缺陷同时存在时仍给出可用信号？ */
export const DOUBLE_MUTANTS: Mutant[] = [
  { id: 'D01', removed: ['contactDamage', 'deathAtZeroHp'], label: '不扣血且不死', caps: without('contactDamage', 'deathAtZeroHp') },
  { id: 'D02', removed: ['attackKills', 'scoreOnKill'],    label: '不击杀且不计分', caps: without('attackKills', 'scoreOnKill') },
  { id: 'D03', removed: ['enemyPatrol', 'contactDamage'],  label: '敌人静止且不扣血', caps: without('enemyPatrol', 'contactDamage') },
];

export const ALL_MUTANTS: Mutant[] = [...SINGLE_MUTANTS, ...DOUBLE_MUTANTS];

export function findMutant(id: string): Mutant {
  const m = ALL_MUTANTS.find((x) => x.id === id);
  if (!m) throw new Error(`未知变异体：${id}（可用：${ALL_MUTANTS.map((x) => x.id).join(', ')}）`);
  return m;
}

// ─────────────────────── 输出层变异体（M4-c）───────────────────────

/**
 * 声音侧变异体：**世界一个字节都不改，只改"播什么"。**
 *
 * 为什么必须单独有一族：M4-f 的上限表用屏幕当唯一分叉面，`invisible=0` 那条结论
 * 只覆盖**世界层**缺陷（`step()` 里的能力被删）。真实引擎里"算"和"播"是两条代码路径，
 * 音频层/渲染层的 bug 不落进状态——只看屏幕的测试工具对这一族**结构性失明**。
 * 这一族就是为了让"失明"变成可数的数字而存在，不是为了难为 agent。
 *
 * 三类形状，缺一不可：
 *  - **漏报**（S01–S08）：某个触发不播了。屏幕照常变化。
 *  - **误报**（S09）：条件写宽，正常移动也播一记闷响。**单局、无参考版**就能让耳朵说出屏幕反对的话
 *    ——这就是"眼耳矛盾是独立异常源"的现成证据，不需要知道正确答案。
 *  - **时钟错位**（S10）：内容全对、帧号整体后移一帧。路线图 M4 那一栏预言过的故障。
 *    它是判据的靶子：把"次数对、内容错"与"内容对、时刻错"混成一桶的判据，
 *    会在 S10 上满屏假矛盾，或在 S09 上全部漏判。
 */
export interface SoundMutant {
  id: string;
  label: string;
  /** 被改坏的发声形状。人工度量与报告用，判据不看。 */
  cue: 'reference' | keyof SoundCaps | 'misfire_bump_on_move' | 'shift_one_tick';
  rig: SoundRig;
}

function soundWithout(...keys: (keyof SoundCaps)[]): SoundRig {
  const caps: SoundCaps = { ...ALL_SOUND_CAPS };
  for (const k of keys) caps[k] = false;
  return { caps };
}

/** 阴性对照：参考版 vs 参考版。两侧都必须零分叉，分叉了就是仪器自己漏气。 */
export const REFERENCE_SOUND: SoundMutant = {
  id: 'R0', label: '参考版发声（阴性对照，应当两侧都不分叉）',
  cue: 'reference', rig: { caps: { ...ALL_SOUND_CAPS } },
};

export const SOUND_MUTANTS: SoundMutant[] = [
  { id: 'S01', label: '脚步声丢失（移动无声）', cue: 'footstep', rig: soundWithout('footstep') },
  { id: 'S02', label: '撞墙闷响丢失（撞上硬物不发声）', cue: 'wallBump', rig: soundWithout('wallBump') },
  { id: 'S03', label: '挥击破风声丢失', cue: 'swing', rig: soundWithout('swing') },
  { id: 'S04', label: '敌人倒地声丢失（击杀无反馈）', cue: 'killThud', rig: soundWithout('killThud') },
  { id: 'S05', label: '受击闷哼丢失（挨打无声）', cue: 'hurtGrunt', rig: soundWithout('hurtGrunt') },
  { id: 'S06', label: '拾取咔哒丢失', cue: 'pickupClick', rig: soundWithout('pickupClick') },
  { id: 'S07', label: '自身倒地声丢失', cue: 'deathThud', rig: soundWithout('deathThud') },
  { id: 'S08', label: '敌人挪动的窸窣丢失', cue: 'enemyFootstep', rig: soundWithout('enemyFootstep') },
  { id: 'S09', label: '误报：正常移动也播闷响（触发条件写宽）', cue: 'misfire_bump_on_move', rig: { caps: { ...ALL_SOUND_CAPS }, bumpOnMove: true } },
  { id: 'S10', label: '时钟错位：整条声流晚一帧（内容全对）', cue: 'shift_one_tick', rig: { caps: { ...ALL_SOUND_CAPS }, shiftTicks: 1 } },
];

export const ALL_SOUND: SoundMutant[] = [REFERENCE_SOUND, ...SOUND_MUTANTS];

export function findSoundMutant(id: string): SoundMutant {
  const m = ALL_SOUND.find((x) => x.id === id);
  if (!m) throw new Error(`未知发声变异体：${id}（可用：${ALL_SOUND.map((x) => x.id).join(', ')}）`);
  return m;
}