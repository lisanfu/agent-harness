/**
 * 预测-对照引擎测试（M4-a）。
 *
 * 钉住三件事，缺一件 M4 的结论就不成立：
 *  1. **差异由代码算**。模型说"我预测对了"不算数，屏幕说了算。
 *     M1 实测：agent 连续 4 次声称"我脚下有 +"，客观账本 stoodOnPickup=false。
 *  2. **无法核对 ≠ 预测被违反**。屏幕缺行、值不合法、字段不认识 → unverifiable。
 *     把前者算成后者会凭空制造异常，污染 M4 的三条独立异常源。
 *  3. **不给预测也要留档**。"不预测"本身是可度量的行为，抹掉它就只剩好看的准确率。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision } from '../src/parse.ts';
import type { Action, Capabilities } from '../src/world/arena.ts';
import { ALL_CAPS, createWorld, step } from '../src/world/arena.ts';
import { PREDICT_SPEC, checkPrediction, describeCheck } from '../src/world/predict.ts';
import { describe, render, renderInitial } from '../src/world/render.ts';

/** 造一对真实前后帧。测试是裁判，可以读内部状态；agent 只能看屏幕。 */
function framePair(seed: number, action: Action, caps: Capabilities = ALL_CAPS) {
  const prev = createWorld(seed);
  const next = step(prev, action, caps, seed);
  return {
    prev, next,
    prevScreen: renderInitial(prev),
    nextScreen: render(next, describe(prev, action, next)),
  };
}

/** 手搓两帧屏幕，用来精确验算差值算术（不依赖任何 seed 的地图布局） */
function screens(hpA: number, hpB: number, scoreA = 0, scoreB = 0): [string, string] {
  const one = (hp: number, score: number, tick: number) => [
    '+--+', '|@.|', '|..|', '+--+',
    `HP [##########] ${hp}/10   分数 ${score}   第 ${tick} 帧`,
    '攻击：就绪   状态：活着',
  ].join('\n');
  return [one(hpA, scoreA, 1), one(hpB, scoreB, 2)];
}

// ── A. 差异由代码算 ─────────────────────────────────────

test('预测与画面一致 → 全 ok，violated=0（引擎不是"永远报违反"）', () => {
  const f = framePair(6, { kind: 'wait' });
  const rec = checkPrediction({
    hpDelta: f.next.player.hp - f.prev.player.hp,
    scoreDelta: f.next.player.score - f.prev.player.score,
    playerAt: [f.next.player.x, f.next.player.y],
    enemyCount: f.next.enemies.filter((e) => e.alive).length,
    pickupCount: f.next.pickups.filter((p) => !p.taken).length,
    alive: f.next.player.alive,
    attackReady: f.next.player.cooldown === 0,
  }, f.prevScreen, f.nextScreen);

  assert.equal(rec.given, true);
  assert.equal(rec.violated, 0);
  assert.equal(rec.unverifiable, 0);
  assert.equal(rec.diffs.length, 7);
  assert.ok(rec.diffs.every((d) => d.status === 'ok'));
});

test('预测坐标错一格 → violated，且 actual 是画面数出来的真坐标', () => {
  const f = framePair(6, { kind: 'move', dir: 1 });
  const wrong: [number, number] = [f.next.player.x + 1, f.next.player.y];
  const rec = checkPrediction({ playerAt: wrong }, f.prevScreen, f.nextScreen);
  assert.equal(rec.violated, 1);
  const d = rec.diffs[0]!;
  assert.equal(d.status, 'violated');
  assert.deepEqual(d.predicted, wrong);
  assert.deepEqual(d.actual, [f.next.player.x, f.next.player.y]);
});

test('掉血差值由代码算：预测 0、画面掉了 2 → violated，actual=-2', () => {
  const [a, b] = screens(10, 8);
  const rec = checkPrediction({ hpDelta: 0 }, a, b);
  assert.equal(rec.violated, 1);
  assert.equal(rec.diffs[0]!.actual, -2);
});

test('分数差值同理：预测 +1、画面没涨 → violated（M08 计分缺陷的信号）', () => {
  const [a, b] = screens(10, 10, 3, 3);
  const rec = checkPrediction({ scoreDelta: 1 }, a, b);
  assert.equal(rec.violated, 1);
  assert.equal(rec.diffs[0]!.actual, 0);
});

test('模型自述"我预测对了"改不了结论：thought 再自信也照判违反', () => {
  const [a, b] = screens(10, 8);
  const raw = '{"thought":"我确认这次不会掉血，预测完全正确","call":{"name":"wait","args":{}},"predict":{"hpDelta":0}}';
  const decision = parseDecision(raw);
  const rec = checkPrediction(decision.predict, a, b);
  assert.equal(rec.violated, 1, '自述不参与核对');
  assert.match(decision.thought, /预测完全正确/);
});

// ── B. 无法核对 ≠ 被违反 ────────────────────────────────

test('不认识的字段 → unverifiable，不是 violated', () => {
  const f = framePair(6, { kind: 'wait' });
  const rec = checkPrediction({ enemyDir: 2, cooldownLeft: 3 }, f.prevScreen, f.nextScreen);
  assert.equal(rec.violated, 0);
  assert.equal(rec.unverifiable, 2);
  assert.ok(rec.diffs.every((d) => d.status === 'unverifiable'));
});

test('预测值不合法 → unverifiable，不猜一个数去比', () => {
  const [a, b] = screens(10, 8);
  const rec = checkPrediction({ hpDelta: '大概会掉一点', playerAt: '不知道', alive: '也许' }, a, b);
  assert.equal(rec.violated, 0);
  assert.equal(rec.unverifiable, 3);
});

test('屏幕缺 HUD → 血量/分数无法核对；但坐标 still 可核对', () => {
  const grid = ['+--+', '|@.|', '|..|', '+--+'].join('\n');
  const rec = checkPrediction({ hpDelta: 0, scoreDelta: 0, playerAt: [0, 0] }, grid, grid);
  assert.equal(rec.violated, 0);
  assert.equal(rec.unverifiable, 2);
  assert.equal(rec.diffs.find((d) => d.field === 'playerAt')!.status, 'ok');
});

test('屏幕没有网格 → 计数类无法核对，绝不把空数组读成"没有敌人"', () => {
  const noGrid = 'HP [##########] 10/10   分数 0   第 1 帧\n攻击：就绪   状态：活着';
  const rec = checkPrediction({ enemyCount: 0, pickupCount: 0, playerAt: [0, 0] }, noGrid, noGrid);
  assert.equal(rec.violated, 0, '解析不到网格时判违反就是凭空制造异常');
  assert.equal(rec.unverifiable, 3);
});

test('前后两帧都解析不出来 → 全 unverifiable，不抛错', () => {
  const rec = checkPrediction({ hpDelta: -2, alive: false }, '连接超时', '');
  assert.equal(rec.violated, 0);
  assert.equal(rec.unverifiable, 2);
});

// ── C. 不给预测也要留档 ─────────────────────────────────

test('没给 predict → given=false，diffs 为空，violated=0', () => {
  const f = framePair(6, { kind: 'wait' });
  const rec = checkPrediction(undefined, f.prevScreen, f.nextScreen);
  assert.equal(rec.given, false);
  assert.deepEqual(rec.diffs, []);
  assert.equal(rec.violated, 0);
  assert.match(describeCheck(rec), /没有给 predict/);
});

test('空对象 predict 等于没预测，不能混进 given=true 把行为藏起来', () => {
  const f = framePair(6, { kind: 'wait' });
  assert.equal(checkPrediction({}, f.prevScreen, f.nextScreen).given, false);
});

// ── D. 容错归一化：模型会写各种形状 ──────────────────────

test('数字字符串 / 坐标三种写法都认', () => {
  const [a, b] = screens(10, 8);
  const rec = checkPrediction({ hpDelta: '-2' }, a, b);
  assert.equal(rec.diffs[0]!.status, 'ok');

  const grid = ['+--+', '|@.|', '|..|', '+--+'].join('\n');
  for (const v of [[0, 0], '0,0', { x: 0, y: 0 }, ['0', '0']]) {
    const r = checkPrediction({ playerAt: v }, grid, grid);
    assert.equal(r.diffs[0]!.status, 'ok', `写法 ${JSON.stringify(v)} 应当被认出来`);
  }
  for (const v of ['true', true]) {
    assert.equal(checkPrediction({ alive: v }, a, b).diffs[0]!.status, 'ok');
  }
});

test('坐标顺序反了要判违反：[y,x] 不是 [x,y]，接口说清楚了就不许含糊', () => {
  const grid = ['+---+', '|...|', '|.@.|', '+---+'].join('\n');  // 玩家在 x=1,y=1
  const sym = ['+---+', '|...|', '|.@.|', '+---+'].join('\n');
  assert.equal(checkPrediction({ playerAt: [1, 1] }, grid, sym).diffs[0]!.status, 'ok');
  const off = ['+---+', '|..@|', '|...|', '+---+'].join('\n');  // 玩家在 x=2,y=0
  assert.equal(checkPrediction({ playerAt: [0, 2] }, off, off).diffs[0]!.status, 'violated');
  assert.equal(checkPrediction({ playerAt: [2, 0] }, off, off).diffs[0]!.status, 'ok');
});

// ── D2. advanced：两类核对必须分得开 ─────────────────────

test('advanced 由画面上的帧号算出：动作步 true，同一帧 false', () => {
  const f = framePair(6, { kind: 'wait' });
  assert.equal(checkPrediction({ hpDelta: 0 }, f.prevScreen, f.nextScreen).advanced, true);
  const same = renderInitial(createWorld(6));
  assert.equal(checkPrediction({ hpDelta: 0 }, same, same).advanced, false, 'look 这类不推进画面的步要标出来');
});

test('帧号解析不到 → 保守当成没推进，不猜它推进了', () => {
  const grid = ['+--+', '|@.|', '|..|', '+--+'].join('\n');
  assert.equal(checkPrediction({ playerAt: [0, 0] }, grid, grid).advanced, false);
});

// ── E. 解析层：附加字段坏了不该让合法动作作废 ──────────────

test('predict 是坏字符串 → 动作照常成立，原样留档为未知字段（unverifiable）', () => {
  const raw = '{"thought":"t","call":{"name":"wait","args":{}},"predict":"我猜不会掉血"}';
  const d = parseDecision(raw);
  assert.equal(d.call.name, 'wait', '预测写歪了不该判大脑失败');
  assert.ok(d.predict);
  const [a, b] = screens(10, 8);
  const rec = checkPrediction(d.predict, a, b);
  assert.equal(rec.given, true, '它确实试着预测了，这条证据不能丢');
  assert.equal(rec.violated, 0, '但也不能凭空判它违反');
  assert.equal(rec.unverifiable, 1);
});

test('predict 套了一层 JSON 字符串也认（和 args 一个毛病）', () => {
  const raw = '{"thought":"t","call":{"name":"wait","args":{}},"predict":"{\\"hpDelta\\":0}"}';
  const d = parseDecision(raw);
  assert.deepEqual(d.predict, { hpDelta: 0 });
});

test('surprise 容错：字符串布尔 / reason 别名都认', () => {
  const d = parseDecision('{"thought":"t","call":{"name":"wait","args":{}},"surprise":{"unexpected":"true","reason":"血怎么掉了"}}');
  assert.deepEqual(d.surprise, { unexpected: true, why: '血怎么掉了' });
});

test('surprise 不可解析：既不猜 false，也不静默丢弃（两条纪律同时成立）', () => {
  // 猜 false 会凭空制造"代码判违反、模型说不意外"；
  // 静默丢弃则让"模型没判断"和"判断写歪了"长得一模一样，归因当场作废。
  for (const bad of ['{"unexpected":"也许"}', '{}', '"是的"', '[]', '{"why":"没给判断"}']) {
    const d = parseDecision(`{"thought":"t","call":{"name":"wait","args":{}},"surprise":${bad}}`);
    assert.ok(d.surprise, `surprise=${bad} 应当留档，不能消失`);
    assert.equal(d.surprise!.unexpected, null, '绝不能被猜成 true/false');
    assert.ok(d.surprise!.why.length > 0, '原文要留下来，否则无从复核它到底写了什么');
  }
  // 字段根本没出现，才是"没判断"
  const none = parseDecision('{"thought":"t","call":{"name":"wait","args":{}}}');
  assert.equal(none.surprise, undefined);
});

test('surprise 写歪时原文可复核：理由字段缺失就留整个原文', () => {
  const d = parseDecision('{"thought":"t","call":{"name":"wait","args":{}},"surprise":{"unexpected":"maybe"}}');
  assert.equal(d.surprise!.unexpected, null);
  assert.match(d.surprise!.why, /maybe/);
});

test('没有 predict / surprise 时 Decision 形状与 M1 完全一致', () => {
  const d = parseDecision('{"thought":"t","call":{"name":"look","args":{}}}');
  assert.deepEqual(d, { thought: 't', call: { name: 'look', args: {} } });
});

// ── F. 回填文本与接口说明的界线 ──────────────────────────

test('describeCheck 陈述事实、给出实际值，并把判断权交回模型', () => {
  const [a, b] = screens(10, 8);
  const text = describeCheck(checkPrediction({ hpDelta: 0, scoreDelta: 0 }, a, b));
  assert.match(text, /由代码核对屏幕得出，不是你的自述/);
  assert.match(text, /1 项不符/);
  assert.match(text, /hpDelta：你预测 0，画面实际 -2/);
  assert.match(text, /surprise/);
  // 只陈述事实，不下结论、不给策略
  for (const banned of ['缺陷', '变异', 'bug', '你应该去', '优先探索']) {
    assert.ok(!text.includes(banned), `回填文本不该替模型下结论：${banned}`);
  }
});

test('PREDICT_SPEC 只给接口，不给策略，也不泄露坐标原点约定', () => {
  for (const banned of ['优先探索', '边界值', '未访问区域', '二分', '覆盖率', '变异', '缺陷']) {
    assert.ok(!PREDICT_SPEC.includes(banned), `预测接口说明不该出现策略提示：${banned}`);
  }
  // 刻意的取舍：说清 [x,y] 的顺序（接口歧义），但不说原点在左上角（世界知识）。
  // 说了就等于把 M1 §7 那 19 次越界自报的答案喂给它，空间推理能力再也测不出来。
  assert.match(PREDICT_SPEC, /x 是列、y 是行/);
  for (const leaked of ['左上', '原点', '向下为正', '向右为正']) {
    assert.ok(!PREDICT_SPEC.includes(leaked), `不该泄露坐标约定：${leaked}`);
  }
  for (const f of ['hpDelta', 'scoreDelta', 'playerAt', 'enemyCount', 'pickupCount', 'alive', 'attackReady']) {
    assert.ok(PREDICT_SPEC.includes(f), `接口说明缺少字段 ${f}`);
  }
});