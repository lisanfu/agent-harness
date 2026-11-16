/**
 * 目标完成条件判定测试（M4-b2，世界层）。
 *
 * 这一层只管一件事：**拿当前屏幕逐字段核对等值**，三态给齐，不合取、不判定、不出声。
 * 合取逻辑归器官（src/goal.test.ts 负责），所以这里的断言全部是"单字段"级别的。
 *
 * 钉住四件事：
 *  1. **词表只有画面上看得见的绝对状态量**。hpDelta / scoreDelta 是"变化"，
 *     而目标是一条"状态"——把差值放进完成条件，等于要求 agent 断言一个转瞬即逝的导数。
 *  2. **无法核对 ≠ 不满足**。字段不认识、值不合法、屏幕缺行，一律 unverifiable。
 *     把前者算成后者会凭空制造"目标永远达不成"，而错的是裁判不是 agent。
 *  3. **只吃屏幕，绝不读内部状态**（observe.ts 铁律 1）。读内部状态就是让 agent 读心。
 *  4. **归一化与预测通道共用一份**（src/world/value.ts）。同一个 `{x:3,y:4}`
 *     若预测通道认、目标通道不认，两条通道会互相打架，而错的是 harness。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Action, Capabilities } from '../src/world/arena.ts';
import { ALL_CAPS, createWorld, step } from '../src/world/arena.ts';
import { GOAL_FIELDS, GOAL_SEAM, GOAL_SPEC, evaluateGoal } from '../src/world/goal.ts';
import { checkPrediction } from '../src/world/predict.ts';
import { describe, render, renderInitial } from '../src/world/render.ts';

/** 造一帧真实画面。测试是裁判，可以读内部状态；agent 只能看屏幕。 */
function frame(seed: number, action?: Action, caps: Capabilities = ALL_CAPS) {
  let w = createWorld(seed);
  let prev = w;
  if (action) {
    w = step(w, action, caps, seed);
    return { world: w, screen: render(w, describe(prev, action, w)) };
  }
  return { world: w, screen: renderInitial(w) };
}

/** 手搓一帧屏幕：精确控制"画面到底印了什么"，不依赖任何 seed 的地图布局 */
function one(opts: {
  hp?: number; score?: number; alive?: boolean; ready?: boolean; tick?: number; grid?: string[];
}): string {
  const lines: string[] = [];
  if (opts.grid) {
    const n = opts.grid[0]!.length;
    lines.push(`+--+${'-'.repeat(n)}`);
    lines.push(...opts.grid.map((r) => `|${r}|`));
    lines.push(`+--+${'-'.repeat(n)}`);
  }
  const hp = opts.hp ?? 10;
  lines.push(`HP [##########] ${hp}/10   分数 ${opts.score ?? 0}   第 ${opts.tick ?? 3} 帧`);
  lines.push(`攻击：${opts.ready === false ? '冷却中' : '就绪'}   状态：${opts.alive === false ? '已倒下' : '活着'}`);
  return lines.join('\n');
}

const field = (diffs: { field: string }[], f: string) =>
  diffs.find((d) => d.field === f)!;

// ── A. 词表：只认画面上看得见的绝对状态量 ────────────────

test('完成条件词表只有绝对状态量，一个差值字段都不许有', () => {
  assert.deepEqual([...GOAL_FIELDS], ['hp', 'score', 'playerAt', 'enemyCount', 'pickupCount', 'alive', 'attackReady']);
  // 目标是"状态"不是"变化"：hpDelta 属于预测通道，不该出现在完成条件里
  for (const banned of ['hpDelta', 'scoreDelta', 'tick', 'maxHp', 'events']) {
    assert.ok(!(GOAL_FIELDS as readonly string[]).includes(banned), `${banned} 不该是完成条件字段`);
  }
  // 内部字段一个都不能有：agent 只能看屏幕
  for (const hidden of ['invincible', 'cooldown', 'seed', 'grid', 'enemies', 'pickups']) {
    assert.ok(!(GOAL_FIELDS as readonly string[]).includes(hidden), `${hidden} 是内部字段，不可核对`);
  }
});

test('GOAL_SPEC 只给接口，不给策略，也不泄露坐标原点约定', () => {
  for (const banned of ['优先探索', '边界值', '未访问区域', '应该', '建议', '注意', '容易', '覆盖率', '缺陷', '变异']) {
    assert.ok(!GOAL_SPEC.includes(banned), `接口说明不该出现策略提示：${banned}`);
  }
  for (const f of GOAL_FIELDS) assert.ok(GOAL_SPEC.includes(f), `接口说明缺少字段 ${f}`);
  // 说清 [x,y] 顺序（接口歧义），但不说原点和轴向（那是世界知识，M1 §7 的 19 次越界要靠它测出来）
  assert.match(GOAL_SPEC, /x 是列、y 是行/);
  for (const leaked of ['左上', '原点', '向下为正', '向右为正']) {
    assert.ok(!GOAL_SPEC.includes(leaked), `不该泄露坐标约定：${leaked}`);
  }
  // 只认等值这件事必须写在接口里，否则模型会写 {"hp":"<5"} 然后被误判
  assert.match(GOAL_SPEC, /等值|相等/);
});

test('接缝三件套自洽：spec / fields / evaluate 都指向同一份词表', () => {
  assert.equal(GOAL_SEAM.spec, GOAL_SPEC);
  assert.deepEqual(GOAL_SEAM.fields, GOAL_FIELDS);
  const s = one({ hp: 0 });
  assert.deepEqual(GOAL_SEAM.evaluate({ hp: 0 }, s), evaluateGoal({ hp: 0 }, s));
});

// ── B. 等值核对：满足就是不满足就是 ──────────────────────

test('血量归零的画面 → hp:0 判 ok。M07 的可核对判据从这里开始', () => {
  const diffs = evaluateGoal({ hp: 0 }, one({ hp: 0 }));
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]!.status, 'ok');
  assert.equal(diffs[0]!.actual, 0);
});

test('真世界帧：按画面实际值写条件 → 全 ok；故意写错一个 → 只有那一项 violated', () => {
  const f = frame(6, { kind: 'wait' });
  const w = f.world;
  const exact = {
    hp: w.player.hp, score: w.player.score, playerAt: [w.player.x, w.player.y],
    enemyCount: w.enemies.filter((e) => e.alive).length,
    pickupCount: w.pickups.filter((p) => !p.taken).length,
    alive: w.player.alive, attackReady: w.player.cooldown === 0,
  };
  const all = evaluateGoal(exact, f.screen);
  assert.equal(all.length, 7);
  assert.ok(all.every((d) => d.status === 'ok'), JSON.stringify(all));

  const wrong = evaluateGoal({ ...exact, hp: exact.hp + 2 }, f.screen);
  assert.equal(field(wrong, 'hp').status, 'violated');
  assert.equal(field(wrong, 'hp').actual, exact.hp, 'actual 必须是画面数出来的真值，不是猜的');
  assert.equal(wrong.filter((d) => d.status === 'violated').length, 1, '世界层不合取，只逐字段给三态');
});

test('合取不在这里做：一 ok 一 violated 一 unverifiable 时三条各留各的态', () => {
  const diffs = evaluateGoal({ hp: 5, score: 999, ghost: 1 }, one({ hp: 5 }));
  assert.deepEqual(diffs.map((d) => d.status), ['ok', 'violated', 'unverifiable']);
  assert.equal(diffs.length, 3, '不许丢字段，也不许合并成一条总结');
});

test('坐标顺序反了要判违反：接口说清了 [x,y] 就不许含糊', () => {
  // 故意把玩家放在 (0,1) 而不是 (0,0)：位置不在对角线上，[x,y] 与 [y,x] 才分得开
  const s = one({ grid: ['...', '@..'] });
  assert.equal(evaluateGoal({ playerAt: [0, 1] }, s)[0]!.status, 'ok');
  assert.equal(evaluateGoal({ playerAt: [1, 0] }, s)[0]!.status, 'violated');
});

// ── C. 无法核对 ≠ 不满足 ────────────────────────────────

test('不认识的字段 → unverifiable，actual 为 null，绝不猜一个值去比', () => {
  const d = evaluateGoal({ invincible: false }, one({ hp: 10 }))[0]!;
  assert.equal(d.status, 'unverifiable');
  assert.equal(d.actual, null);
  assert.equal(d.predicted, false, '原文照留，供审计复核');
});

test('值不合法 → unverifiable：false 就是 false，"yes" 不许猜成布尔', () => {
  assert.equal(evaluateGoal({ alive: 'yes' }, one({ alive: true }))[0]!.status, 'unverifiable');
  assert.equal(evaluateGoal({ hp: 'abc' }, one({ hp: 3 }))[0]!.status, 'unverifiable');
  assert.equal(evaluateGoal({ playerAt: [3] }, one({ hp: 3 }))[0]!.status, 'unverifiable');
  // 但"看起来是数字/布尔的字符串"要认，那是容错不是猜
  assert.equal(evaluateGoal({ hp: '0' }, one({ hp: 0 }))[0]!.status, 'ok');
  assert.equal(evaluateGoal({ alive: 'TRUE' }, one({ alive: true }))[0]!.status, 'ok');
});

test('屏幕缺 HUD → 血量/分数无法核对，网格能数出来的照旧核对', () => {
  const noHud = ['+--+', '|@.|', '|..|', '+--+'].join('\n');
  const diffs = evaluateGoal({ hp: 0, score: 3, playerAt: [0, 0] }, noHud);
  assert.equal(field(diffs, 'hp').status, 'unverifiable');
  assert.equal(field(diffs, 'score').status, 'unverifiable');
  assert.equal(field(diffs, 'playerAt').status, 'ok');
});

test('屏幕没有网格 → 计数与坐标一律无法核对，绝不把空数组读成"0 个敌人"', () => {
  const noGrid = one({ hp: 4 });
  const diffs = evaluateGoal({ enemyCount: 0, pickupCount: 0, playerAt: [0, 0] }, noGrid);
  assert.ok(diffs.every((d) => d.status === 'unverifiable'), JSON.stringify(diffs));
});

test('空条件 → 空数组，不判定也不抛错（判"没条件"是器官的事）', () => {
  assert.deepEqual(evaluateGoal({}, one({ hp: 0 })), []);
});

test('整帧解析不出来 → 全 unverifiable，绝不抛错', () => {
  const diffs = evaluateGoal({ hp: 0, alive: true, attackReady: false }, '这根本不是一帧画面');
  assert.equal(diffs.length, 3);
  assert.ok(diffs.every((d) => d.status === 'unverifiable'));
});

// ── D. 纯函数 + 跨通道一致 ──────────────────────────────

test('纯函数：同一屏幕同一条件必产出同一结果，不读时钟、不用随机', () => {
  const s = one({ hp: 0, grid: ['@.E'] });
  const a = evaluateGoal({ hp: 0, enemyCount: 1 }, s);
  const b = evaluateGoal({ hp: 0, enemyCount: 1 }, s);
  assert.deepEqual(a, b);
  assert.deepEqual(a, evaluateGoal({ hp: 0, enemyCount: 1 }, s));
});

test('跨通道一致：同一份归一化，预测与目标不许对同一个写法判成两样', () => {
  // 故障 #1 的教训：同一份契约不许有两条装配路径。
  // 这里用"动作前后同一帧"（差值为 0）把两条通道摆到同一份绝对坐标写法上对比。
  const s = one({ grid: ['...', '@.E'] });   // 玩家在 (0,1)，不在对角线上，顺序写反必被判违反
  for (const form of [[0, 1], '0,1', { x: 0, y: 1 }, ['0', '1']] as const) {
    const g = field(evaluateGoal({ playerAt: form }, s), 'playerAt');
    const p = field(checkPrediction({ playerAt: form }, s, s).diffs, 'playerAt');
    assert.equal(g.status, 'ok', `目标通道不认写法 ${JSON.stringify(form)}`);
    assert.equal(p.status, g.status, `两条通道对 ${JSON.stringify(form)} 判得不一样`);
  }
  // 反向对照：四种写法里塞一个非法的，两条通道必须一起判无法核对，不许一边猜一边不猜
  const bad = field(evaluateGoal({ playerAt: '0' }, s), 'playerAt');
  assert.equal(bad.status, 'unverifiable');
  assert.equal(field(checkPrediction({ playerAt: '0' }, s, s).diffs, 'playerAt').status, 'unverifiable');
  assert.equal(field(evaluateGoal({ alive: 'yep' }, s), 'alive').status, 'unverifiable');
  assert.equal(field(checkPrediction({ alive: 'yep' }, s, s).diffs, 'alive').status, 'unverifiable');
});

test('actual 只来自屏幕：同样的条件配不同画面给不同结论', () => {
  const cond = { hp: 0, alive: false };
  const alive0 = one({ hp: 0, alive: true });
  const dead = one({ hp: 0, alive: false });
  assert.equal(field(evaluateGoal(cond, alive0), 'hp').status, 'ok');
  assert.equal(field(evaluateGoal(cond, alive0), 'alive').status, 'violated');
  assert.ok(evaluateGoal(cond, dead).every((d) => d.status === 'ok'), JSON.stringify(evaluateGoal(cond, dead)));
});
