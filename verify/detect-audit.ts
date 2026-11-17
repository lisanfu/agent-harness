/**
 * M4-f 检出判决独立审计：**不 import world/detect.ts**，另写一套屏幕重建、覆盖核算、
 * 词表扫描与漏斗算术，从证据文件把整条判决重算一遍，再与 detection.json 逐项比对。
 *
 * 为什么必须重写第二遍（故障 #8 的判决器版）：判定器只有一份代码时，它说什么就是什么。
 * 检出率这个数一旦只由 detectOne 自己算出来，"验算"就退化成了"再打印一遍"。
 *
 * 借的与重写的分界（刻意不重叠）：
 *   借  世界层纯函数 createWorld/step/describe/render/worldHash —— 那是**被测的世界**，不是判决者
 *   借  词表的**数据** ANOMALY_WORDS / ATTRIBUTION / FROZEN_SHA256 —— 一张词表只能有一个主人，
 *       两处各抄一份迟早漂移（故障 #13 那一族）
 *   写  归一化与扫描逻辑、前提判据、覆盖账本、六个判决值的分派、漏斗四层的布尔与失败层
 *       —— 全部在这里独立重写，与 detect.ts 走不同的路拿到同一个数才算数
 *
 * 顺带做两件 detect.ts 自己证明不了的事：
 *   1. **屏幕重建 vs agent 实际所见**：这里重放出来的每一帧，必须与 trace 里那次工具返回值
 *      逐字符相同。不同就说明判决比的东西根本不是 agent 看见的东西——那整张表作废。
 *   2. **零泄漏审计**：变异体 id、能力名、判决术语只能出现在局末的证据里。
 *      扫 trace 全部由代码产出的文本（工具返回、板面、反馈）加上喂给大脑的首屏与任务，
 *      命中一个词就把这一局判废——开卷考试不能靠自觉。
 *
 * 上限表（--ceiling）单独验：随机臂那张表是**预登记**，它必须先于任何检出率成立。
 * 这里按 (mutant, seed, salt, budget) 重新生成轨迹、独立重算 L1/L2 与内部有无分叉，
 * 与 ceiling_cases.jsonl 逐行对。对不上就是预登记表造假，不是"略有出入"。
 *
 * 版本纪律：detection.json 是 M4-f 才落地的。旧证据没有它 → 单独报版本差异，
 * 不混进错误数；但一旦认定是新版，样本量为 0 立刻中止——零样本审计＝假通过。
 *
 * 用法:
 *   node verify/detect-audit.ts <runDir> ... [--ceiling runs/m4f-ceiling] [--ceiling-check 20]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ALL_CAPS, createWorld, DX, DY, step, worldHash, randomActions,
  type Action, type Capabilities, type WorldState,
} from '../src/world/arena.ts';
import { describe, render, renderInitial } from '../src/world/render.ts';
import { findMutant } from '../src/world/mutants.ts';
import { diffFields } from '../src/notary/diff.ts';
import {
  ANOMALY_WORDS, ATTRIBUTION, FROZEN_SHA256, LEXICON_VERSION, lexiconSha, type Cap,
} from '../src/world/lexicon.ts';
import { CAP_NAMES } from '../src/world/arena.ts';
import { fisherExact, wilson } from '../src/stats.ts';

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ─────────────────────────── 判决口径（本文件独立实现） ───────────────────────────

/** 归一化：小写 + 去空白。与 detect.ts 各写一份，为的是"两条路都走得到同一个命中集合" */
const norm = (t: string): string => t.toLowerCase().replace(/[\s　]/g, '');
const hits = (t: string, ws: readonly string[]): string[] => ws.filter((w) => w.length > 0 && t.includes(norm(w)));

interface Claim { reported: boolean; vague: boolean; caps: Cap[]; quotes: { where: string; caps: Cap[] }[] }

function scanClaims(texts: { where: string; text: string }[]): Claim {
  const caps = new Set<Cap>();
  const quotes: Claim['quotes'] = [];
  let vague = false;
  for (const s of texts) {
    const t = norm(s.text);
    if (hits(t, ANOMALY_WORDS).length === 0) continue;
    const found = new Set<Cap>();
    for (const cap of Object.keys(ATTRIBUTION) as Cap[]) {
      if (hits(t, ATTRIBUTION[cap]).length > 0) found.add(cap);
    }
    if (found.size === 0) { vague = true; continue; }
    for (const c of found) caps.add(c);
    quotes.push({ where: s.where, caps: [...found].sort() as Cap[] });
  }
  return { reported: caps.size > 0, vague, caps: [...caps].sort() as Cap[], quotes };
}

type V = '无误报' | '误报' | '未上报' | '报了未指明' | '归因错误' | '归因正确';

function decideOwn(c: Claim, removed: readonly Cap[]): V {
  if (removed.length === 0) return c.reported || c.vague ? '误报' : '无误报';
  if (!c.reported) return c.vague ? '报了未指明' : '未上报';
  return c.caps.some((x) => removed.includes(x)) ? '归因正确' : '归因错误';
}

// ─────────────────────────── 世界重放（自己走 step，不用 GameSession） ───────────────────────────

interface Replay {
  states: WorldState[];
  /** 第 0 项是首屏；其余每项 = render(next, describe(prev, action, next))，即 agent 会看到的那段文本 */
  screens: string[];
  hashes: string[];
  led: Ledger;
}

/** 覆盖账本，全部从 (状态, 动作) 反推，一条都不引用 session 的字段 */
interface Ledger {
  ticks: number;
  wallAttempts: number;
  boundaryAttempts: number;
  attacksWhileCooldown: number;
  attackedWhileAdjacent: boolean;
  touchedByEnemy: boolean;
  stoodOnPickup: boolean;
  hpZeroReached: boolean;
  hpBelowZeroReached: boolean;
  hpAboveMaxReached: boolean;
  kills: number;
}

const aliveEnemies = (s: WorldState): number => s.enemies.filter((e) => e.alive).length;
const adjacent = (s: WorldState): boolean =>
  s.enemies.some((e) => e.alive && Math.abs(e.x - s.player.x) + Math.abs(e.y - s.player.y) <= 1);

function replay(seed: number, caps: Capabilities, actions: readonly Action[]): Replay {
  let s = createWorld(seed);
  const states = [s];
  const screens = [renderInitial(s)];
  const hashes = [worldHash(s)];
  const led: Ledger = {
    ticks: 0, wallAttempts: 0, boundaryAttempts: 0, attacksWhileCooldown: 0,
    attackedWhileAdjacent: false, touchedByEnemy: false, stoodOnPickup: false,
    hpZeroReached: s.player.hp <= 0, hpBelowZeroReached: s.player.hp < 0,
    hpAboveMaxReached: s.player.hp > s.player.maxHp, kills: 0,
  };
  for (const a of actions) {
    const prev = s;
    // 动作**前**的意图：撞墙/撞边界/冷却中出手/贴身出手，这些都只在意图那一刻成立
    if (prev.player.alive) {
      if (a.kind === 'move') {
        const nx = prev.player.x + DX[a.dir]!;
        const ny = prev.player.y + DY[a.dir]!;
        if (nx < 0 || ny < 0 || nx >= prev.size || ny >= prev.size) led.boundaryAttempts++;
        else if (prev.walls.includes(`${nx},${ny}`)) led.wallAttempts++;
      } else if (a.kind === 'attack') {
        if (prev.player.cooldown > 0) led.attacksWhileCooldown++;
        else if (adjacent(prev)) led.attackedWhileAdjacent = true;
      } else if (a.kind === 'pickup') {
        if (prev.pickups.some((p) => !p.taken && p.x === prev.player.x && p.y === prev.player.y)) led.stoodOnPickup = true;
      }
    }
    const before = aliveEnemies(prev);
    s = step(prev, a, caps, seed);
    const after = aliveEnemies(s);
    if (after < before) led.kills += before - after;
    const p = s.player;
    led.ticks = s.tick;
    if (p.hp <= 0) led.hpZeroReached = true;
    if (p.hp < 0) led.hpBelowZeroReached = true;
    if (p.hp > p.maxHp) led.hpAboveMaxReached = true;
    if (p.alive && s.enemies.some((e) => e.alive && e.x === p.x && e.y === p.y)) led.touchedByEnemy = true;
    states.push(s);
    hashes.push(worldHash(s));
    screens.push(render(s, describe(prev, a, s)));
  }
  return { states, screens, hashes, led };
}

/** 两条屏幕流的差异，自己数第一处与总帧数 */
function screenDiff(a: string[], b: string[]): { diverged: boolean; firstStep: number | null; frames: number } {
  let firstStep: number | null = null;
  let frames = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    frames++;
    if (firstStep === null) firstStep = i;
  }
  if (a.length !== b.length) {
    frames += Math.abs(a.length - b.length);
    if (firstStep === null) firstStep = n;
  }
  return { diverged: firstStep !== null, firstStep, frames };
}

/** 玩家侧前提：与 detect.ts 各写一份，判据口径必须一致（不一致就由下面的比对出声） */
const PREM: Record<Cap, { side: 'ref' | 'mutant'; test: (l: Ledger) => boolean }> = {
  wallBlocks: { side: 'ref', test: (l) => l.wallAttempts > 0 },
  enemyPatrol: { side: 'ref', test: (l) => l.ticks >= 2 },
  contactDamage: { side: 'ref', test: (l) => l.touchedByEnemy },
  attackKills: { side: 'ref', test: (l) => l.attackedWhileAdjacent },
  attackCooldown: { side: 'ref', test: (l) => l.attacksWhileCooldown > 0 },
  pickupHeals: { side: 'ref', test: (l) => l.stoodOnPickup },
  deathAtZeroHp: { side: 'ref', test: (l) => l.hpZeroReached },
  scoreOnKill: { side: 'ref', test: (l) => l.kills > 0 },
  hpClamp: { side: 'mutant', test: (l) => l.hpAboveMaxReached || l.hpBelowZeroReached },
};

// ─────────────────────────── 记账 ───────────────────────────

const errors: string[] = [];
const gaps: string[] = [];
let checkedRuns = 0;
let versionSkipped = 0;

const bad = (label: string, detail: string): void => {
  errors.push(`${label} ${detail}`);
  console.log(`${label} ❌ ${detail}`);
};
const good = (label: string, detail: string): void => console.log(`${label} ✅ ${detail}`);
/** 只在"该成立"时核对；条件不成立就跳过并把跳过原因说出来，绝不默默 continue */
function check(label: string, cond: boolean, detail: string, skip?: string): boolean {
  if (skip !== undefined) { console.log(`${label} ⏭ ${skip}`); return true; }
  if (cond) { good(label, detail); return true; }
  bad(label, detail);
  return false;
}

// ─────────────────────────── 逐局审计 ───────────────────────────

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const dirs: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) { flags.set(a.slice(2), argv[i + 1] ?? 'true'); i++; }
  else dirs.push(resolve(a.replace(/\/+$/, '')));
}
if (dirs.length === 0 && !flags.has('ceiling')) {
  console.error('用法: node verify/detect-audit.ts <runDir> ... [--ceiling runs/m4f-ceiling] [--ceiling-check 20]');
  process.exit(2);
}

const JUDGE = `m4f-1+lex-${LEXICON_VERSION}`;
interface Row { dir: string; mutant: string | null; arm: string; src: Src; detectable: boolean; detected: boolean; exact: boolean; fp: boolean; verdict: V; whyNot: string | null }
const rows: Row[] = [];
/** 旧证据（没有 detection.json 的那批）由本文件独立算出的误报对照，只用于算误报率 */
const legacy: { dir: string; fp: boolean; caps: Cap[]; quotes: number; src: Src; mutant: string | null }[] = [];

/**
 * 这批证据到底是谁产生的：真大脑 / 脚本替身（mock）/ 人写夹具。三个互斥类。
 *
 * 为什么必须有这一层：夹具会造两局 `mutant=null` 的参考版，其中一局**故意埋了"仪器过火"**，
 * 用来证明审计不是 print ✅。原先误报率只按 `mutant===null` 收分母，于是那枚阳性样本
 * 被算进仪器精度，当众打出 `1/2 = 50.0%`——**分母混进了不该进的一批证据**，
 * 与 #18「两侧必须是同一量的两种算法」同族：两个不同的量共用了"误报率"这个名字。
 *
 * 本函数第一次跑就翻出更狠的一条：旧证据那 9 局里混着 4 局真大脑、2 局 mock 替身、
 * 1 局人写夹具，**外加 2 局根本不是参考版（mutant=M08 的缺陷局）**——
 * 缺陷局里的上报是真检出，不是误报，却一直在分母里充数。所以这里同时管两件事：
 *   1. 来源分类（下面三条独立信号，不认 header 里那一句声明）；
 *   2. 只有 `mutant===null` 且来源为真大脑的局，才有资格进"误报率"分母。
 *
 * ⚠️ 事后规则不追判旧证据（#19 的教训）：`provenance` 字段是本轮才加的，
 *    旧局没有这个键**不算错**，按信号如实归类即可。
 *    只有"字段已存在却声明成真证据、信号却说是夹具"才是主动冒充，那种判错。
 */
type Src = 'model' | 'double' | 'fixture';
function sourceOf(header: any): { src: Src; note: string | null } {
  const id = String(header.brainId ?? '');
  const declared = header.provenance === 'fixture' ? 'fixture' : header.provenance === 'real' ? 'real' : undefined;
  const sigFixture = id.includes('FIXTURE') || String(header.task ?? '').startsWith('夹具');
  const sigDouble = !sigFixture && (id.startsWith('mock') || id.startsWith('script'));
  const src: Src = sigFixture ? 'fixture' : sigDouble ? 'double' : 'model';
  if (declared === 'real' && src !== 'model') {
    bad('[来源]', `header 声明 provenance='real'，但 brainId=${id} 与 task 前缀都说是${src === 'fixture' ? '人写夹具' : '脚本替身'} —— 冒充真证据会污染误报率分母`);
    return { src, note: '主动冒充：已判错，并按真实来源剔除' };
  }
  if (declared === 'fixture' && src === 'model') {
    return { src: 'fixture', note: '声明是夹具但 brainId/task 不认（只会缩小分母，不影响已报出的精度）' };
  }
  if (declared === undefined && src !== 'model') {
    return { src, note: `旧证据没有 provenance 键（本轮才加），按 brainId 归类为 ${src}；事后规则不追判` };
  }
  return { src, note: null };
}

console.log(`\n===== M4-f 检出判决独立审计（判决口径 ${JUDGE}） =====`);
const drift = lexiconSha() !== FROZEN_SHA256;
if (drift) bad('[词表]', `词表已偏离冻结指纹（frozen=${FROZEN_SHA256.slice(0, 12)}… now=${lexiconSha().slice(0, 12)}…）：判决标准被改过，本轮全部数字作废`);
else good('[词表]', `还是冻结时那张表（${LEXICON_VERSION}，sha ${FROZEN_SHA256.slice(0, 12)}…）`);

/** 从 runDir 的父目录 model_runs.jsonl 里找回融档（on/off）；找不到退回目录名后缀 */
function armOf(dir: string, d: any): string {
  const parent = join(dir, '..');
  const p = join(parent, 'model_runs.jsonl');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      if (r.runDir && resolve(String(r.runDir).replace(/\/+$/, '')) === dir) return String(r.arm);
    }
  }
  const m = /-(on|off)$/.exec(dir.split('/').at(-2) ?? '');
  return m ? m[1]! : (d.mutant === null ? 'ref' : 'n/a');
}

/** 送给大脑的文本里绝不能出现的作者侧标识 */
const LEAK_FORBIDDEN: string[] = [
  'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'D01', 'D02', 'D03',
  ...CAP_NAMES, '变异体', 'mutant', '被删能力', '可见分叉', '玩家侧前提', '归因正确', '归因错误',
  '报了未指明', '检出判决', 'judgementVersion',
];

function auditRun(dir: string): void {
  console.log(`\n----- ${dir} -----`);
  let defect: any; let header: any; let detection: any; let trace: any[];
  try {
    defect = JSON.parse(readFileSync(join(dir, 'defect.json'), 'utf8'));
    header = JSON.parse(readFileSync(join(dir, 'header.json'), 'utf8'));
    trace = readFileSync(join(dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    bad('[证据]', `读不到 defect/header/trace：${(e as Error).message.slice(0, 80)}`);
    return;
  }
  const hasDetection = existsSync(join(dir, 'detection.json'));
  const { src, note } = sourceOf(header);
  if (note) console.log(`[来源] ⏭ ${note}`);
  if (!hasDetection) {
    versionSkipped++;
    gaps.push(`${dir}：没有 detection.json —— M4-f 之前的证据，判决未落盘，不参与本轮结论`);
    console.log('[版本] ⏭ 无 detection.json：这是 M4-f 之前的证据，只跑零泄漏审计与误报对照');
    // 词表的第 2 条防线要求"参考版那批先过一遍这张表"，而 M4-f 之前跑的那些参考局
    // 根本没有 detection.json。如果这里直接跳过不审，误报率就只能靠真模型臂现跑——
    // 那等于"仪器自己的已知阴性"这一格永远是空的。所以旧证据也独立给一次判决：
    // 参考版局没有缺陷可言，能算的只有"它有没有把正常规则说成不对劲"。
    const cl0 = defect.agentClaims ?? {};
    const texts0: { where: string; text: string }[] = [];
    if (cl0.finishSummary) texts0.push({ where: 'finish', text: cl0.finishSummary });
    for (const n of cl0.notes ?? []) texts0.push({ where: 'note', text: n });
    for (const h of cl0.hypotheses ?? []) texts0.push({ where: 'hypothesis', text: h.text });
    const c0 = scanClaims(texts0);
    legacy.push({
      dir, fp: c0.reported || c0.vague, caps: c0.caps, quotes: c0.quotes.length,
      src, mutant: (defect.mutant ?? null) as string | null,
    });
    console.log(
      `[旧证据·误报对照] ${c0.reported || c0.vague ? '误报' : '无误报'}` +
      `（上报=${c0.reported} 空喊=${c0.vague}${c0.caps.length ? ` 指的=${c0.caps.join('+')}` : ''}，文本 ${texts0.length} 条）`,
    );
    leakAudit(dir, header, trace, null);
    return;
  }
  detection = JSON.parse(readFileSync(join(dir, 'detection.json'), 'utf8'));
  checkedRuns++;
  const seed = defect.seed as number;
  const actions = defect.fullWorldActions as Action[];
  const mutId = (defect.mutant ?? null) as string | null;
  const removed = (detection.removed ?? []) as Cap[];
  const caps: Capabilities = mutId ? findMutant(mutId).caps : ALL_CAPS;

  // ── 1. 重放 + 「判决比的是不是 agent 真看见的东西」 ──
  const played = replay(seed, caps, actions);
  const ref = replay(seed, ALL_CAPS, actions);
  const stepRows = trace.filter((r) => r.decision);
  let shown = 0;
  let worldSeen = 0;
  let screenMismatch = 0;
  let pi = 0;
  for (const r of stepRows) {
    const call = r.decision.call ?? {};
    const isWorld = call.name === 'move' || call.name === 'attack' || call.name === 'pickup' || call.name === 'wait';
    // 没成功的世界动作**不推进时间**（非法方向在工具层就被拒了），所以既不计数也不翻页。
    // 但必须把它算进 worldSeen 之外的对账：漏一格，后面每一帧的配对都错位。
    if (!isWorld || r.result?.ok !== true) continue;
    worldSeen++;
    const mine = played.screens[++pi];
    if (typeof r.result.output === 'string' && r.result.output.includes('+--------')) {
      shown++;
      if (mine !== undefined && mine !== r.result.output) screenMismatch++;
    }
  }
  check('[证据对齐]', worldSeen === actions.length,
    `trace 里成功执行的世界动作 ${worldSeen} 个，defect.fullWorldActions ${actions.length} 条`);
  check('[屏幕重建]', screenMismatch === 0 && shown > 0,
    `重放帧与 agent 实际所见逐字符核对 ${shown} 帧，不一致 ${screenMismatch} 帧`,
    shown === 0 ? '这一局没有可核对的屏幕帧（全是非世界动作），重放与所见的等值未验' : undefined);

  // ── 2. L1 可见分叉 ──
  const visible = screenDiff(ref.screens, played.screens);
  const v = detection.visible;
  check('[L1 可见分叉]', visible.diverged === v.diverged && visible.firstStep === v.firstStep && visible.frames === v.frames,
    `重算 分叉=${visible.diverged} 首帧=${visible.firstStep} 帧数=${visible.frames}｜记录 分叉=${v.diverged} 首帧=${v.firstStep} 帧数=${v.frames}`);

  // ── 3. 内部分叉（公证器侧）与「内部叉了屏幕没叉」 ──
  let internalFirst: number | null = null;
  for (let i = 0; i < Math.min(ref.states.length, played.states.length); i++) {
    if (diffFields(ref.states[i], played.states[i]).length > 0) { internalFirst = i; break; }
  }
  const internalDiverged = internalFirst !== null;
  const not = defect.notary ?? {};
  check('[内部一致性]', internalDiverged === !!not.diverged && internalDiverged === !!detection.internal.diverged,
    `独立 diffFields=${internalDiverged}（首叉第 ${internalFirst ?? '无'} 步）｜公证器=${not.diverged}｜判决器=${detection.internal.diverged}`);
  const invisible = internalDiverged && !visible.diverged;
  check('[内部 vs 可见]', invisible === detection.invisibleThoughDiverged,
    `结构性不可见（内部分叉而屏幕全程相同）=${invisible}`);

  // ── 4. 覆盖账本：三处同源核对（我自己算 vs 引擎实时账本 vs 判决器重放账本） ──
  const ledKeys = ['wallAttempts', 'boundaryAttempts', 'attacksWhileCooldown', 'attackedWhileAdjacent',
    'touchedByEnemy', 'stoodOnPickup', 'hpZeroReached', 'hpBelowZeroReached', 'hpAboveMaxReached', 'kills'] as const;
  const live: any = defect.coverage ?? {};
  const judgeLed: any = (detection.coverage ?? {}).mutant ?? {};
  const ledMismatch = ledKeys.filter((k) => played.led[k] !== live[k] || played.led[k] !== judgeLed[k]);
  check('[覆盖账本]', ledMismatch.length === 0,
    ledMismatch.length === 0
      ? `${ledKeys.length} 个前提相关字段：独立重算 = 引擎实时 = 判决器重放，三方一致`
      : `不一致字段 ${ledMismatch.join(', ')}（独立=${ledMismatch.map((k) => `${k}:${played.led[k]}`).join(' ')}｜引擎=${ledMismatch.map((k) => `${k}:${live[k]}`).join(' ')}｜判决器=${ledMismatch.map((k) => `${k}:${judgeLed[k]}`).join(' ')}）`);

  // ── 5. L2 玩家侧前提 ──
  const premOwn = removed.map((cap) => {
    const spec = PREM[cap];
    return { cap, side: spec.side, reached: spec.test(spec.side === 'ref' ? ref.led : played.led) };
  });
  const premRec = (detection.preconditions ?? []) as any[];
  const premOk = premOwn.length === premRec.length
    && premOwn.every((p, i) => p.cap === premRec[i]!.cap && p.reached === premRec[i]!.reached && p.side === premRec[i]!.side);
  check('[L2 玩家侧前提]', premOk,
    `独立=${premOwn.map((p) => `${p.cap}/${p.side}:${p.reached}`).join(' ')}｜记录=${premRec.map((p) => `${p.cap}/${p.side}:${p.reached}`).join(' ')}`);
  const playerPremise = premOwn.every((p) => p.reached);
  check('[L2 汇总]', playerPremise === detection.playerPremise, `前提全达成=${playerPremise}｜记录=${detection.playerPremise}`);

  // ── 6. L3/L4：主观文本 → 上报与归因 ──
  const cl = defect.agentClaims ?? {};
  const texts: { where: string; text: string }[] = [];
  if (cl.finishSummary) texts.push({ where: 'finish', text: cl.finishSummary });
  for (const n of cl.notes ?? []) texts.push({ where: 'note', text: n });
  for (const h of cl.hypotheses ?? []) texts.push({ where: 'hypothesis', text: h.text });
  const claim = scanClaims(texts);
  const rec = detection.claim ?? {};
  check('[L3 上报]', claim.reported === !!rec.reported && claim.vague === !!rec.vague,
    `重算 上报=${claim.reported} 空喊=${claim.vague}｜记录 上报=${rec.reported} 空喊=${rec.vague}｜文本 ${texts.length} 条`);
  check('[L4 归因集合]', eq(claim.caps, rec.caps ?? []), `重算=${claim.caps.join('+') || '（空）'}｜记录=${(rec.caps ?? []).join('+') || '（空）'}`);
  const verdict = decideOwn(claim, removed);
  check('[判决]', verdict === detection.verdict, `重算=${verdict}｜记录=${detection.verdict}`);

  // ── 7. 漏斗算术 ──
  const detectable = visible.diverged;
  const detected = visible.diverged && verdict === '归因正确';
  const exact = visible.diverged && removed.length > 0
    && removed.length === claim.caps.length && removed.every((c) => claim.caps.includes(c));
  const fp = removed.length === 0 && (claim.reported || claim.vague);
  const why = !mutId ? null
    : !visible.diverged ? '不可见'
      : !playerPremise ? '未触达'
        : verdict === '归因正确' ? null
          : verdict === '归因错误' ? '归因错误'
            : verdict === '报了未指明' ? '报了未指明' : '未上报';
  const arith = [['detectable', detectable], ['detected', detected], ['exactlyAttributed', exact], ['falsePositive', fp]]
    .filter(([k, x]) => x !== (detection as any)[k]);
  check('[漏斗算术]', arith.length === 0 && why === detection.whyNot,
    arith.length ? `不一致 ${arith.map(([k, x]) => `${k}: 重算=${x} 记录=${(detection as any)[k]}`).join(' ')}` : `四层布尔与失败层全部重算相符（失败层=${why ?? '—'}）`);
  check('[判决口径]', detection.judgementVersion === JUDGE,
    `记录=${detection.judgementVersion}｜本机应为 ${JUDGE}`,
    drift ? '词表已漂移，上面这条不计入错误：改表必须升版本' : undefined);
  // ── 口径戳的**第二处落点**：header.judgement ──
  // detection.json 里的 judgementVersion 只能证明"判决器自称用了这个版本"；
  // 版本必须在 agent 动手之前就写进 header，才谈得上"判据先于输出冻结"（理由见 types.ts 的 JudgementStamp）。
  // 三处必须同源：header 的戳、detection 的口径、本机词表算出来的版本。少一处相符就是有人局末改过证据。
  const hs = header.judgement as { detector?: string; lexicon?: string; sha?: string } | undefined;
  const stampStr = hs === undefined ? '' : `${hs.detector}+lex-${hs.lexicon}`;
  check('[口径落盘]', hs !== undefined
    && stampStr === JUDGE
    && hs.sha === lexiconSha()
    && detection.judgementVersion === JUDGE,
    hs === undefined
      ? '有 detection.json 却没有开局口径戳：判决版本必须早于 agent 的第一步存在，局末补写不算'
      : `header 戳=${stampStr}/${String(hs.sha).slice(0, 12)}…｜detection=${detection.judgementVersion}｜本机口径=${JUDGE}｜词表 sha=${lexiconSha().slice(0, 12)}…`);
  check('[重放同源]', detection.replayMatchesLiveSession !== false,
    `判决器重放的缺陷版覆盖 = 引擎实时覆盖（记录 ${detection.replayMatchesLiveSession}）`);

  leakAudit(dir, header, trace, detection);
  rows.push({
    dir, mutant: mutId, arm: armOf(dir, detection), src, detectable, detected, exact, fp,
    verdict, whyNot: why,
  });
}

/** 零泄漏：作者侧标识只能出现在局末证据里，绝不能进任何送给大脑的文本 */
function leakAudit(dir: string, header: any, trace: any[], detection: any): void {
  const seen: string[] = [];
  const feed = (label: string, text: unknown): void => {
    if (typeof text !== 'string') return;
    for (const w of LEAK_FORBIDDEN) if (text.includes(w)) seen.push(`${label} 含「${w}」`);
  };
  feed('任务文本', header.task);
  feed('首屏', header.initialState?.world?.screen);
  for (const r of trace) {
    if (r.decision) {
      feed(`第${r.index}步工具返回`, r.result?.output);
      continue;
    }
    // 事件行里凡带 text 的都是**会回喂给大脑**的板面/反馈原文，一条都不许漏着扫
    const p = r.payload ?? {};
    if (typeof p.text === 'string') feed(`${r.kind}`, p.text);
    if (typeof p.summary === 'string') feed(`${r.kind}`, p.summary);
  }
  // 变异体 id 在缺陷局里本来就是作者侧知识；参考局根本不该有它
  if (detection && detection.mutant && String(header.initialState?.world?.mutant ?? '') !== detection.mutant) {
    bad('[零泄漏]', `header 里的 mutant=${header.initialState?.world?.mutant} 与判决器=${detection.mutant} 不同源`);
  }
  check('[零泄漏]', seen.length === 0,
    seen.length === 0 ? `送给大脑的文本 ${LEAK_FORBIDDEN.length} 个禁词一个没出现` : `泄漏命中：${seen.slice(0, 6).join('；')}`);
}

for (const dir of dirs) auditRun(dir);

// ─────────────────────────── 汇总表 ───────────────────────────

function groupKey(r: Row): string { return `${r.mutant ?? 'control'}/${r.arm}`; }

/**
 * 一张分组表。**真证据与夹具必须分两张打**——同一批数字不许有两种读法。
 * 原先两张混在一张里，`M07/n/a 0/1` 这种夹具格子和模型臂格子并排出现，
 * 谁截错一行就能把人写剧本的覆盖自检读成"某模型对 M07 的检出率 0%"。
 *
 * `rate=false` 时**不出百分比、不出置信区间**：夹具那一批要量的是"判决通路走没走全"，
 * 不是任何能力指标。首版只在标题上写了"不许引用"，结果夹具表里仍然印出
 * `M01/n/a 1/2 50.0% [9.5, 90.5]` 这样一行带置信区间的假检出率——
 * 标题管不住截图，**格式本身才管得住**：既然这个数不该被引用，就不该长成可引用的样子。
 */
function table(title: string, note: string, list: Row[], rate: boolean): void {
  console.log(`\n${title}　${note}`);
  if (list.length === 0) { console.log('   （这一批一个都没有——没有证据就没有数字，不许用空表冒充"0%"）'); return; }
  const by = new Map<string, Row[]>();
  for (const r of list) {
    if (!by.has(groupKey(r))) by.set(groupKey(r), []);
    by.get(groupKey(r))!.push(r);
  }
  console.log(rate
    ? '组                        可检(分母)  检出(分子)   检出率[Wilson95]        严格档  未检出的第一处断在哪层'
    : '组                        可检(计数)  检出(计数)   检出率              严格档  判决落点分布（只数通路，不出百分比）');
  for (const [k, rs] of [...by.entries()].sort()) {
    const den = rs.filter((r) => r.detectable).length;
    const num = rs.filter((r) => r.detected).length;
    // den=0 时 Wilson 区间没有意义（0/0 会直接算出 NaN），如实写"无从谈检出率"。
    // 拿 NaN 蒙进表格就是把"这组一条都没看得见"读成"检出率 0%"，那是两种完全不同的结论。
    const [lo, hi] = den > 0 ? wilson(num, den) : [NaN, NaN];
    const why = new Map<string, number>();
    for (const r of rs) {
      if (r.mutant === null) { why.set(r.verdict, (why.get(r.verdict) ?? 0) + 1); continue; }
      if (!r.detected) why.set(r.whyNot ?? '未检出', (why.get(r.whyNot ?? '未检出') ?? 0) + 1);
    }
    const dist = [...why.entries()].map(([w, n]) => `${w}×${n}`).join(' ') || '—';
    console.log(
      `${k.padEnd(25)} ${String(den).padStart(4)}/${String(rs.length).padStart(3)}  ` +
      `${String(num).padStart(4)}/${den}      ` +
      (rate
        ? (den ? `${(100 * num / den).toFixed(1)}% [${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]` : '无从谈检出率（一局都不可检）  ')
        : '（不适用）            ') +
      `${String(rs.filter((r) => r.exact).length).padStart(4)}  ${dist}`,
    );
  }
}

console.log('\n===== 检出率汇总（只统计通过独立复核的局） =====');
if (errors.length) {
  console.log(`⚠️ 上面有 ${errors.length} 处不一致：这些局不进汇总表，先修判决器/世界再谈数字。`);
} else if (rows.length === 0 && legacy.length === 0) {
  console.log('零样本：既没有新版判决证据，也没有旧参考局可算误报率。');
} else {
  const real = rows.filter((r) => r.src === 'model');
  const fxRows = rows.filter((r) => r.src !== 'model');
  table('【真大脑】检出率', '只有这张表的数字可以引用', real, true);
  table('【非真大脑：夹具与脚本替身】判决通路覆盖', '人写剧本/测试替身，只证明判据走得通；**不是 agent 能力证据，这一张表里没有可引用的百分比**', fxRows, false);

  // ── 误报率：分母只收"真大脑 + 参考版世界"的局 ──
  // 三条剔除各有各的理由，都必须出声说清楚，不许默默 continue：
  //   · 夹具/替身的参考局：上报文本是人写的，量的是判据通路，不是仪器在真输出上的精度；
  //   · 缺陷世界（mutant≠null）的局：那里报异常是**真检出**，放进"误报"分母是类别错误；
  //   · 旧证据没有 detection.json：由本审计独立判，单独计数并标明。
  const refsNew = real.filter((r) => r.mutant === null).length;
  const fpsNew = real.filter((r) => r.mutant === null && r.fp).length;
  const refsOld = legacy.filter((l) => l.src === 'model' && l.mutant === null).length;
  const fpsOld = legacy.filter((l) => l.src === 'model' && l.mutant === null && l.fp).length;
  const allRefs = refsNew + refsOld;
  const allFps = fpsNew + fpsOld;
  const [wlo, whi] = allRefs > 0 ? wilson(allFps, allRefs) : [NaN, NaN];
  console.log(
    `\n误报率（**分母＝真大脑跑的参考版局**，仪器自己的已知阴性对照）：${allFps}/${allRefs}` +
    (allRefs
      ? ` = ${(100 * allFps / allRefs).toFixed(1)}% [${(wlo * 100).toFixed(1)}, ${(whi * 100).toFixed(1)}]`
      : ' — 一个真大脑的参考版局都没有，无法算'),
  );
  console.log(`   分母来源：${refsNew} 局有 detection.json + ${refsOld} 局 M4-f 之前的旧证据（本审计独立判，那批没有 detection.json 可对照）`);
  const exFx = fxRows.filter((r) => r.mutant === null).length;
  const exDouble = legacy.filter((l) => l.src === 'double').length;
  const exOldFx = legacy.filter((l) => l.src === 'fixture').length;
  const exDefect = legacy.filter((l) => l.mutant !== null).length;
  if (exFx + exDouble + exOldFx + exDefect > 0) {
    console.log(
      `   已剔除：夹具参考局 ${exFx}（含故意埋的"仪器过火" ${fxRows.filter((r) => r.mutant === null && r.fp).length} 局）` +
      `｜脚本替身旧局 ${exDouble}｜人写夹具旧局 ${exOldFx}｜**缺陷世界的旧局 ${exDefect}——那里报异常是真检出，不是误报**`,
    );
    console.log('   依据=brainId/task 两条独立信号 + header.provenance。该字段本轮才加，旧证据缺键不追判，只如实归类。');
  }
  console.log('检出率必须与误报率成对出现：只看前者，把仪器过火读成模型能干。');
  const on = real.filter((r) => r.arm === 'on' && r.mutant);
  const off = real.filter((r) => r.arm === 'off' && r.mutant);
  if (on.length && off.length) {
    const a = on.filter((r) => r.detected).length, b = on.length - a;
    const c = off.filter((r) => r.detected).length, d = off.length - c;
    console.log(`目标通道开/关：${a}/${on.length} vs ${c}/${off.length}，Fisher 精确 p=${fisherExact(a, b, c, d).toFixed(4)}`);
  }
}
if (gaps.length) {
  console.log(`\n版本差异（不参与本轮结论，也不计入错误）：${gaps.length} 条`);
  for (const g of gaps) console.log(`   ${g}`);
}
if (versionSkipped > 0 && checkedRuns === 0) {
  bad('[样本]', `只有 ${versionSkipped} 局旧证据、0 局新版证据——零样本审计等于假通过`);
}

// ─────────────────────────── 预登记上限表 ───────────────────────────

if (flags.has('ceiling')) {
  const dir = resolve(flags.get('ceiling')!);
  const path = join(dir, 'ceiling_cases.jsonl');
  const limit = Number(flags.get('ceiling-check') ?? 40);
  console.log(`\n===== 预登记上限表独立重算（抽 ${limit} 行）：${path} =====`);
  if (!existsSync(path)) {
    bad('[上限表]', `找不到 ${path}：随机臂没跑过就没有预登记，检出率无从对照`);
  } else {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const sample = lines.filter((_, i) => i % Math.max(1, Math.ceil(lines.length / limit)) === 0).slice(0, limit);
    let mismatch = 0;
    for (const r of sample) {
      const acts = randomActions(r.seed, r.salt, r.budget) as Action[];
      const capsM = findMutant(r.mutant).caps;
      const a = replay(r.seed, ALL_CAPS, acts);
      const b = replay(r.seed, capsM, acts);
      const vis = screenDiff(a.screens, b.screens);
      const removedM = findMutant(r.mutant).removed as Cap[];
      const prem = removedM.every((cap) => PREM[cap].test(PREM[cap].side === 'ref' ? a.led : b.led));
      const internal = (() => {
        for (let i = 0; i < Math.min(a.states.length, b.states.length); i++) if (diffFields(a.states[i], b.states[i]).length > 0) return true;
        return false;
      })();
      const ok = vis.diverged === r.visible && vis.firstStep === r.firstVisibleStep
        && prem === r.playerPremise && internal === r.internal
        && (internal && !vis.diverged) === r.invisibleThoughDiverged;
      if (!ok) {
        mismatch++;
        bad('[上限表]', `${r.mutant} s${r.seed}/salt${r.salt}/步${r.budget}：记录 可见=${r.visible}@${r.firstVisibleStep} 前提=${r.playerPremise} 内部=${r.internal}` +
          `｜重算 可见=${vis.diverged}@${vis.firstStep} 前提=${prem} 内部=${internal}`);
      }
    }
    if (mismatch === 0) good('[上限表]', `抽 ${sample.length}/${lines.length} 行逐行重算，可见分叉、首帧、前提、内部分叉全部相符`);
    else bad('[上限表]', `${mismatch}/${sample.length} 行与独立重算不符——预登记表不可信`);
    if (sample.length === 0) bad('[上限表]', `上限表是空的（${lines.length} 行）：零样本`);
    console.log(`（全表 ${lines.length} 行；抽行按等间隔取，抽样本身也是确定的，重跑同一份表得到同一批行）`);
  }
}

console.log(`\n===== 结论：审计 ${checkedRuns} 局 + 版本差异 ${versionSkipped} 局，不一致 ${errors.length} 处 =====`);
for (const e of errors) console.log(`   ${e}`);
process.exit(errors.length > 0 ? 1 : 0);
