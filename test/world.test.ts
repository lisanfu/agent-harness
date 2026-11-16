/**
 * 世界层测试。重点不是"能跑"，是**确定性纪律真的被强制执行**。
 *
 * 这里有两个测试是别处少见的：
 *  - 给 Date.now / Math.random 装炸弹：世界层敢偷读就当场炸，而不是靠 code review 保证。
 *  - 计数式随机 vs 有状态流的对照：证明"删掉一个系统不会让别的随机数移位"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CAPS, Dir, createWorld, rand01, randInt, randomActions, runSequence, step, worldHash,
  type Action, type Capabilities, type WorldState,
} from '../src/world/arena.ts';
import { createRng } from '../src/rng.ts';

const off = (...keys: (keyof Capabilities)[]): Capabilities => {
  const c = { ...ALL_CAPS };
  for (const k of keys) c[k] = false;
  return c;
};

/**
 * 手工夹具：语义测试要精确控制"谁在哪、朝哪"，靠 createWorld 撞种子既慢又脆。
 * 默认墙为空、敌人在远处，各测试只覆盖自己关心的那一项。
 */
function fixture(over: Partial<WorldState> = {}): WorldState {
  return {
    tick: 0, size: 8, walls: [],
    player: { x: 0, y: 0, hp: 10, maxHp: 10, cooldown: 0, score: 0, alive: true },
    enemies: [{ id: 0, x: 5, y: 5, hp: 1, alive: true, dir: Dir.Right }],
    pickups: [{ id: 0, x: 7, y: 7, taken: false }],
    ...over,
  };
}
const P = (over: Partial<WorldState['player']> = {}) => ({
  x: 0, y: 0, hp: 10, maxHp: 10, cooldown: 0, score: 0, alive: true, ...over,
});

// ───────────────────────── 确定性纪律 ─────────────────────────

test('同种子同世界：createWorld 逐位可复现', () => {
  assert.equal(worldHash(createWorld(42)), worldHash(createWorld(42)));
  assert.notEqual(worldHash(createWorld(42)), worldHash(createWorld(43)));
});

test('step 是纯函数：绝不修改入参（ddmin 要反复重跑同一前缀）', () => {
  const prev = createWorld(9);
  const snapshot = JSON.stringify(prev);
  const acts = randomActions(9, 1, 30);
  let s = prev;
  for (const a of acts) s = step(s, a, ALL_CAPS, 9);
  assert.equal(JSON.stringify(prev), snapshot, '入参被污染了，重跑就会得到不同结果');
  assert.notEqual(worldHash(s), worldHash(prev));
});

test('世界层不读时钟、不用 Math.random：装炸弹，敢读就炸', () => {
  const realNow = Date.now;
  const realRandom = Math.random;
  Date.now = () => { throw new Error('世界层偷读了 Date.now'); };
  Math.random = () => { throw new Error('世界层用了 Math.random'); };
  try {
    const r = runSequence(11, randomActions(11, 2, 60), ALL_CAPS);
    assert.equal(r.states.length, 61);
    assert.equal(r.states[60]!.tick, 60);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
});

test('时间就是 tick：每帧严格 +1，与真实耗时无关', () => {
  let s = createWorld(3);
  for (let i = 0; i < 25; i++) {
    s = step(s, { kind: 'wait' }, ALL_CAPS, 3);
    assert.equal(s.tick, i + 1);
  }
});

test('计数式随机是纯函数：调用顺序/历史完全不影响取值', () => {
  const a = rand01(7, 3, 9000);
  for (let i = 0; i < 50; i++) rand01(7, i, i * 13); // 乱调一通
  assert.equal(rand01(7, 3, 9000), a);
  assert.notEqual(rand01(7, 3, 9001), a, 'salt 必须参与混合');
  assert.notEqual(rand01(7, 4, 9000), a, 'tick 必须参与混合');
});

test('删掉消耗随机的系统不会让其它随机数移位（这是不用有状态流的理由）', () => {
  const seed = 7;
  const draw = () => Array.from({ length: 20 }, (_, t) => randInt(seed, t, 9000, 4));
  const before = draw();
  // enemyPatrol 是 step 里唯一消耗随机的系统，关掉它 = 那些 rand 调用彻底消失
  runSequence(seed, randomActions(seed, 0, 40), off('enemyPatrol'));
  assert.deepEqual(draw(), before, '计数式随机不该被"少调了几次"影响');

  // 对照：有状态流只要少调一次，后面全错位 → 会产生与缺陷无关的假分叉
  const s1 = createRng(seed);
  const v1 = Array.from({ length: 5 }, () => s1());
  const s2 = createRng(seed);
  s2(); // 模拟"某系统被删掉，少消费了一个随机数"
  const v2 = Array.from({ length: 5 }, () => s2());
  assert.notDeepEqual(v1, v2);
});

test('rand01 落在 [0,1)，randInt 落在 [0,n)', () => {
  for (let t = 0; t < 300; t++) {
    const v = rand01(123, t, t);
    assert.ok(v >= 0 && v < 1);
    const n = 1 + (t % 7);
    const i = randInt(123, t, t, n);
    assert.ok(Number.isInteger(i) && i >= 0 && i < n);
  }
});

test('墙表排序且出生点留空（canonical 哈希才稳定）', () => {
  const w = createWorld(5);
  assert.deepEqual(w.walls, [...w.walls].sort());
  assert.ok(!w.walls.includes('0,0'));
  assert.equal(w.player.x, 0);
  assert.equal(w.player.y, 0);
});

// ───────────────────── 规则 vs 能力（边界不是能力）─────────────────────

test('边界永远挡：即使删掉 wallBlocks 也穿不出地图', () => {
  let s = createWorld(3);
  for (let i = 0; i < 5; i++) s = step(s, { kind: 'move', dir: Dir.Left }, off('wallBlocks'), 3);
  assert.equal(s.player.x, 0);
  assert.equal(s.player.y, 0);
});

test('死亡后所有动作一律无效（这是规则，不是能力）', () => {
  const dead = fixture({ player: P({ hp: 0, alive: false, x: 2, y: 2 }) });
  for (const a of [
    { kind: 'move', dir: Dir.Right }, { kind: 'attack' }, { kind: 'pickup' }, { kind: 'wait' },
  ] as Action[]) {
    const s = step(dead, a, ALL_CAPS, 1);
    assert.equal(s.player.x, 2);
    assert.equal(s.player.y, 2);
    assert.equal(s.player.alive, false);
  }
});

// ───────────────────── 九项能力各自的语义（直接验 step，不经公证器）─────────────────────

test('wallBlocks：墙挡路；删掉后可穿墙', () => {
  const w = fixture({ walls: ['1,0'] });
  assert.equal(step(w, { kind: 'move', dir: Dir.Right }, ALL_CAPS, 1).player.x, 0);
  assert.equal(step(w, { kind: 'move', dir: Dir.Right }, off('wallBlocks'), 1).player.x, 1);
});

test('enemyPatrol：敌人每帧移动；删掉后静止', () => {
  const w = fixture({ enemies: [{ id: 0, x: 3, y: 3, hp: 1, alive: true, dir: Dir.Right }] });
  assert.equal(step(w, { kind: 'wait' }, ALL_CAPS, 1).enemies[0]!.x, 4);
  assert.equal(step(w, { kind: 'wait' }, off('enemyPatrol'), 1).enemies[0]!.x, 3);
});

test('contactDamage：巡逻后同格才扣血（证明系统顺序：先移动后结算）', () => {
  // 敌人在 (1,0) 朝左 → 本帧走到 (0,0) 与玩家同格 → 扣 2
  const w = fixture({ enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }] });
  const on = step(w, { kind: 'wait' }, ALL_CAPS, 1);
  assert.equal(on.enemies[0]!.x, 0);
  assert.equal(on.player.hp, 8);
  assert.equal(step(w, { kind: 'wait' }, off('contactDamage'), 1).player.hp, 10);
});

test('attackKills：攻击杀死相邻敌人；删掉后敌人毫发无伤', () => {
  // ⚠️ 顺序教训（这个夹具第一版写错过）：攻击在系统 1 结算，巡逻在系统 3。
  // 所以攻击判定用的是**巡逻前**的位置，敌人必须一开始就相邻，
  // 不能指望它"先走过来再被打"。接触伤害相反，它在巡逻之后（系统 4）。
  const w = fixture({ enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }] });
  const on = step(w, { kind: 'attack' }, ALL_CAPS, 1);
  assert.equal(on.enemies[0]!.alive, false);
  const offR = step(w, { kind: 'attack' }, off('attackKills'), 1);
  assert.equal(offR.enemies[0]!.alive, true);
  assert.equal(offR.enemies[0]!.hp, 1);
});

test('attackCooldown：攻击后进入冷却，冷却中攻击无效', () => {
  // 敌人一开始就相邻（攻击在巡逻之前结算，见 attackKills 的顺序教训）
  const w = fixture({ enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }] });
  const a1 = step(w, { kind: 'attack' }, ALL_CAPS, 1);
  assert.equal(a1.player.cooldown, 2, '设 3 后同帧衰减 1');
  assert.equal(a1.enemies[0]!.alive, false, '相邻敌人确实被杀死，证明夹具生效');
  // 冷却未结束就再攻击：不该刷新冷却，也不该有击杀效果
  const a2 = step(a1, { kind: 'attack' }, ALL_CAPS, 1);
  assert.equal(a2.player.cooldown, 1);
  // 删掉冷却：每帧都能攻击，cooldown 恒为 0
  const b1 = step(w, { kind: 'attack' }, off('attackCooldown'), 1);
  assert.equal(b1.player.cooldown, 0);
});

test('pickupHeals：拾取回血并标记已取；删掉后只标记不回血', () => {
  const w = fixture({ player: P({ hp: 5 }), pickups: [{ id: 0, x: 0, y: 0, taken: false }] });
  const on = step(w, { kind: 'pickup' }, ALL_CAPS, 1);
  assert.equal(on.player.hp, 8);
  assert.equal(on.pickups[0]!.taken, true);
  const offR = step(w, { kind: 'pickup' }, off('pickupHeals'), 1);
  assert.equal(offR.player.hp, 5);
  assert.equal(offR.pickups[0]!.taken, true, '标记已取不属于回血能力');
});

test('deathAtZeroHp：血量归零死亡；删掉后 hp=0 仍活着', () => {
  const w = fixture({
    player: P({ hp: 2 }),
    enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }],
  });
  const on = step(w, { kind: 'wait' }, ALL_CAPS, 1);
  assert.equal(on.player.hp, 0);
  assert.equal(on.player.alive, false);
  const offR = step(w, { kind: 'wait' }, off('deathAtZeroHp'), 1);
  assert.equal(offR.player.hp, 0);
  assert.equal(offR.player.alive, true);
});

test('scoreOnKill：击杀计分；删掉后敌人照死但分为 0', () => {
  // 同样：敌人开局即相邻，攻击在巡逻前结算
  const w = fixture({ enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }] });
  assert.equal(step(w, { kind: 'attack' }, ALL_CAPS, 1).player.score, 1);
  const offR = step(w, { kind: 'attack' }, off('scoreOnKill'), 1);
  assert.equal(offR.player.score, 0);
  assert.equal(offR.enemies[0]!.alive, false);
});

test('hpClamp：血量夹在 [0,maxHp]；删掉后可超上限、可为负', () => {
  const heal = fixture({ player: P({ hp: 10 }), pickups: [{ id: 0, x: 0, y: 0, taken: false }] });
  assert.equal(step(heal, { kind: 'pickup' }, ALL_CAPS, 1).player.hp, 10);
  assert.equal(step(heal, { kind: 'pickup' }, off('hpClamp'), 1).player.hp, 13);

  const hurt = fixture({
    player: P({ hp: 1 }),
    enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }],
  });
  assert.equal(step(hurt, { kind: 'wait' }, ALL_CAPS, 1).player.hp, 0);
  assert.equal(step(hurt, { kind: 'wait' }, off('hpClamp'), 1).player.hp, -1);
});

// ───────────────────────── 序列工具 ─────────────────────────

test('runSequence：状态数 = 动作数 + 1，含初始态', () => {
  const acts = randomActions(4, 0, 17);
  const r = runSequence(4, acts, ALL_CAPS);
  assert.equal(r.states.length, 18);
  assert.equal(r.hashes.length, 18);
  assert.equal(r.hashes[0], worldHash(createWorld(4)));
  assert.equal(r.states[17]!.tick, 17);
});

test('randomActions 可复现、salt 敏感、四种动作都出现', () => {
  assert.deepEqual(randomActions(8, 1, 40), randomActions(8, 1, 40));
  assert.notDeepEqual(randomActions(8, 1, 40), randomActions(8, 2, 40));
  const kinds = new Set(randomActions(8, 1, 200).map((a) => a.kind));
  assert.deepEqual([...kinds].sort(), ['attack', 'move', 'pickup', 'wait']);
});

test('同一序列跑两遍逐帧哈希一致（公证器的女地）', () => {
  const acts = randomActions(21, 3, 60);
  const a = runSequence(21, acts, ALL_CAPS);
  const b = runSequence(21, acts, ALL_CAPS);
  assert.deepEqual(a.hashes, b.hashes);
});