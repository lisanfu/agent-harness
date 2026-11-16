/**
 * 观察提取器测试（M4-a）。
 *
 * 钉住的核心性质：**observe 只认屏幕文本，绝不咨询世界内部状态**。
 * 这不是洁癖，是评测成立的前提：预测-对照的基准若来自 WorldState，
 * 就等于拿答案对答案，agent 的空间推理错误（M1 实测自报坐标越界 19 次）永远暴露不出来。
 *
 * 第二条钉住的性质：**解析不出来给 null，不抛错、不猜**。
 * 猜一个值会把"无法核对"变成"预测被违反"，凭空制造异常。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, worldHash, type DirValue } from '../src/world/arena.ts';
import { observe } from '../src/world/observe.ts';
import { render, renderInitial } from '../src/world/render.ts';

// ── A. 从真实屏幕数出来的东西必须对 ──────────────────────

test('observe 从真实首屏数出玩家/敌人/物品/墙/HUD，与内部状态一致', () => {
  const s = createWorld(6);
  const o = observe(renderInitial(s));

  assert.equal(o.size, s.size);
  assert.deepEqual(o.player, [s.player.x, s.player.y]);
  // 测试是裁判，可以读内部状态；agent 不行。这里正是用答案验眼睛
  assert.deepEqual(o.enemies, s.enemies.filter((e) => e.alive).map((e) => [e.x, e.y]).sort(xy));
  assert.deepEqual(o.pickups, s.pickups.filter((p) => !p.taken).map((p) => [p.x, p.y]).sort(xy));
  assert.deepEqual(o.walls, s.walls.map((w) => w.split(',').map(Number) as [number, number]).sort(xy));
  assert.equal(o.hp, s.player.hp);
  assert.equal(o.maxHp, s.player.maxHp);
  assert.equal(o.score, s.player.score);
  assert.equal(o.tick, s.tick);
  assert.equal(o.attackReady, s.player.cooldown === 0);
  assert.equal(o.alive, s.player.alive);
});

const xy = (a: [number, number], b: [number, number]) => (a[1] - b[1]) || (a[0] - b[0]);

test('坐标按 (y,x) 排序：同一画面必产出同一顺序，否则 diff 会假报违反', () => {
  const s = createWorld(11);
  const o = observe(renderInitial(s));
  assert.deepEqual(o.enemies, [...o.enemies].sort(xy));
  assert.deepEqual(o.pickups, [...o.pickups].sort(xy));
});

test('observe 是纯函数：同一文本两次深相等', () => {
  const text = renderInitial(createWorld(3));
  assert.deepEqual(observe(text), observe(text));
});

// ── B. 只认文本：伪造的屏幕照实解析 ──────────────────────

test('手工伪造的屏幕照实解析——证明它根本没在咨询任何世界', () => {
  // 这张图不是任何 seed 能生成的：3×3、血量 7/10、第 42 帧、冷却中且已倒下。
  // observe 若偷偷读内部状态，这里必然对不上。
  const fake = [
    '+---+',
    '|@..|',
    '|.E.|',
    '|..+|',
    '+---+',
    'HP [#######---] 7/10   分数 5   第 42 帧',
    '攻击：冷却中   状态：已倒下',
  ].join('\n');
  const o = observe(fake);
  assert.equal(o.size, 3);
  assert.deepEqual(o.player, [0, 0]);
  assert.deepEqual(o.enemies, [[1, 1]]);
  assert.deepEqual(o.pickups, [[2, 2]]);
  assert.deepEqual(o.walls, []);
  assert.equal(o.hp, 7);
  assert.equal(o.maxHp, 10);
  assert.equal(o.score, 5);
  assert.equal(o.tick, 42);
  assert.equal(o.attackReady, false);
  assert.equal(o.alive, false);
});

test('图例行里的 @ E + # 不算网格内容（否则每帧都多出一个敌人）', () => {
  const s = createWorld(6);
  const o = observe(renderInitial(s));
  assert.equal(o.enemies.length, s.enemies.filter((e) => e.alive).length);
  assert.equal(o.pickups.length, s.pickups.filter((p) => !p.taken).length);
  assert.deepEqual(o.player, [0, 0], '图例里的 @ 不该被当成第二个玩家');
});

// ── C. 解析不出来给 null，不抛错不猜 ─────────────────────

test('空文本 / 垃圾文本：全 null，不抛错', () => {
  for (const bad of ['', '   ', '连接超时', 'null', '{}']) {
    const o = observe(bad);
    assert.equal(o.size, null);
    assert.equal(o.player, null);
    assert.equal(o.hp, null);
    assert.equal(o.score, null);
    assert.equal(o.tick, null);
    assert.equal(o.attackReady, null);
    assert.equal(o.alive, null);
    assert.deepEqual(o.enemies, []);
  }
});

test('只有网格没有 HUD：坐标能数出来，血量一律 null（不猜 0）', () => {
  const o = observe(['+--+', '|@.|', '|.E|', '+--+'].join('\n'));
  assert.equal(o.size, 2);
  assert.deepEqual(o.player, [0, 0]);
  assert.deepEqual(o.enemies, [[1, 1]]);
  assert.equal(o.hp, null, '没有血条就必须是 null，猜 0 会伪造掉血');
  assert.equal(o.maxHp, null);
  assert.equal(o.alive, null);
});

test('网格行长不齐 → size=null，不猜边长', () => {
  const o = observe(['+---+', '|@..|', '|.E|', '+---+'].join('\n'));
  assert.equal(o.size, null);
});

test('两个 @ → player=null，不猜是哪一个', () => {
  const o = observe(['+--+', '|@@|', '|..|', '+--+'].join('\n'));
  assert.deepEqual(o.player, null);
});

test('负数血量照实解析（M07 那类缺陷的证据不能被正则吃掉）', () => {
  const o = observe('HP [----------] -3/10   分数 0   第 9 帧');
  assert.equal(o.hp, -3);
  assert.equal(o.tick, 9);
});

// ── D. 现象描述原文提取 ─────────────────────────────────

test('events 提取「刚才发生」原文，不改写不总结', () => {
  const s = createWorld(6);
  const events = ['你朝右走了一格。', '有敌人贴到了你身上。'];
  const o = observe(render(s, events));
  assert.deepEqual(o.events, events);
});

test('首屏没有「刚才发生」→ events 为空数组', () => {
  assert.deepEqual(observe(renderInitial(createWorld(6))).events, []);
});

// ── E. 有损投影：内部字段不上屏，观察就不该知道 ────────────

test('内部字段不同、画面相同 → 观察完全相同（眼睛不准读心）', () => {
  const a = createWorld(6);
  const b = createWorld(6);
  // 只改**不上屏**的内部字段：敌人朝向、敌人血量、冷却剩余计数
  b.enemies.forEach((e) => { e.dir = ((e.dir + 1) % 4) as DirValue; e.hp = 99; });
  a.player.cooldown = 3;
  b.player.cooldown = 5;   // 两者都 >0，画面上都是「冷却中」

  const sa = render(a, []);
  const sb = render(b, []);
  assert.equal(sa, sb, '前提：这些内部字段本来就不该上屏');
  assert.notEqual(worldHash(a), worldHash(b), '内部状态确实不同');
  assert.deepEqual(observe(sa), observe(sb), '观察却必须相同——这才叫有损投影');
});

test('Observation 不含任何内部字段名', () => {
  const o = observe(renderInitial(createWorld(6))) as unknown as Record<string, unknown>;
  for (const banned of ['dir', 'cooldown', 'enemyHp', 'caps', 'mutant', 'id']) {
    assert.ok(!(banned in o), `观察里不该出现内部字段 ${banned}`);
  }
});