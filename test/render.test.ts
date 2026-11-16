/**
 * 视网膜测试。核心不是"画得好看"，是**器官边界真的守住了**。
 *
 * 两组关键断言：
 *  A. 泄露检测：只改内部字段（敌人 dir/id/hp、冷却计数），屏幕文本必须一字不变。
 *     这是"眼睛不准读心"的可执行判据——比 code review 可靠。
 *  B. 能力无关文案：变异体删掉能力时，现象描述必须与参考版**完全相同**，
 *     只有血条/分数/存活这些可观测量不同。否则等于把缺陷答案念给 agent 听。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dir, type WorldState } from '../src/world/arena.ts';
import { describe, parseDir, render, renderInitial } from '../src/world/render.ts';

function st(over: Partial<WorldState> = {}): WorldState {
  return {
    tick: 0, size: 8, walls: ['2,0'],
    player: { x: 0, y: 0, hp: 10, maxHp: 10, cooldown: 0, score: 0, alive: true },
    enemies: [{ id: 0, x: 5, y: 5, hp: 1, alive: true, dir: Dir.Right }],
    pickups: [{ id: 0, x: 7, y: 7, taken: false }],
    ...over,
  };
}
const P = (o: Partial<WorldState['player']> = {}) => ({
  x: 0, y: 0, hp: 10, maxHp: 10, cooldown: 0, score: 0, alive: true, ...o,
});

// ───────────────────── A. 泄露检测 ─────────────────────

test('只改敌人朝向：屏幕文本必须一字不变（dir 是内部字段）', () => {
  const a = st({ enemies: [{ id: 0, x: 5, y: 5, hp: 1, alive: true, dir: Dir.Up }] });
  const b = st({ enemies: [{ id: 0, x: 5, y: 5, hp: 1, alive: true, dir: Dir.Left }] });
  assert.equal(render(a), render(b));
  assert.ok(!/[→←↑↓]/.test(render(a)), '不得用箭头泄露朝向');
});

test('只改敌人 id 与血量：屏幕文本必须一字不变', () => {
  const a = st({ enemies: [{ id: 0, x: 5, y: 5, hp: 1, alive: true, dir: Dir.Right }] });
  const b = st({ enemies: [{ id: 99, x: 5, y: 5, hp: 7, alive: true, dir: Dir.Right }] });
  assert.equal(render(a), render(b));
});

test('冷却计数不上屏：2 与 3 都只显示「冷却中」，但 0 显示「就绪」', () => {
  const c2 = st({ player: P({ cooldown: 2 }) });
  const c3 = st({ player: P({ cooldown: 3 }) });
  const c0 = st({ player: P({ cooldown: 0 }) });
  assert.equal(render(c2), render(c3), '剩余计数泄露了内部状态');
  assert.match(render(c2), /攻击：冷却中/);
  assert.match(render(c0), /攻击：就绪/);
  assert.notEqual(render(c0), render(c2));
  assert.ok(!/冷却中（?\d/.test(render(c2)), '不得显示剩余帧数');
});

test('墙表顺序不影响画面（画面按位置渲染，不按数组顺序）', () => {
  const a = st({ walls: ['2,0', '3,3'] });
  const b = st({ walls: ['3,3', '2,0'] });
  assert.equal(render(a), render(b));
});

test('屏幕文本不含内部 JSON 字段名', () => {
  const text = render(st(), ['你原地等待。']);
  for (const key of ['"enemies"', '"pickups"', '"walls"', '"cooldown"', '"maxHp"', '"alive"', '"dir"', '"tick"']) {
    assert.ok(!text.includes(key), `屏幕泄露了内部字段 ${key}`);
  }
});

test('渲染是纯函数：同一状态多次渲染完全一致', () => {
  const s = st({ tick: 12, player: P({ hp: 6, score: 3 }) });
  assert.equal(render(s, ['你原地等待。']), render(s, ['你原地等待。']));
  assert.equal(renderInitial(s), render(s, []));
});

// ───────────────────── 画面正确性 ─────────────────────

test('地图符号落在正确格子：玩家/敌人/拾取物/墙', () => {
  const s = st({
    walls: ['2,0'],
    player: P({ x: 1, y: 1 }),
    enemies: [{ id: 0, x: 3, y: 2, hp: 1, alive: true, dir: Dir.Right }],
    pickups: [{ id: 0, x: 0, y: 3, taken: false }],
  });
  const lines = render(s).split('\n');
  // 第 0 行是上边框，第 1 行是 y=0
  assert.equal(lines[0], '+--------+');
  assert.equal(lines[1]!.charAt(3), '#', 'x=2,y=0 应是墙（偏移 1 是左边框）');
  assert.equal(lines[2]!.charAt(2), '@', 'x=1,y=1 应是玩家');
  assert.equal(lines[3]!.charAt(4), 'E', 'x=3,y=2 应是敌人');
  assert.equal(lines[4]!.charAt(1), '+', 'x=0,y=3 应是拾取物');
});

test('死敌人与已拾取物从画面消失（可见物才上屏）', () => {
  // 只看地图区域（上边框 + 8 行 + 下边框 = 10 行）。
  // 图例行本身就含 "E=敌人" 这个字母，拿整屏断言会误判——第一版就这么写错了。
  const mapOf = (text: string) => text.split('\n').slice(0, 10).join('\n');

  const alive = st({ enemies: [{ id: 0, x: 3, y: 2, hp: 1, alive: true, dir: Dir.Right }] });
  const dead = st({ enemies: [{ id: 0, x: 3, y: 2, hp: 0, alive: false, dir: Dir.Right }] });
  assert.match(mapOf(render(alive)), /E/);
  assert.ok(!mapOf(render(dead)).includes('E'), '死敌人不该还画在地图上');

  const untaken = st({ pickups: [{ id: 0, x: 0, y: 3, taken: false }] });
  const taken = st({ pickups: [{ id: 0, x: 0, y: 3, taken: true }] });
  assert.ok(mapOf(render(untaken)).split('\n')[4]!.includes('+'));
  assert.ok(!mapOf(render(taken)).split('\n')[4]!.includes('+'));
});

test('玩家站在敌人/物品格子上时以玩家为准（图层顺序）', () => {
  const s = st({
    player: P({ x: 3, y: 2 }),
    enemies: [{ id: 0, x: 3, y: 2, hp: 1, alive: true, dir: Dir.Right }],
  });
  assert.equal(render(s).split('\n')[3]!.charAt(4), '@');
});

test('血条与 HUD：血量、分数、帧数都上屏（这些是可观测量）', () => {
  const text = render(st({ tick: 15, player: P({ hp: 6, score: 2 }) }));
  assert.match(text, /HP \[######----\] 6\/10/);
  assert.match(text, /分数 2/);
  assert.match(text, /第 15 帧/);
});

test('M07 的症状是可观察的：hp=0 但仍显示「活着」', () => {
  // 这正是"血量归零不死亡"缺陷在屏幕上的样子。文案不解释原因，只呈现事实。
  const text = render(st({ player: P({ hp: 0, alive: true }) }));
  assert.match(text, /HP \[----------\] 0\/10/);
  assert.match(text, /状态：活着/);
});

test('图例属于接口而非策略：含符号说明，不含任何测试策略词', () => {
  const text = render(st());
  assert.match(text, /图例：@=你 E=敌人 \+=可拾取 #=墙 \.=空地/);
  for (const w of ['优先探索', '边界值', '未访问区域', '二分', '覆盖率', '变异', '建议', '应该先']) {
    assert.ok(!text.includes(w), `屏幕泄露了策略手册词：${w}`);
  }
});

// ───────────────────── B. 能力无关文案（不许念答案）─────────────────────

test('拾取文案能力无关：回血与不回血，描述完全相同', () => {
  const prev = st({ player: P({ hp: 5 }), pickups: [{ id: 0, x: 0, y: 0, taken: false }] });
  const ref = st({ player: P({ hp: 8 }), pickups: [{ id: 0, x: 0, y: 0, taken: true }] });
  const mut = st({ player: P({ hp: 5 }), pickups: [{ id: 0, x: 0, y: 0, taken: true }] });
  const a = describe(prev, { kind: 'pickup' }, ref);
  const b = describe(prev, { kind: 'pickup' }, mut);
  assert.deepEqual(a, b, '文案差异等于把 pickupHeals 缺陷的答案念给 agent');
  assert.deepEqual(a, ['你拾取了地上的东西。']);
  // 差异只体现在可观测量上
  assert.notEqual(render(ref), render(mut));
});

test('接触文案能力无关：扣血与不扣血，描述完全相同', () => {
  const prev = st({
    player: P({ hp: 10 }),
    enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }],
  });
  const on = st({
    player: P({ hp: 8 }),
    enemies: [{ id: 0, x: 0, y: 0, hp: 1, alive: true, dir: Dir.Left }],
  });
  const off = st({
    player: P({ hp: 10 }),
    enemies: [{ id: 0, x: 0, y: 0, hp: 1, alive: true, dir: Dir.Left }],
  });
  const a = describe(prev, { kind: 'wait' }, on);
  const b = describe(prev, { kind: 'wait' }, off);
  assert.deepEqual(a, b);
  assert.ok(a.includes('有敌人贴到了你身上。'));
  assert.notEqual(render(on), render(off));
});

test('攻击文案能力无关：杀死与没杀死，描述完全相同（只按可见几何）', () => {
  const prev = st({ enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }] });
  const killed = st({
    player: P({ score: 1 }),
    enemies: [{ id: 0, x: 1, y: 0, hp: 0, alive: false, dir: Dir.Left }],
  });
  const notKilled = st({ enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }] });
  const a = describe(prev, { kind: 'attack' }, killed);
  const b = describe(prev, { kind: 'attack' }, notKilled);
  assert.deepEqual(a, b, '文案不得区分"打死了"与"没打死"，那等于报答案');
  assert.deepEqual(a, ['你朝身边的敌人挥击。']);
  // 击杀的证据在画面（敌人消失）和分数上，不在文案里
  assert.notEqual(render(killed), render(notKilled));
});

test('身边没敌人时的攻击文案与有敌人时不同（这是可见几何差异，不是能力差异）', () => {
  const far = st({ enemies: [{ id: 0, x: 5, y: 5, hp: 1, alive: true, dir: Dir.Right }] });
  const near = st({ enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }] });
  assert.deepEqual(describe(far, { kind: 'attack' }, far), ['你挥击，但身边没有敌人。']);
  assert.deepEqual(describe(near, { kind: 'attack' }, near), ['你朝身边的敌人挥击。']);
});

test('死亡后动作文案：只说没效果，不解释内部原因', () => {
  const dead = st({ player: P({ hp: 0, alive: false }) });
  const d = describe(dead, { kind: 'move', dir: Dir.Right }, dead);
  assert.deepEqual(d, ['你已经倒下，动作没有效果。']);
});

test('撞障碍与走成功的文案不同（这是可见结果，允许差异）', () => {
  const prev = st({ walls: ['1,0'] });
  const blocked = st({ walls: ['1,0'] });
  const moved = st({ walls: ['1,0'], player: P({ x: 0, y: 1 }) });
  assert.deepEqual(describe(prev, { kind: 'move', dir: Dir.Right }, blocked), ['你朝右撞上了障碍，没能移动。']);
  assert.deepEqual(describe(prev, { kind: 'move', dir: Dir.Down }, moved), ['你朝下走了一格。']);
});

// ───────────────────── 方向白名单 ─────────────────────

test('parseDir 只认四个词，大小写与空白容错', () => {
  assert.equal(parseDir('up').ok, true);
  assert.equal(parseDir('RIGHT').ok, true);
  assert.equal(parseDir('  down  ').ok, true);
  if (parseDir('left').ok) assert.equal(parseDir('left').dir, Dir.Left);
});

test('parseDir 拒绝理由必须可行动：列出四个合法词，不说 invalid', () => {
  for (const bad of ['north', '上', 'u', '', undefined, 1]) {
    const r = parseDir(bad);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /up \/ right \/ down \/ left/);
      assert.ok(!/invalid/i.test(r.reason));
    }
  }
});