/**
 * 目标完成条件的判定实现（M4-b2，世界层）。
 *
 * 分工：这一层**只拿当前屏幕逐字段核对等值**，返回 PredictionDiff[]。
 * 合取（"全都满足才算达成"）、计数、出声、状态机，全部归器官 src/goal.ts——
 * 那样换个游戏只改这个文件，器官一行不动。
 *
 * 与预测通道（predict.ts）的三个关键差别：
 *  1. 字段是**绝对状态量**（hp / score / …），不是差值。目标断言的是"我要让局面停在哪个状态"，
 *     不是一瞬间的变化率。hpDelta 放进完成条件没有意义——下一帧它就变了。
 *  2. **只吃一帧**，不吃前后两帧。所以画面静止时目标照样可判定，
 *     这正是故障 #10 的教训：闸门按"有没有可核对的事实"划，不按"这步有没有动"划。
 *     于是目标通道**没有 applies 判据**，静态帧也得判。
 *  3. 归一化复用 value.ts 同一份。同一个 `{x:3,y:4}` 若预测认、目标不认，
 *     两条通道会互相打架，而错的是 harness 不是 agent。
 *
 * 诚实纪律照抄预测通道：字段不认识 / 值不合法 / 屏幕没印这个量 → unverifiable，
 * **绝不记 violated**。把无法核对算成不满足，会让"目标永远达不成"成为裁判的产物。
 */
import { observe } from './observe.ts';
import { bool, num, pos, same } from './value.ts';
import type { GoalSeam, PredictionDiff } from '../types.ts';

/**
 * 允许写进完成条件的字段。全部是**画面上可见**的绝对状态量，不含任何内部字段。
 * 刻意不含 tick：帧号每帧都变，作为完成条件等于要求 agent 停在某一帧上，
 * 而那既不可复现也不是"局面"。
 */
export const GOAL_FIELDS = [
  'hp', 'score', 'playerAt', 'enemyCount', 'pickupCount', 'alive', 'attackReady',
] as const;

export type GoalField = (typeof GOAL_FIELDS)[number];

/**
 * 完成条件字段的**接口说明**，原样进 system 契约。
 *
 * 界线同 PREDICT_SPEC：只说「字段是什么、答案长什么形状、多个字段怎么合起来算」，
 * 绝不说「该去追哪个状态」「哪个字段容易出问题」。后者是策略，归大脑。
 *
 * 同一条刻意取舍：说清 [x,y] 的**顺序**（接口歧义，不说会把"数对了但写反了"判成违反，
 * 凭空制造异常），不说原点与轴向（世界知识，要靠 agent 自己数格子）。
 */
export const GOAL_SPEC = [
  'doneWhen 的可用字段。每个字段写"你要画面上等于什么"，代码只认**等值**，不支持 >、<、区间之类的比较：',
  '  - hp: 整数，画面上 HP 行印着的当前血量',
  '  - score: 整数，画面上印着的分数',
  '  - playerAt: [x, y]，你所在的格子；x 是列、y 是行',
  '  - enemyCount: 整数，画面上活着的敌人个数',
  '  - pickupCount: 整数，画面上未被拾取的物品个数',
  '  - alive: true / false，画面上状态行印着的生死',
  '  - attackReady: true / false，画面上攻击是否就绪',
  '  可以只写其中一部分字段；写了多个字段时，代码按"全都相等"算一次判定。',
  '  例：{"doneWhen":{"hp":0,"enemyCount":0}}',
].join('\n');

/** 从一帧屏幕算出各字段的实际值。画面没印出来就是 null，绝不补一个 0。 */
function actuals(screen: string): Record<GoalField, unknown> {
  const o = observe(screen);
  // 网格没解析出来时坐标/计数一律 null：空数组会被误读成"画面里没有敌人"
  const gridOk = o.size !== null;
  return {
    hp: o.hp,
    score: o.score,
    playerAt: gridOk ? o.player : null,
    enemyCount: gridOk ? o.enemies.length : null,
    pickupCount: gridOk ? o.pickups.length : null,
    alive: o.alive,
    attackReady: o.attackReady,
  };
}

const normalize = (field: GoalField, v: unknown): unknown => {
  switch (field) {
    case 'hp': case 'score': case 'enemyCount': case 'pickupCount': return num(v);
    case 'playerAt': return pos(v);
    case 'alive': case 'attackReady': return bool(v);
  }
};

/**
 * 逐字段核对一个完成条件。顺序 = 模型写的顺序，一条不丢。
 * 三态给齐就收工；合取由器官做，这里不判"整体达成没达成"。
 */
export function evaluateGoal(
  condition: Record<string, unknown>,
  screen: string,
): PredictionDiff[] {
  const act = actuals(screen);
  const out: PredictionDiff[] = [];
  for (const [field, raw] of Object.entries(condition ?? {})) {
    const known = (GOAL_FIELDS as readonly string[]).includes(field);
    const want = known ? normalize(field as GoalField, raw) : null;
    const actual = known ? act[field as GoalField] : null;
    // 三种情况都是「无法核对」：字段不认识 / 写的值不合法 / 画面没印这个量
    const status: PredictionDiff['status'] =
      want === null || actual === null || actual === undefined ? 'unverifiable'
        : same(want, actual) ? 'ok' : 'violated';
    out.push({ field, predicted: raw, actual: actual ?? null, status });
  }
  return out;
}

/**
 * 注入给循环层的目标接缝。
 * 契约层拿到的是「词表 + 一个函数」，它不知道屏幕长什么样、hp 是什么。
 */
export const GOAL_SEAM: GoalSeam = {
  spec: GOAL_SPEC,
  fields: GOAL_FIELDS,
  evaluate: evaluateGoal,
};
