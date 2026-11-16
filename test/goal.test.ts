/**
 * 目标器官本身的单元测试（M4-b2）。
 *
 * 目标故障（真跑逼出来的，不是设想）：M4-b1 第二局模型把
 * "需要探索：1)移动规则 2)敌人行为 3)拾取效果 4)攻击机制" 塞进了**假设板正文**——
 * 它有目标，却没有目标通道，只能把待办清单伪装成假设。
 * 而 M3 早就给了硬约束：探索必须能表达"我要制造 hp=0 的局面"这类**状态条件意图**，
 * 随机游走 320 步对 M07 的检出率只有 16.7%，加长度救不回来。
 *
 * 与 goal-loop.test.ts 的分工：那边验**接线**（工具→循环→大脑→线上 payload→证据），
 * 这边验**器官自身的不变量**——尤其是三条容易被接线测试漏掉的：
 *   1. 计数闭合：met + unmet + unverifiable === checks 恒成立
 *   2. 三态合取：一个 violated 压倒 unverifiable；无法判定绝不许算成"达成"
 *   3. 客观计数不受主观状态影响：模型标 achieved/abandoned 之后代码照样判定，
 *      否则它只要声明一句就能把计数停掉，评测指标当场被被测对象控制。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Goals, describeGoalCheck, goalAttention } from '../src/goal.ts';
import type { GoalWrite, PredictionDiff } from '../src/types.ts';

const FIELDS = ['hp', 'score', 'playerAt', 'enemyCount', 'pickupCount', 'alive', 'attackReady'] as const;

function organ(): { g: Goals; writes: GoalWrite[]; setStep: (n: number) => void } {
  let step = 0;
  const writes: GoalWrite[] = [];
  const g = new Goals({ step: () => step, fields: FIELDS, onWrite: (w) => writes.push(w) });
  return { g, writes, setStep: (n) => { step = n; } };
}

const diff = (field: string, status: PredictionDiff['status'], actual: unknown = 0): PredictionDiff =>
  ({ field, predicted: 0, actual, status });

/** 固定返回一份差异的判定器。器官不认识屏幕，判定由世界层注入——这里用桩代替世界层。 */
const fixed = (diffs: PredictionDiff[]) => () => diffs;

/**
 * 假画面：字段 → 实际值。按条件里的期望值逐字段做等值判定，模拟世界层的真实语义。
 * 多目标测试必须用它：拿一份固定差异喂给所有目标，会让"hp 条件"和"enemyCount 条件"
 * 收到同一个字段，测出来的行为在世界里根本不会发生（测试前提错，不是代码错）。
 */
const fakeScreen = (actual: Record<string, unknown>) => (cond: Record<string, unknown>): PredictionDiff[] =>
  Object.entries(cond).map(([field, want]) => {
    const a = actual[field];
    const status: PredictionDiff['status'] = a === undefined ? 'unverifiable'
      : JSON.stringify(a) === JSON.stringify(want) ? 'ok' : 'violated';
    return { field, predicted: want, actual: a ?? null, status };
  });

test('计数闭合恒等式：任意混合判定之后，三态之和恒等于 checks', () => {
  const { g, setStep } = organ();
  g.write({ id: 'G1', text: '我要制造血量归零的局面', doneWhen: { hp: 0 } });
  const rounds: PredictionDiff[][] = [
    [diff('hp', 'violated', 7)],
    [diff('hp', 'violated', 3)],
    [diff('hp', 'ok', 0)],
    [diff('hp', 'unverifiable', null)],
    [diff('hp', 'ok', 0)],
    [diff('hp', 'unverifiable', null)],
  ];
  let n = 0;
  for (const r of rounds) {
    n++;
    setStep(n);   // 步号由循环层注入，夹具必须自己推进，否则盖戳全是 0
    g.evaluate(fixed(r));
    const goal = g.get('G1')!;
    assert.equal(goal.checks, n);
    assert.equal(goal.met + goal.unmet + goal.unverifiable, goal.checks, '账本漏项');
    assert.equal(goal.lastCheckedStep, n);
  }
  const goal = g.get('G1')!;
  assert.deepEqual(
    { met: goal.met, unmet: goal.unmet, unverifiable: goal.unverifiable },
    { met: 2, unmet: 2, unverifiable: 2 },
  );
  assert.equal(goal.firstMetStep, 3, '首次达成必须盖步号戳，否则事后无从复核是哪一步');
});

test('三态合取：一个 violated 压倒 unverifiable；无法判定绝不算达成，也绝不算不达成', () => {
  const { g } = organ();
  g.write({ id: 'G1', text: '清空敌人且自己满血', doneWhen: { enemyCount: 0, hp: 10 } });

  // 一个不满足 + 一个无法核对 → 整体**明确不满足**（不满足是硬事实）
  let [c] = g.evaluate(fixed([diff('enemyCount', 'violated', 2), diff('hp', 'unverifiable', null)]));
  assert.equal(c!.met, false);
  assert.equal(g.get('G1')!.unmet, 1);

  // 全 ok → 达成
  [c] = g.evaluate(fixed([diff('enemyCount', 'ok', 0), diff('hp', 'ok', 10)]));
  assert.equal(c!.met, true);
  assert.equal(g.get('G1')!.met, 1);

  // 一个 ok + 一个无法核对 → **无法判定**。既不能报达成（凭空制造成功），
  // 也不能报不达成（凭空制造失败）。这是 M4-a 三态诚实在合取上的延伸。
  [c] = g.evaluate(fixed([diff('enemyCount', 'ok', 0), diff('hp', 'unverifiable', null)]));
  assert.equal(c!.met, null);
  const goal = g.get('G1')!;
  assert.deepEqual(
    { checks: goal.checks, met: goal.met, unmet: goal.unmet, unverifiable: goal.unverifiable },
    { checks: 3, met: 1, unmet: 1, unverifiable: 1 },
  );
});

test('判定绝不改 status：判断权归模型，代码只动计数', () => {
  const { g } = organ();
  g.write({ id: 'G1', text: '血量归零', doneWhen: { hp: 0 }, status: 'open' });
  g.evaluate(fixed([diff('hp', 'ok', 0)]));
  assert.equal(g.get('G1')!.status, 'open', '画面满足了也不许代码替它标 achieved');
  assert.deepEqual(g.metNotClosed(), ['G1']);
  // 模型自己收口之后，出声名单立刻清空——但计数一个都不许少
  g.write({ id: 'G1', status: 'achieved', why: '画面已经 0/10，我确认达成' });
  assert.deepEqual(g.metNotClosed(), []);
  assert.deepEqual(g.nagging(), []);
  assert.equal(g.get('G1')!.met, 1, '收口不是抹掉客观事实');
  assert.equal(g.get('G1')!.statusWhy, '画面已经 0/10，我确认达成');
});

test('客观计数不受主观状态影响：标 achieved / abandoned 之后照样判定', () => {
  const { g } = organ();
  g.write({ id: 'G1', text: '血量归零', doneWhen: { hp: 0 } });
  g.write({ id: 'G2', text: '走到右下角', doneWhen: { playerAt: [7, 7] } });
  g.write({ id: 'G1', status: 'achieved', why: '我觉得达成了' });
  g.write({ id: 'G2', status: 'abandoned', why: '走不过去，放弃' });
  // 若计数随状态停摆，模型只要声明一句就能把指标关掉——评测被被测对象控制
  const checks = g.evaluate(fakeScreen({ hp: 9 }));
  assert.deepEqual(checks.map((c) => c.goal.id).sort(), ['G1', 'G2']);
  assert.equal(g.get('G1')!.checks, 1);
  assert.equal(g.get('G2')!.checks, 1);
  assert.deepEqual(g.closedNeverMet(), ['G1'], '自称达成却从未被画面满足 = 主客观脱钩');
});

test('出声判据三条互斥：一条目标最多一个理由，名单与行数天然对得上', () => {
  const { g } = organ();
  g.write({ id: 'G1', text: '血量归零', doneWhen: { hp: 0 } });          // 正常待达成
  g.write({ id: 'G2', text: '随便走走' });                                // 没有完成条件
  g.write({ id: 'G3', text: '清空敌人', doneWhen: { enemyCount: 0 } });
  g.write({ id: 'G4', text: '满血', doneWhen: { hp: 10 } });
  g.evaluate(fakeScreen({ hp: 3, enemyCount: 0 }));
  // G1 条件可判定、这一步没满足 → **不出声**（那正是追目标过程中的正常状态，出声就是噪音）
  // G2 没给完成条件 → 出声；G3 这一步被画面满足了却仍标 open → 出声
  assert.deepEqual(g.nagging(), ['G2', 'G3']);
  assert.ok(!g.nagging().includes('G1'), '正常待达成也出声 = 制造噪音');
  assert.deepEqual(g.metNotClosed(), ['G3']);

  g.write({ id: 'G3', status: 'achieved', why: '敌人清完了' });
  assert.deepEqual(g.closedNeverMet(), [], 'G3 真被画面满足过，不算脱钩');
  g.write({ id: 'G4', status: 'achieved', why: '我觉得满血了' });
  assert.deepEqual(g.closedNeverMet(), ['G4']);
  assert.deepEqual(g.nagging(), ['G2', 'G4']);

  // 让 G1 真被满足一次：它从"不出声"变成 met_not_closed，且只有一个理由。
  // 同一帧 hp=0 对 G4（要 hp=10）是明确不满足，所以 G4 仍然停在"自称达成却从未满足"。
  g.evaluate(fakeScreen({ hp: 0, enemyCount: 0 }));
  assert.equal(goalAttention(g.get('G1')!), 'met_not_closed');
  assert.deepEqual(g.metNotClosed(), ['G1']);
  assert.deepEqual(g.nagging(), ['G1', 'G2', 'G4']);
  for (const id of g.ids()) {
    const reasons = [g.metNotClosed(), g.closedNeverMet(), g.uncheckable()].filter((l) => l.includes(id));
    assert.ok(reasons.length <= 1, `${id} 同时落进两个出声名单 = 判据不互斥`);
    // 名单与三个分类必须一致：G3 已收口且真被满足过，两边都不该有它
    assert.equal(reasons.length === 1, g.nagging().includes(id), `${id} 的出声名单与分类对不上`);
  }
});

test('全部字段都无法核对：算"无法判定"，并且要出声说清缺的是哪个接口', () => {
  const { g } = organ();
  g.write({ id: 'G1', text: '把敌人血量打光', doneWhen: { enemyHp: 0 } });
  const [c] = g.evaluate(fixed([diff('enemyHp', 'unverifiable', null)]));
  assert.equal(c!.met, null);
  const goal = g.get('G1')!;
  assert.equal(goal.checks, 1);
  assert.equal(goal.unverifiable, 1);
  assert.equal(goal.met, 0);
  assert.deepEqual(g.uncheckable(), ['G1'], '条件写了却永远判不出结果 = 目标通道空转，必须出声');
  assert.equal(goalAttention(goal), 'uncheckable');
});

test('空条件不判定：checks 不增，但 uncheckable 要出声（不丢也不猜）', () => {
  const { g } = organ();
  g.write({ id: 'G1', text: '我想变强', doneWhen: {} });
  g.write({ id: 'G2', text: '我想活下去' });
  const checks = g.evaluate(fixed([diff('hp', 'ok', 0)]));
  assert.deepEqual(checks, [], '没有字段就没什么可判定的，绝不凭空记一次达成');
  assert.equal(g.get('G1')!.checks, 0);
  assert.equal(g.get('G2')!.checks, 0);
  assert.deepEqual(g.uncheckable(), ['G1', 'G2']);
});

test('doneWhen 形状不可用：留原文、不猜、单独计数', () => {
  const { g, writes } = organ();
  const w = g.write({ id: 'G1', text: '血量归零', doneWhen: 'hp=0' as unknown });
  assert.equal(w.ok, true, '形状歪不该整条拒绝：那会抹掉"模型确实立了目标"这个行为');
  const goal = g.get('G1')!;
  assert.equal(goal.doneWhen, null, '绝不把字符串猜解析成条件');
  assert.equal(goal.doneWhenRaw, 'hp=0', '原文必须留档（故障 #9：静默丢弃 = 归因作废）');
  assert.deepEqual(g.evaluate(fixed([diff('hp', 'ok', 0)])), []);
  assert.deepEqual(g.uncheckable(), ['G1']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.after!.doneWhenRaw, 'hp=0');
});

test('未知 id 只改状态 → 拒绝，绝不悄悄新建一条目标', () => {
  const { g, writes } = organ();
  const w = g.write({ id: 'G9', status: 'achieved' });
  assert.equal(w.ok, false);
  assert.match(w.message, /G9/);
  assert.deepEqual(g.ids(), []);
  assert.equal(writes.length, 1, '被拒的写入也要落盘：否则分不清"没立过"和"立了被拒"');
  assert.equal(writes[0]!.ok, false);
});

test('非法 status → 拒绝并列出合法值（拒绝理由必须可行动）', () => {
  const { g } = organ();
  g.write({ id: 'G1', text: '血量归零', doneWhen: { hp: 0 } });
  const w = g.write({ id: 'G1', status: 'done' });
  assert.equal(w.ok, false);
  assert.match(w.message, /open/);
  assert.match(w.message, /achieved/);
  assert.match(w.message, /abandoned/);
  assert.equal(g.get('G1')!.status, 'open');
});

test('已存在的 id 什么都不给 → 拒绝，绝不把空操作记成一次意图声明', () => {
  const { g } = organ();
  g.write({ id: 'G1', text: '血量归零', doneWhen: { hp: 0 } });
  const w = g.write({ id: 'G1' });
  assert.equal(w.ok, false);
  assert.equal(g.get('G1')!.checks, 0);
});

test('新建必须给正文；id 空白一律拒绝', () => {
  const { g } = organ();
  assert.equal(g.write({ id: 'G1', doneWhen: { hp: 0 } }).ok, false);
  assert.equal(g.write({ id: '   ', text: 'x' }).ok, false);
  assert.equal(g.write({ id: 'G1', text: '   ' }).ok, false);
  assert.deepEqual(g.ids(), []);
});

test('改写完成条件要留痕：conditionChanged 与旧的 before 快照都在', () => {
  const { g, setStep } = organ();
  setStep(2);
  g.write({ id: 'G1', text: '血量归零', doneWhen: { hp: 0 } });
  g.evaluate(fixed([diff('hp', 'violated', 5)]));
  setStep(5);
  const w = g.write({ id: 'G1', doneWhen: { alive: false }, why: '血量看不见，改用状态行' });
  assert.equal(w.ok, true);
  assert.equal(w.conditionChanged, true);
  assert.equal(w.textChanged, false);
  assert.deepEqual(w.before!.doneWhen, { hp: 0 });
  assert.deepEqual(w.after!.doneWhen, { alive: false });
  // 换条件之后旧计数怎么处理？刻意**不清零**：清零等于抹掉"它曾经追过一个判不出的条件"这段历史。
  // 代价是计数横跨两个条件，必须在文档里写明这个局限，而不是偷偷重置。
  assert.equal(g.get('G1')!.checks, 1);
  assert.equal(g.get('G1')!.unmet, 1);
});

test('交出去的一律是副本：后续写入与判定不许篡改历史证据', () => {
  const { g, writes } = organ();
  g.write({ id: 'G1', text: '血量归零', doneWhen: { hp: 0 } });
  const snapshot = g.get('G1')!;
  const all = g.all();
  const [c] = g.evaluate(fixed([diff('hp', 'ok', 0)]));
  snapshot.status = 'abandoned';
  snapshot.met = 999;
  all[0]!.text = '被外面改掉了';
  c!.goal.met = 999;
  assert.equal(g.get('G1')!.status, 'open');
  assert.equal(g.get('G1')!.met, 1);
  assert.equal(g.get('G1')!.text, '血量归零');
  assert.equal(writes[0]!.after!.met, 0, '落盘的写入快照被后续判定篡改 = 审计看到的不是当时那份');
  assert.equal(writes[0]!.after!.doneWhen!['hp'], 0);
  // doneWhen 是对象，浅拷贝不够：必须连它一起复制
  writes[0]!.after!.doneWhen!['hp'] = 42;
  assert.equal(g.get('G1')!.doneWhen!['hp'], 0, 'doneWhen 只浅拷贝 = 外部能改到板上的条件');
});

test('首次达成才出声，重复达成不刷屏；文本只陈述事实并把判断权交回模型', () => {
  const { g, setStep } = organ();
  g.write({ id: 'G1', text: '血量归零', doneWhen: { hp: 0 } });
  setStep(3);
  const first = g.evaluate(fixed([diff('hp', 'ok', 0)]));
  assert.equal(first[0]!.firstMet, true);
  const text = describeGoalCheck(first);
  assert.ok(text !== null);
  assert.match(text!, /G1/);
  assert.match(text!, /首次/);
  assert.match(text!, /由你判断|由你声明/);
  assert.ok(!text!.includes('应该'), '出声文案不许变成策略指挥');
  setStep(4);
  const again = g.evaluate(fixed([diff('hp', 'ok', 0)]));
  assert.equal(again[0]!.firstMet, false);
  assert.equal(describeGoalCheck(again), null, '每步都重复播报达成 = 噪音，还会挤爆上下文预算');
  assert.equal(describeGoalCheck([]), null);
});

test('未达成的判定不出声，但证据照样留（不丢）', () => {
  const { g } = organ();
  g.write({ id: 'G1', text: '血量归零', doneWhen: { hp: 0 } });
  const checks = g.evaluate(fixed([diff('hp', 'violated', 8)]));
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.met, false);
  assert.equal(describeGoalCheck(checks), null);
  assert.equal(g.get('G1')!.unmet, 1);
});

test('局末快照按状态计数，状态仍是模型声明的那一个', () => {
  const { g } = organ();
  g.write({ id: 'G1', text: 'a', doneWhen: { hp: 0 } });
  g.write({ id: 'G2', text: 'b', doneWhen: { score: 3 } });
  g.write({ id: 'G3', text: 'c', doneWhen: { alive: false } });
  g.write({ id: 'G2', status: 'achieved', why: 'x' });
  g.write({ id: 'G3', status: 'abandoned', why: 'y' });
  const all = g.all();
  assert.deepEqual(all.map((x) => x.status), ['open', 'achieved', 'abandoned']);
  assert.deepEqual(all.map((x) => x.id), ['G1', 'G2', 'G3'], '按创建顺序，淘汰/收口都不删除');
});