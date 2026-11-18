/**
 * M4-d 对账汇总器：对**已发布**的 runs/ 逐局把 agent 自述与它当时看到的屏幕对上。
 *
 * 零模型调用、零 key——判据要动的东西全在仓库里（trace.jsonl 的 thought 与 result.output、
 * header.initialState.world.screen）。这既是省额度，也是刻意的：**对账天然事后**，
 * 一个需要现场跑的判断标准永远会被"再跑一局看看"污染。
 *
 * 用法:
 *   node verify/recon.ts                 # 全部真大脑局，逐局写 reconciliation.json + 打印汇总
 *   node verify/recon.ts --run <dir>     # 只跑一局（dir 相对仓库根或绝对）
 *   node verify/recon.ts --dry           # 只算不写盘
 *
 * 三处必须出声的失败：
 *   ① 证据缺失（缺 trace/header）→ 说清缺哪个、为什么、下一步跑什么；
 *   ② 屏幕对齐自检不过（帧号非单调 / 首帧不是第 0 帧）→ 整局判「对账不可用」，
 *      **绝不带着错位的锚点出数**（#18 家族：锚点错了，每个数字都自洽地错）；
 *   ③ 零样本 → exit 1。四桶全 0 不是"没有矛盾"，是"根本没测"（#22）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { observe, type Observation } from '../src/world/observe.ts';
import {
  EXCLUDED_RULES, KINDS, RECON_VERSION, RULES, VERDICTS,
  clauseFor, countExcluded, extractClaims, judgeAll, reconDrift, reconSha, reconStamp,
  type Claim, type Judged, type Kind, type Verdict,
} from '../src/world/reconcile.ts';

const HERE = resolve(new URL('.', import.meta.url).pathname);
const ROOT = resolve(join(HERE, '..'));
const RUNS = join(ROOT, 'runs');

function need(dir: string, file: string): string {
  const p = join(dir, file);
  if (!existsSync(p)) {
    console.error(`[证据缺失] 读不到 ${p}\n` +
      `  对账需要 ${file}。两种可能：① run 目录名写错（列一下 runs/）；` +
      `② 这批证据还没跑出来（真模型臂：npm run verify:m4f -- --arm model）。`);
    process.exit(2);
  }
  return readFileSync(p, 'utf8');
}

/**
 * 全量扫描时**不能**用 need()：一个 e2e 演示目录少个 world.jsonl 不该让整轮审计退出。
 * 但静默跳过更糟——所以这里返回 null，由调用侧把理由计数打印出来（#22「跳过要说出声」）。
 * 显式 --run 某一局时仍然走 need()：那是用户点名要的证据，缺了就是错。
 */
const optional = (dir: string, file: string): string | null => {
  const p = join(dir, file);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

/** 判决 + 锚点三件套（证据侧字段，不进冻结指纹） */
type AnchorJudged = Judged & { row: number; tick: number | null; screenSha: string | null; clause: string };

/** 屏幕指纹：审计侧用它确认"我们看的是同一帧"，不参与任何判决。 */
const sha12 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

type Row = {  index?: number;
  kind?: string;
  decision?: { thought?: string; call?: { name: string; args?: Record<string, unknown> } };
  result?: { ok?: boolean; output?: string };
  stateHash?: string;
};

/** 屏幕判据：HUD 行必然以 \nHP 开头。工具返回的普通文本（"已记录"）不是屏幕。 */
const isScreen = (o: unknown): o is string => typeof o === 'string' && /\nHP /.test(o);

function walk(d: string, depth = 0): string[] {
  const out: string[] = [];
  for (const n of readdirSync(d).sort()) {
    const p = join(d, n);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, 'header.json'))) out.push(p);
    else if (depth < 2) out.push(...walk(p, depth + 1));
  }
  return out;
}

interface RunResult {
  dir: string;
  brain: string;
  eligible: boolean;
  skipWhy?: string;
  /** 屏幕对齐自检 */
  align: { screens: number; ticksMonotone: boolean; firstTick: number | null; lastTick: number | null; worldRows: number | null };
  usable: boolean;
  thoughtRows: number;
  skippedRows: number;
  claims: number;
  counts: Record<Verdict, number>;
  byKind: Record<Kind, Record<Verdict, number>>;
  excluded: Record<string, number>;
  /**
   * 逐条判决 + **锚点**。row/tick/screenSha 不是判据的一部分（判据本体在 reconcile.ts，
   * 冻结指纹不含它们），是证据侧的"这句话是对着哪一帧屏幕判的"。
   * 没有这三样，verify/recon-audit.ts 就得自己再实现一遍锚点选择然后各信一份（台账 #14）；
   * 有了它们，审计能独立重算那一帧的可观测量并回查判据引用的屏幕值。
   */
  judged: AnchorJudged[];
}

const zeroCounts = (): Record<Verdict, number> =>
  Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
const zeroByKind = (): Record<Kind, Record<Verdict, number>> =>
  Object.fromEntries(KINDS.map((k) => [k, zeroCounts()])) as Record<Kind, Record<Verdict, number>>;

/** 一局：抽主张 → 选锚点屏幕 → 判决。锚点选择在**这一层**，reconcile.ts 不知道 trace 长什么样。 */
function reconcileRun(dir: string, explicit: boolean): RunResult {
  const header = JSON.parse(need(dir, 'header.json'));
  const brain = String(header.brainId ?? '（无 brainId）');
  const base: RunResult = {
    dir: dir.slice(RUNS.length + 1), brain, eligible: false, align: { screens: 0, ticksMonotone: false, firstTick: null, lastTick: null, worldRows: null },
    usable: false, thoughtRows: 0, skippedRows: 0, claims: 0, counts: zeroCounts(), byKind: zeroByKind(),
    excluded: {}, judged: [],
  };
  // 假大脑（mock:）与人写剧本（script:）的文本不是自然语言自述，混进来等于用夹具冒充真样本
  if (brain.startsWith('mock:')) { base.skipWhy = 'mock 大脑（测试替身，不是自然语言自述）'; return base; }
  if (brain.startsWith('script:')) { base.skipWhy = '人写剧本夹具（同上）'; return base; }
  const rawTrace = explicit ? need(dir, 'trace.jsonl') : optional(dir, 'trace.jsonl');
  if (rawTrace === null) { base.skipWhy = '没有 trace.jsonl（非大脑局记录，如 e2e 演示/夹具）'; return base; }
  base.eligible = true;

  const rows: Row[] = rawTrace.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const initScreen = isScreen(header?.initialState?.world?.screen) ? header.initialState.world.screen : null;

  // ① 先把屏幕流与帧号收齐（帧号从屏幕自己读，不读内部状态）
  const tickOf = (s: string): number | null => observe(s).tick;
  let last: string | null = initScreen;
  const ticks: number[] = [];
  if (initScreen !== null) { const t = tickOf(initScreen); if (t !== null) ticks.push(t); }
  // 锚点只有一个：本行**之前**最后出现的那帧屏幕。
  // 为什么没有"动作后"这一档：thought 永远排在它对应的动作之前，agent 说话时
  // 那一步还没发生——给它配一个"之后的屏幕"，等于替它编造没看见过的画面。
  const beforeScreen: (string | null)[] = [];
  for (const r of rows) {
    beforeScreen.push(last);
    if (isScreen(r.result?.output)) {
      last = r.result!.output!;
      const t = tickOf(last);
      if (t !== null) ticks.push(t);
    }
  }
  let mono = true;
  for (let i = 1; i < ticks.length; i++) if (ticks[i]! < ticks[i - 1]!) mono = false;
  base.align = {
    screens: ticks.length, ticksMonotone: mono,
    firstTick: ticks.length ? ticks[0]! : null,
    lastTick: ticks.length ? ticks.at(-1)! : null,
    // world.jsonl 只作为交叉参考信息；对账的锚点自检只用屏幕自己的帧号
    worldRows: (() => {
      const w = optional(dir, 'world.jsonl');
      return w === null ? null : w.trim().split('\n').filter(Boolean).length;
    })(),
  };
  // 锚点自检：帧号必须单调，且第 0 帧就是首屏。做不到就说明 trace 与屏幕流对不齐，
  // 此时**任何**判决都不可信——整局作废，而不是悄悄出一个错位的相符率。
  base.usable = mono && base.align.firstTick === 0;

  const obsCache = new Map<string, Observation>();
  const obsOf = (s: string | null): Observation | null => {
    if (s === null) return null;
    let o = obsCache.get(s);
    if (o === undefined) { o = observe(s); obsCache.set(s, o); }
    return o;
  };

  const pairs: { claim: Claim; obs: Observation | null }[] = [];
  const anchors: { row: number; obs: Observation | null; screen: string | null }[] = [];
  const excluded: Record<string, number> = {};
  for (const rule of EXCLUDED_RULES) excluded[rule.name] = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.index === undefined || !r.decision?.thought) {
      base.skippedRows++;   // 非决策行（brain_retry 等）——计数，不静默
      continue;
    }
    const text = r.decision.thought;
    base.thoughtRows++;
    const claims = extractClaims(text);
    const screen = beforeScreen[i] ?? null;
    const obs = obsOf(screen);
    for (const c of claims) {
      pairs.push({ claim: c, obs });
      anchors.push({ row: i, obs, screen });   // 与 pairs 同序：judgeAll 按输入顺序返回
    }
    for (const e of countExcluded(text)) excluded[e.name] = (excluded[e.name] ?? 0) + e.n;
  }

  const { judged, counts, byKind } = judgeAll(pairs);
  base.claims = judged.length;
  base.counts = counts;
  base.byKind = byKind;
  base.excluded = excluded;
  base.judged = judged.map((j, k) => ({
    ...j,
    row: anchors[k]!.row,
    tick: anchors[k]!.obs?.tick ?? null,
    screenSha: anchors[k]!.screen === null ? null : sha12(anchors[k]!.screen!),
    // 从句原文：人工复核不必回去翻 trace（台账：报告里的每条矛盾都要能被独立读懂）
    clause: clauseFor(rows[anchors[k]!.row]!.decision!.thought!, j),
  }));
  return base;
}

// ─────────────────────────── 主流程 ───────────────────────────

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const onlyIdx = argv.indexOf('--run');
if (argv.includes('--help')) {
  console.log('用法: node verify/recon.ts [--run <runDir>] [--dry]\n' +
    '对已发布 runs/ 做「自述 vs 屏幕」对账；判据见 src/world/reconcile.ts（版本 ' + RECON_VERSION + '）。');
  process.exit(0);
}
const drift = reconDrift();
if (drift) { console.error(`[判据漂移] ${drift}\n  对账标准被改过但没升版本：本轮全部数字作废。`); process.exit(1); }

const dirs = onlyIdx >= 0
  ? [argv[onlyIdx + 1]!.startsWith('/') ? argv[onlyIdx + 1]! : resolve(join(ROOT, argv[onlyIdx + 1]!))]
  : walk(RUNS);

const results: RunResult[] = [];
const explicit = onlyIdx >= 0;
for (const d of dirs) results.push(reconcileRun(d, explicit));

const eligible = results.filter((r) => r.eligible);
const usable = eligible.filter((r) => r.usable);
const skipped = results.filter((r) => !r.eligible);
const broken = eligible.filter((r) => !r.usable);

console.log(`\n===== M4-d 主客观对账（判据 ${RECON_VERSION}，sha=${reconSha().slice(0, 12)}…）=====`);
console.log(`扫描 run 目录 ${results.length}：真大脑 ${eligible.length}｜假大脑/剧本 ${skipped.length}｜锚点自检不过 ${broken.length}`);
if (skipped.length) console.log(`  跳过理由（同一句反复说清）：${[...new Set(skipped.map((r) => r.skipWhy))].join('；')}`);
for (const b of broken) console.log(`  [对账不可用] ${b.dir}：帧号单调=${b.align.ticksMonotone} 首帧=${b.align.firstTick} 屏数=${b.align.screens} world行数=${b.align.worldRows}`);

if (usable.length === 0) {
  console.error('\n零样本：没有任何一局通过锚点自检。这不是"没有矛盾"，是"根本没测"（台账 #22）。');
  process.exit(1);
}

// 总计
const total = zeroCounts();
const totalKind = zeroByKind();
const totalExcluded: Record<string, number> = {};
let claimRows = 0, thoughtRows = 0, skippedRows = 0;
for (const r of usable) {
  for (const v of VERDICTS) total[v] += r.counts[v];
  for (const k of KINDS) for (const v of VERDICTS) totalKind[k][v] += r.byKind[k][v];
  for (const [n, x] of Object.entries(r.excluded)) totalExcluded[n] = (totalExcluded[n] ?? 0) + x;
  claimRows += r.claims; thoughtRows += r.thoughtRows; skippedRows += r.skippedRows;
}
const sum = VERDICTS.reduce((s, v) => s + total[v], 0);
if (sum !== claimRows) { console.error(`[恒等式断裂] 四桶之和 ${sum} ≠ 主张总数 ${claimRows}`); process.exit(1); }

const pct = (a: number, b: number) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`);
console.log(`\n判据本体：规则 ${RULES.length} 条｜类别 ${KINDS.length} 类｜排除表 ${EXCLUDED_RULES.length} 条`);
console.log(`参与对账：局 ${usable.length}｜有 thought 的决策行 ${thoughtRows}｜跳过的非决策行 ${skippedRows}｜主张 ${claimRows} 条`);

console.log(`\n── 类别 × 四桶（每行自成一个分母，绝不相乘）──`);
console.log('类别            主张   相符   矛盾   存疑  无法核对   无约定歧义档相符率  矛盾率');
for (const k of KINDS) {
  const c = totalKind[k];
  const n = VERDICTS.reduce((s, v) => s + c[v], 0);
  // 「无约定歧义档」= 相符+矛盾（排除约定存疑与无法核对）：只有这一档能出率
  const rate = n === 0 ? '—' : pct(c['相符'], c['相符'] + c['矛盾']);
  const crate = n === 0 ? '—' : pct(c['矛盾'], c['相符'] + c['矛盾']);
  console.log(k.padEnd(14), String(n).padStart(5), String(c['相符']).padStart(6), String(c['矛盾']).padStart(6),
    String(c['约定存疑']).padStart(6), String(c['无法核对']).padStart(8), String(rate).padStart(16), String(crate).padStart(10));
}
console.log(`\n合计 主张 ${claimRows}：相符 ${total['相符']}(${pct(total['相符'], claimRows)})｜矛盾 ${total['矛盾']}(${pct(total['矛盾'], claimRows)})｜` +
  `约定存疑 ${total['约定存疑']}(${pct(total['约定存疑'], claimRows)})｜无法核对 ${total['无法核对']}(${pct(total['无法核对'], claimRows)})`);
console.log(`恒等式 ${total['相符']}+${total['矛盾']}+${total['约定存疑']}+${total['无法核对']}=${sum}=主张总数 ✅`);

console.log(`\n── 判据未纳入的自述形状（不判，只报数量，免得读者以为它们不存在）──`);
for (const r of EXCLUDED_RULES) console.log(`  ${r.name}：${totalExcluded[r.name] ?? 0} 处｜不纳入理由：${r.why}`);

// 逐局落盘
const payload = (r: RunResult) => ({
  recon: reconStamp(),
  run: r.dir,
  brain: r.brain,
  align: r.align,
  usable: r.usable,
  thoughtRows: r.thoughtRows,
  skippedRows: r.skippedRows,
  claims: r.claims,
  counts: r.counts,
  byKind: r.byKind,
  excluded: r.excluded,
  // 逐条：局内第几行、命中片段、依据屏幕的帧号、判决与理由
  detail: r.judged.map((j, i) => ({ i, ...j })),
});

if (!dry) {
  for (const r of usable) writeFileSync(join(RUNS, r.dir, 'reconciliation.json'), JSON.stringify(payload(r), null, 1) + '\n');
  const outDir = join(RUNS, 'm4d-recon');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
    recon: reconStamp(),
    scanned: results.length, eligible: eligible.length, usable: usable.length,
    unusable: broken.map((b) => b.dir), skippedFixtures: skipped.map((s) => s.dir),
    thoughtRows, skippedRows, claims: claimRows, counts: total, byKind: totalKind, excluded: totalExcluded,
    perRun: usable.map((r) => ({ run: r.dir, claims: r.claims, ...r.counts, excluded: r.excluded })),
  }, null, 1) + '\n');
  console.log(`\n落盘：${usable.length} 份 runs/<局>/reconciliation.json ＋ runs/m4d-recon/summary.json`);
}

// 每条矛盾都要能被人工复核：打印前 N 条最"硬"的（HUD 类，无约定歧义）
const hard = usable.flatMap((r) => r.judged.filter((j) => j.verdict === '矛盾').map((j) => ({ run: r.dir, j })));
console.log(`\n── 矛盾明细抽样（最多 12 条，全部 ${hard.length} 条见 reconciliation.json）──`);
for (const h of hard.slice(0, 12)) {
  console.log(`  [${h.run.slice(0, 34)}] ${h.j.kind}/${h.j.rule}：${JSON.stringify(h.j.quote)} ${h.j.value.length ? JSON.stringify(h.j.value) + ' ' : ''}${h.j.why}`);
}
process.exit(0);
