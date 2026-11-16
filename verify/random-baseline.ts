/**
 * M4-e 随机策略基线臂：把"没有大脑时会发生什么"钉成一个数字。
 *
 * 定位（这条最容易写歪，先把话说清）：
 *   这一臂**没有大脑**，也不碰 predict / testing / goal 任何一个接口。
 *   所以它**不能**用来论证"目标导向有没有用"——它论证不了任何接口的事。
 *   它只回答一个问题：**这个世界的 hp=0 到底难不难摸到**。
 *   没有这个下限，"agent 25 步没打到 0 血"这句话就没有可比对象，
 *   评审可以问"换我个人乱点是不是也一样"，我们答不上来。
 *
 * 为什么可以大 n 而真模型臂不行：这一臂零 key、零网络，一局几百步只要毫秒级。
 *   所以它的置信区间是真窄的，不是"n=3 撑出来的样子"。
 *
 * 用法: node verify/random-baseline.ts [--reps 200] [--budgets 25,320] [--worlds 6,7,8,42]
 */
import { randomActions, type Action } from '../src/world/arena.ts';
import { GameSession } from '../src/world/session.ts';

export interface BaselineRow {
  budget: number;
  reps: number;
  /** hp 到过 0 的局数（比率由它算，置信区间也用它，避免四舍五入回来对不上） */
  hpZeroCount: number;
  /** hp 到过 0 的比例 */
  hpZeroRate: number;
  /** 死过一次的比例（活着不代表安全） */
  diedRate: number;
  diedCount: number;
  /** hp 掉进过负数——本世界结算段把血量夹在 [0, maxHp]，所以这条应当恒 0。
   *  留着不是为了好看：等值核对 `hp:0` 与覆盖统计"到过 0"是否同一事件，全靠这条判据撑着。 */
  hpBelowZeroCount: number;
  /** 与敌人相邻过的比例——攻击的前提 */
  adjacencyRate: number;
  /** 整局一次血都没掉的比例（hpSeen 只有一种值＝起始血量）。
   *  M4-e 的关键一问：随机臂和真模型臂**谁愿意受伤**。相邻只是前提，
   *  挨打要求留在那儿不躲开——所以这一列和 adjacencyRate 必须分开看。 */
  neverHurtCount: number;
  neverHurtRate: number;
  meanKills: number;
  meanCells: number;
  /** 见过多少种不同血量值（状态覆盖，M3 硬约束：只记步数不够） */
  meanHpValues: number;
}

/** 一臂：同一个世界 seed，salt 换出一条条独立随机动作序列。 */
export async function randomArm(seed: number, budget: number, reps: number): Promise<BaselineRow> {
  let hpZero = 0;
  let died = 0;
  let belowZero = 0;
  let adjacent = 0;
  let neverHurt = 0;
  let kills = 0;
  let cells = 0;
  let hpValues = 0;
  for (let salt = 0; salt < reps; salt++) {
    const actions = randomActions(seed, salt, budget) as Action[];
    const s = new GameSession(seed);
    for (const a of actions) await s.apply(a);
    const c = s.coverage();
    if (c.hpZeroReached) hpZero++;
    if (c.hpBelowZeroReached) belowZero++;
    if (c.died) died++;
    if (c.adjacentEnemyReached) adjacent++;
    if (c.hpSeen.length === 1) neverHurt++;
    kills += c.kills;
    cells += c.cellsVisited;
    hpValues += c.hpSeen.length;
  }
  return {
    budget,
    reps,
    hpZeroCount: hpZero,
    hpZeroRate: hpZero / reps,
    diedCount: died,
    diedRate: died / reps,
    hpBelowZeroCount: belowZero,
    adjacencyRate: adjacent / reps,
    neverHurtCount: neverHurt,
    neverHurtRate: neverHurt / reps,
    meanKills: kills / reps,
    meanCells: cells / reps,
    meanHpValues: hpValues / reps,
  };
}

function parseFlags(argv: string[]): { reps: number; budgets: number[]; worlds: number[] } {
  const get = (name: string, dflt: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : dflt;
  };
  return {
    reps: Number(get('reps', '200')),
    budgets: get('budgets', '25,320').split(',').map(Number),
    worlds: get('worlds', '6,7,8,42').split(',').map(Number),
  };
}

/**
 * wilson 的主人已经搬到 src/stats.ts（M4-f 的汇总也要用它，两边必须同一个实现）。
 * 这里原样转出：test/random-baseline.test.ts 与既有调用方的 import 路径一字不改。
 */
export { wilson } from '../src/stats.ts';
import { wilson } from '../src/stats.ts';

async function runBaseline(argv: string[]): Promise<number> {
  const { reps, budgets, worlds } = parseFlags(argv);
  if (!Number.isFinite(reps) || reps < 1 || budgets.some((b) => !Number.isFinite(b) || b < 1) || worlds.length === 0) {
    console.error('❌ 参数不合法（--reps/--budgets/--worlds 都得是正数）。参数没解析成功却照样出表，就是故障 #17 那一族。');
    return 1;
  }
  console.log(`\n===== M4-e 随机策略基线（无大脑、无接口、零 key；reps=${reps}／世界） =====`);
  for (const w of worlds) {
    for (const b of budgets) {
      const r = await randomArm(w, b, reps);
      const [lo, hi] = wilson(r.hpZeroCount, reps);
      console.log(
        `世界 seed=${w} 步预算=${b}：hp=0 到达 ${r.hpZeroCount}/${reps}=${(r.hpZeroRate * 100).toFixed(1)}%（95% Wilson [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]）` +
        ` 死过=${r.diedCount}/${reps} hp掉进负数=${r.hpBelowZeroCount}（本世界由血量夹逼保证恒 0，见测试）` +
        ` 挨过敌人=${(r.adjacencyRate * 100).toFixed(1)}% ` +
        `整局没掉血=${r.neverHurtCount}/${reps}=${(r.neverHurtRate * 100).toFixed(1)}% ` +
        `平均击杀=${r.meanKills.toFixed(2)} 走过格=${r.meanCells.toFixed(1)}/64 血量种类=${r.meanHpValues.toFixed(1)}`,
      );
    }
  }
  console.log('\n[读法边界] 这一臂没有大脑，也不碰任何接口。它能说的只有"世界的下限难度"，');
  console.log('一句都不许写成"目标导向比随机强多少"——那句话要等真模型真的声明过目标才有资格说。');
  return 0;
}

if (process.argv[1]?.endsWith('random-baseline.ts')) {
  runBaseline(process.argv.slice(2)).then((c) => process.exit(c));
}
