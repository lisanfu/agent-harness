/**
 * M4-d 主客观对账判据的单元测试（作者侧，绝不进契约）。
 *
 * 这一份只验**判据本身**：真值表、恒等式、冻结指纹、逆投影对齐、零内部状态。
 * 端到端（已发布证据有没有真被读出来、分母对不对）由三件套负责：
 *   verify/recon-fixture.ts   手写已知判决的夹具
 *   verify/recon-audit.ts     独立重算（不 import 判据本体）
 *   verify/recon-selftest.ts  注入 + 反向对照
 * 三边各走各路才叫独立复核（台账 #14：两个通道不许各信一份）。
 *
 * ⚠️ 本文件**不跑真模型、不读 runs/**：全部用纯函数 + 内存构造的屏幕。
 *    更关键的是：下面的期望值是**人对着屏幕读出来的**，不是从统计里回填的。
 *    写表时只有一条判据：把这一帧屏幕摆在眼前，这句话到底对不对。
 *    第一版真值表跑出 3 类红（极性档、回溯词转义、意图动词组）——
 *    那三处就是台账 #24 与 #23 同族，判据因此从 m4d-1 升到 m4d-2 才冻结。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observe, type Observation } from '../src/world/observe.ts';
import { describe, render, renderInitial } from '../src/world/render.ts';
import type { WorldState } from '../src/world/arena.ts';
import {
  EXCLUDED_RULES, FULLWIDTH_ASCII, FULLWIDTH_MAP, FROZEN_AT, FROZEN_SHA256, KINDS, RECON_VERSION,
  RULES, RETRO_RULES, SUB_CLAUSE_DELIMS, SYMBOL_WORDS, VERDICTS, bucketize, cellSymbolAt, clauseFor, countExcluded,
  extractClaims, judgeAll, judgeClaim, normalizeText, reconCanonical, reconDrift, reconSha, reconStamp,
  reconcileText, subClauseOf, type Claim, type Kind, type Verdict,
} from '../src/world/reconcile.ts';

// ─────────────────────────── 唯一的真值屏幕 ───────────────────────────

/**
 * 一份手写的战场状态。屏幕由 render() 生成，判决由 observe() 逆投影——
 * 也就是说真值表核对的是**真屏幕**，不是我脑补的观测量。
 *
 * 布局（x→，y↓），刻意包含三个"内部有、屏幕上没有"的陷阱：
 *   (1,1) 有一个**已死**的敌人    → 屏幕上这里是空地
 *   (4,4) 有一个**已拾走**的物品  → 屏幕上这里是空地
 *   (2,3) 玩家脚下没有物品，但 (3,3) 的物品紧贴着他
 * 玩家 (2,3)、可见敌人 (4,3) 与 (0,4)、可见物品 (2,1) 与 (3,3)、顶边一整排墙。
 */
const BASE: WorldState = {
  tick: 5,
  size: 5,
  walls: ['0,0', '1,0', '2,0', '3,0', '4,0'],
  player: { x: 2, y: 3, hp: 7, maxHp: 10, cooldown: 0, score: 2, alive: true },
  enemies: [
    { id: 1, x: 4, y: 3, hp: 1, alive: true, dir: 0 },
    { id: 2, x: 0, y: 4, hp: 1, alive: true, dir: 0 },
    { id: 3, x: 1, y: 1, hp: 1, alive: false, dir: 0 },
  ],
  pickups: [
    { id: 1, x: 2, y: 1, taken: false },
    { id: 2, x: 3, y: 3, taken: false },
    { id: 3, x: 4, y: 4, taken: true },
  ],
};

const screenOf = (events: string[] = [], over: Partial<WorldState> = {}): string =>
  render({ ...BASE, ...over }, events);
const obsOf = (events: string[] = [], over: Partial<WorldState> = {}): Observation =>
  observe(screenOf(events, over));

/** 真值表的主键：`类别:判决`。数组顺序=主张在文本里的先后。 */
const flat = (text: string, obs: Observation | null): string[] =>
  reconcileText(text, obs).map((j) => `${j.kind}:${j.verdict}`);

const S = obsOf();
const S_PICKED = obsOf(['你拾取了地上的东西。']);
const S_EMPTY = obsOf(['你脚下没有可拾取的东西。']);

/** 手写一条主张（不经过抽取器），用来直接守"绝不猜"那两条防御分支。 */
const synth = (over: Partial<Claim>): Claim => ({
  kind: 'attack', rule: '合成', quote: '合成', value: [], positive: null,
  polarity: 'none', symbol: null, at: 0, retro: false, retroWord: '', retroTick: null, ...over,
});

// ─────────────────────────── 冻结指纹 ───────────────────────────

test('判据还是冻结时那张表（改一个字就出声）', () => {
  assert.equal(reconSha(), FROZEN_SHA256, '判据漂移：必须升 RECON_VERSION，两版数字分开留档');
  assert.equal(reconDrift(), null);
  const stamp = reconStamp();
  assert.equal(stamp.recon, RECON_VERSION);
  assert.equal(stamp.sha, FROZEN_SHA256);
  assert.equal(RECON_VERSION, 'm4d-5', 'm4d-1/m4d-2 试算与 m4d-3、m4d-4 落盘均已作废（版本史见 src/world/reconcile.ts 顶部），对外只许出 m4d-5');
  assert.ok(FROZEN_AT >= '2026-11-16', '冻结日期必须晚于全部证据的产出日期');
});

test('冻结覆盖判决标准本体：规则名/正则/词表/依据/排除表/回溯词都在指纹里', () => {
  const c = reconCanonical();
  /** canonical 是 JSON 文本，反斜杠被转义过，比对要用同一套转义形状。 */
  const inCanon = (s: string) => c.includes(JSON.stringify(s).slice(1, -1));
  for (const r of RULES) {
    assert.ok(inCanon(r.name), `规则名未进指纹：${r.name}`);
    assert.ok(inCanon(r.source), `正则未进指纹：${r.name}`);
    assert.ok(inCanon(r.basis), `可核对性说明未进指纹：${r.name}`);
    for (const list of [r.words?.positive ?? [], r.words?.negative ?? []]) {
      for (const w of list) assert.ok(inCanon(w), `极性词未进指纹：${w}`);
    }
  }
  for (const [w] of SYMBOL_WORDS) assert.ok(inCanon(w), `符号词未进指纹：${w}`);
  for (const r of RETRO_RULES) assert.ok(inCanon(r.source), `回溯线索未进指纹：${r.source}`);
  // m4d-5：回溯的**范围单位**同样是口径，只活在代码里的话就是台账 #27 的诞生方式
  assert.ok(inCanon(SUB_CLAUSE_DELIMS), '子句分隔符未进指纹：算到哪一句没人认领');
  assert.ok(reconCanonical().includes('"colonLeadIn":true'), '冒号引导句并入这条规则未进指纹');
  assert.ok(reconCanonical().includes('"bracketsProtected":true'), '括号内部不作分隔这条规则未进指纹');
  for (const [f, h] of FULLWIDTH_MAP) assert.ok(inCanon(f) && inCanon(h), `全角映射未进指纹：${f}`);
  for (const e of EXCLUDED_RULES) {
    assert.ok(inCanon(e.name) && inCanon(e.source) && inCanon(e.why), `排除表未进指纹：${e.name}`);
  }
  // 诚实性边界（说清楚，不假装全覆盖）：judgeClaim 的实现**不在**指纹里，
  // 它由这份真值表 + verify/recon-audit.ts 的独立重算两头约束。
  assert.ok(!c.includes('两种读法都不符'), '判决实现细节不该混进判据指纹');
});

test('四桶与类别表：互斥、穷尽、与规则表一一对应', () => {
  assert.deepEqual(VERDICTS, ['相符', '矛盾', '约定存疑', '无法核对']);
  assert.equal(new Set(VERDICTS).size, 4);
  assert.deepEqual([...KINDS].sort(), RULES.map((r) => r.kind).sort());
  assert.equal(new Set(KINDS).size, KINDS.length, '类别不得重复');
  // 每条规则都要写明客观依据；写不出依据的规则就没有资格判相符/矛盾
  for (const r of RULES) assert.ok(r.basis.length >= 10, `${r.name} 缺可核对性说明`);
  for (const r of RULES) assert.ok(/屏幕|observe|现象行|意图|预测|兜底|主语|决策前|帧/.test(r.basis), `${r.name} 的依据没指向屏幕：${r.basis}`);
});

// ─────────────────────────── 防线：零内部状态 ───────────────────────────

/** 剥掉注释，只留真正的代码——判据读没读 WorldState 这件事只看代码。 */
function codeOnly(file: string): string {
  return file
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/[^\n]*$/gm, '');
}

test('判据本体只吃屏幕文本：不 import 战场状态、不看 WorldState', () => {
  const url = new URL('../src/world/reconcile.ts', import.meta.url);
  const src = readFileSync(url, 'utf8');
  const specs = [...src.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
  assert.deepEqual(specs, ['node:crypto', './observe.ts'],
    `判据的依赖必须只有哈希 + 屏幕逆投影：${specs.join(', ')}`);
  const code = codeOnly(src);
  // 内部状态符号：屏幕侧根本没有这些东西
  for (const forbidden of ['WorldState', 'arena.ts', 'capabilities', 'mutant', 'MUTANTS', 'Dir.', '.dir']) {
    assert.ok(!code.includes(forbidden), `判据代码里出现了内部状态符号：${forbidden}`);
  }
  // 只有内部才有的字段（冷却剩余计数、拾取标记、敌人 id）。
  // 注意 hp/maxHp/alive 不算：HUD「HP 7/10」与状态行「活着/已倒下」本来就上屏。
  for (const leak of ['.cooldown', '.taken', '.id', '.alive &&', 'enemies.filter']) {
    assert.ok(!code.includes(leak), `判据代码里出现了只有内部状态才有的字段：${leak}`);
  }
});

test('逆投影与正投影逐格对齐：cellSymbolAt 就是 render 画出来的那个字符', () => {
  // 两个通道：render 的网格字符串（正投影） vs observe+cellSymbolAt（逆投影后按图层重排）。
  // 逐格比对是对「判据没有读心」最硬的机器证明——读心会直接对上内部坐标。
  const states: WorldState[] = [
    BASE,
    { ...BASE, player: { ...BASE.player, x: 3, y: 3 } },               // 玩家踩在物品上
    { ...BASE, player: { ...BASE.player, x: 4, y: 3, alive: false } }, // 玩家压在敌人格上且已倒下
    { ...BASE, enemies: BASE.enemies.map((e) => ({ ...e, alive: false })) },
    { ...BASE, pickups: BASE.pickups.map((p) => ({ ...p, taken: true })) },
    { ...BASE, walls: [] },
    { ...BASE, size: 8, walls: ['7,7', '0,0'] },
  ];
  for (const s of states) {
    const text = renderInitial(s);
    const lines = text.split('\n').filter((l) => l.startsWith('|') && l.endsWith('|'));
    const obs = observe(text);
    assert.notEqual(obs.size, null);
    for (let y = 0; y < s.size; y++) {
      for (let x = 0; x < s.size; x++) {
        assert.equal(cellSymbolAt(obs, x, y), lines[y]![x + 1], `图层顺序对不上：(${x},${y})`);
      }
    }
  }
});

test('屏幕侧引用的文案真的来自 render（判据不许引用屏幕没有的话）', () => {
  // 现象行不是我从字符串里挑的，是让 render.describe() 在真动作上**自己产出**的
  const nothing = describe(BASE, { kind: 'pickup' }, BASE);
  const tookOne = describe(BASE, { kind: 'pickup' }, {
    ...BASE, pickups: BASE.pickups.map((p, i) => (i === 0 ? { ...p, taken: true } : p)),
  });
  const hitWall = describe(BASE, { kind: 'move', dir: 0 }, BASE);
  // 「就绪/活着」与「冷却中/已倒下」分属两种状态，屏幕要各出一张，不能拿一张冒充全套
  const ready = render({ ...BASE, player: { ...BASE.player, cooldown: 0, alive: true } }, [...nothing, ...tookOne, ...hitWall]);
  const done = render({ ...BASE, player: { ...BASE.player, cooldown: 2, alive: false } }, [...nothing, ...tookOne, ...hitWall]);
  const full = ready + '\n' + done;
  const cited = [
    '你脚下没有可拾取的东西', '你拾取了地上的东西',
    '攻击：', '就绪', '冷却中', '状态：', '已倒下', 'HP ', '分数 ', '第 ', '帧',
    '@', 'E', '+', '#', '.', '墙', '敌人', '可拾取', '空地',
  ];
  for (const c of cited) assert.ok(full.includes(c), `屏幕里找不到被判决引用的文案：「${c}」`);
  assert.ok(nothing.join('').includes('你脚下没有可拾取的东西'), '现象行文案变了：判据得跟着改');
  assert.ok(tookOne.join('').includes('你拾取了地上的东西'), '现象行文案变了：判据得跟着改');
});

test('越界与无网格：判据不猜，给 null 或矛盾，绝不抛错', () => {
  assert.equal(cellSymbolAt(S, -1, 0), null);
  assert.equal(cellSymbolAt(S, 5, 0), null);
  assert.equal(cellSymbolAt(S, 0, 9), null);
  const noGrid: Observation = { ...S, size: null, player: null };
  assert.deepEqual(flat('我在(2,3)', noGrid), ['playerPos:无法核对']);
  assert.deepEqual(flat('(1,1)是墙', noGrid), ['cellSymbol:无法核对']);
  assert.deepEqual(flat('我在(2,3)', null), ['playerPos:无法核对'], '没有屏幕可依据=未观察，不许判');
  assert.deepEqual(flat('HP 7/10', null), ['hp:无法核对']);
});

// ─────────────────────────── 归一化 ───────────────────────────

test('全角映射表逐对核对：m4d-1 的两条平行字符串差一个字符，整表错位', () => {
  assert.equal(new Set(FULLWIDTH_MAP.map((p) => p[0])).size, FULLWIDTH_MAP.length, '全角键不得重复');
  for (const [from, to] of FULLWIDTH_MAP) {
    assert.equal(normalizeText(from), to.toLowerCase(), `${from} → ${to} 没映射对`);
    assert.equal(from.length, 1);
    assert.equal(to.length, 1, `${from} 的目标必须也是单字符（等长前提）`);
  }
  // 数字与括号必须真的映射：m4d-1 在这里静默失效，全角坐标一条主张都抽不出
  assert.equal(normalizeText('（２，３）'), '(2,3)');
  assert.equal(normalizeText('【2，3】'), '(2,3)');
  assert.equal(normalizeText('［4，5］'), '[4,5]');
  // 全角 ASCII 整块（字母也算）：区首区尾必须都能落到 ASCII
  assert.equal(normalizeText(FULLWIDTH_ASCII.first), '!');
  assert.equal(normalizeText(FULLWIDTH_ASCII.last), '~');
  assert.equal(normalizeText('ＨＰ'), 'hp', '全角字母没映射：整句会因此免检');
});

test('归一化等长：quote 要从原文切，下标不许漂', () => {
  for (const t of [
    '我在(2,3)，HP 7/10', '我 在（２，３）。分数：2', 'HP 7/10   分数 2   第 5 帧',
    '', '\t我在(2,3)', '全角１２３４５６７８９０与　空格',
  ]) {
    assert.equal(normalizeText(t).length, t.length, `归一化改了长度：${JSON.stringify(t)}`);
  }
});

test('全角与大小写不改变判决（同一句话只有一个下场）', () => {
  assert.deepEqual(flat('我在（２，３）', S), ['playerPos:相符']);
  assert.deepEqual(flat('我在（２，３）', S), flat('我在(2,3)', S));
  const claim = extractClaims('我在（２，３）')[0]!;
  assert.equal(claim.quote, '我在（２，３）', 'quote 必须保留原文，给人复核用');
  assert.deepEqual(claim.value, [2, 3]);
  assert.deepEqual(flat('ＨＰ 7/10', S), ['hp:相符']);
});

test('数字取坐标对本身，不取"句子里的前两个数字"', () => {
  // 「我在第2次尝试后位于(2,3)」：限定语里的 2 不许被当成坐标（编出来的假矛盾最毒）
  const [c] = extractClaims('我在第2次尝试后位于(2,3)');
  assert.ok(c, '该句要抽出主张');
  assert.equal(c!.kind, 'playerPos');
  assert.deepEqual(c!.value, [2, 3]);
  assert.deepEqual(flat('我在第2次尝试后位于(2,3)', S), ['playerPos:相符']);
  // 这一条在 m4d-2 冻结**之前**改过期望值（原写 ['cellSymbol:相符']）：
  // 「3个敌人在(4,3)」的「3 个」是数量，被 cellSymbol 整段吞掉后真正能硬核对的计数主张就消失了。
  // 详见下面「数量句不被抢走」一组；这里保留同一句话，只为让改动留下可比的痕迹。
  assert.deepEqual(flat('3个敌人在(4,3)', S), ['enemyCount:矛盾', 'barePair:无法核对']);
  // 反过来：坐标写在数字前面时也不能被反向吞掉
  assert.deepEqual(extractClaims('我在(3,2)有2个敌人')[0]!.value, [3, 2]);
});

// ─────────────────────────── 真值表：位置类 ───────────────────────────

/**
 * 屏幕（BASE）：
 *   y=0 "#####"  y=1 "..+.."  y=2 "....."  y=3 "..@+E"  y=4 "E...."
 *   HUD  HP [#######---] 7/10   分数 2   第 5 帧
 *   状态行 攻击：就绪   状态：活着
 * 玩家 '@' 数出来是 [x=2, y=3]。
 */
test('真值表·玩家位置：相符 / 约定存疑 / 矛盾 / 越界，四档各就位', () => {
  const cases: [string, string[], string][] = [
    ['我在(2,3)', ['playerPos:相符'], '@ 就在 (2,3)'],
    ['我在(3,2)', ['playerPos:约定存疑'], '屏幕没标轴：(3,2) 按行列读就是 @ 那格 → 不是模型的错'],
    ['我在(0,0)', ['playerPos:矛盾'], '(0,0) 是墙，两种读法都不等于 @ 所在的 (2,3)'],
    ['玩家当前位于(4,3)', ['playerPos:矛盾'], '(4,3) 是敌人格，@ 不在那儿'],
    ['我在(5,2)', ['playerPos:矛盾'], '越界：5×5 屏幕没有第 5 列，两种读法都不可能'],
    ['我在(9,9)', ['playerPos:矛盾'], '越界（另一方向）'],
  ];
  for (const [text, want, why] of cases) assert.deepEqual(flat(text, S), want, `${text} —— ${why}`);
});

test('真值表·完成时自述：锚点仍是决策前最后一帧', () => {
  // ⚠️ 台账 #23 的守门条目：thought 永远排在动作之前，所以"我刚刚移动到 X"说的
  // 也是它看到的那一帧。把「刚才/刚刚」当回溯词，会把最该核对的一类全推给无法核对，
  // 看着更保守、其实更空（#22 家族）。
  const moved = extractClaims('我刚刚移动到了(2,3)')[0]!;
  assert.equal(moved.kind, 'movedTo');
  assert.equal(moved.retro, false, '「刚刚」不是回溯线索词（它指的就是锚点那一帧）');
  assert.deepEqual(flat('我刚刚移动到了(2,3)', S), ['movedTo:相符']);
  assert.deepEqual(flat('我已经走到(3,2)', S), ['movedTo:约定存疑']);
  assert.deepEqual(flat('刚才移动到(0,0)了', S), ['movedTo:矛盾']);
});

test('真值表·回溯陈述：不判对错，但要计数出声', () => {
  for (const lead of ['原来', '之前', '上一帧', '第 2 帧时', '当时的']) {
    const claims = extractClaims(`${lead}敌人在(1,1)`);
    assert.equal(claims.length, 1, `${lead} 应抽出一条主张，不许丢`);
    assert.equal(claims[0]!.retro, true, `回溯线索词没命中：${lead}`);
    assert.ok(claims[0]!.retroWord.length > 0, `${lead} 命中了但要说出是哪个词`);
    assert.deepEqual(flat(`${lead}敌人在(1,1)`, S), ['cellSymbol:无法核对']);
  }
  // 反面对照：同一句话去掉回溯词就是矛盾。这一档不是"什么都判不了"的免检通道。
  assert.deepEqual(flat('(1,1)是敌人', S), ['cellSymbol:矛盾']);
});

test('真值表·意图句不当事实核：屏幕无从反驳', () => {
  assert.deepEqual(flat('我下一步移动到(2,2)', S), ['moveIntent:无法核对']);
  assert.deepEqual(flat('我向右移动一格到(2,2)', S), ['moveIntent:无法核对']);
  assert.deepEqual(flat('先向下走一格到(2,4)，再看(2,3)', S), ['moveIntent:无法核对', 'barePair:无法核对']);
  // 意图与事实同句：各归各档，谁也不许替谁背锅
  assert.deepEqual(flat('我在(2,3)，下一步移动到(2,4)', S), ['playerPos:相符', 'moveIntent:无法核对']);
});

// ─────────────────────────── 真值表：抢跑吞句（台账 #25） ───────────────────────────

/**
 * 这一组全部来自**抽样复核矛盾明细**时读出来的错绑句子（verify/recon.ts --dry 的
 * 「矛盾样本」段），但每一条的期望值是人对着 BASE 屏幕逐格定的，不是从统计回填的。
 * 病灶同一种形状：**排在前面的规则把后面那条更合适的主张整段吞掉**（extractClaims 的
 * overlap 屏蔽），于是屏幕上明明说得清的东西，被判成了另一回事。
 * 修法一律往"少判"走：抢跑的规则让位，剩下的落进 barePair＝无法核对，绝不编造判决。
 */
test('真值表·计划句不被 playerPos 抢走（GAP + 位置名词同守）', () => {
  // 「现在…(a,b)」曾被 playerPos 第二支吞掉：GAP 允许数字，时间词后什么都不要求也能凑上坐标。
  assert.deepEqual(flat('现在向右移动一格到(3,2)', S), ['moveIntent:无法核对']);
  assert.deepEqual(flat('当前准备朝左移动到(4,3)', S), ['moveIntent:无法核对']);
  // 真·位置自述离不开「位置/坐标」这个名词，去掉它就不是在说坐标
  assert.deepEqual(flat('现在位置(2,3)', S), ['playerPos:相符']);
  assert.deepEqual(flat('目前坐标为(2,3)', S), ['playerPos:相符']);
});

test('真值表·数量句不被抢走：吞掉它等于让该核对的主张消失', () => {
  // 旧 bug：playerPos 抢走整句后拿 @ 的坐标核对，报出一条**不存在的位置矛盾**，
  // 而真正该数的「剩余 2 个敌人」因为 span 重叠当场消失（#25 与 #22 的合流）。
  assert.deepEqual(flat('目前还剩余2个敌人E(6,0)', S), ['enemyCount:相符', 'barePair:无法核对']);
  // 「N 个 X 在 (a,b)」说的是数量顺带指个位置，不是「这一格里有 X」
  assert.deepEqual(flat('3个敌人在(2,3)', S), ['enemyCount:矛盾', 'barePair:无法核对']);
  // 不带数量的「敌人在(2,3)」仍然是格内容主张，这一档不许被连带修坏
  assert.deepEqual(flat('敌人在(4,3)', S), ['cellSymbol:相符']);
  // 让位的边界要说清：拦路虎是"数量规则读得出的那种写法"，即 **阿拉伯数字 + 量词**。
  // 「两个敌人」的「两」enemyCount 本来就数不出来（它只认 \d），此时 cellSymbol 不许跟着让位，
  // 否则就是用一个洞去补另一个洞——整句从"能核对"掉到"两条都无法核对"。
  assert.deepEqual(flat('两个敌人在(4,3)', S), ['cellSymbol:相符']);
});

test('真值表·开局帧是回溯：不带过去时标记的远指也要认出来', () => {
  for (const lead of ['初始', '开局', '一开始', '开始时', '最初']) {
    const c = extractClaims(`${lead}@在(0,0)`)[0]!;
    assert.equal(c.kind, 'cellSymbol', `${lead}：主张要抽得出`);
    assert.equal(c.retro, true, `${lead} 是回溯线索词，不该拿当下屏幕核对`);
    assert.deepEqual(flat(`${lead}@在(0,0)`, S), ['cellSymbol:无法核对']);
  }
  // 反面对照：(0,0) 当下是墙，去掉远指词就是一条真矛盾——这一档不是免检通道
  assert.deepEqual(flat('@在(0,0)', S), ['cellSymbol:矛盾']);
});

// ─────────────────── 真值表：回溯的范围单位与帧号归位（台账 #27） ───────────────────

/**
 * #27 的形状：回溯判定过去看的是"命中段左右各 18 个字符"，一个由**字符数**而非语义
 * 决定的窗口。真语料里它连自己都不自洽——同一句话里「我在[0,0]」被算回溯、
 * 紧挨着的「分数0」不算（20261113-220900-s6 第 4 行；全语料 112 处这种分裂），
 * 反过来「玩家右移一格到(1,0)后」又被子句外的词判成回溯。
 * 这一组把范围单位钉成**子句**，并把"回溯说的是哪一帧"变成判据的一部分：
 * 说得出帧号且正好等于锚点帧 → 那不是回溯，是现状，照常核对。
 * 期望值同样是人工读句定的：先看句子在说什么，再看那一帧屏幕画了什么。
 */
test('真值表·子句边界：分隔符切在哪由人读得出，不由字符数决定', () => {
  const t = normalizeText('我在(2,3)，之前敌人在(1,1)。分数2');
  const scope = (s: string): string => { const i = t.indexOf(s); return subClauseOf(t, i, i + s.length); };
  assert.equal(scope('我在(2,3)'), '我在(2,3)');
  assert.equal(scope('之前敌人在(1,1)'), '之前敌人在(1,1)');
  // 句号右边是新的一句话：「分数2」不该被「之前」连坐
  assert.equal(scope('分数2'), '分数2');
  // ⚠️ 括号**内部**的逗号不是分隔符：坐标字面自己就用括号，切开等于把主张从中间劈开
  //    （#27 首跑就是红在这——「…(1,1)我在(2,3)」的后半句从 `(1` 与 `1)` 之间被锯断，
  //    于是同一句话里只有前半句背上回溯，正好复刻窗口口径那种不自洽）
  const u = normalizeText('之前敌人在(1,1)我在(2,3)');
  const j = u.indexOf('我在(2,3)');
  assert.equal(subClauseOf(u, j, j + 8), u, '括号内部的逗号不许当分隔符');
  assert.equal(subClauseOf(normalizeText('(3,5)是最近的物品'), 0, 4), '(3,5)是最近的物品');
});

test('真值表·回溯只算自己那半句：窗口口径的分裂不再出现', () => {
  const claims = extractClaims('我在(2,3)，之前敌人在(1,1)');
  assert.deepEqual(claims.map((c) => [c.kind, c.retro]), [['playerPos', false], ['cellSymbol', true]]);
  assert.deepEqual(flat('我在(2,3)，之前敌人在(1,1)', S), ['playerPos:相符', 'cellSymbol:无法核对']);
  // 前半句是现状，屏幕上就 @ 在 (2,3)：旧窗口在这里白丢一条可核对主张（112 处里的一个形状）
  assert.deepEqual(flat('分数2，之前我在(0,0)', S), ['score:相符', 'playerPos:无法核对']);
  // 下半句仍然受回溯保护：(0,0) 当下是墙，判它矛盾就是判据的错
  // 反过来：整句没标点时子句＝整句，读不出线索词管到哪儿 → 保守，两条都不核对
  const merged = extractClaims('之前敌人在(1,1)我在(2,3)');
  assert.equal(merged.length, 2, '两条主张都要抽出，不许丢');
  assert.deepEqual(merged.map((c) => c.retro), [true, true], '没标点时不许只让一条背回溯');
  assert.deepEqual(flat('之前敌人在(1,1)我在(2,3)', S), ['cellSymbol:无法核对', 'playerPos:无法核对']);
});

test('真值表·冒号引导句管着后面整句：「已获取初始状态：…」不许当成现状', () => {
  const c = extractClaims('已获取初始状态：我在(2,3)')[0]!;
  assert.equal(c.kind, 'playerPos');
  assert.equal(c.retro, true, '「初始」在冒号前，管的正是冒号后这句');
  assert.equal(c.retroTick, 0, '「初始」族自己就把帧号说成第 0 帧了');
  assert.deepEqual(flat('已获取初始状态：我在(2,3)', S), ['playerPos:无法核对']);   // 锚点是第 5 帧
  // 引导句是句号/逗号时**不**并入：那是另一句话，连坐就是把判据的胆子写成模型的错
  assert.deepEqual(flat('上一帧我朝右走。我在(2,3)', S), ['playerPos:相符']);
});

test('真值表·帧号归位：说得出帧号且正好是锚点帧，就不是回溯', () => {
  const c = extractClaims('第 5 帧敌人在(4,3)')[0]!;
  assert.equal(c.retro, true, '抽取侧仍如实记下它带远指线索（不靠"看起来像现状"就瞒过去）');
  assert.equal(c.retroTick, 5, '「第 N 帧」的 N 必须真的被捕获——m4d-1 那处转义 bug 的同族');
  assert.deepEqual(flat('第 5 帧敌人在(4,3)', S), ['cellSymbol:相符']);
  // 归位不等于放行：帧号对不上才是不核对，而且 why 要报出"哪一帧 vs 哪一帧"
  const j = reconcileText('第 2 帧敌人在(4,3)', S)[0]!;
  assert.equal(j.verdict, '无法核对');
  assert.match(j.why, /第 2 帧.*第 5 帧/, `归位失败的 why 没把两个帧号都写出来：${j.why}`);
  // 反面对照：归位到锚点之后判决照常落下——说错了就是一条真矛盾，这一档不是免检通道
  assert.deepEqual(flat('第 5 帧敌人在(1,1)', S), ['cellSymbol:矛盾']);
  // 第 0 帧的锚点（首条决策行的 header 首屏）：同一句「初始」在这一帧就是可核对的现状
  const S0 = obsOf([], { tick: 0 });
  assert.deepEqual(flat('已获取初始状态：我在(2,3)', S0), ['playerPos:相符']);
  assert.deepEqual(flat('第 0 帧敌人在(4,3)', S0), ['cellSymbol:相符']);
});

test('真值表·线索词同现时取保守：说不出帧号就不核对', () => {
  // 「之前」+「第 5 帧」同现（「之前看过第 5 帧那张图」）：句子到底指哪一帧读不出来。
  // 归位到 5 就是替模型编一个它没说出口的锚点，编错了产出的是一条**看起来很像**的矛盾（#24 同族）。
  const c = extractClaims('之前在第 5 帧看过敌人在(4,3)')[0]!;
  assert.equal(c.retroWord, '之前', '要说出口报的是哪个线索词让这一条不核对');
  assert.equal(c.retroTick, null);
  assert.deepEqual(flat('之前在第 5 帧看过敌人在(4,3)', S), ['cellSymbol:无法核对']);
  // 同族的另一头：屏幕上读不出帧号时，也不许猜一个帧号放行（锚点自检不过就整条不判）
  const noTick = observe(screenOf([], { tick: 99 }).replace('第 99 帧', '第 ? 帧'));
  assert.equal(noTick.tick, null, '这份屏幕真的读不出帧号，才是这一格要验的东西');
  assert.deepEqual(flat('第 99 帧敌人在(4,3)', noTick), ['cellSymbol:无法核对']);
});

// ─────────────────── 真值表：括注里的回溯词（m4d-5 人读定案，F43/F44 同两侧） ───────────────────

test('真值表·括注里的回溯线索词照样命中：明知少核一条，仍不把过去陈述当现状', () => {
  // 真语料 10 条命中在这儿逐条读过：8 条的括注装的就是那句过去陈述（「(原来在(7,0)的敌人还在…)」），
  // 2 条的括注只是原因注脚（「攻击处于冷却中(第13帧触发)」）。模式分不出这两类，
  // 所以只能整条不判——写清楚代价，别让它变成"括号＝免检"的口径漂移。
  const aside = extractClaims('攻击处于冷却中（第13帧触发）')[0]!;
  assert.equal(aside.kind, 'attack');
  assert.equal(aside.retroTick, 13, '括注里的帧号也得真捕获：不许因为"在括号里"就装看不见');
  assert.deepEqual(flat('攻击处于冷却中（第13帧触发）', S), ['attack:无法核对']);
  // ①侧（10 条里的 8 条）：括注里那句「之前…」说的是过去，绝不按现状核对
  assert.deepEqual(flat('我在(2,3)（之前我在(0,4)）', S), ['playerPos:无法核对', 'playerPos:无法核对']);
  // 反向对照 A：括号里**没有**线索词时不许连带免检——否则这条规则就成了"进了括号就不用对账"
  assert.deepEqual(flat('血量是7/10（HP 条在屏幕下方）', S), ['hp:相符']);
  // 反向对照 B：帧号归位到锚点，括注同样放行——命中≠不判，读得出说的是哪一帧就照常核对
  const at13 = obsOf([], { tick: 13, player: { ...BASE.player, cooldown: 2 } });
  assert.deepEqual(flat('攻击处于冷却中（第13帧触发）', at13), ['attack:相符']);
});

// ─────────────────────────── 真值表：修饰语叠加（台账 #26） ───────────────────────────

/**
 * #26 的形状：规则里的状语写成「可选的**一个**词」，两个词一连（目前是 / 还没 / 大小为）
 * 整条规则就静默失效。漏收比错收更难发现——它不出现在矛盾明细里，只是那一条主张
 * 从来没被核对过。这三格由 verify/recon-fixture.ts 的手写夹具判红后才修的。
 */
test('真值表·两个状语连着说也抽得出，白名单外的字仍然吃不进', () => {
  assert.deepEqual(flat('血量目前是7/10', S), ['hp:相符']);
  assert.deepEqual(flat('hp目前是10/10', S), ['hp:矛盾']);
  assert.deepEqual(flat('地图大小为5x5', S), ['gridSize:相符']);
  assert.deepEqual(flat('攻击还没就绪', S), ['attack:矛盾']);   // BASE 屏幕攻击=就绪
  assert.deepEqual(flat('攻击已经就绪', S), ['attack:相符']);
  // 反向对照：修漏收不许退化成通配。「攻击验证得分与冷却逻辑」是动作+名词，不是状态主张
  assert.deepEqual(extractClaims('攻击验证得分与冷却逻辑'), [], '白名单被放宽就虚高相符率');
  // 否定式极性：「还没就绪」的「就绪」在段里，但它是被否定的，不许判成肯定（#24 同族）
  const c = extractClaims('攻击还没就绪')[0]!;
  assert.equal(c.polarity, 'neg', '极性读成正＝把没错的自述冤枉成矛盾');
});

// ─────────────────────────── 真值表：格子内容 ───────────────────────────

test('真值表·某格内容：四种写法都抽得出，不许静默失效', () => {
  // 台账 #23：交替组没包好时「X在(a,b)」这一支静默失效，屏幕上明摆着的断言一条都抽不出来。
  const shapes: [string, string[]][] = [
    ['(0,0)是墙', ['cellSymbol:相符']],
    ['(2,1)有可拾取物', ['cellSymbol:相符']],
    ['(3,3)是物品', ['cellSymbol:相符']],
    ['(4,3)是敌人', ['cellSymbol:相符']],
    ['(2,1)处有一个+', ['cellSymbol:相符']],
    ['(4,3)有个敌人', ['cellSymbol:相符']],
    ['(2,2)是空地', ['cellSymbol:相符']],
    ['敌人在(4,3)', ['cellSymbol:相符']],      // X在(a,b) 语序
    ['墙在(0,0)', ['cellSymbol:相符']],
    ['可拾取物在(2,1)', ['cellSymbol:相符']], // 命中恰在句首 → lastIndexOf(-1) 死循环回归
    ['敌人在(3,4)', ['cellSymbol:约定存疑']], // 只有转置读法落得到 E
    ['(1,1)是敌人', ['cellSymbol:矛盾']],      // 内部有具死敌，屏幕上这里是「.」
    ['(4,4)是物品', ['cellSymbol:矛盾']],      // 已拾走，不上屏
    ['(2,2)是墙', ['cellSymbol:矛盾']],
    ['(2,3)是敌人', ['cellSymbol:无法核对']],  // @ 盖掉 E：屏幕看不出来，不冤枉
    ['(2,3)是空地', ['cellSymbol:约定存疑']],  // 本格是 @，转置格 (3,2) 才是「.」
  ];
  for (const [text, want] of shapes) assert.deepEqual(flat(text, S), want, text);
});

test('真值表·格内容抽不出符号时不许编：只给空格子的写法进兜底', () => {
  assert.deepEqual(flat('(2,1)有什么', S), ['barePair:无法核对']);
});

test('真值表·脚下物品：只能看现象行，图层挡住了就不判', () => {
  assert.deepEqual(flat('脚下没有可拾取物', S), ['pickupHere:无法核对'], '本帧现象行没说，@ 盖住 +');
  assert.deepEqual(flat('脚下没有可拾取物', S_PICKED), ['pickupHere:矛盾'], '现象行明写「你拾取了地上的东西」');
  assert.deepEqual(flat('脚下有可拾取物', S_PICKED), ['pickupHere:相符']);
  assert.deepEqual(flat('脚下没有可拾取物', S_EMPTY), ['pickupHere:相符']);
  assert.deepEqual(flat('脚下有物品', S_EMPTY), ['pickupHere:矛盾']);
  assert.deepEqual(flat('可拾取物并不在我脚下', S_PICKED), ['pickupHere:矛盾']);
});

// ─────────────────────────── 真值表：HUD 数值 ───────────────────────────

test('真值表·血量与分数：无坐标即无约定歧义', () => {
  const cases: [string, string[]][] = [
    ['HP 7/10', ['hp:相符']],
    ['血量8/10', ['hp:矛盾']],
    ['hp是7', ['hpValue:相符']],
    ['血量剩3', ['hpValue:矛盾']],
    ['分数 2', ['score:相符']],
    ['分数5', ['score:矛盾']],
  ];
  for (const [text, want] of cases) assert.deepEqual(flat(text, S), want, text);
  // 增量自述**不进**核对（那是 M4-a predict 通道的活），但必须被排除表数到
  assert.deepEqual(flat('分数+1', S), []);
  assert.equal(countExcluded('分数+1').find((e) => e.name === '增量自述')!.n, 1,
    '「分数+1」要计入未纳入，不许当没看见');
});

test('真值表·存活与攻击：否定前缀不许吃进肯定词', () => {
  // ⚠️ 台账 #24：naive includes 让「没有」含「有」、「未就绪」含「就绪」、
  // 「没倒下」含「倒下」，于是**否定式主张永远判不出极性**，整类静默掉进无法核对。
  const cases: [string, string[]][] = [
    ['我还活着', ['alive:相符']],
    ['我没死', ['alive:相符']],
    ['我没倒下', ['alive:相符']],
    ['我还没有倒下', ['alive:相符']],
    ['我不会死', ['alive:相符']],
    ['我倒下了', ['alive:矛盾']],
    ['我已经死了', ['alive:矛盾']],
    ['我阵亡了', ['alive:矛盾']],
    ['攻击就绪', ['attack:相符']],
    ['攻击状态：就绪', ['attack:相符']],
    ['技能已准备好', ['attack:相符']],
    ['攻击未就绪', ['attack:矛盾']],
    ['攻击还在冷却', ['attack:矛盾']],
    ['攻击冷却中', ['attack:矛盾']],
  ];
  for (const [text, want] of cases) assert.deepEqual(flat(text, S), want, text);
  // 假阳性守门：动作+名词的连写不是状态主张（早期版本用带间距的正则吃到它）
  assert.deepEqual(flat('攻击验证得分与冷却逻辑，先摸清机制', S), []);
  // 倒下那一帧的对照：屏幕说「已倒下」时，「我还活着」必须是矛盾
  const dead = obsOf([], { player: { ...BASE.player, alive: false } });
  assert.deepEqual(flat('我还活着', dead), ['alive:矛盾']);
  assert.deepEqual(flat('我已经死了', dead), ['alive:相符']);
});

test('极性判不出时两条分支各说各话（绝不猜，#15）', () => {
  // 抽取器的形状决定了这两种情况极少同时出现在**一句**里，所以这里直接构造主张，
  // 守的是判据那两条分支——它们不是装饰（#22：测不到的分支＝没在守东西）。
  const both = judgeClaim(synth({ polarity: 'both', positive: null }), S);
  assert.equal(both.verdict, '无法核对');
  assert.match(both.why, /同现/);
  const none = judgeClaim(synth({ polarity: 'none', positive: null }), S);
  assert.equal(none.verdict, '无法核对');
  assert.match(none.why, /没有任何已登记的/);
  assert.notEqual(both.why, none.why, '「模型说得含混」和「我的词表没覆盖」必须分开出声');
});

test('真值表·数量与尺寸：数的是屏幕上可见的，不是内部的', () => {
  const cases: [string, string[]][] = [
    ['画面有2个敌人', ['enemyCount:相符']],
    ['剩余2个敌人', ['enemyCount:相符']],
    ['有3个敌人', ['enemyCount:矛盾']],
    ['2个敌人', ['enemyCount:相符']],
    ['有4个可拾取物', ['pickupCount:矛盾']], // 屏幕可见 +=2，这是真跑里抓到过的误差形状
    ['地图上2个可拾取物', ['pickupCount:相符']],
    ['地图是5x5', ['gridSize:相符']],
    ['地图8x8', ['gridSize:矛盾']],
    ['地图8x9', ['gridSize:矛盾']],
  ];
  for (const [text, want] of cases) assert.deepEqual(flat(text, S), want, text);
});

// ─────────────────────────── 真值表：不丢、不重、不混 ───────────────────────────

test('真值表·每个数字对恰好属于一条主张（兜底不丢，具主语不重）', () => {
  const texts = [
    '我在(2,3)，(4,3)是敌人，脚下没有可拾取物',
    '先看(1,2)再看(4,0)',
    '我刚刚移动到了(3,2)，原来敌人在(1,1)',
    '敌人在(4,3)或(0,4)，我在(2,3)',
    '我下一步移动到(2,2)，目标(3,3)',
  ];
  for (const t of texts) {
    const claims = extractClaims(t);
    const pairCount = (normalizeText(t).match(/[\[(]\d{1,2}[,，]\d{1,2}[\])]/g) ?? []).length;
    const withPair = claims.filter((c) => c.value.length === 2 && c.kind !== 'gridSize');
    assert.equal(withPair.length, pairCount, `数字对个数不符：${t} → 抽 ${withPair.length} / 屏 ${pairCount}`);
    const spans = [...claims].sort((a, b) => a.at - b.at);
    for (let i = 1; i < spans.length; i++) {
      assert.ok(spans[i - 1]!.at + spans[i - 1]!.quote.length <= spans[i]!.at, `主张区间重叠：${t}`);
    }
  }
});

test('真值表·裸数字对进无法核对·主语不明，一个都不许丢', () => {
  const claims = extractClaims('先看(1,2)再看(4,0)');
  assert.deepEqual(claims.map((c) => c.kind), ['barePair', 'barePair']);
  assert.deepEqual(flat('先看(1,2)再看(4,0)', S), ['barePair:无法核对', 'barePair:无法核对']);
  assert.ok(judgeAll(claims.map((claim) => ({ claim, obs: S }))).judged.every((j) => j.why.includes('主语')));
});

/** 全量真值语料：每条都在上面的表里逐句定过判决，这里只做聚合与覆盖检查。 */
const FULL_CORPUS: string[] = [
  '我在(2,3)', '我在(3,2)', '我在(0,0)', '玩家当前位于(4,3)', '我在(5,2)',
  '我刚刚移动到了(2,3)', '我已经走到(3,2)', '刚才移动到(0,0)了',
  '我下一步移动到(2,2)', '我向右移动一格到(2,2)',
  '(0,0)是墙', '(2,1)有可拾取物', '(4,3)是敌人', '敌人在(4,3)', '可拾取物在(2,1)',
  '(1,1)是敌人', '(4,4)是物品', '(2,3)是敌人', '敌人在(3,4)',
  '脚下没有可拾取物', '脚下有可拾取物',
  'HP 7/10', '血量8/10', 'hp是7', '分数 2', '分数+1',
  '我还活着', '我没倒下', '我已经死了', '攻击就绪', '攻击未就绪', '攻击还在冷却', '攻击验证得分与冷却逻辑',
  '画面有2个敌人', '有4个可拾取物', '地图是5x5', '地图8x9',
  '先看(1,2)再看(4,0)', '原来敌人在(1,1)',
  '我在(2,3)，地图是5x5，画面有2个敌人，攻击就绪，分数 2',
];

test('真值表·约定存疑只可能出现在坐标类，且必须有样本', () => {
  const suspicious: Kind[] = [];
  let unverifiable = 0;
  for (const t of FULL_CORPUS) {
    for (const j of reconcileText(t, S)) {
      if (j.verdict === '约定存疑') suspicious.push(j.kind);
      if (j.verdict === '无法核对') unverifiable++;
    }
  }
  for (const k of suspicious) {
    assert.ok(['playerPos', 'movedTo', 'cellSymbol'].includes(k), `无坐标的类别被判了约定存疑：${k}`);
  }
  assert.ok(suspicious.length > 0, '真值表里一条约定存疑都没有 → 该档没被覆盖（#22）');
  assert.ok(unverifiable > 0, '真值表里一条无法核对都没有 → 屏幕盲区没被覆盖（#22）');
  // 数值类绝不许走约定存疑：它们没有坐标，读法歧义这条路根本不存在
  for (const k of ['hp', 'hpValue', 'score', 'alive', 'attack', 'enemyCount', 'pickupCount', 'gridSize'] as Kind[]) {
    assert.ok(!suspicious.includes(k), `${k} 不该有约定存疑样本`);
  }
});

test('真值表·四桶都有样本，14 个类别都有样本（零样本=失败，#17）', () => {
  const seenVerdicts = new Set<Verdict>();
  const seenKinds = new Set<Kind>();
  for (const t of FULL_CORPUS) {
    const obs = t.includes('脚下') ? S_PICKED : S;
    for (const j of reconcileText(t, obs)) { seenVerdicts.add(j.verdict); seenKinds.add(j.kind); }
  }
  for (const v of VERDICTS) assert.ok(seenVerdicts.has(v), `真值表里没有${v}样本 → 该判决分支没被跑到（#22）`);
  for (const k of KINDS) assert.ok(seenKinds.has(k), `真值表里没有${k}样本 → 该类判据是空跑的（#17）`);
});

test('真值表·一屏多主张：分类计数与总量都走恒等式', () => {
  const text = '我在(2,3)，地图是5x5，画面有2个敌人，攻击就绪，分数 2';
  assert.deepEqual(flat(text, S), [
    'playerPos:相符', 'gridSize:相符', 'enemyCount:相符', 'attack:相符', 'score:相符',
  ]);
  const claims = extractClaims(text);
  const { judged, counts, byKind } = judgeAll(claims.map((claim) => ({ claim, obs: S })));
  assert.equal(judged.length, 5);
  assert.equal(counts['相符'], 5);
  assert.equal(counts['矛盾'] + counts['约定存疑'] + counts['无法核对'], 0);
  assert.equal(VERDICTS.reduce((s, v) => s + counts[v], 0), judged.length, '恒等式：分母要有身份（#21）');
  assert.equal(byKind.playerPos['相符'], 1);
  assert.equal(Object.keys(byKind).length, KINDS.length, '每类都要有分母，包括 0 样本的类');
  for (const k of KINDS) assert.equal(VERDICTS.reduce((s, v) => s + byKind[k][v], 0), judged.filter((j) => j.kind === k).length);
});

test('类别表外的主张：判据炸掉，不许静默算出偏小的分母', () => {
  const bogus = synth({ kind: 'notAKind' as Kind });
  assert.throws(() => judgeClaim(bogus, S), /类别表外/);
  assert.throws(() => judgeAll([{ claim: bogus, obs: S }]), /类别表外/);
});

test('判决表外：恒等式守卫得真能抛（不是装饰）', () => {
  const ok = extractClaims('我在(2,3)')[0]!;
  const bad = { ...judgeClaim(ok, S), verdict: '大概相符' as unknown as Verdict };
  assert.throws(() => bucketize([bad]), /判决表外|恒等式断裂/, '表外判决必须出声');
  assert.deepEqual(bucketize([judgeClaim(ok, S)]).counts['相符'], 1, '正常路径要能算');
});

test('判决理由必须带屏幕侧的实际值（给人复核用，不是给代码自证）', () => {
  for (const t of FULL_CORPUS) {
    for (const j of reconcileText(t, S)) {
      assert.ok(j.why.length >= 8, `${t} → 理由太短：${j.why}`);
      assert.ok(j.quote.length > 0);
      if (j.verdict === '矛盾') {
        assert.ok(/屏幕|现象行/.test(j.why), `${t} 的矛盾理由没引用屏幕：${j.why}`);
      }
      if (j.verdict === '无法核对') {
        assert.ok(/没有|不可见|看不出来|盖掉|覆盖|屏幕|意图|主语|极性|回溯/.test(j.why), `${t} 的免检理由没讲清是哪条盲区：${j.why}`);
      }
    }
  }
});

test('clauseFor 给的是主张所在从句，长度有界', () => {
  const text = '前面一堆废话。我在(2,3)，后面又是一堆废话和更多的废话和更多的废话。';
  const [claim] = extractClaims(text);
  const clause = clauseFor(text, claim!);
  assert.ok(clause.includes('(2,3)'));
  assert.ok(clause.length <= 70, `从句切得太长：${clause.length}`);
});

test('排除表：假设句与方位词位置各归一档，且只计数不判决', () => {
  const c = countExcluded('可能是敌人巡逻导致掉血，左边(1,2)紧邻(2,3)');
  assert.equal(c.length, EXCLUDED_RULES.length);
  assert.ok(c.find((x) => x.name === '机制假设')!.n >= 1);
  assert.ok(c.find((x) => x.name === '方位词位置')!.n >= 1);
  // 排除表不许把具主语的主张吞掉：同句里的「我在(2,3)」照样要核对
  assert.deepEqual(flat('可能说明我在(2,3)', S), ['playerPos:相符']);
});
