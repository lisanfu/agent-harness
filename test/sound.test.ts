/**
 * M4-c 听觉器官的单元测试。
 *
 * 这一轮的学习单位是一条可复现的失败：**只有一只眼睛的靶场看不见输出层的缺陷**。
 * 所以这份测试最要紧的不是"声音对不对"，而是三条**结构性**断言：
 *  1. 与 `describe()` 零共享（两条投影各写各的，否则眼耳互查是同义反复）；
 *  2. 现象文本里不许出现任何拉丁标识符（出现即等于把内部字段名/函数名念给 agent 听）；
 *  3. 删掉一项**世界层**能力时，若画面结果没变，声音也必须一字不变
 *     （`pickupHeals` 是判例：为"回血"发声 = 把缺陷的名字喊出来，见 §render 铁律 3）。
 *
 * ⚠️ 不跑真模型、不跑 runArena：全部纯函数 + 内存夹具（同 detect.test.ts 的分工）。
 * ⚠️ 夹具默认**不带会巡逻的敌人**（`solo`）：远处敌人每帧都出一句"窸窣"，
 *    凡是想钉死"某一帧只该听到某一句"的用例都得先把它请出去，否则测的是背景音。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CAPS, Dir, createWorld, randomActions, step, type Action, type Capabilities, type WorldState,
} from '../src/world/arena.ts';
import { describe } from '../src/world/render.ts';
import {
  ALL_SOUND_CAPS, REFERENCE_RIG, SOUND_CAP_NAMES, earText, soundFrame, soundStream,
  type SoundCaps, type SoundRig,
} from '../src/world/sound.ts';

const off = (...keys: (keyof Capabilities)[]): Capabilities => {
  const c = { ...ALL_CAPS };
  for (const k of keys) c[k] = false;
  return c;
};

/** 手工夹具：与 world.test.ts 同一套思路——精确控制"谁在哪"，不靠撞种子。 */
function fixture(over: Partial<WorldState> = {}): WorldState {
  return {
    tick: 0, size: 8, walls: [],
    player: { x: 0, y: 0, hp: 10, maxHp: 10, cooldown: 0, score: 0, alive: true },
    enemies: [{ id: 0, x: 5, y: 5, hp: 1, alive: true, dir: Dir.Right }],
    pickups: [{ id: 0, x: 7, y: 7, taken: false }],
    ...over,
  };
}

/** 背景音为零的夹具：场上没有活着的东西，只有玩家和自己的脚。 */
const solo = (over: Partial<WorldState> = {}): WorldState =>
  fixture({ enemies: [], pickups: [], ...over });

/** 走一帧，返回 (prev, action, next) 三元组，绝大多数断言都从它出发。 */
function one(prev: WorldState, action: Action, caps: Capabilities = ALL_CAPS) {
  return { prev, action, next: step(prev, action, caps, 1) };
}

/** 一串动作跑成的 (states, actions) 对，喂给 soundStream。 */
function play(seed: number, acts: readonly Action[], caps: Capabilities = ALL_CAPS) {
  const states: WorldState[] = [createWorld(seed)];
  const actions: (Action | null)[] = [null];
  for (const a of acts) { states.push(step(states[states.length - 1]!, a, caps, seed)); actions.push(a); }
  return { states, actions };
}

const hear = (prev: WorldState, action: Action, next: WorldState, caps: SoundCaps = ALL_SOUND_CAPS) =>
  soundFrame(prev, action, next, caps);

const BUMP = '一声闷响，像撞上了硬物。';
const STEP = '一声脚步。';

// ───────────────────── 结构性断言 1：与眼睛零共享 ─────────────────────

test('耳朵与眼睛是两条独立代码路径：产出的现象文本零交集', () => {
  // 若哪天有人图省事让 soundFrame 复用 describe 的字符串，这条立刻红——
  // 那时"眼耳一致"就退回成同一把尺子量两次（台账 #15 的通道侧复发）。
  const acts = randomActions(3, 1, 40);
  const { states, actions } = play(3, acts);
  const heard = new Set<string>();
  const seen = new Set<string>();
  for (let i = 1; i < states.length; i++) {
    for (const t of soundFrame(states[i - 1]!, actions[i]!, states[i]!)) heard.add(t);
    for (const t of describe(states[i - 1]!, actions[i]!, states[i]!)) seen.add(t);
  }
  assert.ok(heard.size >= 3, `夹具太单调：只听见到 ${heard.size} 种现象，交叉验证无从谈起`);
  assert.ok(seen.size >= 3, '屏幕侧现象表本身就没跑出几种，这条测试失去意义');
  const both = [...heard].filter((t) => seen.has(t));
  assert.deepEqual(both, [], `耳朵和眼睛复用了同一句文案：${both.join(' / ')}`);
});

// ─────────────────── 结构性断言 2：现象文本不许带标识符 ───────────────────

test('声流只给现象：整段跑下来没有一个拉丁字母', () => {
  const { states, actions } = play(7, randomActions(7, 2, 60));
  const stream = soundStream(states, actions);
  assert.ok(stream.length > 10, `夹具太瘦：只跑出一条 ${stream.length} 句的声流，扫描没有意义`);
  for (const e of stream) {
    assert.doesNotMatch(e.text, /[A-Za-z_]/, `现象文本里混进了标识符：${e.text}`);
    assert.doesNotMatch(e.text, /(冷却|能力|血量|HP|hp|坐标|第 \d+ 格)/, `现象文本泄露了内部因果：${e.text}`);
  }
});

test('耳朵没有布局：任何一句都不指位置，只报次数', () => {
  const acts = randomActions(13, 4, 40);
  const { states, actions } = play(13, acts);
  for (const e of soundStream(states, actions)) {
    assert.doesNotMatch(e.text, /\d+,\d+|\(\s*\d+\s*[,，]\s*\d+\s*\)|(上下左右)边|第 \d+ 行|第 \d+ 列/,
      `声音说出了屏幕才有的空间信息：${e.text}`);
  }
});

test('给 agent 的那一份只有帧号与现象，且静音必须说人话', () => {
  assert.match(earText([]), /什么都没听见/);
  assert.doesNotMatch(earText([]), /^\s*$/, '空字符串 = 分不清"静音"和"没核到"（#17 家族）');
  const s = solo();
  const s1 = step(s, { kind: 'move', dir: Dir.Right }, ALL_CAPS, 1);
  const txt = earText(soundStream([s, s1], [null, { kind: 'move', dir: Dir.Right }]));
  assert.equal(txt, '第 1 帧：一声脚步。');
  assert.doesNotMatch(txt, /footstep|SoundCaps|tick:/, '送达面混进了字段名');
});

test('uptoTick 只截到指定帧，不许把未来的声音提前给出去', () => {
  const s0 = solo();
  const s1 = step(s0, { kind: 'move', dir: Dir.Right }, ALL_CAPS, 1);
  const s2 = step(s1, { kind: 'move', dir: Dir.Down }, ALL_CAPS, 1);
  const stream = soundStream([s0, s1, s2], [null, { kind: 'move', dir: Dir.Right }, { kind: 'move', dir: Dir.Down }]);
  assert.equal(stream.length, 2);
  assert.equal(earText(stream, 1), '第 1 帧：一声脚步。',
    '把第 2 帧的声音算进了第 1 帧——"眼耳时间不对齐"就是这么造出来的');
});

// ───────────────────── 触发条件真值表（逐条钉死） ─────────────────────

test('走成一格 → 只有一声脚步，没有闷响', () => {
  const { prev, action, next } = one(solo(), { kind: 'move', dir: Dir.Right });
  assert.deepEqual(hear(prev, action, next), [STEP]);
});

test('撞上墙 → 只有闷响，没有脚步', () => {
  const prev = solo({ walls: ['1,0'] });
  const { action, next } = one(prev, { kind: 'move', dir: Dir.Right });
  assert.equal(next.player.x, 0, '夹具不成立：这一下没被墙挡住');
  assert.deepEqual(hear(prev, action, next), [BUMP]);
});

test('撞出边界 → 也算闷响（边界与墙对耳朵是同一个现象）', () => {
  const prev = solo();
  const { action, next } = one(prev, { kind: 'move', dir: Dir.Up });
  assert.equal(next.player.y, 0);
  assert.deepEqual(hear(prev, action, next), [BUMP]);
});

test('挥击：破风声照播；身边有人倒下才加一记倒地声', () => {
  const 空挥 = one(solo(), { kind: 'attack' });
  assert.deepEqual(hear(空挥.prev, 空挥.action, 空挥.next), ['一下破风声。']);

  const 贴身 = one(
    solo({ enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }] }),
    { kind: 'attack' },
  );
  assert.equal(贴身.next.enemies[0]!.alive, false, '夹具不成立：这一刀没杀掉');
  assert.deepEqual(hear(贴身.prev, 贴身.action, 贴身.next), ['一下破风声。', '一声短促的倒地声。']);
});

test('冷却中出手 → 一下声音都没有（没结算就没有现象）', () => {
  const prev = solo({ player: { x: 0, y: 0, hp: 10, maxHp: 10, cooldown: 2, score: 0, alive: true } });
  const { action, next } = one(prev, { kind: 'attack' });
  assert.deepEqual(hear(prev, action, next), []);
  assert.equal(next.tick, 1, '夹具自检：帧还是要推进的');
});

test('受击 → 一声闷哼；不扣血的世界（contactDamage 被删）就一声不响', () => {
  const prev = fixture({ enemies: [{ id: 0, x: 0, y: 1, hp: 1, alive: true, dir: Dir.Up }] });
  const hurt = one(prev, { kind: 'wait' });
  assert.ok(hurt.next.player.hp < 10, '夹具不成立：这一下没打上');
  assert.deepEqual(hear(prev, { kind: 'wait' }, hurt.next), ['一声闷哼。', '远处有 1 处窸窣。']);
  const mute = one(prev, { kind: 'wait' }, off('contactDamage'));
  assert.equal(mute.next.player.hp, 10);
  assert.deepEqual(hear(prev, { kind: 'wait' }, mute.next), ['远处有 1 处窸窣。'],
    '没掉血却闷哼 = 耳朵在替世界编造它没发生的事');
});

test('同帧又挨打又回血 → 只听净结果（与眼睛同一口径，不许各说各话）', () => {
  // 拾取回 3、接触掉 2 ⇒ 净 +1，屏幕上 hp 只涨不落。
  // 如果耳朵按"内部结算过几次伤害"发声，就会出现**屏幕说没受伤、耳朵说受伤了**的假矛盾。
  const prev = fixture({
    pickups: [{ id: 0, x: 0, y: 0, taken: false }],
    enemies: [{ id: 0, x: 0, y: 1, hp: 1, alive: true, dir: Dir.Up }],
    player: { x: 0, y: 0, hp: 8, maxHp: 10, cooldown: 0, score: 0, alive: true },
  });
  const heal = one(prev, { kind: 'pickup' });
  assert.ok(heal.next.player.hp >= prev.player.hp, '夹具不成立：这一帧净伤害为负，本例不成立');
  assert.doesNotMatch(hear(prev, { kind: 'pickup' }, heal.next).join(''), /闷哼/,
    '净血量没掉却闷哼 = 耳朵读到了屏幕读不到的内部结算次数（变相读心）');

  const noHeal = one(prev, { kind: 'pickup' }, off('pickupHeals'));
  assert.ok(noHeal.next.player.hp < prev.player.hp);
  assert.deepEqual(hear(prev, { kind: 'pickup' }, noHeal.next),
    ['一声闷哼。', '一声咔哒，像什么东西被拿了起来。', '远处有 1 处窸窣。']);
});

test('倒下：一记沉重倒地声，且只有一记；死后动作一律无声', () => {
  const prev = solo({ player: { x: 0, y: 0, hp: 2, maxHp: 10, cooldown: 0, score: 0, alive: true } });
  const dead: WorldState = { ...prev, tick: 1, player: { ...prev.player, hp: 0, alive: false } };
  assert.deepEqual(hear(prev, { kind: 'wait' }, dead), ['一声闷哼。', '一记沉重的倒地声。']);
  const after: WorldState = { ...dead, tick: 2, player: { ...dead.player, x: 1 } };
  assert.deepEqual(hear(dead, { kind: 'move', dir: Dir.Right }, after), [],
    '已经倒下还播脚步 = 声音读的是意图不是状态');
});

test('敌人挪动只报"几处"，绝不报在哪一格（耳朵没有布局）', () => {
  const prev = fixture({
    enemies: [
      { id: 0, x: 5, y: 5, hp: 1, alive: true, dir: Dir.Right },
      { id: 1, x: 6, y: 6, hp: 1, alive: true, dir: Dir.Down },
      { id: 2, x: 3, y: 3, hp: 1, alive: true, dir: Dir.Up },
    ],
  });
  const next: WorldState = {
    ...prev, tick: 1,
    enemies: [
      { id: 0, x: 6, y: 5, hp: 1, alive: true, dir: Dir.Right },
      { id: 1, x: 6, y: 7, hp: 1, alive: true, dir: Dir.Down },
      { id: 2, x: 3, y: 3, hp: 1, alive: true, dir: Dir.Left },
    ],
  };
  const t = hear(prev, { kind: 'wait' }, next);
  assert.deepEqual(t, ['远处有 2 处窸窣。'], '第三个敌人原地换向，不该出声');
  assert.doesNotMatch(t.join(''), /\d+,\d+|\(.*\)/, '现象文本里出现了坐标');
});

// ───────────── 结构性断言 3：能力开关不许改变"该播什么" ─────────────

test('判例：删掉 pickupHeals，声流逐字节不变（为回血发声=念出缺陷名字）', () => {
  const prev = solo({
    pickups: [{ id: 0, x: 0, y: 0, taken: false }],
    player: { x: 0, y: 0, hp: 4, maxHp: 10, cooldown: 0, score: 0, alive: true },
  });
  const heals = one(prev, { kind: 'pickup' });
  const muted = one(prev, { kind: 'pickup' }, off('pickupHeals'));
  assert.ok(heals.next.player.hp > prev.player.hp, '夹具不成立：参考版没回血');
  assert.equal(muted.next.player.hp, prev.player.hp);
  assert.deepEqual(
    hear(prev, { kind: 'pickup' }, heals.next),
    hear(prev, { kind: 'pickup' }, muted.next),
    '两版的拾取声不同 = 声音把世界层缺陷的答案喊出来了',
  );
  assert.deepEqual(hear(prev, { kind: 'pickup' }, heals.next), ['一声咔哒，像什么东西被拿了起来。']);
});

test('八个发声开关各管一条：关掉它只消对应那一句，且八个都必须被覆盖到', () => {
  // 覆盖判据：一个开关都没被触发到的"逐条验证"是假验证（#8/#13/#15/#17/#26 家族）。
  // 随机长局覆盖不到的形状（死亡、击杀、拾取）就手工补几帧——补的每一帧都先自检世界真的这么走了。
  const random = [1, 2, 3].flatMap((seed) => {
    const { states, actions } = play(seed, randomActions(seed, 7, 120));
    return states.slice(1).map((next, i) => ({ prev: states[i]!, action: actions[i + 1]!, next }));
  });
  const made: { prev: WorldState; action: Action; next: WorldState }[] = [];
  const push = (prev: WorldState, action: Action, caps: Capabilities = ALL_CAPS) =>
    made.push({ prev, action, next: step(prev, action, caps, 1) });
  const 撞墙前 = solo({ walls: ['1,0'] });
  push(撞墙前, { kind: 'move', dir: Dir.Right });
  const 贴身边 = solo({ enemies: [{ id: 0, x: 1, y: 0, hp: 1, alive: true, dir: Dir.Left }] });
  push(贴身边, { kind: 'attack' });
  assert.equal(step(贴身边, { kind: 'attack' }, ALL_CAPS, 1).enemies[0]!.alive, false, '补的击杀帧没真杀掉');
  const 脚下有 = solo({ pickups: [{ id: 0, x: 0, y: 0, taken: false }] });
  push(脚下有, { kind: 'pickup' });
  assert.equal(step(脚下有, { kind: 'pickup' }, ALL_CAPS, 1).pickups[0]!.taken, true, '补的拾取帧没真拾到');
  const 会被贴 = solo({
    enemies: [{ id: 0, x: 0, y: 1, hp: 1, alive: true, dir: Dir.Up }],
    player: { x: 0, y: 0, hp: 8, maxHp: 10, cooldown: 0, score: 0, alive: true },
  });
  push(会被贴, { kind: 'wait' });
  const 濒死 = solo({ player: { x: 0, y: 0, hp: 2, maxHp: 10, cooldown: 0, score: 0, alive: true } });
  made.push({
    prev: 濒死, action: { kind: 'wait' },
    next: { ...濒死, tick: 1, player: { ...濒死.player, hp: 0, alive: false } },
  });
  const corpus = [...random, ...made];

  const refAll = corpus.map((f) => hear(f.prev, f.action, f.next));
  const touched: string[] = [];
  const uncovered: string[] = [];
  for (const cap of SOUND_CAP_NAMES) {
    const caps: SoundCaps = { ...ALL_SOUND_CAPS, [cap]: false };
    let removedTotal = 0;
    for (let i = 0; i < corpus.length; i++) {
      const f = corpus[i]!;
      const cut = hear(f.prev, f.action, f.next, caps);
      const removed = refAll[i]!.filter((t) => !cut.includes(t));
      const added = cut.filter((t) => !refAll[i]!.includes(t));
      assert.deepEqual(added, [], `第 ${f.next.tick} 帧：关掉 ${cap} 却多出一句：${added.join(' / ')}`);
      assert.ok(removed.length <= 1, `关掉 ${cap} 消掉 ${removed.length} 句：一个开关管多条 = 归因表会串`);
      removedTotal += removed.length;
    }
    if (removedTotal === 0) uncovered.push(cap); else touched.push(cap);
  }
  assert.deepEqual(uncovered, [], `这批语料里从没触发过这些开关，"关了对应句消失"根本没验：${uncovered.join('/')}`);
  assert.equal(touched.length, SOUND_CAP_NAMES.length);
});

test('wallBlocks 被删（可穿墙）：耳朵跟着画面走，播脚步不播闷响', () => {
  const prev = solo({ walls: ['1,0'] });
  const through = one(prev, { kind: 'move', dir: Dir.Right }, off('wallBlocks'));
  assert.equal(through.next.player.x, 1, '夹具不成立：没穿过去');
  assert.deepEqual(hear(prev, { kind: 'move', dir: Dir.Right }, through.next), [STEP]);
});

test('enemyPatrol 被删：世界静止，窸窣声随之消失', () => {
  const prev = fixture({ enemies: [{ id: 0, x: 5, y: 5, hp: 1, alive: true, dir: Dir.Right }] });
  const still = one(prev, { kind: 'wait' }, off('enemyPatrol'));
  assert.deepEqual(hear(prev, { kind: 'wait' }, still.next), []);
  const alive = one(prev, { kind: 'wait' });
  assert.deepEqual(hear(prev, { kind: 'wait' }, alive.next), ['远处有 1 处窸窣。']);
});

// ───────────────────────────── 确定性 / 纯度 ─────────────────────────────

test('声流是纯函数：同输入逐字节相同，且绝不修改入参', () => {
  const acts = randomActions(11, 5, 50);
  const { states, actions } = play(11, acts);
  const snapS = JSON.stringify(states);
  const snapA = JSON.stringify(actions);
  const first = JSON.stringify(soundStream(states, actions));
  const second = JSON.stringify(soundStream(states, actions));
  assert.equal(first, second, '同一对状态跑两次得到不同声流 = 世界层偷读了时钟或随机');
  assert.equal(JSON.stringify(states), snapS, 'states 被污染，重放与 ddmin 会错位');
  assert.equal(JSON.stringify(actions), snapA, 'actions 被污染');
});

test('声流的帧号单调不减，且不含第 0 帧（首帧没有动作）', () => {
  const { states, actions } = play(5, randomActions(5, 9, 40));
  const stream = soundStream(states, actions);
  for (let i = 1; i < stream.length; i++) {
    assert.ok(stream[i]!.tick >= stream[i - 1]!.tick, `帧号倒流：${stream[i - 1]!.tick} → ${stream[i]!.tick}`);
  }
  assert.ok(stream.every((e) => e.tick >= 1), '首帧不该有声音：还没有任何动作发生');
});

test('帧内 seq 从 0 连续编号（声音是序列，不是集合）', () => {
  const prev = solo({
    pickups: [{ id: 0, x: 0, y: 0, taken: false }],
    enemies: [{ id: 0, x: 0, y: 1, hp: 1, alive: true, dir: Dir.Up }],
    player: { x: 0, y: 0, hp: 6, maxHp: 10, cooldown: 0, score: 0, alive: true },
  });
  const next = one(prev, { kind: 'pickup' }, off('pickupHeals')).next;
  const lines = hear(prev, { kind: 'pickup' }, next);
  assert.ok(lines.length >= 3, `夹具太瘦：${lines.length} 句，测不到帧内次序`);
  const stream = soundStream([prev, next], [null, { kind: 'pickup' }]);
  assert.deepEqual(stream.map((e) => e.seq), [...lines.keys()]);
  assert.equal(stream.length, lines.length, 'soundStream 与 soundFrame 对同一帧给出的句子数不同 = 两份接线在漂移');
});

test('状态数与动作数不等 → 抛错且理由带两个数字', () => {
  const s = [fixture(), fixture({ tick: 1 })];
  assert.throws(() => soundStream(s, [null]), /状态数\(2\).*动作数\(1\)/);
});

// ─────────────────────────── rig：两类输出层缺陷 ───────────────────────────

test('误报型 rig：走得好好的也来一记闷响，且只加在真位移的移动帧', () => {
  const acts: Action[] = [
    { kind: 'move', dir: Dir.Right }, { kind: 'wait' }, { kind: 'attack' },
    { kind: 'move', dir: Dir.Up }, // 边界外：本来就该闷响
  ];
  const s0 = solo();
  const states = [s0];
  const actions: (Action | null)[] = [null];
  for (const a of acts) { states.push(step(states[states.length - 1]!, a, ALL_CAPS, 1)); actions.push(a); }
  const ref = soundStream(states, actions);
  const bad = soundStream(states, actions, { ...REFERENCE_RIG, bumpOnMove: true });
  assert.ok(bad.length > ref.length, 'bumpOnMove 什么都没改 = 这条接线是空转的（#8 家族）');
  assert.deepEqual(ref.filter((e) => e.tick === 1).map((e) => e.text), [STEP]);
  assert.deepEqual(bad.filter((e) => e.tick === 1).map((e) => e.text), [STEP, BUMP], '误报只该加在真走成的那一步');
  // 第 4 帧本来就撞边界：误报不许叠加成两声闷响
  assert.equal(bad.filter((e) => e.tick === 4).length, ref.filter((e) => e.tick === 4).length,
    '本来就该响的地方又叠了一声 = 触发条件不是"位移"而是"所有移动"');
  // wait / attack 两帧不受影响
  assert.deepEqual(bad.filter((e) => e.tick === 2 || e.tick === 3), ref.filter((e) => e.tick === 2 || e.tick === 3));
});

test('错位型 rig：内容一字不改，只把帧号整体后移（判据必须单独成桶的前提）', () => {
  const { states, actions } = play(23, randomActions(23, 3, 30));
  const ref = soundStream(states, actions);
  const late = soundStream(states, actions, { ...REFERENCE_RIG, shiftTicks: 1 });
  assert.ok(ref.length > 5, '语料太瘦，条数相等这个断言没有意义');
  assert.equal(late.length, ref.length, '错位只改时钟，条数必须一模一样');
  assert.deepEqual(late.map((e) => e.text), ref.map((e) => e.text), '错位在偷偷改内容');
  assert.deepEqual(late.map((e) => e.tick), ref.map((e) => e.tick + 1));
  const rig: SoundRig = { caps: ALL_SOUND_CAPS, shiftTicks: 0 };
  assert.deepEqual(soundStream(states, actions, rig), ref);
});

test('两根线同时接错：脚步声换成闷响，条数与帧号全对得上、内容却全错位', () => {
  // 这条不是给判据加分的，是给它**挖坑并写进文档**的：
  // 只看"每帧响了几声"的对账在这里完全过关，只看内容不看时钟的对账则满屏假矛盾。
  // ⇒ 眼耳判据必须同时比**帧号、次数、内容**三样，缺一样就有一类缺陷溜过去。
  const acts: Action[] = [{ kind: 'move', dir: Dir.Right }, { kind: 'move', dir: Dir.Down }];
  const s0 = solo();
  const states = [s0];
  const actions: (Action | null)[] = [null];
  for (const a of acts) { states.push(step(states[states.length - 1]!, a, ALL_CAPS, 1)); actions.push(a); }
  const ref = soundStream(states, actions);
  const swapped = soundStream(states, actions, { caps: { ...ALL_SOUND_CAPS, footstep: false }, bumpOnMove: true });
  assert.equal(swapped.length, ref.length);
  assert.deepEqual(swapped.map((e) => e.tick), ref.map((e) => e.tick));
  assert.notDeepEqual(swapped.map((e) => e.text), ref.map((e) => e.text),
    '这条夹具本该造出"次数对、内容错"的缺陷，否则下面的断言没有着力点');
  assert.deepEqual(ref.map((e) => e.text), [STEP, STEP]);
  assert.deepEqual(swapped.map((e) => e.text), [BUMP, BUMP]);
});
