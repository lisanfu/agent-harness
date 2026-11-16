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