/**
 * M4-e 随机基线臂的单测。这一臂是报告里唯一"n 真的大"的数字，
 * 所以它的判据必须能钉住三件事：
 *   1. **确定性**：salt 定了动作序列就定了，同参数跑两遍必须逐字相同（否则"800 局"只是气氛）；
 *   2. **它测的是什么**：hp 归零这件事在这个世界里几乎只由"被敌人打死"产生，
 *      所以 hpZeroCount 与 diedCount 的关系必须被钉住，防止把"打空敌人血条"当同一件事；
 *   3. 置信区间不许捅出 [0,1]，全 0 的样本也不许报"0%"这种点估计（那是把噪声当结论）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomArm, wilson } from '../verify/random-baseline.ts';

test('随机臂确定性强：同 seed 同预算同 reps 两次跑出逐字相同的行', async () => {
  const a = await randomArm(6, 30, 12);
  const b = await randomArm(6, 30, 12);
  assert.deepEqual(a, b);
});

test('随机臂：换个世界 seed 就是另一道世界，数字不许一样（否则随机动作生成器根本没用到 seed）', async () => {
  const s6 = await randomArm(6, 30, 12);
  const s7 = await randomArm(7, 30, 12);
  assert.notDeepEqual(s6, s7, '两个初始哈希不同的世界，随机游走统计量不可能逐字相同');
});

test('随机臂：hp 归零基本等价于被打死——这条关系被写死，防止把"敌人血条清零"混成同一个指标', async () => {
  const reps = 60;
  const r = await randomArm(6, 120, reps);
  // 世界里玩家 hp→0 只由接触伤害产生（HEAL/拾取只会加回来），所以两件事应高度同步。
  assert.ok(
    Math.abs(r.hpZeroRate - r.diedRate) < 1e-9,
    `hp=0 到达率(${r.hpZeroRate}) 与 死亡率(${r.diedRate}) 应当同步；不同步说明覆盖统计里有别的 hp 归零路径，判据要重写`,
  );
  assert.ok(r.hpZeroCount <= reps && r.hpZeroCount >= 0);
});

test('随机臂：贴身是掉血的**前提**不是结果——同一臂里两个数必须能分开（M4-e §5 的"谁愿意受伤"）', async () => {
  const r = await randomArm(6, 25, 200);
  assert.equal(r.adjacencyRate, 1, '25 步随机游走在 seed=6 世界里局局贴过身（报告里的 100%）');
  assert.ok(r.neverHurtCount > 0, '既然局局贴过身，就有局全程没掉过血——挨打要求留在那儿不躲开');
  assert.ok(r.neverHurtCount < r.reps, '也不是全都躲开了：两臂都得允许"贴过身且掉过血"存在');
  // 步数越多越不可能整局不掉血：这条只在**确定性**前提下敢写死（同参数两次跑出逐字相同的行）。
  const long = await randomArm(6, 320, 200);
  assert.ok(long.neverHurtRate < r.neverHurtRate, `25 步没掉血率=${r.neverHurtRate}，320 步=${long.neverHurtRate}：掉了这条说明两臂预算不可比`);
});

test('Wilson 区间：全 0 的样本给出的是"上界"，不是"0%"；全中的样本上界封在 1，下界不许谎报成 100%', () => {
  const [lo0, hi0] = wilson(0, 200);
  assert.equal(lo0, 0);
  // 经验法则 3/n=0.015，Wilson 略宽；卡在这个量级说明公式没写错
  assert.ok(hi0 > 0.015 && hi0 < 0.025, `0/200 的上界应约 1.9%，实测 ${hi0}`);
  const [lo1, hi1] = wilson(200, 200);
  assert.equal(hi1, 1);
  assert.ok(lo1 > 0.975 && lo1 < 1, `200/200 的下界应约 98%，实测 ${lo1}`);
  assert.ok(Number.isNaN(wilson(0, 0)[0]), 'n=0 必须 NaN：把"没样本"印成"0%"就是故障 #17');
});
