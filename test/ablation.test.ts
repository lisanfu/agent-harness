/**
 * M4-e 采纳率汇总脚本的单测（verify/ablation.ts）。
 *
 * 为什么这份测试必须存在：这个脚本算出来的数字**直接变成报告里的结论**，
 * 而它是本项目里第一处"判据是统计的"地方。前面几轮换来的纪律照搬过来——
 *   1. Fisher 的每一张表都小到能手算，所以断言写死手算结果，错了当场暴露；
 *   2. 逐帧重算与账本不一致时必须出声，不许静默取一个口径（故障 #14 家族）；
 *   3. "判据没跑"必须与"判据没发现问题"可区分（故障 #17）：零样本要拒绝退出 0。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fisherExact, readRun, measurable, main } from '../verify/ablation.ts';

// ────────────────────────── 1. Fisher 精确检验：断言写死手算值 ──────────────────────────

test('Fisher 两尾：边际固定后把不比观测表更可能的表全加起来（手算可复核）', () => {
  // 表 [[1,4],[5,0]]：n1=n2=5，成功数 k=6，C(10,6)=210。
  // 可能表只有 x=1..5：p(1)=C(5,1)C(5,5)/210=5/210，p(2)=50/210，p(3)=100/210，p(4)=50/210，p(5)=5/210。
  // 观测 x=1 → 两尾 = 2×5/210 = 1/21。
  assert.ok(Math.abs(fisherExact(1, 4, 5, 0) - 1 / 21) < 1e-12, '1/21≈0.047619');
});

test('Fisher 两尾：观测表就是最可能的表时 p=1（"不显著"不许读成"没差异"）', () => {
  // 表 [[2,3],[3,2]]：k=5，C(10,5)=252，六张表概率 1/252、25/252、100/252、100/252、25/252、1/252，
  // 观测 x=2 概率 100/252 是并列最大 → 全部加起来 = 1。
  assert.ok(Math.abs(fisherExact(2, 3, 3, 2) - 1) < 1e-12);
});

test('Fisher 两尾：完全一样的两表 p=1；一方全中另一方全不中才给出最小概率', () => {
  assert.ok(Math.abs(fisherExact(3, 2, 3, 2) - 1) < 1e-12);
  // [[5,0],[0,5]]：k=5，只有 x=0..5，p(x)=C(5,x)C(5,5-x)/252 → 观测 x=5 → p=1/252，两尾=2/252。
  assert.ok(Math.abs(fisherExact(5, 0, 0, 5) - 2 / 252) < 1e-12);
});

test('Fisher 两尾：某一档没有局 → NaN，绝不能当成 p=1 或 p=0 印出去', () => {
  assert.ok(Number.isNaN(fisherExact(3, 2, 0, 0)), '空分母必须是 NaN（脚本据此拒绝出结论）');
});

// ────────────────────────── 2. 逐帧指标：合成一局最小证据 ──────────────────────────

/** 造一局最小证据：前 5 步里第 2、3 步给了 predict，第 4 步是工具步（代码没法核对）。 */
function makeRun(over: { declaredGoals?: number; ledgerGiven?: number; ledgerChecked?: number; ledgerDeclared?: number; buckets?: Record<string, number>; checkProblem?: string | null; maxSteps?: number; stopReason?: string; truncateAt?: number; hpSeen?: number[]; adjacentEnemyReached?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ablation-'));
  const runDir = join(root, '20261114-000000-s6');
  mkdirSync(runDir);
  const all: unknown[] = [
    { index: 1, decision: { thought: 't', call: { name: 'look', args: {} } } },
    { index: 2, decision: { thought: 't', call: { name: 'move', args: {} }, predict: { hpDelta: 0 } } },
    { index: 3, decision: { thought: 't', call: { name: 'move', args: {} }, predict: { hpDelta: -2 }, testing: { id: 'H1' } } },
    { index: 4, decision: { thought: 't', call: { name: 'note', args: {} }, predict: { hpDelta: 0 } } },
    { index: 5, decision: { thought: 't', call: { name: 'move', args: {} } } },
    { kind: 'prediction_check', payload: { step: 2, given: true } },
    { kind: 'prediction_check', payload: { step: 3, given: true } },
    { kind: 'prediction_check', payload: { step: 5, given: false } },
    { kind: 'goal_write', payload: { op: 'declare', step: 3 } },
    { kind: 'hypothesis_check', payload: { step: 3, problem: over.checkProblem ?? null } },
  ];
  const declared = over.declaredGoals ?? 1;
  for (let i = 1; i < declared; i++) all.push({ kind: 'goal_write', payload: { op: 'declare', step: 4 } });
  // 打断局：只保留前 truncateAt 步（事件按 step/index 一起过滤，证据必须自洽）
  const cap = over.truncateAt;
  const trace = cap === undefined ? all : all.filter((e) => {
    const rec = e as { index?: number; payload?: { step?: number } };
    const n = rec.index ?? rec.payload?.step;
    return n === undefined || n <= cap;
  });
  const steps = trace.filter((e) => (e as { index?: number }).index !== undefined).length;
  writeFileSync(join(runDir, 'header.json'), JSON.stringify({
    runId: 'TEST-RUN', seed: 6, brainId: 'script:TEST', seams: { predict: true, goal: true },
    config: { maxSteps: over.maxSteps ?? 5 }, initialState: {},
  }));
  writeFileSync(join(runDir, 'trace.jsonl'), trace.map((t) => JSON.stringify(t)).join('\n') + '\n');
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    stopReason: over.stopReason ?? 'max_steps',
    steps: Array.from({ length: steps }, (_, i) => ({ index: i + 1 })),
  }));
  writeFileSync(join(runDir, 'coverage.json'), JSON.stringify({
    cellsVisited: 7, hpSeen: over.hpSeen ?? [8, 10], hpZeroReached: false,
    adjacentEnemyReached: over.adjacentEnemyReached ?? false, kills: 1,
  }));
  writeFileSync(join(runDir, 'defect.json'), JSON.stringify({
    predictionStats: { given: over.ledgerGiven ?? 2, checked: over.ledgerChecked ?? 3 },
    hypothesisStats: over.buckets ?? { attributed: 1, unknownTarget: 0, malformed: 0, notChecked: 0, fieldAbsent: 0 },
    goalStats: { declared: over.ledgerDeclared ?? declared },
  }));
  return { root, runDir };
}

test('readRun：起步取"最早那次可核对的给出"，工具步单独算 emitted 不混进 given', () => {
  const { root, runDir } = makeRun();
  const { m, problems } = readRun(runDir);
  assert.deepEqual(problems, [], '账本与逐帧应当一致');
  assert.equal(m.steps, 5);
  assert.equal(m.checked, 3, '只有 prediction_check 事件才算"代码核对过"');
  assert.equal(m.given, 2, '第 4 步是工具步：模型写了 predict，但代码没核对，不能进 given');
  assert.equal(m.emitted, 3, '但"模型确实写了三次"是行为证据，必须留得下');
  assert.equal(m.firstGivenStep, 2);
  assert.equal(m.earlyGiven, 2);
  assert.equal(m.earlyChecked, 3, '前 5 步里可核对的有 3 步');
  assert.equal(m.testingGiven, 1, '"写了 testing"是一个口径');
  assert.equal(m.attributed, 1, '"归因成功"是另一个口径，两者都有独立来源');
  assert.equal(m.goalDeclared, 1);
  assert.equal(m.complete, true);
  rmSync(root, { recursive: true, force: true });
});

test('readRun：逐帧与账本对不上时必须出声（不静默取一个口径）', () => {
  const { root, runDir } = makeRun({ ledgerGiven: 5 });
  const { problems } = readRun(runDir);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /predict given 逐帧=2 账本=5/);
  rmSync(root, { recursive: true, force: true });
});

test('readRun：goal 声明数与账本对不上同样出声（"没用过"不许被伪造成"量过"）', () => {
  // 事件里只有 1 条 declare，账本却写 3 → 必须撞出来
  const { root, runDir } = makeRun({ ledgerDeclared: 3 });
  const { m, problems } = readRun(runDir);
  assert.equal(m.goalDeclared, 1);
  assert.ok(problems.some((p) => p.includes('goal 声明 逐帧=1 账本=3')), problems.join('|'));
  rmSync(root, { recursive: true, force: true });
});

test('readRun：被 429 打断的局标 complete=false，且可核对不足 3 步时"起步"量不出（不进主判据分母）', () => {
  // 只跑到第 3 步：前 5 步窗口里可核对的只剩 2 步 → measurable=false，
  // 但局粒度仍可数（跑满=false）。两者必须分开，否则"没量出"会被读成"量出个 0"。
  const { root, runDir } = makeRun({ truncateAt: 3, stopReason: 'brain_failed', maxSteps: 25, ledgerChecked: 2 });
  const { m, problems } = readRun(runDir);
  assert.deepEqual(problems, [], '过滤后的证据仍然自洽');
  assert.equal(m.complete, false);
  assert.equal(measurable(m), false, '前 5 步只核对了 2 步 → 这局不进主判据分母');
  rmSync(root, { recursive: true, force: true });

  const { root: r2, runDir: d2 } = makeRun({ truncateAt: 5, stopReason: 'brain_failed', maxSteps: 25 });
  const { m: m2, problems: p2 } = readRun(d2);
  assert.deepEqual(p2, []);
  assert.equal(m2.complete, false, '预算 25 步只跑到 5 步：没跑满');
  assert.equal(m2.earlyChecked, 3);
  assert.equal(measurable(m2), true, '但前 5 步核对满 3 步，起步与否量得出');
  rmSync(r2, { recursive: true, force: true });
});

// ────────────────────────── 3. 归因口径：故障 #18 的两侧 ──────────────────────────

test('写了 testing 但归因没成立（fieldAbsent）→ 一致，不许报不一致（这是故障 #18 的放行侧）', () => {
  // 第 3 步写 testing 指向没预测过的字段：代码照样落 hypothesis_check 事件，只是 problem 不为 null。
  // 于是"写了 1 步 / 归因成功 0 步"是**正常形状**，拿 attributed 当逐帧口径的旧写法会在这里误报。
  const { root, runDir } = makeRun({
    buckets: { attributed: 0, unknownTarget: 0, malformed: 0, notChecked: 0, fieldAbsent: 1 },
    checkProblem: 'field_absent',
  });
  const { m, problems } = readRun(runDir);
  assert.equal(m.testingGiven, 1);
  assert.equal(m.attributed, 0);
  assert.deepEqual(problems, [], problems.join('|'));
  rmSync(root, { recursive: true, force: true });
});

test('五个桶合计与"写了 testing 的步数"对不上 → 必须出声（拒绝侧）', () => {
  const { root, runDir } = makeRun({
    buckets: { attributed: 0, unknownTarget: 0, malformed: 0, notChecked: 0, fieldAbsent: 5 },
  });
  const { problems } = readRun(runDir);
  assert.ok(problems.some((p) => p.includes('五个归因桶合计=5 写了 testing 的步=1')), problems.join('|'));
  rmSync(root, { recursive: true, force: true });
});

// ────────────────────────── 4. 受伤口径：相邻 ≠ 掉血（报告里最容易写混的一对） ──────────────────────────

test('整局没掉血 = 血量只见过一种值；与"与敌相邻过"是两个独立口径（M4-e §5 的对照靠这两个数）', () => {
  // 见过贴身、但一次血都没掉——真模型臂里 4/9 跑满局就是这个形状。
  // 如果实现把"相邻"当成"受伤"的代名词，这里第一行断言就会红。
  const { root, runDir } = makeRun({ hpSeen: [10], adjacentEnemyReached: true });
  const { m } = readRun(runDir);
  assert.equal(m.coverage.adjacentEnemyReached, true, '贴过身＝攻击与掉血的**前提**成立');
  assert.equal(m.coverage.neverHurt, true, '前提成立不等于结果发生：全程血量没变过就是没受伤');
  assert.equal(m.coverage.numHpValues, 1);
  rmSync(root, { recursive: true, force: true });

  const { root: r2, runDir: d2 } = makeRun({ hpSeen: [8, 10], adjacentEnemyReached: true });
  assert.equal(readRun(d2).m.coverage.neverHurt, false, '血量见过两种值＝掉过血');
  rmSync(r2, { recursive: true, force: true });

  // coverage.json 里压根没有 hpSeen 字段（旧证据）→ 不能算"没掉血"，
  // 也不能算"掉过血"：把它当成 neverHurt=false 是唯一不吹牛的方向，但**不许**反过来。
  const { root: r3, runDir: d3 } = makeRun();
  writeFileSync(join(d3, 'coverage.json'), JSON.stringify({ cellsVisited: 3, hpZeroReached: false, kills: 0 }));
  const m3 = readRun(d3).m;
  assert.equal(m3.coverage.neverHurt, false);
  assert.equal(m3.coverage.numHpValues, 0, '缺字段如实留 0 种，不猜');
  rmSync(r3, { recursive: true, force: true });
});

// ────────────────────────── 5. 零样本 / 缺证据守卫 ──────────────────────────

test('readRun：证据缺一个文件要说清缺的是哪个，main 带着半截证据拒绝出表', () => {
  const { root, runDir } = makeRun();
  rmSync(join(runDir, 'result.json'));
  assert.throws(() => readRun(runDir), /result\.json/);
  assert.equal(main([runDir]), 1, '少一份证据还照样出汇总表＝免检通道换了个入口');
  rmSync(root, { recursive: true, force: true });
});

test('main：不带任何 run 目录 → 退出码 1，不许打印"0 处不一致"式的绿', () => {
  assert.equal(main([]), 1);
});
