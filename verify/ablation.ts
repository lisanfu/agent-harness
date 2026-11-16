/**
 * M4-e 采纳率汇总：把"这一局第几步开始给可选字段"变成跨局可比的数字。
 *
 * 为什么单独一个脚本，不复用 goal-audit / board-audit：
 *   那两个管**这一局的证据自不自洽**（判决型，输出"不一致 N 处"）；
 *   这个管**档与档之间差多少**（统计型，输出比例 + Fisher 精确检验）。
 *   两种判据混在一个脚本里，迟早出现"把统计不显著读成证据没问题"或反过来。
 *
 * 三条硬纪律（都是前几轮的坑换来的）：
 *   1. **只读证据文件**，不 import src/ 里任何判决代码——算错指标可以重算，
 *      拿被测代码自己算自己的指标，错了也发现不了（故障 #8 家族）。
 *   2. 逐帧算出来的数与 defect.json 的账本**必须交叉核对**，不一致就出声并退出非零。
 *      取哪一个都不许静默（故障 #14：两个通道时序不同，判据不能照抄，也不能只信一个）。
 *   3. **样本不够就不出 p 值**：两档各 ≥2 局才算 Fisher，否则明写"本轮够不着判定"。
 *      零样本/欠样本还要照样打印一行绿字，就是故障 #17 的第四种形态。
 *
 * 用法: node verify/ablation.ts <runDir>...
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RunMetrics {
  runId: string;
  seed: number;
  brainId: string;
  /** 本局开了哪些通道（header.seams；缺键＝b2 之前的版本，按 undefined 如实报出） */
  goalSeam: boolean | undefined;
  predictSeam: boolean | undefined;
  maxSteps: number;
  /** 实际决策步数 */
  steps: number;
  stopReason: string;
  /** 跑满预算=false 的局（429 打断）不进采纳率合计，只单列 */
  complete: boolean;
  /** 有 prediction_check 事件的步数（世界被推进、代码可核对） */
  checked: number;
  /** 其中给了 predict 的步数（账本口径） */
  given: number;
  /** 决策 JSON 里写了 predict 的步数（含不推进画面、代码没法核对的工具步） */
  emitted: number;
  /** 第一步给出 predict 的步号；整局没给=null */
  firstGivenStep: number | null;
  /** 前 5 步里给了 predict 的步数 / 前 5 步里可核对的步数 */
  earlyGiven: number;
  earlyChecked: number;
  /** 写了 testing 的步数（模型的主动行为） */
  testingGiven: number;
  /** hypothesis_check 事件数（代码侧一一对应） */
  hypEvents: number;
  /** 其中归因成功的步数（账本口径） */
  attributed: number;
  /** 声明目标次数（goal_write 里 op=declare） */
  goalDeclared: number;
  coverage: { cellsVisited: number; cellsTotal: number; numHpValues: number; hpZeroReached: boolean; adjacentEnemyReached: boolean; neverHurt: boolean; kills: number };
}

export interface RunReading {
  m: RunMetrics;
  /** 逐帧重算与账本的对不上之处；空数组＝这条局的指标可信 */
  problems: string[];
}

/** 只取"这一步是不是一个决策记录"：决策记录有 decision 而没有 kind。 */
function isDecisionRecord(e: Record<string, unknown>): boolean {
  return e.kind === undefined && e.decision !== undefined;
}

/** 证据缺一个文件就是缺一个：报出来并退出非零，**不许悄悄跳过这一局**。
 *  跳过＝"少一份证据"变成"少一个可能被质疑的样本"，那是故障 #16 的免检通道换了个入口。 */
function readJson<T = Record<string, any>>(dir: string, name: string): T {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
  } catch {
    throw new Error(`${dir}/${name} 读不到或不是合法 JSON（局还在跑？写坏了？）——缺证据不許跳过这一局`);
  }
}

export function readRun(dir: string): RunReading {
  const d = dir.replace(/\/+$/, '');
  const header = readJson(d, 'header.json');
  const result = readJson(d, 'result.json');
  const defect = readJson(d, 'defect.json');
  const coverage = readJson(d, 'coverage.json');
  const events = readFileSync(join(d, 'trace.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const recs = events.filter(isDecisionRecord) as Array<{
    index: number;
    decision: { predict?: unknown; testing?: unknown };
  }>;
  const checks = (events.filter((e) => e.kind === 'prediction_check') as Array<{ payload: { step: number; given: boolean } }>)
    .map((e) => e.payload);

  let checked = 0;
  let given = 0;
  let firstGivenStep: number | null = null;
  let earlyGiven = 0;
  let earlyChecked = 0;
  let hypEvents = 0;
  let hypAttributed = 0;
  let testingGiven = 0;
  // emitted：决策 JSON 里写了 predict 的步数，**不管这一步能不能核对**。
  // 与 given 分成两个口径是有意的：工具步（note / hypothesis / goal）不推进画面，
  // 代码无从核对，账本就不计——但"模型确实写了"这件事本身是行为证据，不能跟着一起丢。
  let emitted = 0;
  for (const c of checks) {
    checked++;
    if (c.step <= 5) earlyChecked++;
    if (c.given) {
      given++;
      if (firstGivenStep === null || c.step < firstGivenStep) firstGivenStep = c.step;
      if (c.step <= 5) earlyGiven++;
    }
  }
  for (const r of recs) {
    if (r.decision.predict !== undefined) emitted++;
    if (r.decision.testing !== undefined) testingGiven++;
  }
  for (const e of events as Array<{ kind?: string; payload?: { problem?: string | null } }>) {
    if (e.kind !== 'hypothesis_check') continue;
    hypEvents++;
    if (e.payload?.problem === null) hypAttributed++;
  }

  const goalDeclared = (events.filter((e) => e.kind === 'goal_write') as Array<{ payload: { op?: string } }>)
    .filter((e) => e.payload.op === 'declare').length;

  const maxSteps = header.config?.maxSteps ?? recs.length;
  const m: RunMetrics = {
    runId: String(header.runId ?? d.split('/').pop()),
    seed: header.seed,
    brainId: String(header.brainId ?? '?'),
    goalSeam: header.seams?.goal as boolean | undefined,
    predictSeam: header.seams?.predict as boolean | undefined,
    maxSteps,
    steps: recs.length,
    stopReason: String(result.stopReason ?? '?'),
    complete: recs.length >= maxSteps || result.stopReason === 'finished',
    checked,
    given,
    emitted,
    firstGivenStep,
    earlyGiven,
    earlyChecked,
    testingGiven,
    hypEvents,
    attributed: hypAttributed,
    goalDeclared,
    coverage: {
      cellsVisited: coverage.cellsVisited,
      cellsTotal: coverage.cellsTotal,
      numHpValues: (coverage.hpSeen ?? []).length,
      hpZeroReached: coverage.hpZeroReached === true,
      // 与随机臂同一个字段、同一个定义（session.ts 的 adjacentEnemyReached）：
      // 不比"挨打次数"，只比"有没有把局面推进到与敌人相邻过"——攻击与掉血的前提。
      adjacentEnemyReached: coverage.adjacentEnemyReached === true,
      // 整局一次血都没掉（血量只见过一种值＝起始血量）。与随机臂 `neverHurtRate` 同一个定义。
      // 相邻只是"能挨打的前提"，这一列量的才是"有没有真的让自己受伤"。
      neverHurt: (coverage.hpSeen ?? []).length === 1,
      kills: coverage.kills,
    },
  };

  // ── 交叉核对：逐帧 vs 账本，两边不许静默取一 ──
  const problems: string[] = [];
  const ps = defect.predictionStats;
  const hs = defect.hypothesisStats;
  const gs = defect.goalStats;
  if (ps) {
    if (ps.given !== given) problems.push(`predict given 逐帧=${given} 账本=${ps.given}`);
    if (ps.checked !== checked) problems.push(`可核对步 逐帧=${checked} 账本=${ps.checked}`);
  }
  if (hs) {
    // 恒等式（读 loop.ts 归因段得来的，不是巧合）：模型每写一次 testing，
    // 必然落进 attributed / unknownTarget / malformed / notChecked / fieldAbsent 五个桶里的**唯一一个**，
    // 并且必然落一条 hypothesis_check 事件。所以三个数必须相等。
    // ⚠️ 曾经写成"逐帧 testing === 账本 attributed"——那是把"写了"和"归因成功"当一个口径（故障 #18）。
    const buckets = hs.attributed + hs.unknownTarget + hs.malformed + hs.notChecked + hs.fieldAbsent;
    if (hypEvents !== testingGiven) problems.push(`hypothesis_check 事件=${hypEvents} 写了 testing 的步=${testingGiven}`);
    if (buckets !== testingGiven) problems.push(`五个归因桶合计=${buckets} 写了 testing 的步=${testingGiven}`);
    if (hs.attributed !== hypAttributed) problems.push(`归因成功 事件侧=${hypAttributed} 账本=${hs.attributed}`);
  }
  if (gs && gs.declared !== goalDeclared) problems.push(`goal 声明 逐帧=${goalDeclared} 账本=${gs.declared}`);
  if (m.steps !== (Array.isArray(result.steps) ? result.steps.length : result.steps)) {
    problems.push(`决策步数 逐帧=${m.steps} result.steps=${JSON.stringify(result.steps)?.slice(0, 40)}`);
  }
  return { m, problems };
}

// ────────────────────────── Fisher 精确检验（两尾） ──────────────────────────
// 实现的主人已搬到 src/stats.ts：M4-f 的检出率两档比较与本档的采纳率比较必须用同一个检验，
// 两处各写一份，改了一边就会出现"两张表的 p 值口径不同"这种查不出来的错。
// 这里原样转出，test/ablation.test.ts 的 import 路径一字不改。
import { fisherExact } from '../src/stats.ts';
export { fisherExact };

// ───────────────────────────── 汇总与出声 ─────────────────────────────

export interface ArmAgg {
  goalOn: boolean | undefined;
  runs: number;
  /** 跑满预算的局（只有这些进步×粒度的合计） */
  completeRuns: number;
  given: number;
  checked: number;
  earlyGiven: number;
  earlyChecked: number;
  /** "整局一次都没给" 的局数——双峰性的直接读数（只数跑满的局，被打断的局说不清） */
  zeroRuns: number;
  /** 主判据的分母：前 5 步里至少有 3 步可核对，"起步与否"才谈得上量过 */
  measurableRuns: number;
  /** 前 5 步内给过至少一次 predict 的局数 */
  earlyStarters: number;
  testingGiven: number;
  attributed: number;
  goalDeclared: number;
  hpZeroReached: number;
  /** 与敌人相邻过（含同格，曼哈顿距离 ≤1）的局数——与随机臂 `adjacencyRate` 同一个字段同一个定义 */
  adjacentEnemyReached: number;
  /** 整局一次血都没掉的局数——与随机臂 `neverHurtCount` 同一定义（hpSeen 只有一种值） */
  neverHurtRuns: number;
  meanCells: number;
  meanHpValues: number;
}

/** "前 5 步有没有起步"在这局上量得出吗？只跑 10 步、又被 429 打断的局，5 步预算是够的；
 *  但可核对步太少（<3）就只剩噪声，必须显式排除而不是悄悄算进分母。 */
export function measurable(r: RunMetrics): boolean {
  return r.earlyChecked >= 3;
}

function aggregate(rows: RunMetrics[]): ArmAgg[] {
  const key = (r: RunMetrics) => String(r.goalSeam);
  const groups = new Map<string, RunMetrics[]>();
  for (const r of rows) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups.entries()].sort().map(([k, rs]) => {
    const full = rs.filter((r) => r.complete);
    const meas = rs.filter(measurable);
    const sum = (f: (r: RunMetrics) => number, arr = rs) => arr.reduce((s, r) => s + f(r), 0);
    return {
      goalOn: k === 'undefined' ? undefined : k === 'true',
      runs: rs.length,
      completeRuns: full.length,
      given: sum((r) => r.given, full),
      checked: sum((r) => r.checked, full),
      earlyGiven: sum((r) => r.earlyGiven, full),
      earlyChecked: sum((r) => r.earlyChecked, full),
      zeroRuns: full.filter((r) => r.given === 0).length,
      measurableRuns: meas.length,
      earlyStarters: meas.filter((r) => r.earlyGiven > 0).length,
      testingGiven: sum((r) => r.testingGiven, full),
      attributed: sum((r) => r.attributed, full),
      goalDeclared: sum((r) => r.goalDeclared, full),
      hpZeroReached: sum((r) => (r.coverage.hpZeroReached ? 1 : 0), full),
      adjacentEnemyReached: sum((r) => (r.coverage.adjacentEnemyReached ? 1 : 0), full),
      neverHurtRuns: sum((r) => (r.coverage.neverHurt ? 1 : 0), full),
      meanCells: full.length === 0 ? 0 : sum((r) => r.coverage.cellsVisited, full) / full.length,
      meanHpValues: full.length === 0 ? 0 : sum((r) => r.coverage.numHpValues, full) / full.length,
    };
  });
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${n}/${d}=${(100 * n / d).toFixed(0)}%`;
}

function pText(p: number): string {
  if (Number.isNaN(p)) return '算不出（分母为 0）';
  if (p < 0.0001) return `${p.toExponential(2)}`;
  return p.toFixed(4);
}

function requireDirs(argv: string[]): string[] {
  if (argv.length === 0) {
    throw new Error('没有指定任何 run 目录 → 本脚本一行都没汇总。零样本＝假通过，拒绝以 0 退出。');
  }
  return argv;
}

export function main(argv: string[]): number {
  let dirs: string[];
  try {
    dirs = requireDirs(argv);
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    return 1;
  }
  const readings: RunReading[] = [];
  let broken = 0;
  for (const dir of dirs) {
    try {
      readings.push(readRun(dir));
    } catch (e) {
      console.error(`❌ ${(e as Error).message}`);
      broken++;
    }
  }
  if (broken > 0) {
    console.error(`\n❌ ${broken} 个 run 目录证据不完整——汇总拒绝在缺证据的情况下出表。`);
    return 1;
  }
  let bad = 0;
  console.log('\n===== M4-e 采纳率逐局表（只读证据，逐帧重算） =====');
  for (const { m, problems } of readings) {
    const seam = m.goalSeam === undefined ? '无 seams（b2 之前的版本）' : m.goalSeam ? '目标开' : '目标关';
    const first = m.firstGivenStep === null ? '整局没给' : `第 ${m.firstGivenStep} 步`;
    const flag = m.complete ? '' : ` ⚠️没跑满（${m.stopReason}）→ 不进合计`;
    console.log(
      `${m.runId} ${seam}${flag}\n` +
      `    步=${m.steps}/${m.maxSteps} predict ${pct(m.given, m.checked)}（另写了 ${m.emitted - m.given} 步没法核对）` +
      ` 起步=${first} 前5步 ${pct(m.earlyGiven, m.earlyChecked)}` +
      ` testing写了=${m.testingGiven}(归因成 ${m.attributed}) goal声明=${m.goalDeclared} hp=0到过=${m.coverage.hpZeroReached ? '是' : '否'} 与敌相邻过=${m.coverage.adjacentEnemyReached ? '是' : '否'} 整局没掉血=${m.coverage.neverHurt ? '是' : '否'} 走过格=${m.coverage.cellsVisited}/${m.coverage.cellsTotal} 血量种类=${m.coverage.numHpValues}`,
    );
    for (const p of problems) {
      console.log(`    ❌ 逐帧与账本不一致：${p}`);
      bad++;
    }
  }
  if (bad > 0) {
    console.log(`\n❌ ${bad} 处逐帧重算与账本对不上——上面所有数字都不许用于结论，先修证据链。`);
    return 1;
  }

  const arms = aggregate(readings.map((r) => r.m));
  console.log('\n===== 分档合计（只算跑满预算的局） =====');
  for (const a of arms) {
    console.log(
      `${a.goalOn === undefined ? '无 seams' : a.goalOn ? '目标开  ' : '目标关  '} ` +
      `局=${a.runs}（跑满 ${a.completeRuns}／可量度 ${a.measurableRuns}）起步局=${a.earlyStarters}/${a.measurableRuns} predict ${pct(a.given, a.checked)} 前5步 ${pct(a.earlyGiven, a.earlyChecked)} ` +
      `整局0给=${a.zeroRuns}局 testing写了=${a.testingGiven}(归因成 ${a.attributed}) goal声明=${a.goalDeclared} hp=0到达=${a.hpZeroReached}/${a.completeRuns} 与敌相邻过=${a.adjacentEnemyReached}/${a.completeRuns} 整局没掉血=${a.neverHurtRuns}/${a.completeRuns} 平均走过格=${a.meanCells.toFixed(1)} 平均血量种类=${a.meanHpValues.toFixed(1)}`,
    );
  }

  const on = arms.find((a) => a.goalOn === true);
  const off = arms.find((a) => a.goalOn === false);
  console.log('\n===== 稀释风险：目标契约块有没有压低 predict 采纳率 =====');
  if (!on || !off) {
    console.log('两档不齐（缺目标开或缺目标关），本轮不出检验。');
  } else if (on.measurableRuns < 2 || off.measurableRuns < 2) {
    console.log(`样本不够（开 ${on.measurableRuns} 局 / 关 ${off.measurableRuns} 局可量度），本轮不出 p 值——**不许把这行读成"没有差异"**。`);
  } else {
    // 主判据必须**以局为单位**：同一局内部的步高度自相关（头几步定了调就一直照着办），
    // 把步当独立样本会造出假显著——M4-b2 §2 第 3 条写的就是这件事。
    const a1 = on.earlyStarters;
    const b1 = on.measurableRuns - on.earlyStarters;
    const a2 = off.earlyStarters;
    const b2 = off.measurableRuns - off.earlyStarters;
    const pRuns = fisherExact(a1, b1, a2, b2);
    const vRuns = Number.isNaN(pRuns)
      ? '算不出（两档都没有可量度的局）'
      : pRuns < 0.05
        ? '**达到** 0.05 显著（以局为单位）'
        : `够不着 0.05。**"不显著"≠"已排除"**：局数只有 ${on.measurableRuns}+${off.measurableRuns}，这个功效本来就查不出中等效应`;
    console.log(`[主判据·以局为单位] 前 5 步内起步的局：开 ${pct(on.earlyStarters, on.measurableRuns)} vs 关 ${pct(off.earlyStarters, off.measurableRuns)} → Fisher 两尾 p=${pText(pRuns)}，${vRuns}`);
    const excluded = readings.filter((r) => !measurable(r.m)).length;
    if (excluded > 0) console.log(`    （${excluded} 局因"前 5 步可核对不足 3 步"排除在分母外，不是悄悄不算）`);

    // 以步为单位只当**描述统计**：样本大得虚假，p 值看着漂亮但全是伪重复换来的。
    const [g1, c1, g2, c2] = [on.earlyGiven, on.earlyChecked, off.earlyGiven, off.earlyChecked];
    const pSteps = fisherExact(g1, c1 - g1, g2, c2 - g2);
    console.log(`[描述·以步为单位] 前 5 步采纳率：开 ${pct(g1, c1)} vs 关 ${pct(g2, c2)} → 名义 p=${pText(pSteps)}，⚠️**伪重复，不许当检验结果引用**`);
    const [gg, gc, gh, gch] = [on.given, on.checked, off.given, off.checked];
    console.log(`[描述·以步为单位] 整局采纳率：开 ${pct(gg, gc)} vs 关 ${pct(gh, gch)} → 名义 p=${pText(fisherExact(gg, gc - gg, gh, gch - gh))}，同上不许引用；整局 0 给的局 开 ${on.zeroRuns}/${on.completeRuns}、关 ${off.zeroRuns}/${off.completeRuns}`);
  }
  console.log('\n[读法边界] 本表只回答"两档采纳率差多少"，不回答"目标接口好不好用"——后者要求模型真去调用它，见 goal-audit 的 [使用率]。');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith('ablation.ts')) {
  process.exit(main(process.argv.slice(2)));
}
