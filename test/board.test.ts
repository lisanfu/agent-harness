/**
 * 假设板器官本身的单元测试（M4-b1）。
 *
 * 与 hypothesis.test.ts 的分工：那边验**接线**（工具→循环→大脑→线上 payload→证据），
 * 这边验**器官自身的不变量**——尤其是两条容易被接线测试漏掉的：
 *   1. 计数闭合：supported + contradicted + unverifiable === checks 恒成立
 *   2. 快照语义：交出去的假设对象与落盘的事件必须是副本，
 *      否则后续写入会**篡改历史证据**，审计时看到的就不是当时那份了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, describeAttribution } from '../src/board.ts';
import type { BoardWrite, PredictionDiff } from '../src/types.ts';

function board(): { b: Board; writes: BoardWrite[]; setStep: (n: number) => void } {
  let step = 0;
  const writes: BoardWrite[] = [];
  const b = new Board({ step: () => step, onWrite: (w) => writes.push(w) });
  return { b, writes, setStep: (n) => { step = n; } };
}

const diff = (field: string, status: PredictionDiff['status']): PredictionDiff =>
  ({ field, predicted: 1, actual: 2, status });

test('计数闭合恒等式：任意混合核对之后，三态之和恒等于 checks', () => {
  const { b } = board();
  b.write({ id: 'H1', text: '敌人数量恒定' });
  const rounds: PredictionDiff[][] = [
    [diff('enemyCount', 'ok'), diff('playerAt', 'violated')],
    [diff('enemyDir', 'unverifiable')],
    [diff('hpDelta', 'violated'), diff('scoreDelta', 'violated'), diff('alive', 'ok')],
    [],
    [diff('pickupCount', 'unverifiable'), diff('attackReady', 'ok')],
  ];
  let n = 0;
  for (const r of rounds) {
    b.attribute('H1', r);
    n += r.length;
    const h = b.get('H1')!;
    assert.equal(h.checks, n);
    assert.equal(h.supported + h.contradicted + h.unverifiable, h.checks, '账本漏项');
  }
  assert.deepEqual(
    { supported: b.get('H1')!.supported, contradicted: b.get('H1')!.contradicted, unverifiable: b.get('H1')!.unverifiable },
    { supported: 3, contradicted: 3, unverifiable: 2 },
  );
});

test('归因绝不改 status：判断权归模型，代码只动计数', () => {
  const { b } = board();
  b.write({ id: 'H1', text: '敌人会新生成', status: 'confirmed', why: '我数错了' });
  for (let i = 0; i < 5; i++) b.attribute('H1', [diff('enemyCount', 'violated')]);
  const h = b.get('H1')!;
  assert.equal(h.contradicted, 5);
  assert.equal(h.status, 'confirmed', '代码擅自淘汰 = 启发式兜底，抢走大脑的判断权');
  assert.equal(h.statusWhy, '我数错了');
  assert.deepEqual(b.contradictedNotRetired(), ['H1']);
  // 模型自己淘汰之后，出声名单立刻清空——但计数一个都不许少
  b.write({ id: 'H1', status: 'retired', why: '画面里只减不增' });
  assert.deepEqual(b.contradictedNotRetired(), []);
  assert.equal(b.get('H1')!.contradicted, 5, '淘汰不是抹掉反证');
});

/**
 * 故障 #13 的器官级判据：出声名单由**事实**推出，两条互斥，且都不改 status。
 * 真跑里模型自称"此步验证了…"却从不声明 testing，计数恒为 0，
 * 于是"被反对才出声"的淘汰机制永不触发——所以零核对本身也必须出声。
 */
test('出声名单：被反对 / 自称成立却零核对，两条互斥且都只陈述事实', () => {
  const { b } = board();
  b.write({ id: 'H1', text: '敌人会新生成', status: 'confirmed' });
  b.write({ id: 'H2', text: '攻击有冷却', status: 'proposed' });
  b.write({ id: 'H3', text: '墙在 (3,3)', status: 'confirmed' });
  b.attribute('H3', [diff('playerAt', 'ok')]);

  // proposed 零核对是正常状态，不许出声（否则全是噪音）
  assert.deepEqual(b.confirmedNoChecks(), ['H1'], 'H3 已有核对，H2 只是 proposed');
  assert.deepEqual(b.contradictedNotRetired(), []);
  assert.deepEqual(b.nagging(), ['H1']);

  // 有了核对，零核对提示立刻消失；被反对则换成另一条
  b.attribute('H1', [diff('enemyCount', 'violated')]);
  assert.deepEqual(b.confirmedNoChecks(), []);
  assert.deepEqual(b.contradictedNotRetired(), ['H1']);
  assert.deepEqual(b.nagging(), ['H1'], '两条互斥：一条假设最多一个出声理由');
  assert.equal(b.get('H1')!.status, 'confirmed', '出声不等于代它改状态');

  // 淘汰之后两条都不再触发，但计数一个都不许少
  b.write({ id: 'H1', status: 'retired', why: '我数错了' });
  assert.deepEqual(b.nagging(), []);
  assert.equal(b.get('H1')!.contradicted, 1);

  // 全部无法核对 ≠ 被反对，也 ≠ 零核对：不许把不确定性算成反证
  b.write({ id: 'H4', text: '敌人血量看不见', status: 'confirmed' });
  b.attribute('H4', [diff('enemyHp', 'unverifiable')]);
  assert.deepEqual(b.nagging(), [], '无法核对既不是支持也不是反对，更不该触发淘汰提示');
  assert.equal(b.get('H4')!.checks, 1);
});

test('未知 id 归因返回 null，绝不悄悄新建一条假设', () => {
  const { b } = board();
  assert.equal(b.attribute('H9', [diff('enemyCount', 'ok')]), null);
  assert.deepEqual(b.ids(), []);
});

test('field 限定归因：只算那一个字段；没预测它就 fieldAbsent，不拿别的顶替', () => {
  const { b } = board();
  b.write({ id: 'H1', text: 'x' });
  const diffs = [diff('enemyCount', 'ok'), diff('playerAt', 'violated')];
  const a = b.attribute('H1', diffs, 'enemyCount')!;
  assert.deepEqual(a.fields, ['enemyCount']);
  assert.equal(a.fieldAbsent, false);
  assert.equal(b.get('H1')!.contradicted, 0, 'playerAt 不属于这条假设');

  const miss = b.attribute('H1', diffs, 'scoreDelta')!;
  assert.equal(miss.fieldAbsent, true);
  assert.deepEqual(miss.fields, []);
  assert.equal(b.get('H1')!.checks, 1, '没归因成功就不许加计数');
});

test('all() 与事件里的 before/after 都是副本：后续写入不得篡改历史', () => {
  const { b, writes } = board();
  b.write({ id: 'H1', text: '第一版' });
  const snap = b.all();
  b.write({ id: 'H1', text: '第二版' });
  b.attribute('H1', [diff('enemyCount', 'violated')]);

  assert.equal(snap[0]!.text, '第一版', 'all() 交出的是活引用 → 历史被篡改');
  assert.equal(snap[0]!.checks, 0);
  assert.equal(writes[0]!.after!.text, '第一版');
  assert.equal(writes[1]!.before!.text, '第一版', 'before 快照被后续写入污染');
  assert.equal(writes[1]!.after!.text, '第二版');
  assert.equal(writes[1]!.after!.checks, 0, 'after 快照不该带上之后的归因');
  // 调用方改自己手里的副本，也影响不到板子
  snap[0]!.text = '外部篡改';
  assert.equal(b.get('H1')!.text, '第二版');
});

test('被拒的写入也出声，且带上原始参数与当时的快照', () => {
  const { b, writes, setStep } = board();
  setStep(4);
  b.write({ id: 'H1', text: 'x' });
  setStep(7);
  const w = b.write({ id: 'H9', status: 'retired', why: '不成立' });
  assert.equal(w.ok, false);
  assert.equal(w.step, 7, '步号必须来自循环层注入的 getter');
  assert.equal(writes.length, 2, '被拒也要落盘：不丢，否则分不清"没写"和"写了被拒"');
  assert.deepEqual(writes[1]!.input, { id: 'H9', status: 'retired', why: '不成立' });
  assert.equal(writes[1]!.after, null);
  assert.equal(writes[1]!.before, null);
  assert.deepEqual(b.ids(), ['H1']);
});

// 故障 #19：板面按行认条目，正文跨行会把一条假设拆成几条。
// 拦在写入这里（一个类别一个主人），而不是渲染时悄悄改写——悄悄改写＝证据与自述分家。
test('跨行正文被拒且给可行动理由：不许悄悄渲染成多行，也不许静默收下（故障 #19）', () => {
  const { b, writes } = board();
  const multi = b.write({ id: 'H1', text: '敌人朝玩家移动\n观察：E1 (7,0)→(6,0)→向左' });
  assert.equal(multi.ok, false, '带换行的正文必须被拒');
  assert.match(multi.message, /一行/, '拒绝理由要说清合约：一条假设占一行');
  assert.match(multi.message, /note|拆成/, '还要给可行动的替代通道，不能只说 invalid');
  assert.deepEqual(b.ids(), [], '被拒的假设不许留在板上');
  assert.equal(writes.length, 1, '被拒也要落盘');
  // 已有的假设同样拦：改写时换成跨行正文不许通过
  b.write({ id: 'H2', text: '拾取物回血' });
  const rev = b.write({ id: 'H2', text: '第一行\n第二行' });
  assert.equal(rev.ok, false);
  assert.equal(b.get('H2')?.text, '拾取物回血', '被拒的改写不许动到板上正文');
});

test('改写正文与改状态分开记：空操作不算一次学习', () => {  const { b, writes } = board();
  b.write({ id: 'H1', text: 'x' });
  const same = b.write({ id: 'H1', text: 'x' });
  assert.equal(same.ok, true);
  assert.equal(same.textChanged, false, '写了一模一样的正文不该算一次修正');
  assert.equal(same.statusChanged, false);
  const st = b.write({ id: 'H1', status: 'confirmed' });
  assert.equal(st.textChanged, false);
  assert.equal(st.statusChanged, true);
  assert.equal(writes.length, 3);
});

test('纯笔记与结构化假设是两个互不干扰的通道', () => {
  const { b } = board();
  b.addPlain('门后可能有东西');
  b.write({ id: 'H1', text: '钥匙在门后' });
  b.addPlain('再看一眼');
  assert.deepEqual(b.plain(), ['门后可能有东西', '再看一眼']);
  assert.deepEqual(b.ids(), ['H1']);
  assert.equal(b.get('H1')!.checks, 0);
});

test('淘汰后仍留档：id、正文、理由、计数一个都不删', () => {
  const { b } = board();
  b.write({ id: 'H1', text: '敌人会新生成', status: 'confirmed' });
  b.attribute('H1', [diff('enemyCount', 'violated')]);
  b.write({ id: 'H1', status: 'retired', why: '只减不增' });
  const h = b.get('H1')!;
  assert.deepEqual(
    { id: h.id, text: h.text, status: h.status, statusWhy: h.statusWhy, contradicted: h.contradicted },
    { id: 'H1', text: '敌人会新生成', status: 'retired', statusWhy: '只减不增', contradicted: 1 },
  );
  assert.deepEqual(b.ids(), ['H1'], '淘汰不是删除：删了模型会把同一条假规则再立一遍');
});

// ── 归因出声文本：只陈述事实，不替模型下结论 ──────────────────

test('归因成功：文本报出增量与累计，并显式声明状态归模型', () => {
  const { b } = board();
  b.write({ id: 'H1', text: '敌人数量恒定' });
  const a = b.attribute('H1', [diff('enemyCount', 'violated'), diff('playerAt', 'ok')])!;
  const text = describeAttribution({ problem: null, test: { id: 'H1' }, knownIds: ['H1'], result: a })!;
  assert.match(text, /支持 \+1 \/ 反对 \+1 \/ 无法核对 \+0/);
  assert.match(text, /累计核对 2 次/);
  assert.ok(text.includes('由你声明，代码不会替你改'));
  assert.ok(!text.includes('应该淘汰'), '出声不许变成指令：那就成了启发式兜底');
});

test('四种归因失败都要出声，且给出可行动的下一步', () => {
  const ids = ['H1', 'H2'];
  const malformed = describeAttribution({
    problem: 'malformed', test: { id: null, raw: { field: 'x' } }, knownIds: ids, result: null,
  })!;
  assert.match(malformed, /形状不可用/);
  assert.ok(malformed.includes('"testing":"H1"'), '必须给出正确格式');

  const unknown = describeAttribution({
    problem: 'unknown_target', test: { id: 'H9' }, knownIds: ids, result: null,
  })!;
  assert.ok(unknown.includes('H9') && unknown.includes('H1, H2'), '必须点名错的 id 并列出现有 id');

  const notChecked = describeAttribution({
    problem: 'not_checked', test: { id: 'H1' }, knownIds: ids, result: null,
  })!;
  assert.match(notChecked, /没有产生可核对的画面事实/);

  const absent = describeAttribution({
    problem: 'field_absent', test: { id: 'H1', field: 'enemyCount' }, knownIds: ids, result: null,
    predictedFields: ['playerAt'],
  })!;
  assert.match(absent, /没有预测 enemyCount/);
  assert.ok(absent.includes('playerAt'), '必须告诉它这一步实际预测了什么');
});

test('空板时 unknown_target 也要说清楚"还没有"，不能给一个空列表', () => {
  const text = describeAttribution({
    problem: 'unknown_target', test: { id: 'H1' }, knownIds: [], result: null,
  })!;
  assert.ok(text.includes('（还没有）'));
});