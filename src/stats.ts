/**
 * 统计工具的**唯一主人**。
 *
 * 为什么要单独一个文件：wilson 原来写在 verify/random-baseline.ts、fisher 写在 verify/ablation.ts，
 * 两边各自可用。M4-f 的汇总也需要它们，于是出现第三个调用方——
 * 要么 src 反向 import verify（层次倒转），要么抄第三份（三个主人，迟早漂移）。
 * 抄一份是最坏选择：两个 wilson 只要有一个改了四舍五入，两张表的置信区间就不可比，
 * 而没有任何一条测试会疼（故障 #13 的原话：一个判据只能有一个主人）。
 */

/**
 * Wilson 95% 区间：n 小的时候对称正态区间会捅出 [0,1]，所以用这个。
 *
 * 两条不可删的行为，都有测试盯着（test/random-baseline.test.ts）：
 *  - 全 0 的样本给的是**上界**而不是"0%"——0/200 说成 0% 是把运气说成结论；
 *  - n=0 必须 NaN——把"没样本"印成"0%"是故障 #17。
 */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [NaN, NaN];
  const z = 1.96;
  const p = k / n;
  const den = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// ────────────────────────── Fisher 精确检验（两尾） ──────────────────────────
// 手写而不引依赖：本项目零依赖是硬约束，而且这张表小到能用手算复核。
// P(表) = C(n1,a)·C(n2,c) / C(N,a+c)，两尾＝把边际固定后所有"不比观测表更可能"的表加起来。

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/**
 * @param a 第一组"成功"数，b 第一组"失败"数，c 第二组"成功"，d 第二组"失败"
 * @returns 两尾 p 值；任一组为空 → NaN（没有可比性，不许当成 p=1）
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const n1 = a + b;
  const n2 = c + d;
  const k = a + c;
  const N = n1 + n2;
  if (n1 <= 0 || n2 <= 0 || N <= 0) return NaN;
  const lo = Math.max(0, k - n2);
  const hi = Math.min(n1, k);
  if (a < lo || a > hi) return NaN;
  const logDenom = logChoose(N, k);
  const prob = (x: number) => Math.exp(logChoose(n1, x) + logChoose(n2, k - x) - logDenom);
  const pObs = prob(a);
  let sum = 0;
  for (let x = lo; x <= hi; x++) {
    const px = prob(x);
    if (px <= pObs * (1 + 1e-9)) sum += px;
  }
  return Math.min(1, sum);
}

/** 分位数（中位数/q90 用）。空数组给 null，绝不给 0——0 是一个看起来合法的假答案。 */
export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
}

/** 小样本的比例打印：分母为 0 时给破折号，绝不给 0%。 */
export function rate(n: number, d: number): string {
  return d === 0 ? '—' : `${n}/${d}=${((100 * n) / d).toFixed(1)}%`;
}
