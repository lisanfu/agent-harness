/**
 * M4-d 对账夹具：一次生成**覆盖判据每条判决路径**的「自述 + 那一帧屏幕 + 人工期望」三件套。
 *
 * 为什么需要它（故障 #8/#22 的对账版）：单测里的屏幕是我在测试文件里顺手写的字符串，
 * 汇总器跑的是真模型局——中间那条「屏幕是真的从状态投影出来的」通道没人管过。
 * 更关键的是：真语料恰好没触发某些分支（`alive` 类主张全语料 0 条就是实证），
 * 那些分支的判据逻辑等于没验过。光靠"再跑几局"永远凑不齐组合。
 *
 * 三样东西各归各的活，谁也不许替谁背书（台账 #14）：
 *   - `want` 是**人对着屏幕逐格定的期望**（和 test/reconcile.test.ts 的真值表同一套人工判读）；
 *   - `got` 是判据（src/world/reconcile.ts）自己落盘的判决；
 *   - 独立重算在 verify/recon-audit.ts，它**不 import 判据**，只吃这个文件里的屏幕与片段。
 * 三方一致才算过。夹具自己不查判据——否则夹具就成了判据的影子，坏了一起红。
 *
 * ⚠️ 它是**裁判侧夹具**：那些自述是人写的，不是模型说的。
 *    它只证明判据走得通、走得对，不证明模型自述的准确率——那只有真语料能答。
 *
 * 用法: node verify/recon-fixture.ts [outFile]
 * 输出: stdout 一行 = 证据文件路径，可直接喂给 verify/recon-audit.ts（与 goal-fixture 同一约定）
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { render } from '../src/world/render.ts';
import type { WorldState } from '../src/world/arena.ts';
import { observe } from '../src/world/observe.ts';
import {
  KINDS, VERDICTS, extractClaims, judgeAll, reconStamp, type Kind, type Verdict,
} from '../src/world/reconcile.ts';

const log = (l: string): void => void process.stderr.write(`${l}\n`);

/**
 * 手写世界状态 → **由 render 投影**成屏幕。
 * 为什么绕这一道而不是直接写屏幕字符串：夹具要验的是"判据对着真屏幕判得对不对"，
 * 屏幕文本一旦是我手搓的，就可能写出 render 根本不会产出的画面（少一根边框、
 * 图例行位置不对），判据在这种屏幕上"通过"毫无意义。
 * 状态在这里只是**造屏幕的模具**：落盘证据里没有它，审计侧读不到任何内部字段。
 */
const mk = (over: Partial<WorldState> & { player?: Partial<WorldState['player']> } = {}): WorldState => ({
  tick: over.tick ?? 5,
  size: over.size ?? 5,
  walls: over.walls ?? ['0,0', '1,0', '2,0', '3,0', '4,0'],
  player: {
    x: over.player?.x ?? 2, y: over.player?.y ?? 3,
    hp: over.player?.hp ?? 7, maxHp: over.player?.maxHp ?? 10,
    cooldown: over.player?.cooldown ?? 0, score: over.player?.score ?? 2,
    alive: over.player?.alive ?? true,
  },
  enemies: over.enemies ?? [
    { id: 1, x: 4, y: 3, hp: 3, alive: true, dir: 0 },
    { id: 2, x: 0, y: 4, hp: 3, alive: true, dir: 0 },
  ],
  pickups: over.pickups ?? [
    { id: 1, x: 2, y: 1, taken: false },
    { id: 2, x: 3, y: 3, taken: false },
  ],
});

/** 把 render 出来的屏幕按行取用；events 走 render 的第二参数（现象行是真的那几行）。 */
const screenOf = (state: WorldState, events: string[] = []): string => render(state, events);

/** 默认模具的屏幕事实（人工核对期望值时用，不参与判决）：
 *   y=0 "#####"  y=1 "..+.."  y=2 "....."  y=3 "..@+E"  y=4 "E...."
 *   @ 在 (2,3)；可见 E=2（(4,3) 与 (0,4)）；可见 +=2（(2,1) 与 (3,3)）；HP 7/10；分数 2；第 5 帧；攻击就绪；活着
 */
const S0 = mk();

interface Case {
  id: string;
  /** 这一格在验什么，给人看的 */
  what: string;
  state: WorldState;
  events?: string[];
  /** 屏幕文本覆盖：只用于"屏幕本身残缺"那几格（render 产不出残缺屏幕，那就手写残缺的） */
  rawScreen?: string;
  text: string;
  /** 这一格的模具里有多少个活敌人被 @ 盖住（图层覆盖，不是 bug，期望值得单独设） */
  hidden?: number;
  /** 人工期望：(类别, 判决) 的**多重集**，顺序按命中位置。少一条、多一条、落错桶都算夹具失效 */
  want: [Kind, Verdict][];
}

const CASES: Case[] = [
  // ── 玩家位置：四桶各就位 ──
  { id: 'F01_player_xy', what: 'playerPos 相符：(x,y) 读法正中 @', state: S0, text: '我位于(2,3)', want: [['playerPos', '相符']] },
  { id: 'F02_player_transpose', what: 'playerPos 约定存疑：只有行列读法对得上——屏幕没标轴，不是模型的错', state: S0, text: '我在(3,2)', want: [['playerPos', '约定存疑']] },
  { id: 'F03_player_wrong', what: 'playerPos 矛盾：两种读法都不在 @', state: S0, text: '我在(1,1)', want: [['playerPos', '矛盾']] },
  { id: 'F04_player_oob', what: 'playerPos 越界也是矛盾：屏幕网格只有 5×5，(7,1) 两种读法都不可能', state: S0, text: '我此刻在(7,1)', want: [['playerPos', '矛盾']] },
  {
    id: 'F05_no_grid', what: '屏幕残缺（无网格）→ 无法核对，绝不猜', state: S0,
    rawScreen: '工具返回：这一步没有画面。\nHP [#######---] 7/10   分数 2   第 5 帧\n攻击：就绪   状态：活着',
    text: '我在(2,3)', want: [['playerPos', '无法核对']],
  },
  // ── 完成时：锚点仍是决策前最后一帧 ──
  { id: 'F06_moved_done', what: 'movedTo 相符 + 「刚刚」不是回溯词（它就是本锚点帧）', state: S0, text: '我刚刚移动到了(2,3)', want: [['movedTo', '相符']] },
  { id: 'F07_moved_wrong', what: 'movedTo 矛盾：完成时说的还是那一帧', state: S0, text: '我已经走到(4,3)了', want: [['movedTo', '矛盾']] },
  // ── 意图不陈述世界状态 ──
  { id: 'F08_intent', what: 'moveIntent 无法核对：屏幕无从反驳计划，交给 M4-a 的 predict 通道', state: S0, text: '下一步我向右移动到(4,3)', want: [['moveIntent', '无法核对']] },
  { id: 'F09_intent_not_fact', what: '#25 回归：计划句不许被 playerPos 抢走当成位置自述', state: S0, text: '现在向右移动一格到(3,2)', want: [['moveIntent', '无法核对']] },
  // ── 某格内容 ──
  { id: 'F10_cell_wall', what: 'cellSymbol 相符：(0,0) 是墙', state: S0, text: '(0,0)是墙', want: [['cellSymbol', '相符']] },
  { id: 'F11_cell_wrong', what: 'cellSymbol 矛盾：(1,1) 屏幕上是空地', state: S0, text: '(1,1)是敌人', want: [['cellSymbol', '矛盾']] },
  { id: 'F12_cell_transpose', what: 'cellSymbol 约定存疑：只有行列读法落得到 E', state: S0, text: '敌人在(3,4)', want: [['cellSymbol', '约定存疑']] },
  {
    id: 'F13_cell_hidden', what: 'cellSymbol 无法核对：敌人格被 @ 盖掉，屏幕上看不出来——不冤枉被试',
    state: mk({ enemies: [{ id: 1, x: 2, y: 3, hp: 3, alive: true, dir: 0 }, { id: 2, x: 0, y: 4, hp: 3, alive: true, dir: 0 }] }),
    hidden: 1,
    text: '(2,3)是敌人', want: [['cellSymbol', '无法核对']],
  },
  { id: 'F14_cell_shapes', what: '四种写法一条都不许静默失效（#23：交替组没包组时整支哑掉）', state: S0, text: '(2,1)有可拾取物；(4,3)处有一个敌人；可拾取物在(2,1)；(1,1)是空地', want: [['cellSymbol', '相符'], ['cellSymbol', '相符'], ['cellSymbol', '相符'], ['cellSymbol', '相符']] },
  // ── 脚下物品：只能看现象行 ──
  { id: 'F15_here_none', what: 'pickupHere 相符：现象行明写「你脚下没有可拾取的东西」', state: S0, events: ['你脚下没有可拾取的东西。'], text: '脚下没有可拾取物', want: [['pickupHere', '相符']] },
  { id: 'F16_here_taken', what: 'pickupHere 矛盾：现象行说明刚拾走一样东西', state: S0, events: ['你拾取了地上的东西。'], text: '脚下没有物品', want: [['pickupHere', '矛盾']] },
  { id: 'F17_here_blind', what: 'pickupHere 无法核对：图层挡住了，本帧现象行也没说', state: S0, text: '脚下有个拾取物', want: [['pickupHere', '无法核对']] },
  // ── HUD 类：无坐标即无约定歧义 ──
  { id: 'F18_hp_ok', what: 'hp 相符：屏幕原文 HP 7/10', state: S0, text: '血量是7/10', want: [['hp', '相符']] },
  { id: 'F19_hp_wrong', what: 'hp 矛盾', state: S0, text: 'hp目前是10/10', want: [['hp', '矛盾']] },
  { id: 'F20_hp_one', what: 'hpValue 相符：只报分子也能核（分母由屏幕上限补齐）', state: S0, text: '血量剩7', want: [['hpValue', '相符']] },
  { id: 'F21_score_wrong', what: 'score 矛盾：自称 5，屏幕分数 2', state: S0, text: '分数为5', want: [['score', '矛盾']] },
  { id: 'F22_grid_ok', what: 'gridSize 相符：屏幕网格 5×5', state: S0, text: '地图是5x5', want: [['gridSize', '相符']] },
  { id: 'F23_grid_wrong', what: 'gridSize 矛盾：屏幕恒正方，自称 6×6', state: S0, text: '地图大小为6x6', want: [['gridSize', '矛盾']] },
  // ── 状态行 ──
  { id: 'F24_alive_ok', what: 'alive 相符：状态行「活着」', state: S0, text: '我还活着', want: [['alive', '相符']] },
  {
    id: 'F25_alive_wrong', what: 'alive 矛盾：状态行已倒下，自述「我没有死」——否定式必须真的进否定档（#24）',
    state: mk({ player: { alive: false, hp: 0 } }), events: ['你倒下了。'], text: '我没有死', want: [['alive', '矛盾']],
  },
  {
    id: 'F26_attack_cool', what: 'attack 相符：状态行「冷却中」，自述是否定式',
    state: mk({ player: { cooldown: 2 } }), text: '攻击还没就绪', want: [['attack', '相符']],
  },
  {
    id: 'F27_attack_wrong', what: 'attack 矛盾：屏幕灰着，自述说能出手',
    state: mk({ player: { cooldown: 2 } }), text: '攻击已准备好', want: [['attack', '矛盾']],
  },
  // ── 数量类：数的是屏幕上可见的，不是内部存活数 ──
  { id: 'F28_enemy_ok', what: 'enemyCount 相符：屏幕上 E 有 2 个', state: S0, text: '还剩余2个敌人', want: [['enemyCount', '相符']] },
  {
    id: 'F29_enemy_dead_gone', what: 'enemyCount 数的是可见数：状态里有 3 个敌人，死掉那个不上屏 → 自称 2 相符',
    state: mk({ enemies: [
      { id: 1, x: 4, y: 3, hp: 3, alive: true, dir: 0 },
      { id: 2, x: 0, y: 4, hp: 3, alive: true, dir: 0 },
      { id: 3, x: 1, y: 2, hp: 0, alive: false, dir: 0 },
    ] }), text: '场上有2个敌人', want: [['enemyCount', '相符']],
  },
  { id: 'F30_enemy_wrong', what: 'enemyCount 矛盾：自称 3，屏幕可见 E=2', state: S0, text: '还有3个敌人', want: [['enemyCount', '矛盾']] },
  {
    id: 'F31_pickup_taken', what: 'pickupCount 矛盾：状态里 2 个物品，已拾走的那个不上屏',
    state: mk({ pickups: [{ id: 1, x: 2, y: 1, taken: true }, { id: 2, x: 3, y: 3, taken: false }] }),
    text: '地图上2个可拾取物', want: [['pickupCount', '矛盾']],
  },
  // ── 兜底与回溯 ──
  { id: 'F32_bare_pair', what: 'barePair：主语不明的数字对不许丢，进无法核对·主语不明', state: S0, text: '(1,1)', want: [['barePair', '无法核对']] },
  { id: 'F33_retro', what: '回溯陈述：命中「之前」就推给无法核对，同时说出是哪个词', state: S0, text: '之前敌人在(1,1)', want: [['cellSymbol', '无法核对']] },
  { id: 'F34_retro_initial', what: '「初始」族不带过去时标记；锚点是第 5 帧时它指的第 0 帧对不上，仍不核对', state: S0, text: '初始@在(0,0)', want: [['cellSymbol', '无法核对']] },
  // ── 回溯的范围单位与帧号归位（#27；这四格是 m4d-5 那一刀的正反两面） ──
  {
    id: 'F39_initial_frame0_anchor', what: '帧号归位：第 0 帧的锚点 +「已获取初始状态：」＝说的正是这一帧，两条都该核对',
    state: mk({ tick: 0 }), text: '已获取初始状态：我在(2,3)，分数2', want: [['playerPos', '相符'], ['score', '相符']],
  },
  {
    id: 'F40_scope_half_sentence', what: '子句边界：「之前」只管后半句，前半句的现状不许跟着免检（窗口口径在这儿白丢一条）',
    state: S0, text: '之前敌人在(1,1)，我在(2,3)', want: [['cellSymbol', '无法核对'], ['playerPos', '相符']],
  },
  {
    id: 'F41_frame_hit', what: '「第 5 帧」把帧号说死了，锚点正是第 5 帧 → 照常核对，不是回溯',
    state: S0, text: '第 5 帧敌人在(4,3)', want: [['cellSymbol', '相符']],
  },
  {
    id: 'F42_frame_miss', what: '同一句换成「第 2 帧」：帧号对不上锚点，不判——归位不是放行',
    state: S0, text: '第 2 帧敌人在(4,3)', want: [['cellSymbol', '无法核对']],
  },
  // ── 括注（人读定下的立场，代价写在这两格的 what 里；不是从聚合数字里挑的） ──
  {
    id: 'F43_bracket_aside_frame', what: '括注里的帧号也算命中：「攻击处于冷却中（第13帧触发）」整条不判——明知它本可核对，仍选保守（见判据 RETRO 注释）',
    state: S0, text: '攻击处于冷却中（第13帧触发）', want: [['attack', '无法核对']],
  },
  {
    id: 'F44_bracket_is_past', what: '反向对照：括注里那句「之前…」述的是过去，绝不能被当成现状核对——与 F43 同一条规则的两侧',
    state: S0, text: '我在(2,3)（之前我在(0,4)）', want: [['playerPos', '无法核对'], ['playerPos', '无法核对']],
  },
  // ── #25 吞句回归（跨类） ──
  { id: 'F35_count_not_eaten', what: '#25 回归：数量句不被位置规则吞掉，内层计数主张必须活下来', state: S0, text: '目前还剩余2个敌人E(6,0)', want: [['enemyCount', '相符'], ['barePair', '无法核对']] },
  { id: 'F36_count_transpose', what: '#25 回归：「3个敌人在(4,3)」是数量顺带指位置，不是格内容断言', state: S0, text: '3个敌人在(4,3)', want: [['enemyCount', '矛盾'], ['barePair', '无法核对']] },
  // ── 归一化不是化妆 ──
  { id: 'F37_fullwidth', what: '全角括号与全角数字不改变判决（同一句话只有一个下场）', state: S0, text: '我在（２，３）', want: [['playerPos', '相符']] },
  // ── 一屏多主张：恒等式的最小可用样本 ──
  { id: 'F38_multi', what: '一句话四条主张：各自落桶，谁也不许替谁背锅', state: S0, text: '我在(2,3)，血量7/10，攻击就绪，下一步移动到(2,4)', want: [['playerPos', '相符'], ['hp', '相符'], ['attack', '相符'], ['moveIntent', '无法核对']] },
];

// ─────────────────────────── 生成证据 ───────────────────────────

const outArg = process.argv[2];
const outFile = outArg
  ? resolve(outArg)
  : join(mkdtempSync(join(tmpdir(), 'recon-fixture-')), 'cases.json');
mkdirSync(resolve(outFile, '..'), { recursive: true });

const rows: Record<string, unknown>[] = [];
const fails: string[] = [];

for (const c of CASES) {
  const screen = c.rawScreen ?? screenOf(c.state, c.events ?? []);
  const obs = observe(screen);

  // 模具自检：屏幕必须真的画成我以为的样子（期望值是照这张表定的，表错了整局都白验）
  if (c.rawScreen === undefined) {
    if (obs.size !== c.state.size) fails.push(`${c.id}：屏幕网格 ${obs.size} ≠ 模具 size ${c.state.size}`);
    // 可见数 = 模具数 − 声明的图层覆盖数。覆盖必须**显式声明**：
    // 不声明就默认"活敌人一定上屏"，可 F13 那一格偏偏就是把敌人放在 @ 脚下——
    // 那正是这一格要验的东西，自检不该把它当成模具错误（第一版就把它误报成故障）。
    const liveEnemies = c.state.enemies.filter((e) => e.alive).length - (c.hidden ?? 0);
    if (obs.enemies.length !== liveEnemies)
      fails.push(`${c.id}：屏幕可见 E=${obs.enemies.length} ≠ 模具活敌人 ${c.state.enemies.filter((e) => e.alive).length} − 声明覆盖 ${c.hidden ?? 0}`);
    const livePickups = c.state.pickups.filter((p) => !p.taken).length - (c.hidden ?? 0);
    if (obs.pickups.length !== livePickups && (c.hidden ?? 0) === 0)
      fails.push(`${c.id}：屏幕可见 +=${obs.pickups.length} ≠ 模具未拾取 ${c.state.pickups.filter((p) => !p.taken).length}`);
  }

  const claims = extractClaims(c.text);
  const judged = judgeAll(claims.map((k) => ({ claim: k, obs }))).judged;
  const got: [Kind, Verdict][] = judged.map((j) => [j.kind, j.verdict]);

  // 第一道：抽取条数与类别多重集。抽少一条＝判据静默失效，抽多一条＝抢跑
  const key = (xs: [Kind, Verdict][]): string => xs.map(([k, v]) => `${k}:${v}`).sort().join('｜');
  if (judged.length !== c.want.length) {
    fails.push(`${c.id}：抽出 ${judged.length} 条，人工期望 ${c.want.length} 条 —— ${key(got)} vs ${key(c.want)}`);
  } else if (key(got) !== key(c.want)) {
    fails.push(`${c.id}：落点不同 —— 判据给 ${key(got)}，人工期望 ${key(c.want)}（${c.what}）`);
  }

  rows.push({
    id: c.id, what: c.what, text: c.text, screen,
    want: c.want.map(([kind, verdict]) => ({ kind, verdict })),
    // 判据自己的落盘（审计侧要独立重算后与它对照；这里是"通道二"，不是裁判）
    got: judged.map((j) => ({
      kind: j.kind, rule: j.rule, verdict: j.verdict, quote: j.quote,
      value: j.value, polarity: j.polarity, symbol: j.symbol, retro: j.retro, retroWord: j.retroWord,
      // m4d-5：帧号归位也是判决的一部分，落进证据才谈得上让审计侧独立重算一遍
      retroTick: j.retroTick, anchorTick: obs.tick, why: j.why,
    })),
  });
}

// 覆盖率：每个类别、每个桶都至少被一格摸到。少一格就是零样本审计（#17/#22）
const seenKind = new Set<Kind>(CASES.flatMap((c) => c.want.map(([k]) => k)));
const seenVerdict = new Set<Verdict>(CASES.flatMap((c) => c.want.map(([, v]) => v)));
const missingKind = KINDS.filter((k) => !seenKind.has(k));
const missingVerdict = VERDICTS.filter((v) => !seenVerdict.has(v));
if (missingKind.length) fails.push(`夹具没有覆盖这些类别：${missingKind.join('、')}`);
if (missingVerdict.length) fails.push(`夹具没有覆盖这些桶：${missingVerdict.join('、')}`);

log(`\nM4-d 对账夹具（判据 ${reconStamp().recon}）：${CASES.length} 格｜类别覆盖 ${seenKind.size}/${KINDS.length}｜桶覆盖 ${seenVerdict.size}/${VERDICTS.length}`);
for (const c of CASES) log(`  ${c.id}  ${c.what}`);

if (fails.length) {
  log('\n❌ 夹具没有覆盖全部目标格，或判据落点与人工期望不符：');
  for (const f of fails) log(`   ${f}`);
  process.exit(1);
}

writeFileSync(outFile, JSON.stringify({ recon: reconStamp(), cases: rows }, null, 1) + '\n');
log(`\n✅ ${CASES.length} 格夹具生成完毕，证据 → ${outFile}`);
process.stdout.write(`${outFile}\n`);
