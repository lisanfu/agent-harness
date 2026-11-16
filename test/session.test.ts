/**
 * 会话测试：M1 的「手」与裁判侧账本。
 *
 * 最重要的一条是**并发串行**：applyNow 里有 await 点（真实引擎就是异步的），
 * 不排队的话两个并发 apply 会读到同一帧、后写覆盖先写，动作序列与实际轨迹错位，
 * 重放当场作废。这里真的并发打一遍，并与顺序执行逐帧比对哈希。
 *
 * 覆盖统计的夹具种子由探针实测后硬编码：
 *   seed 3 → 出生点右侧 (1,0) 是墙
 *   seed 1 → 出生点右侧 (1,0) 是拾取物（初始满血，可测 pickupAtFullHp）
 *   seed 6 → 出生点右侧 (1,0) 是敌人
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CAPS, createWorld, worldHash, type Action } from '../src/world/arena.ts';
import { GameSession } from '../src/world/session.ts';

const W: Action = { kind: 'wait' };
const R: Action = { kind: 'move', dir: 1 };
const L: Action = { kind: 'move', dir: 3 };

// ───────────────────── 只有一只手 ─────────────────────

test('并发动作严格串行：不丢更新，且与顺序执行逐帧哈希一致', async () => {
  const acts: Action[] = [W, R, W, L, W, R];
  const concurrent = new GameSession(5);
  const results = await Promise.all(acts.map((a) => concurrent.apply(a)));
  assert.deepEqual(results.map((r) => r.tick), [1, 2, 3, 4, 5, 6], '有动作被丢掉了');

  const sequential = new GameSession(5);
  for (const a of acts) await sequential.apply(a);

  assert.equal(concurrent.stateHash(), sequential.stateHash());
  assert.deepEqual(
    concurrent.frames().map((f) => f.hash),
    sequential.frames().map((f) => f.hash),
    '并发与顺序的轨迹必须逐帧相同，否则重放不可信',
  );
  assert.deepEqual(concurrent.actionSequence(), acts);
});

test('并发下动作顺序 = 到达顺序（手不会重排动作）', async () => {
  const s = new GameSession(9);
  const acts: Action[] = [R, R, W, { kind: 'attack' }, { kind: 'pickup' }];
  await Promise.all(acts.map((a) => s.apply(a)));
  assert.deepEqual(s.actionSequence(), acts);
  assert.equal(s.internalState().tick, acts.length);
});

// ───────────────────── 逐帧账本 ─────────────────────

test('逐帧哈希落盘：帧数 = 动作数 + 1，tick 严格递增', async () => {
  const s = new GameSession(4);
  const acts = [W, R, W, { kind: 'attack' } as Action];
  for (const a of acts) await s.apply(a);
  const frames = s.frames();
  assert.equal(frames.length, acts.length + 1);
  assert.equal(frames[0]!.tick, 0);
  assert.equal(frames[0]!.action, null);
  assert.deepEqual(frames.map((f) => f.tick), [0, 1, 2, 3, 4]);
  assert.equal(frames[0]!.hash, worldHash(createWorld(4)));
  assert.equal(frames[4]!.hash, s.stateHash());
  // 每帧哈希互不相同（wait 也推进 tick，所以状态必然变）
  assert.equal(new Set(frames.map((f) => f.hash)).size, frames.length);
});

test('initialHash 与种子绑定，可作重放起点', () => {
  assert.equal(new GameSession(7).initialHash(), worldHash(createWorld(7)));
  assert.equal(new GameSession(7).initialHash(), new GameSession(7).initialHash());
  assert.notEqual(new GameSession(7).initialHash(), new GameSession(8).initialHash());
});

test('screen 确定性：首屏无「刚才发生」，动作后有现象描述', async () => {
  const s = new GameSession(2);
  const first = s.screen();
  assert.ok(!first.includes('刚才发生'));
  assert.equal(s.screen(), first);
  const r = await s.apply(W);
  assert.match(r.screen, /刚才发生/);
  assert.match(r.screen, /你原地等待/);
  assert.equal(s.screen(), r.screen);
});

// ───────────────────── 覆盖账本（M3 硬约束）─────────────────────

test('覆盖：撞墙与撞边界分别计数（seed 3 右侧是墙）', async () => {
  const s = new GameSession(3);
  await s.apply(R);            // 撞墙 (1,0)
  await s.apply(L);            // 撞左边界
  const c = s.coverage();
  assert.equal(c.wallAttempts, 1);
  assert.equal(c.boundaryAttempts, 1);
  assert.equal(c.cellsVisited, 1, '两次都没动，只待过出生点');
  assert.equal(c.ticks, 2);
});

test('覆盖：满血拾取被记录（seed 1 右侧是拾取物）——这是 M06/M09 的前提', async () => {
  const s = new GameSession(1);
  await s.apply(R);
  await s.apply({ kind: 'pickup' });
  const c = s.coverage();
  assert.equal(c.stoodOnPickup, true);
  assert.equal(c.pickupAtFullHp, true);
  assert.equal(c.pickupsTaken, 1);
  assert.deepEqual(c.hpSeen, [10], '满血拾取被 hpClamp 夹住，血量没变');
  assert.equal(c.hpAboveMaxReached, false);
});

test('覆盖：与敌人相邻被记录（seed 6 右侧是敌人）——这是攻击的前提', async () => {
  const s = new GameSession(6);
  assert.equal(s.coverage().adjacentEnemyReached, true);
});

test('覆盖：冷却中攻击被计数——这是 M05 的前提', async () => {
  const s = new GameSession(6);
  await s.apply({ kind: 'attack' });
  await s.apply({ kind: 'attack' });
  await s.apply({ kind: 'attack' });
  const c = s.coverage();
  assert.equal(c.attacksWhileCooldown, 2, '第 2、3 次都在冷却中');
});

test('覆盖：击杀计数与血量值集合', async () => {
  const s = new GameSession(6);
  // 敌人在 (1,0)，攻击可打到；反复攻击直到打死（冷却 3 帧，用 wait 垫）
  for (let i = 0; i < 12; i++) {
    await s.apply({ kind: 'attack' });
    await s.apply(W);
  }
  const c = s.coverage();
  assert.ok(c.kills >= 1, `应至少击杀 1 个，实际 ${c.kills}`);
  assert.ok(c.hpSeen.length >= 1);
  assert.ok(c.cellsVisited >= 1);
  assert.equal(c.cellsTotal, 64);
});

test('覆盖账本是快照：返回后外部修改不影响内部', async () => {
  const s = new GameSession(3);
  const c = s.coverage();
  c.wallAttempts = 999;
  c.hpSeen.push(-999);
  assert.equal(s.coverage().wallAttempts, 0);
  assert.ok(!s.coverage().hpSeen.includes(-999));
});

test('变异版会话：能力开关生效，且覆盖账本能解释"为什么没触达"', async () => {
  // M06（拾取不回血）：满血拾取时血量本来就不变，所以这个夹具下两版覆盖相同。
  // 换成非满血才能看出差异——这里验的是账本如实记录，不是替变异体下结论。
  const mut = new GameSession(1, { ...ALL_CAPS, pickupHeals: false });
  await mut.apply(R);
  await mut.apply({ kind: 'pickup' });
  assert.equal(mut.coverage().pickupsTaken, 1);
  assert.deepEqual(mut.coverage().hpSeen, [10]);
});

test('internalState 只给裁判：它与 screen 是两条独立通道', async () => {
  const s = new GameSession(6);
  const internal = s.internalState();
  assert.equal(typeof internal.enemies[0]!.dir, 'number', '裁判拿得到内部朝向');
  assert.ok(!s.screen().includes('"dir"'), '屏幕拿不到');
  await s.apply(W);
  assert.equal(s.internalState().tick, 1);
});