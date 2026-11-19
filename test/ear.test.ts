/**
 * M4-c 下半：眼耳矛盾判据的单元测试（作者侧，绝不进契约）。
 *
 * ⚠️ 这个文件是**先写的，而且是先红的**。下面每一条期望值都是人对着两帧屏幕
 *    手工读出来的（屏幕由 render() 生成、由 observe() 逆投影回来），
 *    没有一条是从 ear.ts 的实际输出里回填的——回填出来的真值表只能证明代码等于它自己。
 *    冻结顺序（§ear 纪律 5）：写这张表 → 实现 → 表全绿 → **才**写 FROZEN_SHA256 → 再出统计。
 *
 * 这一份只验判据本体。端到端三件套各走各路（台账 #14）：
 *   verify/ear-fixture.ts   手写已知判决的夹具局
 *   verify/ear-audit.ts     不 import 判据，自己重放重判
 *   verify/ear-selftest.ts  注入 + 反向对照
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observe } from '../src/world/observe.ts';
import { renderInitial } from '../src/world/render.ts';
import { ALL_CAPS, randomActions, runSequence, type Action, type WorldState } from '../src/world/arena.ts';
import { soundStream } from '../src/world/sound.ts';
import {
  CAPACITY_ITEMS, EAR_CUES, EAR_CUE_TABLE, EAR_VERDICTS, EAR_VERSION, FROZEN_SHA256,
  bucketizeEar, earCanonical, earDrift, earFrames, earSha, earStamp, eyeFrame, judgeEar,
  type EarClaim, type EarSound, type FrameInput,
} from '../src/world/ear.ts';

// ─────────────────────────── 造两帧屏幕 ───────────────────────────

interface Cell { x: number; y: number }

interface Spec {
  tick?: number;
  walls?: string[];
  at?: Cell;
  hp?: number;
  score?: number;
  cooldown?: number;
  alive?: boolean;
  enemies?: Cell[];
  pickups?: Cell[];
}

/** 手写一帧世界状态。默认 6×6、玩家 (1,1)、满血、就绪、活着。 */
function ws(s: Spec): WorldState {
  const at = s.at ?? { x: 1, y: 1 };
  return {
    tick: s.tick ?? 1,
    size: 6,
    walls: s.walls ?? [],
    player: {
      x: at.x, y: at.y, hp: s.hp ?? 10, maxHp: 10,
      cooldown: s.cooldown ?? 0, score: s.score ?? 0, alive: s.alive ?? true,
    },
    enemies: (s.enemies ?? []).map((c, i) => ({ id: i, x: c.x, y: c.y, hp: 1, alive: true, dir: 0 as const })),
    pickups: (s.pickups ?? []).map((c, i) => ({ id: i, x: c.x, y: c.y, taken: false })),
  };
}

/** 屏幕 = 眼睛能看到的全部。判决只吃这张图逆投影回来的东西。 */
const look = (s: WorldState) => observe(renderInitial(s));

const MOVE = (dir: 0 | 1 | 2 | 3): Action => ({ kind: 'move', dir });
const ATTACK: Action = { kind: 'attack' };
const TAKE: Action = { kind: 'pickup' };
const WAIT: Action = { kind: 'wait' };

/** 取某一族发声事件的眼侧判决行。 */
function status(cue: string, prev: WorldState, action: Action, next: WorldState): string {
  const row = eyeFrame(look(prev), action, look(next)).find((r) => r.cue === cue)!;
  return row.status;
}

// ─────────────────────────── A. 眼侧真值表（逐条手工读屏幕） ───────────────────────────

test('A1 走了一格：脚步该响、闷响不该响', () => {
  const prev = ws({ at: { x: 1, y: 1 } });
  const next = ws({ tick: 2, at: { x: 2, y: 1 } });
  assert.equal(status('footstep', prev, MOVE(1), next), '该响');
  assert.equal(status('wallBump', prev, MOVE(1), next), '不该响');
});

test('A2 撞上画得出来的墙（位置没变）：闷响该响、脚步不该响', () => {
  const prev = ws({ at: { x: 1, y: 1 }, walls: ['2,1'] });
  const next = ws({ tick: 2, at: { x: 1, y: 1 }, walls: ['2,1'] });
  assert.equal(status('wallBump', prev, MOVE(1), next), '该响');
  assert.equal(status('footstep', prev, MOVE(1), next), '不该响');
});

test('A3 撞出边界（屏幕上根本没有那一格）：闷响该响', () => {
  const prev = ws({ at: { x: 0, y: 0 } });
  const next = ws({ tick: 2, at: { x: 0, y: 0 } });
  assert.equal(status('wallBump', prev, MOVE(0), next), '该响');
});

test('A4 墙不挡路那一族（M01 形状）：人穿过去了 ⇒ 闷响不该响、脚步该响', () => {
  // 眼睛只认"画面上你有没有挪"。挪了就是没撞上，内部那格是不是墙与声音无关。
  const prev = ws({ at: { x: 1, y: 1 }, walls: ['2,1'] });
  const next = ws({ tick: 2, at: { x: 2, y: 1 }, walls: ['2,1'] });
  assert.equal(status('wallBump', prev, MOVE(1), next), '不该响');
  assert.equal(status('footstep', prev, MOVE(1), next), '该响');
});

test('A5 位置没动、目标格却是空地：闷响**说不清**（不许硬判成该响或不该响）', () => {
  // 屏幕上"没挪 + 前面没墙"这两件事同时成立，眼睛说不出这声闷响该不该有。
  // 判成"该响"会造出假矛盾；判成"不该响"会把真实的阻挡物缺陷洗白。只能落进无法核对并计数。
  const prev = ws({ at: { x: 1, y: 1 } });
  const next = ws({ tick: 2, at: { x: 1, y: 1 } });
  assert.equal(status('wallBump', prev, MOVE(1), next), '说不清');
  assert.equal(status('footstep', prev, MOVE(1), next), '不该响');
});

test('A6 出手：就绪 ⇒ 破风声该响；冷却中 ⇒ 不该响', () => {
  const ready = ws({});
  const readyNext = ws({ tick: 2 });
  assert.equal(status('swing', ready, ATTACK, readyNext), '该响');
  const cold = ws({ cooldown: 2 });
  assert.equal(status('swing', cold, ATTACK, ws({ tick: 2, cooldown: 1 })), '不该响');
});

test('A7 击杀声只认 HUD 分数：分数涨了才该响，没涨就不该响（不看 E 少没少）', () => {
  // 世界契约 scoreOnKill：一次击杀 +1 分。分数是屏幕上唯一数得出的击杀计数。
  const prev = ws({ enemies: [{ x: 3, y: 1 }, { x: 5, y: 5 }] });
  const oneDead = ws({ tick: 2, enemies: [{ x: 5, y: 5 }], score: 1 });
  assert.equal(status('killThud', prev, ATTACK, oneDead), '该响');
  // 分数涨了、但这一帧并没有出手（例如 M05 冷却坏了）：眼睛照样记到击杀 ⇒ 该响（矛盾该由耳朵承担）
  assert.equal(status('killThud', prev, WAIT, oneDead), '该响');
  // 出手了但画面没记到击杀：不该响
  assert.equal(
    status('killThud', prev, ATTACK, ws({ tick: 2, enemies: [{ x: 3, y: 1 }, { x: 5, y: 5 }] })),
    '不该响',
  );
});

test('A7b 可见「E」变少不是击杀证据：两个敌人叠进同一格，屏幕上只画一个', () => {
  // 首跑 C3 第 37 帧的真实形状（当时判据凭空造出一条"倒地声漏报"矛盾）：
  // (6,7) 那个敌人走到 (7,7)，那格本来已经站着一个 ⇒ 可见 E 从 2 格变 1 格，谁也没死（分数没涨）。
  // 「E」是"哪些格上有敌人"，不是"有几个敌人"——数错这一层，判据就成了假矛盾的制造机。
  const prev = ws({ at: { x: 1, y: 1 }, enemies: [{ x: 6, y: 5 }, { x: 5, y: 5 }] });
  const next = ws({ tick: 2, at: { x: 1, y: 1 }, enemies: [{ x: 5, y: 5 }, { x: 5, y: 5 }] });
  assert.equal(look(prev).enemies.length, 2, '夹具前提：两格各画一个 E');
  assert.equal(look(next).enemies.length, 1, '夹具前提：叠到同一格之后屏幕上只剩一个 E');
  assert.equal(status('killThud', prev, ATTACK, next), '不该响', '分数没涨 ⇒ 画面没记到击杀，那一声倒地声压根不该有');
  // 但"有人挪了"这一条是硬证据：(6,5) 那格确定空出来了、没被 @ 盖住、画面又没记到击杀 ⇒ 只能是被走掉的
  const row = eyeFrame(look(prev), ATTACK, look(next)).find((r) => r.cue === 'shuffle')!;
  assert.equal(row.status, '该响');
  assert.deepEqual(row.interval, [1, null], '下界 1、上界为 null：藏起来的几个敌人屏幕压根数不出');
});

test('A8 HUD 少一行，判决就瞎一行：分数栏缺失⇒击杀声/窸窣说不清，攻击行缺失⇒破风声说不清', () => {
  const prev = ws({ enemies: [{ x: 3, y: 1 }] });
  const next = ws({ tick: 2, enemies: [], score: 1 });
  const drop = (prefix: string) => (s: WorldState): string =>
    renderInitial(s).split('\n').filter((l) => !l.startsWith(prefix)).join('\n');
  // 分数是眼侧唯一的击杀计数：这一栏读不出来，"死没死"和"空出来的那格是死了还是走了"必须一起失明
  const noScore = eyeFrame(observe(drop('HP ')(prev)), ATTACK, observe(drop('HP ')(next)));
  assert.equal(noScore.find((r) => r.cue === 'killThud')!.status, '说不清');
  assert.equal(noScore.find((r) => r.cue === 'shuffle')!.status, '说不清');
  assert.equal(noScore.find((r) => r.cue === 'hurtGrunt')!.status, '说不清');
  // 只缺攻击那一行：分数还在，击杀声照判；失明的只有"这一下到底有没有真出手"
  const noAtk = eyeFrame(observe(drop('攻击：')(prev)), ATTACK, observe(drop('攻击：')(next)));
  assert.equal(noAtk.find((r) => r.cue === 'swing')!.status, '说不清');
  assert.equal(noAtk.find((r) => r.cue === 'killThud')!.status, '该响');
});

test('A9 血条掉了 ⇒ 闷哼该响；血条没动 ⇒ 不该响', () => {
  assert.equal(status('hurtGrunt', ws({ hp: 10 }), WAIT, ws({ tick: 2, hp: 8 })), '该响');
  assert.equal(status('hurtGrunt', ws({ hp: 10 }), WAIT, ws({ tick: 2, hp: 10 })), '不该响');
  // 掉血不需要任何动作配合：敌人自己贴上来也算
  assert.equal(status('hurtGrunt', ws({ hp: 10 }), MOVE(0), ws({ tick: 2, hp: 6 })), '该响');
});

test('A10 拾取：只有"血条涨了"这一条画面证据；脚下那格的东西屏幕上从来就看不见', () => {
  // '@' 在 render 里最后画，玩家脚下的 '+' 永远被盖住 ⇒ 眼睛看不见"脚下少了一个物品"这件事。
  const prev = ws({ at: { x: 2, y: 2 }, pickups: [{ x: 2, y: 2 }, { x: 5, y: 5 }] });
  const healed = ws({ tick: 2, at: { x: 2, y: 2 }, hp: 10, pickups: [{ x: 5, y: 5 }] });
  assert.deepEqual(look(prev).pickups, [[5, 5]], '夹具前提：脚下的物品在屏幕上不可见（图层遮蔽）');
  assert.equal(status('pickupClick', prev, TAKE, healed), '说不清', '满血拾取：血条不动，画面说不出拿没拿');
  const hurt = ws({ at: { x: 2, y: 2 }, hp: 5, pickups: [{ x: 2, y: 2 }, { x: 5, y: 5 }] });
  const hurtHealed = ws({ tick: 2, at: { x: 2, y: 2 }, hp: 8, pickups: [{ x: 5, y: 5 }] });
  assert.equal(status('pickupClick', hurt, TAKE, hurtHealed), '该响', '血条涨了 3 点 ⇒ 确实拿起了东西');
  // M06 形状：拾取不回血 ⇒ 眼睛当场失明，只能说不清（不许判成漏报）
  const m06 = ws({ tick: 2, at: { x: 2, y: 2 }, hp: 5, pickups: [{ x: 5, y: 5 }] });
  assert.equal(status('pickupClick', hurt, TAKE, m06), '说不清');
  // 没做拾取动作 ⇒ 不该响
  assert.equal(status('pickupClick', hurt, WAIT, m06), '不该响');
});

test('A11 别人踩走了我的物品格：可见 '+' 少一格，但那不是拾取（图层遮蔽必须校正）', () => {
  // '+' 在 (4,4)，下一帧一个敌人站到了 (4,4) 上 ⇒ 屏幕上 '+' 消失。
  // 判据若只数 '+' 的个数，会凭空造出一条"咔哒漏报"矛盾。
  const prev = ws({ at: { x: 1, y: 1 }, pickups: [{ x: 4, y: 4 }] });
  const next = ws({ tick: 2, at: { x: 1, y: 1 }, enemies: [{ x: 4, y: 4 }] });
  assert.equal(look(next).pickups.length, 0, '夹具前提：被敌人盖住后屏幕上数不到那格物品');
  assert.equal(status('pickupClick', prev, WAIT, next), '不该响');
});

test('A12 敌人格子可见地变了 ⇒ 窸窣该响；一格都没变 ⇒ 说不清（屏幕上敌人没有名字）', () => {
  const prev = ws({ enemies: [{ x: 3, y: 1 }] });
  const moved = ws({ tick: 2, enemies: [{ x: 4, y: 1 }] });
  assert.equal(status('shuffle', prev, WAIT, moved), '该响');
  // 两帧画面逐字节相同：敌人可以互换位置而不留痕迹，眼睛说不出"有没有人挪过"
  const same = ws({ tick: 2, enemies: [{ x: 3, y: 1 }] });
  assert.equal(status('shuffle', prev, WAIT, same), '说不清');
});

test('A13 玩家踩到敌人格：「E」被「@」盖住，不许数成"少了一个敌人 ⇒ 有人死了"', () => {
  const prev = ws({ at: { x: 1, y: 1 }, enemies: [{ x: 2, y: 1 }] });
  const next = ws({ tick: 2, at: { x: 2, y: 1 }, hp: 8 });
  assert.equal(look(next).enemies.length, 0, '夹具前提：玩家站上去之后那个 E 在屏幕上消失了');
  assert.equal(status('killThud', prev, MOVE(1), next), '不该响', '分数没涨：那格空出来是被 @ 盖住，不是有人死了');
  assert.equal(status('shuffle', prev, MOVE(1), next), '说不清', '被玩家盖住的 E 不许当成"有人挪走了"');
});

test('A14 倒下那一帧：倒地声该响；倒下之后的每一帧：全部说不清', () => {
  const last = ws({ hp: 2 });
  const dead = ws({ tick: 2, hp: 0, alive: false });
  assert.equal(status('deathThud', last, WAIT, dead), '该响');
  assert.equal(status('hurtGrunt', last, WAIT, dead), '该响');
  // 倒下之后世界仍在推进（tick 会走），但"死后还该不该有声音"是**设计决定**不是画面事实
  const rows = eyeFrame(look(dead), WAIT, look(ws({ tick: 3, hp: 0, alive: false })));
  assert.deepEqual(rows.map((r) => r.status), EAR_CUES.map(() => '说不清'));
});

test('A15 一帧固定产出 8 行、顺序固定，且不读屏幕上的"刚才发生"', () => {
  const prev = ws({ at: { x: 1, y: 1 }, walls: ['2,1'] });
  const rows = eyeFrame(look(prev), MOVE(1), look(prev));
  assert.equal(rows.length, EAR_CUES.length);
  assert.deepEqual(rows.map((r) => r.cue), [...EAR_CUES], '行序就是 CUE 表序，两处各排各的迟早漂移');
  // 拿一段"说反话"的现象文本糊在同一张屏幕上：几何说不清，判决就不许跟着文案走
  const lying = renderInitial(prev).replace('图例：', '刚才发生：\n  - 你朝右走了一格。\n图例：');
  const rows2 = eyeFrame(observe(lying), MOVE(1), observe(lying));
  assert.deepEqual(rows2.map((r) => [r.cue, r.status]), rows.map((r) => [r.cue, r.status]));
});

// ─────────────────────────── B. 判决与恒等式 ───────────────────────────

const STEP = '一声脚步。';
const BUMP = '一声闷响，像撞上了硬物。';
const SWING = '一下破风声。';
const KILL = '一声短促的倒地声。';
const GRUNT = '一声闷哼。';
const CLICK = '一声咔哒，像什么东西被拿了起来。';
const rustle = (n: number): string => `远处有 ${n} 处窸窣。`;
const DEAD = '一记沉重的倒地声。';

function heard(tick: number, texts: string[]): EarSound[] {
  return texts.map((text, seq) => ({ tick, seq, text }));
}

/** 一帧 = (前一刻屏幕, 动作, 后一刻屏幕, 这一帧听到的一切)。 */
function frame(tick: number, prev: WorldState, action: Action, next: WorldState, texts: string[]): FrameInput {
  return { tick, inRange: true, prev: look(prev), action, next: look(next), heard: heard(tick, texts) };
}

/** 三帧一直走 + 一帧撞墙：参考版应当全绿（除容量差）。 */
function referenceStream(textsPerTick: Record<number, string[]>): FrameInput[] {
  // 玩家一路向右：(1,1)→(2,1)→(3,1)→(4,1) 共三帧真移动，第 4 帧撞上 (5,1) 那格画得出来的墙、人停住。
  const wall = ['5,1'];
  const s1 = ws({ tick: 1, at: { x: 1, y: 1 }, walls: wall });
  const s2 = ws({ tick: 2, at: { x: 2, y: 1 }, walls: wall });
  const s3 = ws({ tick: 3, at: { x: 3, y: 1 }, walls: wall });
  const s4 = ws({ tick: 4, at: { x: 4, y: 1 }, walls: wall });
  return [
    frame(1, s1, MOVE(1), s2, textsPerTick[1] ?? []),
    frame(2, s2, MOVE(1), s3, textsPerTick[2] ?? []),
    frame(3, s3, MOVE(1), s4, textsPerTick[3] ?? []),
    frame(4, s4, MOVE(1), s4, textsPerTick[4] ?? []),
  ];
}

test('B1 参考版：脚步全对上，矛盾=0、时钟错位=0，容量差如实计数', () => {
  const { claims, counts } = judgeEar(referenceStream({
    1: [STEP], 2: [STEP], 3: [STEP], 4: [BUMP],
  }));
  assert.equal(counts['矛盾'], 0);
  assert.equal(counts['时钟错位'], 0);
  assert.equal(counts['无法核对'], 0);
  // 4 帧：3 次真移动（每次 眼+耳 = 2 条相符）+ 1 次撞墙（2 条相符）
  assert.equal(counts['相符'], 8, claims.filter((c) => c.verdict === '相符').map((c) => `${c.tick}:${c.cue}`).join(' '));
  // 容量差：玩家每一帧都换了一格，而"走到哪一格"耳朵说不出来（3 帧移动）
  assert.equal(counts['容量差'], 3, claims.filter((c) => c.verdict === '容量差').map((c) => `${c.tick}:${c.cue}`).join(' '));
  assert.equal(
    VERDICT_SUM(counts), claims.length,
    '恒等式：五桶之和必须等于主张总数',
  );
});

test('B2 一缺一多如果帧号差恒定（≥3 次）⇒ 判成时钟错位，不许满屏假矛盾', () => {
  // S10 的形状：内容全对，整条流晚一帧。
  const frames: FrameInput[] = [
    frame(1, ws({ tick: 1, at: { x: 1, y: 1 } }), MOVE(1), ws({ tick: 2, at: { x: 2, y: 1 } }), []),
    frame(2, ws({ tick: 2, at: { x: 2, y: 1 } }), MOVE(1), ws({ tick: 3, at: { x: 3, y: 1 } }), [STEP]),
    frame(3, ws({ tick: 3, at: { x: 3, y: 1 } }), MOVE(1), ws({ tick: 4, at: { x: 4, y: 1 } }), [STEP]),
    frame(4, ws({ tick: 4, at: { x: 4, y: 1 } }), MOVE(1), ws({ tick: 5, at: { x: 5, y: 1 } }), [STEP]),
    // 第 4 帧的脚步落到了第 5 帧上——屏幕根本没有第 5 帧
    frame(5, ws({ tick: 5, at: { x: 5, y: 1 } }), WAIT, ws({ tick: 5, at: { x: 5, y: 1 } }), [STEP]),
  ];
  const { counts } = judgeEar(frames);
  assert.equal(counts['时钟错位'], 8, '4 对 × 每对 2 条（两侧各一条），与"漏报+误报"同分母');
  assert.equal(counts['矛盾'], 0);
  assert.equal(counts['相符'], 0);
});

test('B3 只缺一两声 ⇒ 不许拿"整族错位"当遮羞布，照旧判矛盾', () => {
  // 同上四帧，但只有第 2 帧多响了一声、第 1 帧少响一声：位移解释被最少次数闸门拦下。
  const frames: FrameInput[] = [
    frame(1, ws({ tick: 1, at: { x: 1, y: 1 } }), MOVE(1), ws({ tick: 2, at: { x: 2, y: 1 } }), []),
    frame(2, ws({ tick: 2, at: { x: 2, y: 1 } }), MOVE(1), ws({ tick: 3, at: { x: 3, y: 1 } }), [STEP, STEP]),
    frame(3, ws({ tick: 3, at: { x: 3, y: 1 } }), MOVE(1), ws({ tick: 4, at: { x: 4, y: 1 } }), [STEP]),
    frame(4, ws({ tick: 4, at: { x: 4, y: 1 } }), MOVE(1), ws({ tick: 5, at: { x: 5, y: 1 } }), [STEP]),
  ];
  const { counts } = judgeEar(frames);
  assert.equal(counts['时钟错位'], 0);
  assert.equal(counts['矛盾'], 2, '1 条漏报（第 1 帧）+ 1 条误报（第 2 帧多出的那一声）');
  assert.equal(counts['相符'], 6);
});

test('B4 漏报（S01 形状）：眼睛说走了、耳朵一声不响 ⇒ 矛盾，且只算耳侧缺席那一条', () => {
  const { claims, counts } = judgeEar(referenceStream({ 4: [BUMP] }));
  assert.equal(counts['相符'], 2, '只有撞墙那一记两侧对上');
  assert.equal(counts['矛盾'], 3, claims.filter((c) => c.verdict === '矛盾').map((c) => `${c.tick}:${c.cue}`).join(' '));
  assert.ok(claims.every((c) => c.verdict !== '矛盾' || c.side === '眼'), '漏报只能来自眼侧主张');
  assert.ok(claims.filter((c) => c.verdict === '矛盾').every((c) => c.why.includes('漏报')));
});

test('B5 误报（S09 形状）：走得好好的多一记闷响 ⇒ 矛盾，单局无参考版即可成立', () => {
  const { claims, counts } = judgeEar(referenceStream({ 1: [STEP, BUMP], 2: [STEP, BUMP], 3: [STEP, BUMP], 4: [BUMP] }));
  assert.equal(counts['矛盾'], 3, claims.filter((c) => c.verdict === '矛盾').map((c) => `${c.tick}:${c.cue}:${c.side}`).join(' '));
  assert.equal(counts['相符'], 8);
  assert.ok(claims.filter((c) => c.verdict === '矛盾').every((c) => c.side === '耳'), '误报只能来自耳侧主张');
  assert.ok(claims.filter((c) => c.verdict === '矛盾').every((c) => c.why.includes('误报')));
});

test('B6 听不见的那一族：说不清 + 耳朵响了 ⇒ 无法核对，不许冒充矛盾', () => {
  // 玩家满血站在物品格上做拾取：血条不会涨（已顶到上限），脚下的 '+' 又永远被 '@' 盖着
  // ⇒ 画面说不出这一帧到底有没有东西被拿起来。耳朵响了一声咔哒，屏幕既不支持也不反对。
  const prev = ws({ at: { x: 2, y: 2 }, hp: 10, pickups: [{ x: 2, y: 2 }] });
  const next = ws({ tick: 2, at: { x: 2, y: 2 }, hp: 10, pickups: [] });
  assert.deepEqual(look(prev).pickups, [], '夹具前提：脚下的物品在屏幕上不可见');
  const frames: FrameInput[] = [
    frame(1, ws({ at: { x: 1, y: 1 } }), MOVE(1), ws({ tick: 2, at: { x: 2, y: 1 } }), [STEP]),
    frame(2, prev, TAKE, next, [CLICK]),
  ];
  const { counts } = judgeEar(frames);
  assert.equal(counts['矛盾'], 0);
  assert.equal(counts['无法核对'], 1);
  assert.equal(counts['相符'], 2);
});

test('B7 一帧死两个敌人：一声倒地（2 条相符）+ 哪一格 + 多出来那一具 = 两条容量差', () => {
  const prev = ws({ enemies: [{ x: 3, y: 1 }, { x: 1, y: 3 }, { x: 5, y: 5 }] });
  const next = ws({ tick: 2, enemies: [{ x: 5, y: 5 }], score: 2 });
  const { counts, claims } = judgeEar([frame(1, prev, ATTACK, next, [SWING, KILL])]);
  const cap = claims.filter((c) => c.verdict === '容量差');
  assert.equal(counts['容量差'], cap.length);
  assert.ok(cap.some((c) => c.why.includes('哪一格')), '死了两个：屏幕数得出"少了两具"，耳朵说不出是哪几格');
  assert.ok(cap.some((c) => c.why.includes('挤进同一声')), '第二具尸体挤进同一声倒地声里');
  assert.ok(cap.some((c) => c.why.includes('分数')), '计分是纯画面量，耳朵没有对应主张');
  assert.equal(counts['矛盾'], 0, '窸窣 0 处不许被读成矛盾——这一帧敌人确实没挪');
});

test('B8 窸窣的数字：低于画面下界 ⇒ 矛盾；高于下界多少都不许判矛盾（上界刻意放弃）', () => {
  // 屏幕上只看得见 1 个敌人确定离开了原来那格 ⇒ lo = 1。
  // 少报（说 0 处）当场抓住；多报抓不住——这不是疏忽，是**唯一诚实的做法**：
  // 两个敌人叠进同一格只画一个 E，藏起来的敌人数量屏幕永远数不出，硬卡上界＝凭空造矛盾（首跑 C3 实测踩过）。
  const prev = ws({ enemies: [{ x: 3, y: 1 }, { x: 0, y: 5 }] });
  const next = ws({ tick: 2, enemies: [{ x: 4, y: 1 }, { x: 0, y: 5 }] });
  const under = judgeEar([frame(1, prev, WAIT, next, [rustle(0)])]);
  assert.equal(under.counts['矛盾'], 2, under.claims.filter((c) => c.verdict === '矛盾').map((c) => c.why).join(' | '));
  const ok = judgeEar([frame(1, prev, WAIT, next, [rustle(1)])]);
  assert.equal(ok.counts['矛盾'], 0);
  assert.equal(ok.counts['相符'], 2);
  const over = judgeEar([frame(1, prev, WAIT, next, [rustle(9)])]);
  assert.equal(over.counts['矛盾'], 0, '上界是登记过的盲区（EAR_INTERVAL_RULE.blindSpot），不许拿它冒充检出');
  assert.equal(over.counts['相符'], 2);
});

test('B9 耳朵听见一句判据词表里没有的话 ⇒ 当场抛错，不许静默丢掉', () => {
  assert.throws(
    () => judgeEar([frame(1, ws({}), MOVE(1), ws({ tick: 2, at: { x: 2, y: 1 } }), ['一段没登记过的声音。'])]),
    /表外|未登记/,
  );
});

test('B10 恒等式：任何一批判决，五桶之和必须等于主张总数；表外判决必须炸', () => {
  const { claims } = judgeEar(referenceStream({ 1: [STEP], 2: [STEP], 3: [STEP], 4: [BUMP] }));
  const buckets = bucketizeEar(claims);
  assert.equal(VERDICT_SUM(buckets.counts), claims.length);
  assert.throws(
    () => bucketizeEar([{ ...claims[0]!, verdict: '差不多' as EarClaim['verdict'] }]),
    /表外/,
  );
  assert.equal(
    Object.values(buckets.byKey).reduce((s, c) => s + VERDICT_SUM(c), 0),
    claims.length,
    '分族（按 cue@帧）之和也必须等于主张总数',
  );
});

const VERDICT_SUM = (counts: Record<string, number>): number =>
  EAR_VERDICTS.reduce((s, v) => s + (counts[v] ?? 0), 0);

test('B11 整局位移之下，样本少的族不许退化成假矛盾：D 从已过闸的族继承', () => {
  // 一个"整条录音晚一帧"的 bug（S10）是**录音的属性**，不是每一族各自的属性：所有族同一个 D。
  // 脚步一局响几十次，够闸门；破风声、倒地声一局只响一两次，永远够不着"至少 3 次"。
  // 不继承的话，后者那一缺一多各记一条矛盾 ⇒ 一个时钟 bug 被读成两起事实矛盾（纪律 4 要防的正是这个）。
  const s = (tick: number, x: number, score = 0): WorldState => ws({ tick, at: { x, y: 1 }, score });
  const frames: FrameInput[] = [
    frame(1, s(1, 1), MOVE(1), s(2, 2), [STEP]),
    frame(2, s(2, 2), MOVE(1), s(3, 3), [STEP]),
    frame(3, s(3, 3), ATTACK, s(4, 3, 1), [SWING, KILL]),
    frame(4, s(4, 3, 1), MOVE(1), s(5, 4, 1), [STEP]),
    frame(5, s(5, 4, 1), MOVE(1), s(6, 5, 1), [STEP]),
    frame(6, s(6, 5, 1), WAIT, s(6, 5, 1), []),
  ];
  // 上面这份是**参考时序**（每一声都落在自己那一帧）：先确认它本身没有矛盾，
  // 再把整条流往后挪一帧——挪动只改帧号、不改内容，所以判决里一条矛盾都不许多出来。
  const clean = judgeEar(frames);
  assert.equal(clean.counts['矛盾'], 0, clean.claims.filter((c) => c.verdict === '矛盾').map((c) => c.why).join('\n'));
  assert.equal(clean.counts['相符'], 12, '6 声（4 脚步 + 1 破风 + 1 倒地）× 两侧各一条');

  const late = frames.flatMap((f) => f.heard.map((h) => ({ ...h, tick: h.tick + 1 })));
  const shifted: FrameInput[] = frames.map((f) => ({ ...f, heard: late.filter((h) => h.tick === f.tick) }));
  assert.equal(shifted.reduce((n, f) => n + f.heard.length, 0), 6, '夹具自检：6 声一个不少，只是整体晚了一帧');
  const { counts, claims } = judgeEar(shifted);
  assert.equal(counts['矛盾'], 0, claims.filter((c) => c.verdict === '矛盾').map((c) => `第${c.tick}帧 ${c.cue}[${c.side}] ${c.why}`).join('\n'));
  assert.equal(counts['时钟错位'], 12, '还是那 6 声 × 两侧各一条，只是全部换桶');
  assert.deepEqual(
    [...new Set(claims.filter((c) => c.verdict === '时钟错位').map((c) => `${c.cue}:${c.shift}`))].sort(),
    ['footstep:1', 'killThud:1', 'swing:1'],
  );
  assert.equal(counts['相符'], 0, '一帧都不对齐，就不该有"相符"');
});

test('B12 屏幕之外那一帧（声流挪出末尾）：那一帧不存在 ⇒ 无法核对', () => {
  const frames: FrameInput[] = [
    frame(1, ws({ at: { x: 1, y: 1 } }), MOVE(1), ws({ tick: 2, at: { x: 2, y: 1 } }), [STEP]),
    { ...frame(2, ws({ tick: 2, at: { x: 2, y: 1 } }), WAIT, ws({ tick: 2, at: { x: 2, y: 1 } }), [GRUNT]), inRange: false },
  ];
  const { counts } = judgeEar(frames);
  assert.equal(counts['无法核对'], 1);
  assert.equal(counts['矛盾'], 0);
});

// ─────────────────────────── C. 重放接线：耳朵不参与算画面 ───────────────────────────

test('C1 发声装置不改世界：同一局换一套耳朵，眼侧判决逐字节不动', async () => {
  const actions: Action[] = [MOVE(1), MOVE(2), WAIT];
  const a = await earFrames({ seed: 6, actions, sounds: [] });
  const b = await earFrames({
    seed: 6, actions,
    // 同一局、同一动作、同一能力，只在耳朵那边多加一记闷响（S09 的形状）。
    // earFrames 的入参里**根本没有 rig 这一项**——发声装置进不了眼侧，这是签名层面的保证。
    sounds: [1, 2, 3].flatMap((tick) => heard(tick, [BUMP])),
  });
  assert.equal(a.frames.length, b.frames.length);
  assert.deepEqual(
    a.frames.map((f) => eyeFrame(f.prev, f.action, f.next)),
    b.frames.map((f) => eyeFrame(f.prev, f.action, f.next)),
    '眼睛那一侧一个字都不许因为"播什么"而变',
  );
  assert.equal(a.claims.filter((c) => c.side === '耳').length, 0);
  assert.equal(b.counts['矛盾'] > 0, true, '反向对照：加了误报，判决必须动起来');
});

test('C2 重放出的帧数 = 动作数，且每帧的屏幕帧号与账本帧号对齐', async () => {
  const actions: Action[] = [MOVE(1), MOVE(2), WAIT, ATTACK];
  const { frames, consistency } = await earFrames({ seed: 7, actions, sounds: [] });
  assert.equal(frames.length, actions.length);
  assert.equal(consistency.tickAligned, true);
  assert.equal(consistency.screens, actions.length + 1);
});

test('C3 阴性对照：参考版声流对着眼睛判，一条矛盾都不许有（多 seed 多长度扫）', async () => {
  // 这一条是整个判据的**下限**：两通道都没坏的时候，判决必须干净。
  // 它红了只有两种解释——判据凭空造矛盾（判据的错），或者发声层在屏幕看不见的地方动了手
  // （那是要当场读明细的，不许改成 expect(...).not 蒙过去）。
  // 为什么扫多组：首跑只扫了 seed6/40 帧，就漏掉了"两个敌人叠成一格"那一类（第 37 帧假矛盾），
  // 单局抽样根本碰不到所有遮蔽形状。跑过的每一组都是判据的债。
  const rows: string[] = [];
  for (const [seed, len] of [[6, 40], [6, 120], [7, 60], [11, 60], [23, 80], [42, 80], [101, 150], [777, 200]] as const) {
    const actions = randomActions(seed, 3, len);
    const { states } = runSequence(seed, actions, ALL_CAPS);
    const sounds = soundStream(states, [null, ...actions]);
    const { counts, claims } = await earFrames({ seed, actions, sounds });
    const bad = claims.filter((c) => c.verdict === '矛盾');
    assert.equal(counts['矛盾'], 0, `seed${seed}/${len} 帧：\n${bad.map((c) => `第${c.tick}帧 ${c.cue} [${c.side}] ${c.why}`).join('\n')}`);
    assert.equal(counts['时钟错位'], 0, `seed${seed}/${len}：参考版的帧号本来就对齐，判出错位就是判据自己错了`);
    assert.ok(counts['相符'] > 0, `seed${seed}/${len}：一条都没对上＝判据根本没在读耳朵`);
    assert.ok(counts['容量差'] > 0, `seed${seed}/${len}：耳朵对画面的容量差必须如实计数，不许悄悄免检`);
    rows.push(`seed${seed}/${len} 相符 ${counts['相符']} 无法核对 ${counts['无法核对']} 容量差 ${counts['容量差']}`);
  }
  process.stdout.write(`  （阴性对照 ${rows.length} 组：${rows.join('；')}）\n`);
});

// ─────────────────────────── D. 冻结与零共享守卫 ───────────────────────────
test('D1 判据冻结：指纹必须等于写死的那一行，改了任何词表/区间口径都要红', () => {
  assert.match(FROZEN_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(earSha(), FROZEN_SHA256, earDrift() ?? '');
  assert.equal(earDrift(), null);
  assert.equal(earCanonical(), earCanonical(), 'canonical 必须是纯函数');
  assert.ok(earCanonical().includes(EAR_VERSION));
  assert.equal(earStamp().ear, EAR_VERSION);
  assert.equal(earStamp().sha, FROZEN_SHA256);
});

test('D2 canonical 覆盖了全部会动判决的东西：词表、区间口径、错位闸门、容量词条', () => {
  const c = JSON.parse(earCanonical()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(c).sort(), [
    'afterDeath', 'buckets', 'capacityItems', 'cues', 'intervalRule', 'shiftRule', 'version',
  ].sort(), '冻结面少了任何一项，就等于那一项没人认领');
  assert.equal((c.cues as unknown[]).length, EAR_CUES.length);
  assert.equal((c.capacityItems as unknown[]).length, CAPACITY_ITEMS.length);
  assert.equal((c.buckets as string[]).join('|'), EAR_VERDICTS.join('|'));
  assert.deepEqual((c.cues as { cue: string }[]).map((d) => d.cue), [...EAR_CUES]);
  assert.deepEqual((c.capacityItems as { id: string }[]).map((d) => d.id), CAPACITY_ITEMS.map((d) => d.id));
  assert.equal(typeof c.intervalRule, 'object');
  assert.equal(typeof c.shiftRule, 'object');
});

test('D3 判据与听觉器官零共享：不 import sound/render，不读屏幕上的"刚才发生"', () => {
  const src = readFileSync(new URL('../src/world/ear.ts', import.meta.url), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');
  assert.ok(!/from '\.\/(sound|render)\.ts'/.test(code), '判据不许 import 发声层或渲染层');
  const arena = /import([^;]*)from '\.\/arena\.ts'/.exec(code);
  assert.ok(arena, '必须只从 arena 拿 Action 类型');
  assert.match(arena[1]!, /^\s*type\s*\{[^}]*\bAction\b[^}]*\}\s*$/, '只许类型导入');
  assert.ok(!/WorldState|\bstep\b|describe|createWorld|runSequence|rand01/.test(arena[1]!),
    `从 arena 只许拿类型：拿到的是「${arena[1]!.trim()}」`);
  assert.ok(!/\bWorldState\b/.test(code), '判据不许认识内部状态');
  assert.ok(!/\.events\b/.test(code), '眼侧只认几何与 HUD，"刚才发生"是 describe() 的文案，读了就是一条共享通道');
  assert.ok(!/\bdescribe\s*\(/.test(code), '同上：不许调用现象文案');
});

test('D4 每条 cue 的现象文本必须能被自己的正则全匹配，且互相不抢', () => {
  const samples: [string, string][] = [
    ['footstep', STEP], ['wallBump', BUMP], ['swing', SWING], ['killThud', KILL],
    ['hurtGrunt', GRUNT], ['pickupClick', CLICK], ['shuffle', rustle(3)], ['deathThud', DEAD],
  ];
  for (const [cue, text] of samples) {
    const defs = EAR_CUE_TABLE.filter((d) => new RegExp(`^(?:${d.pattern})$`).test(text));
    assert.deepEqual(defs.map((d) => d.cue), [cue], `「${text}」必须且只能被 ${cue} 一家认领`);
  }
});
