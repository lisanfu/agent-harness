/**
 * 预测-对照闭环的接线测试（M4-a）。
 *
 * ⚠️ 本文件的方法论来自故障 #8：**分支跑了 ≠ 分支起作用**。
 * 当年"回炉提示"进了 history 却没进 payload，193 个测试全绿，因为没人断言线上内容。
 * 所以这里不只断言"算了 diff"，还必须断言 **diff 真的出现在大脑下一次收到的消息里**。
 *
 * 另外钉住四条诚实纪律：
 *  - 不推进画面的步（note/look/finish）不核对，否则白送"相符"，准确率灌水
 *  - 工具报错那一步不核对，世界里根本没发生
 *  - 没给预测也要留档（given=false）
 *  - 主观（decision.predict / surprise）与客观（prediction / predictionStats）分开存
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toWorldActions } from '../src/tools/game.ts';
import type { Brain, Decision, DecideRequest, HarnessConfig } from '../src/types.ts';
import { ALL_CAPS, createWorld, runSequence, step } from '../src/world/arena.ts';
import { runArena } from '../src/world/harness.ts';

/** 剧本大脑：按顺序吐决策，并把每次收到的 DecideRequest 原样抓出来看。 */
class ScriptBrain implements Brain {
  readonly id = 'script:TEST-DOUBLE';
  readonly seen: DecideRequest[] = [];
  private readonly script: Decision[];
  constructor(script: Decision[]) { this.script = script; }
  decide(req: DecideRequest): Promise<Decision> {
    this.seen.push(req);
    const d = this.script[this.seen.length - 1];
    return Promise.resolve(d ?? { thought: '剧本用完', call: { name: 'finish', args: { summary: 'end' } } });
  }
}

const d = (name: string, args: Record<string, unknown> = {}, extra: Partial<Decision> = {}): Decision =>
  ({ thought: 't', call: { name, args }, ...extra });

function cfg(over: Partial<HarnessConfig> = {}): HarnessConfig {
  const sandbox = mkdtempSync(join(tmpdir(), 'predict-sbx-'));
  writeFileSync(join(sandbox, 'a.txt'), 'hello');
  return {
    task: '零说明书试玩', sandbox, seed: 6, maxSteps: 12, maxWallMs: 30_000,
    maxContextChars: 20_000, keepRecent: 12, maxParseRetry: 2, repeatLimit: 9,
    outDir: mkdtempSync(join(tmpdir(), 'predict-out-')),
    ...over,
  };
}

/** seed=6 的真实世界推进。测试是裁判，可以读内部状态；agent 只能看屏幕。 */
const w0 = createWorld(6);
const w1 = step(w0, { kind: 'move', dir: 1 }, ALL_CAPS, 6);
const at1: [number, number] = [w1.player.x, w1.player.y];
const wrong1: [number, number] = [w1.player.x + 1, w1.player.y];
const hpDelta1 = w1.player.hp - w0.player.hp;

/** 六步剧本：note → 走(预测错) → 非法方向 → wait(不预测+说不意外) → wait(乱预测+说意外) → finish */
function script(): Decision[] {
  return [
    d('note', { text: '我先看看' }, { predict: { hpDelta: 0 } }),
    d('move', { dir: 'right' }, { predict: { playerAt: wrong1, hpDelta: hpDelta1 } }),
    d('move', { dir: 'north' }, { predict: { playerAt: at1 } }),
    d('wait', {}, { surprise: { unexpected: false, why: '我觉得都正常' } }),
    d('wait', {}, { predict: { hpDelta: 99, enemyDir: 1 }, surprise: { unexpected: true, why: '血条不对劲' } }),
    d('finish', { summary: '玩完了' }),
  ];
}

const readJsonl = (p: string): Record<string, unknown>[] =>
  readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

// ── A. 契约真的送出去了 ─────────────────────────────────

test('system 契约含预测字段与 surprise 格式（不是只写在代码里）', async () => {
  const brain = new ScriptBrain(script());
  await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const sys = brain.seen[0]!.system;
  assert.match(sys, /hpDelta/);
  assert.match(sys, /playerAt/);
  assert.match(sys, /"surprise"/);
  assert.match(sys, /预测不符不算失败/);
  // 契约仍是零说明书：不许出现策略
  for (const banned of ['优先探索', '边界值', '未访问区域', '覆盖率', '变异']) {
    assert.ok(!sys.includes(banned), `system 不该出现策略提示：${banned}`);
  }
});

// ── B. 差异真的回填进了下一次的 payload（故障 #8 的教训）──────

test('代码算出的差异出现在大脑下一次收到的消息里，且紧跟画面', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });

  // 第 1 步是 note，不推进画面 → 第 2 次请求里不该有任何对账文本
  const before = JSON.stringify(brain.seen[1]!.messages);
  assert.ok(!before.includes('预测对照'), 'note 那一步不该产生对账');

  // 第 2 步预测错了坐标 → 第 3 次请求必须带着这份差异
  const msgs = brain.seen[2]!.messages;
  const tool = msgs.filter((m) => m.role === 'tool' && m.toolName === 'move').pop();
  assert.ok(tool, '没找到 move 的返回消息');
  assert.match(tool!.content, /预测对照（由代码核对屏幕得出，不是你的自述）/);
  assert.match(tool!.content, /1 项不符/);
  assert.ok(tool!.content.includes(JSON.stringify(at1)), `回填里必须有画面数出来的真坐标 ${JSON.stringify(at1)}`);
  assert.ok(tool!.content.includes('**不符**'));
  // 画面与对账合成一条观察，画面在前
  assert.ok(tool!.content.indexOf('HP ') < tool!.content.indexOf('预测对照'));

  // 关键：两次请求的 payload 必须真的不同（#8 就是"看起来改了其实没改"）
  assert.notEqual(JSON.stringify(brain.seen[2]!.messages), JSON.stringify(brain.seen[1]!.messages));
  assert.equal(r.run.stopReason, 'finished');
});

test('第 1 次请求不含对账文本：差异只能来自已经发生过的动作', async () => {
  const brain = new ScriptBrain(script());
  await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  assert.ok(!JSON.stringify(brain.seen[0]!.messages).includes('预测对照'));
});

// ── C. 哪些步该核对、哪些不该 ────────────────────────────

test('note / 非法方向 / finish 都不核对；只有真推进画面的步才核对', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const steps = r.run.steps;

  assert.equal(steps[0]!.decision.call.name, 'note');
  assert.equal(steps[0]!.prediction, undefined, 'note 前后同一帧，核对它等于白送相符');
  assert.equal(steps[2]!.result.ok, false, '前提：north 是非法方向，应当被工具层拒绝');
  assert.equal(steps[2]!.prediction, undefined, '工具报错那一步世界里根本没发生');
  assert.equal(steps[5]!.decision.call.name, 'finish');
  assert.equal(steps[5]!.prediction, undefined);

  for (const i of [1, 3, 4]) assert.ok(steps[i]!.prediction, `第 ${i + 1} 步应当核对`);
});

test('没给预测的那一步也留档：given=false，不是悄悄跳过', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const p = r.run.steps[3]!.prediction!;
  assert.equal(p.given, false);
  assert.deepEqual(p.diffs, []);
  assert.equal(r.run.predictionStats!.missing, 1);
});

// ── D. 客观账本：数字必须对得上 ──────────────────────────

test('predictionStats 逐项对账：相符/不符/无法核对/意外判断分开记', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const ps = r.run.predictionStats!;
  assert.deepEqual(ps, {
    checked: 3,          // 第 2、4、5 步
    staticChecks: 0,     // 这个剧本没有 look
    given: 2,            // 第 2、5 步
    missing: 1,          // 第 4 步
    fields: 4,           // 2 + 0 + 2
    ok: 1,               // 第 2 步的 hpDelta
    violated: 2,         // 第 2 步 playerAt + 第 5 步 hpDelta
    unverifiable: 1,     // 第 5 步 enemyDir（内部字段，画面上没有）
    surpriseGiven: 2,
    surpriseUnexpected: 1,
    surpriseMalformed: 0,
    violatedButNotSurprised: 1,   // 第 4 步：上一步代码判不符，它却说"都正常"
  });
});

test('预测错的那一步：actual 是画面真值，不是模型自述', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const p = r.run.steps[1]!.prediction!;
  assert.equal(p.violated, 1);
  const bad = p.diffs.find((x) => x.field === 'playerAt')!;
  assert.equal(bad.status, 'violated');
  assert.deepEqual(bad.predicted, wrong1);
  assert.deepEqual(bad.actual, at1);
  const good = p.diffs.find((x) => x.field === 'hpDelta')!;
  assert.equal(good.status, 'ok', '同一份预测里对的字段要判对，不能一竿子全否');
});

test('内部字段预测判 unverifiable，绝不判 violated（不凭空制造异常）', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const p = r.run.steps[4]!.prediction!;
  assert.equal(p.diffs.find((x) => x.field === 'enemyDir')!.status, 'unverifiable');
  assert.equal(p.diffs.find((x) => x.field === 'hpDelta')!.status, 'violated');
  assert.equal(p.violated, 1);
});

test('全部预测正确时 violated=0：引擎不是"永远报违反"', async () => {
  // 这个剧本第一步就是 wait，所以基准是 w0 --wait--> v1 --wait--> v2，别复用 w1
  const v1 = step(w0, { kind: 'wait' }, ALL_CAPS, 6);
  const v2 = step(v1, { kind: 'wait' }, ALL_CAPS, 6);
  const brain = new ScriptBrain([
    d('wait', {}, {
      predict: {
        hpDelta: v1.player.hp - w0.player.hp,
        playerAt: [v1.player.x, v1.player.y],
        alive: v1.player.alive,
        enemyCount: v1.enemies.filter((e) => e.alive).length,
      },
    }),
    d('wait', {}, {
      predict: { hpDelta: v2.player.hp - v1.player.hp, playerAt: [v2.player.x, v2.player.y] },
      surprise: { unexpected: false, why: '和我想的一样' },
    }),
    d('finish', { summary: 'ok' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const ps = r.run.predictionStats!;
  assert.equal(ps.checked, 2);
  assert.equal(ps.given, 2);
  assert.equal(ps.violated, 0);
  assert.equal(ps.unverifiable, 0);
  assert.equal(ps.ok, 6);
  assert.equal(ps.violatedButNotSurprised, 0, '上一步没违反，说不意外是正常的');
});

test('look 也核对：不推进画面，但对当前画面的绝对量断言照样能被抓出来', async () => {
  // 真跑 M08 那局换来的修正：agent 第一步 look 就断言自己在 [1,1]、2 个敌人，
  // 实际是 [0,0]、3 个。旧闸门把 look 排除，等于把最大的一次感知错误放过去了。
  const brain = new ScriptBrain([
    d('look', {}, { predict: { playerAt: [1, 1], enemyCount: 2, hpDelta: 0 } }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const p = r.run.steps[0]!.prediction!;
  assert.equal(p.advanced, false, 'look 不推进帧');
  assert.deepEqual(p.diffs.find((x) => x.field === 'playerAt')!.actual, [0, 0]);
  assert.equal(p.diffs.find((x) => x.field === 'playerAt')!.status, 'violated');
  assert.equal(p.diffs.find((x) => x.field === 'enemyCount')!.status, 'violated');
  assert.equal(p.diffs.find((x) => x.field === 'hpDelta')!.status, 'ok', '同一帧血量当然不变');
  const ps = r.run.predictionStats!;
  assert.equal(ps.checked, 1);
  assert.equal(ps.staticChecks, 1, '这类偏容易的核对必须能与动作步分开算');
  assert.equal(r.worldActions, 0, 'look 不该进动作序列');
  assert.equal(r.evidenceConsistent, true);
});

test('动作步 advanced=true：两类核对分得开', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  for (const i of [1, 3, 4]) assert.equal(r.run.steps[i]!.prediction!.advanced, true);
  assert.equal(r.run.predictionStats!.staticChecks, 0);
});

// ── D2. 一份差异只被判断一次 ─────────────────────────────

test('连着两步都说不意外，只算一次：不重复计账放大"看见了不当回事"', async () => {
  // 中间必须用 note（不推进画面）：若用 wait，那一步自己也会被核对，
  // 后一个 surprise 就有新的差异可指代，测不到"重复计账"这条路。
  const brain = new ScriptBrain([
    d('move', { dir: 'right' }, { predict: { playerAt: wrong1 } }),
    d('note', { text: 'a' }, { surprise: { unexpected: false, why: '正常' } }),
    d('note', { text: 'b' }, { surprise: { unexpected: false, why: '还是正常' } }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const ps = r.run.predictionStats!;
  assert.equal(ps.surpriseGiven, 2);
  assert.equal(ps.violatedButNotSurprised, 1, '第二次判断没有新差异可对应，不该再计一次');

  const ev = readJsonl(join(r.run.runDir, 'trace.jsonl'))
    .filter((x) => x['kind'] === 'surprise_judgment')
    .map((x) => x['payload'] as { step: number; aboutStep: number | null; aboutViolated: number | null });
  assert.deepEqual(ev.map((e) => e.step), [2, 3]);
  assert.deepEqual(ev.map((e) => e.aboutStep), [1, null], '判断必须能追溯到具体哪一步的差异');
  assert.deepEqual(ev.map((e) => e.aboutViolated), [1, null]);
});

test('没预测的那一步也算一次核对：后续判断指向它，而不是更早那次违反', async () => {
  // 诚实纪律：模型这一步看到的是"你没给 predict"，不是上一步的违反。
  // 把旧违反算到它头上，就是冤枉它"看见了不当回事"。
  const brain = new ScriptBrain([
    d('move', { dir: 'right' }, { predict: { playerAt: wrong1 } }),
    d('wait', {}),
    d('wait', {}, { surprise: { unexpected: false, why: '没什么不对' } }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  assert.equal(r.run.predictionStats!.violatedButNotSurprised, 0);
  const ev = readJsonl(join(r.run.runDir, 'trace.jsonl'))
    .filter((x) => x['kind'] === 'surprise_judgment')
    .map((x) => x['payload'] as { aboutStep: number | null; aboutViolated: number | null })
    .map((e) => ({ aboutStep: e.aboutStep, aboutViolated: e.aboutViolated }));
  assert.deepEqual(ev, [{ aboutStep: 2, aboutViolated: 0 }]);
});

test('判断写歪了单独记一笔：不混进可用判断，也不凭空算成"不意外"', async () => {
  const brain = new ScriptBrain([
    d('move', { dir: 'right' }, { predict: { playerAt: wrong1 } }),
    d('note', { text: 'a' }, { surprise: { unexpected: null, why: '{"unexpected":"也许"}' } }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const ps = r.run.predictionStats!;
  assert.equal(ps.surpriseMalformed, 1);
  assert.equal(ps.surpriseGiven, 0);
  assert.equal(ps.violatedButNotSurprised, 0, '形状不可用不等于"说不意外"');
});

// ── E. 主观与客观分开存 ─────────────────────────────────

test('trace 里 result.output 仍是纯画面，对账文本只进 prediction 与 history', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  for (const s of r.run.steps) {
    assert.ok(!s.result.output.includes('预测对照'), '工具返回被对账文本污染了，证据就不纯了');
  }
  // 主观自述留档在 decision 里
  assert.deepEqual(r.run.steps[1]!.decision.predict, { playerAt: wrong1, hpDelta: hpDelta1 });
  assert.deepEqual(r.run.steps[3]!.decision.surprise, { unexpected: false, why: '我觉得都正常' });
});

test('prediction_check 事件逐步落盘，没预测的那一步也在', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const rows = readJsonl(join(r.run.runDir, 'trace.jsonl'));
  const ev = rows.filter((x) => x['kind'] === 'prediction_check');
  assert.equal(ev.length, 3);
  const payload = ev.map((x) => x['payload'] as { step: number; given: boolean });
  assert.deepEqual(payload.map((p) => p.step), [2, 4, 5]);
  assert.deepEqual(payload.map((p) => p.given), [true, false, true]);
});

test('回填原文落盘，且与大脑下一次收到的消息逐字相同（真跑也能证送达）', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const rows = readJsonl(join(r.run.runDir, 'trace.jsonl'));
  const fb = rows.filter((x) => x['kind'] === 'prediction_feedback')
    .map((x) => x['payload'] as { aboutStep: number; text: string });
  const checks = rows.filter((x) => x['kind'] === 'prediction_check');
  assert.equal(fb.length, checks.length, '每一次核对都必须留下回填原文，不许只记判定不记送了什么');
  assert.deepEqual(fb.map((f) => f.aboutStep), [2, 4, 5]);

  // 判据：history 整份下发 → 第 N 步回填的原文，必须逐字出现在第 N+1 次请求里。
  // 这条规则让**真跑的证据**也能证送达，不必靠"模型引用了差异"去反推。
  for (const f of fb) {
    const next = brain.seen[f.aboutStep];   // seen[N] 就是第 N+1 步的请求
    assert.ok(next, `第${f.aboutStep}步之后没有下一次请求，无法断言送达`);
    const name = r.run.steps[f.aboutStep - 1]!.decision.call.name;
    const tool = next.messages.filter((m) => m.role === 'tool' && m.toolName === name).pop();
    assert.ok(tool, `第${f.aboutStep + 1}次请求里没有 ${name} 的返回消息`);
    assert.ok(tool!.content.endsWith(`\n\n${f.text}`), '落盘原文与线上 payload 不逐字相同 → 证据不可用于审计');
  }
});

test('最后一步的回填也留档，但不冒充已送达：没有下一次请求就是没送到', async () => {
  const brain = new ScriptBrain([d('move', { dir: 'right' }, { predict: { playerAt: wrong1 } })]);
  const r = await runArena({ brain, seed: 6, config: cfg({ maxSteps: 1 }), doMinimize: false });
  assert.equal(r.run.stopReason, 'max_steps');
  assert.equal(brain.seen.length, 1, '前提：只发生了一次大脑请求');
  const rows = readJsonl(join(r.run.runDir, 'trace.jsonl'));
  const fb = rows.filter((x) => x['kind'] === 'prediction_feedback')
    .map((x) => x['payload'] as { aboutStep: number; text: string });
  assert.equal(fb.length, 1, '核对发生了就要留档，即使这一步之后整局就结束了');
  assert.equal(fb[0]!.aboutStep, 1);
  assert.match(fb[0]!.text, /1 项不符/);
  // 事件里没有"已送达"字段：送达与否由「是否存在第 N+1 步」推出，不由引擎自述。
  assert.ok(!('delivered' in fb[0]!), '不许引擎自己宣称送达——那正是 #8 那种自说自话');
});

test('result.json 与 defect.json 都带上客观账本，且不在 agentClaims 里', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const result = JSON.parse(readFileSync(join(r.run.runDir, 'result.json'), 'utf8'));
  const defect = JSON.parse(readFileSync(r.files.defect, 'utf8'));
  assert.deepEqual(result.predictionStats, r.run.predictionStats);
  assert.deepEqual(defect.predictionStats, r.run.predictionStats);
  assert.ok(!('predictionStats' in defect.agentClaims), '客观账本混进主观陈述就没法对账了');
});

// ── F. M4 接线不许扰动 M2/M3 的确定性 ────────────────────

test('加了预测闭环，动作序列与逐帧哈希仍与纯世界重放逐位相同', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  assert.equal(r.evidenceConsistent, true);
  const actions = toWorldActions(r.run.actionSequence);
  assert.equal(actions.length, 3, 'note / 非法方向 / finish 都不该进动作序列');
  const replay = runSequence(6, actions, ALL_CAPS);
  const frames = readJsonl(r.files.world) as unknown as { hash: string }[];
  assert.deepEqual(frames.map((f) => f.hash), replay.hashes, '预测闭环污染了世界重放');
  assert.equal(r.run.steps.at(-1)!.stateHash, replay.hashes.at(-1));
});

// ── G. 关掉开关就退回 M1 条件（消融对照与复现都要用）──────────

test('doPredict=false：契约无预测字段、无 prediction、无 predictionStats', async () => {
  const brain = new ScriptBrain(script());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false, doPredict: false });
  const sys = brain.seen[0]!.system;
  assert.ok(!sys.includes('hpDelta'), '关掉后契约必须退回 M1 原样');
  assert.ok(!sys.includes('surprise'));
  assert.ok(!JSON.stringify(brain.seen.map((s) => s.messages)).includes('预测对照'));
  for (const s of r.run.steps) assert.equal(s.prediction, undefined);
  assert.equal(r.run.predictionStats, undefined);
  const rows = readJsonl(join(r.run.runDir, 'trace.jsonl'));
  assert.equal(rows.filter((x) => x['kind'] === 'prediction_check').length, 0);
  const defect = JSON.parse(readFileSync(r.files.defect, 'utf8'));
  assert.equal(defect.predictionStats, null);
  // 世界照常推进：关掉预测不该改变游戏本身
  assert.equal(r.worldActions, 3);
  assert.equal(r.evidenceConsistent, true);
});