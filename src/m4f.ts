#!/usr/bin/env node
/**
 * M4-f 缺陷版靶场运行器。三臂，各自回答一个不同的问题。
 *
 *   --policy random    零 key、零大脑。随机策略在**缺陷版**上跑大批量，
 *                      量的是这件事的上限：**不加任何智能，缺陷有机会在画面上露脸吗？**
 *                      这一臂必须在真模型之前跑完并把表落盘——那才是"预登记"：
 *                      先声明每个变异体的可达上限，再拿模型成绩去比，
 *                      事后按结果挑"哪些变异体本来就不该算"就没有余地了。
 *
 *   --policy model     真模型臂：同一个变异体，目标通道开/关各跑若干局。
 *                      这是本轮唯一能出**检出率**的一臂。
 *
 * ⚠️ 本文件**不出汇总表**。汇总只有一个主人：verify/detect-audit.ts，
 *    它独立重放、独立判决，与运行器不同源——运行器和判决器共用一份判据等于没有复核。
 *    曾在这里写过第三个 --summarize 模式并印在帮助里，但 mainAsync 从不分派给它，
 *    于是帮助承诺了一条不存在的路径（故障 #15 的同族：判据说了却没接线）。已删。
 *
 * 三条硬纪律（前几轮的坑换来的，别再犯）：
 *  1. **一局失败不许带走整批。** 429 打断过整批的教训在 M4-e：arena 模式没走到 finish 退 2，
 *     用 && 串起来第一条失败后面全没跑。这里每局独立 try/catch，失败单列计数并**照样进报告**。
 *  2. **随机策略对世界无反应**，所以"参考版与缺陷版跑同一条序列"成立；真模型是**反应式**的，
 *     它只活在缺陷版里，参考版那一侧只是反事实重放。两种"同序列"含义不同，注释里必须写清，
 *     否则会把随机臂的可见率直接当成模型臂的分母（那是两个不同的世界线）。
 *  3. 变异体 id、被删能力、词表只在**局末判决**时用。判决代码绝不进契约、不进工具返回。
 *     这条由 verify/detect-audit.ts 的泄漏审计核，不靠这里自觉。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomActions, type Action } from './world/arena.ts';
import { ALL_MUTANTS, ALL_SOUND, findMutant } from './world/mutants.ts';
import { detectOne, type Detection } from './world/detect.ts';
import { runDifferential } from './notary/diff.ts';
import { minimize } from './notary/ddmin.ts';
import { createBrain, loadEnv, type BrainKind } from './brain/index.ts';
import { runArena, ARENA_TASK } from './world/harness.ts';
import { wilson, quantile } from './stats.ts';
import type { HarnessConfig } from './types.ts';

const ROOT = resolve(import.meta.dirname, '..');
const log = (l: string): void => void process.stderr.write(`${l}\n`);

interface Args { [k: string]: string | boolean }

function parseArgv(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
function num(v: string | boolean | undefined, d: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}
function list<T extends string>(v: string | boolean | undefined, dflt: T[], valid: readonly string[]): T[] {
  if (typeof v !== 'string' || v.trim() === '' || v === 'all') return dflt;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !valid.includes(p));
  // 参数写错却照样出表 = 故障 #17 那一族。这里直接拒绝，不静默降级成默认值。
  if (bad.length) throw new Error(`无法识别的取值：${bad.join(', ')}（可用：${valid.join(', ')}）`);
  return parts as T[];
}
function nums(v: string | boolean | undefined, dflt: number[]): number[] {
  if (typeof v !== 'string' || v.trim() === '') return dflt;
  const out = v.split(',').map((s) => Number(s.trim()));
  if (out.some((n) => !Number.isFinite(n) || n < 1)) throw new Error(`数字列表解析失败："${v}"`);
  return out;
}

function usage(): void {
  log(`
M4-f 缺陷版靶场

用法:
  node src/m4f.ts --policy random [--seeds 6,7,8,42] [--budgets 25,120] [--reps 50]
                  [--mutants all|M01,M07] [--dd-per-mutant 3] [--out runs/m4f-ceiling]

  node src/m4f.ts --policy model --mutants M01,M02 [--arms on,off] [--reps 1] [--seed 6]
                  [--max-steps 25] [--brain openai] [--sound-mutants R0,S10] [--out runs/m4f-model]

汇总不在这里：跑完后用
  node verify/detect-audit.ts $(cat 那些 runDir) [--ceiling runs/m4f-ceiling]
它独立重放、独立判决，才算复核（运行器和判决器共用一份判据等于没有复核）。

两臂：
  random    零 key 上限表（可见分叉率／前提达成率／结构性不可见数），**跑真模型前先出这张表**
  model     真模型缺陷臂：变异体 × 目标开/关 × 重复局 —— **检出率只从这一臂的证据里算**

--sound-mutants（M4-c 下半，仅 model 臂）：给这一臂再加一维"装哪个发声装置"。
  默认只有 R0，也就是**不加这一项时跑的条件与已发布那批逐字节相同**。
  ⚠️ 它不改世界：S01..S10 下 world.jsonl 与 R0 完全一致，变的只有 sound.jsonl / ear.json。
     所以这一维量的是"耳朵能不能替眼睛兜住屏幕看不见的缺陷"，不是检出率的分母。
     发声侧的可达上限表在 src/m4c.ts（npm run verify:ear:ceiling），不在这里。
`);
}

// ─────────────────────────── 随机臂：可达上限 ───────────────────────────

export interface CeilingCase {
  mutant: string;
  seed: number;
  salt: number;
  budget: number;
  /** L1：屏幕上露过脸吗 */
  visible: boolean;
  /** 首次可见分叉出现在第几帧（null=从没出现） */
  firstVisibleStep: number | null;
  /** 公证器口径（内部状态哈希）分叉吗 */
  internal: boolean;
  /** 内部分了叉、屏幕却没变 = 这套视网膜下的结构性不可见 */
  invisibleThoughDiverged: boolean;
  /** L2：玩家侧前提达成（按各能力该读的那一版） */
  playerPremise: boolean;
  preconditions: { cap: string; side: string; reached: boolean }[];
  /** 最小复现步数（只在抽样做 ddmin 时有值） */
  minimizedSteps: number | null;
  oneMinimal: boolean | null;
}

/**
 * 一条随机轨迹的判决。
 *
 * 注意 claims 传的是**空**：随机臂没有大脑，L3/L4 天然不存在。
 * 这一臂只出 L1/L2 的数，任何"随机策略检出了几个缺陷"的说法都是把空集读成了成绩。
 */
export async function ceilingCase(
  mutantId: string, worldSeed: number, salt: number, budget: number, doDd: boolean,
): Promise<CeilingCase> {
  const m = findMutant(mutantId);
  const actions = randomActions(worldSeed, salt, budget) as Action[];
  const diff = runDifferential(worldSeed, actions, m.caps, { runToEnd: true, verifyDeterminism: false });
  const d: Detection = await detectOne({
    seed: worldSeed,
    actions,
    mutant: mutantId,
    claims: { finishSummary: null, notes: [], hypotheses: [] },
    internal: { diverged: diff.diverged, firstStep: diff.first?.step ?? null },
  });
  let minimizedSteps: number | null = null;
  let oneMinimal: boolean | null = null;
  if (doDd && d.visible.diverged) {
    const r = minimize(worldSeed, actions, m.caps, { maxTests: 400 });
    // 独立复核：不信 ddmin 自述，重跑一遍差分
    if (runDifferential(worldSeed, r.minimized, m.caps, { runToEnd: false, verifyDeterminism: false }).diverged) {
      minimizedSteps = r.minimized.length;
      oneMinimal = r.oneMinimal;
    }
  }
  return {
    mutant: mutantId,
    seed: worldSeed,
    salt,
    budget,
    visible: d.visible.diverged,
    firstVisibleStep: d.visible.firstStep,
    internal: d.internal.diverged,
    invisibleThoughDiverged: d.invisibleThoughDiverged,
    playerPremise: d.playerPremise,
    preconditions: d.preconditions.map((p) => ({ cap: p.cap, side: p.side, reached: p.reached })),
    minimizedSteps,
    oneMinimal,
  };
}

interface CeilingAgg {
  mutant: string;
  removed: string[];
  cases: number;
  visible: number;
  internal: number;
  invisibleThoughDiverged: number;
  playerPremise: number;
  firstSteps: number[];
  dd: { n: number; min: number; max: number; mean: number; oneMinimal: number };
}

function aggregateCeiling(rows: CeilingCase[]): CeilingAgg[] {
  const by = new Map<string, CeilingCase[]>();
  for (const r of rows) {
    if (!by.has(r.mutant)) by.set(r.mutant, []);
    by.get(r.mutant)!.push(r);
  }
  return [...by.entries()].sort().map(([id, rs]) => {
    const dd = rs.map((r) => r.minimizedSteps).filter((n): n is number => n !== null);
    return {
      mutant: id,
      removed: findMutant(id).removed,
      cases: rs.length,
      visible: rs.filter((r) => r.visible).length,
      internal: rs.filter((r) => r.internal).length,
      invisibleThoughDiverged: rs.filter((r) => r.invisibleThoughDiverged).length,
      playerPremise: rs.filter((r) => r.playerPremise).length,
      firstSteps: rs.map((r) => r.firstVisibleStep).filter((n): n is number => n !== null),
      dd: {
        n: dd.length,
        min: dd.length ? Math.min(...dd) : NaN,
        max: dd.length ? Math.max(...dd) : NaN,
        mean: dd.length ? dd.reduce((a, b) => a + b, 0) / dd.length : NaN,
        oneMinimal: rs.filter((r) => r.oneMinimal === true).length,
      },
    };
  });
}


async function armRandom(args: Args): Promise<number> {
  const seeds = nums(args['seeds'], [6, 7, 8, 42]);
  const budgets = nums(args['budgets'], [25, 120]);
  const reps = num(args['reps'], 50);
  const ids = list(args['mutants'], ALL_MUTANTS.map((m) => m.id), ALL_MUTANTS.map((m) => m.id));
  const ddPer = num(args['dd-per-mutant'], 3);
  const outDir = resolve(typeof args['out'] === 'string' ? args['out'] : join(ROOT, 'runs', 'm4f-ceiling'));
  mkdirSync(outDir, { recursive: true });

  log(`M4-f 随机上限臂｜变异体=${ids.length} 世界seed=${seeds.length} 步预算=${budgets.join('/')} 每格重复=${reps}`);
  log('这一臂没有大脑：只出 L1 可见分叉率与 L2 前提达成率，出不了检出率。');
  log('');

  const rows: CeilingCase[] = [];
  let ddLeft = new Map<string, number>();
  for (const id of ids) ddLeft.set(id, ddPer);
  const t0 = Date.now();
  for (const id of ids) {
    for (const budget of budgets) {
      for (const seed of seeds) {
        for (let salt = 0; salt < reps; salt++) {
          const left = ddLeft.get(id) ?? 0;
          const doDd = left > 0;
          if (doDd) ddLeft.set(id, left - 1);
          rows.push(await ceilingCase(id, seed, salt, budget, doDd));
        }
      }
    }
  }
  const perBudget = new Map<number, CeilingCase[]>();
  for (const r of rows) {
    if (!perBudget.has(r.budget)) perBudget.set(r.budget, []);
    perBudget.get(r.budget)!.push(r);
  }

  writeFileSync(join(outDir, 'ceiling_cases.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  for (const [budget, sub] of [...perBudget.entries()].sort((a, b) => a[0] - b[0])) {
    log(`── 步预算 ${budget} ──`);
    log('id    被删能力                     局数  屏幕可见分叉            前提达成            内部分叉但屏幕没变  首可见分叉帧(中位/q90)  最小复现步数');
    for (const a of aggregateCeiling(sub)) {
      const [lo, hi] = wilson(a.visible, a.cases);
      const p = quantile(a.firstSteps, 0.5);
      const p90 = quantile(a.firstSteps, 0.9);
      log(
        `${a.mutant.padEnd(5)} ${a.removed.join('+').padEnd(26)} ${String(a.cases).padStart(4)}  ` +
        `${String(a.visible).padStart(4)}/${a.cases}=${(100 * a.visible / a.cases).toFixed(1)}% [${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]  ` +
        `${String(a.playerPremise).padStart(4)}/${a.cases}=${(100 * a.playerPremise / a.cases).toFixed(1)}%  ` +
        `${String(a.invisibleThoughDiverged).padStart(3)}  ` +
        `${p === null ? '—' : `${p}/${p90 ?? '—'}`.padEnd(18)}  ` +
        `${a.dd.n === 0 ? '未抽样' : `n=${a.dd.n} min=${a.dd.min} 均=${a.dd.mean.toFixed(1)} 1-min=${a.dd.oneMinimal}`}`,
      );
    }
    log('');
  }

  // 这一条是本轮最可能被拿来指控我的话：内部分叉 ≠ 可见分叉，差多少必须自己先说出来
  const totalInternal = rows.filter((r) => r.internal).length;
  const totalVisible = rows.filter((r) => r.visible).length;
  const invisible = rows.filter((r) => r.invisibleThoughDiverged).length;
  log(`汇总：${rows.length} 例，用时 ${Date.now() - t0}ms。公证器口径分叉 ${totalInternal} 例，其中屏幕从没变过的 ${invisible} 例（${(100 * invisible / Math.max(1, totalInternal)).toFixed(1)}%）。`);
  log(`屏幕可见分叉合计 ${totalVisible}/${rows.length}。可见率就是**任何**试玩策略的检出上限：`);
  log('分母用"可见"而不用"全部"，因为拿一条画面从没不同的轨迹去考 agent，考的是运气不是能力。');
  writeFileSync(join(outDir, 'ceiling_summary.json'), JSON.stringify({
    judgement: rows.length ? 'm4f-1' : 'n/a',
    seeds, budgets, reps, totalCases: rows.length, totalInternal, totalVisible, invisible,
    perBudget: [...perBudget.entries()].map(([b, sub]) => ({ budget: b, agg: aggregateCeiling(sub) })),
  }, null, 2) + '\n');
  log(`证据落盘：${outDir}/ceiling_cases.jsonl｜ceiling_summary.json`);
  return 0;
}

// ─────────────────────────── 真模型臂 ───────────────────────────

function baseConfig(args: Args, outDir: string, seed: number): HarnessConfig {
  return {
    // 零说明书任务是 runArena 的输入之一，从 harness.ts 取同一个常量，
    // 绝不在这里另写一句"提示词"——改任务文本就等于改实验条件。
    task: ARENA_TASK,
    sandbox: join(ROOT, 'sandbox'),
    seed,
    maxSteps: num(args['max-steps'], 25),
    maxWallMs: num(args['max-wall-ms'], 300_000),
    maxContextChars: num(args['max-context-chars'], 12_000),
    keepRecent: num(args['keep-recent'], 8),
    maxParseRetry: num(args['max-parse-retry'], 2),
    repeatLimit: num(args['repeat-limit'], 3),
    outDir,
  };
}

interface ModelRunRow {
  mutant: string | null;
  /** 发声装置 id（'R0' = 参考版发声）。M4-c 下半：屏幕那侧的缺陷臂与耳朵那侧的装置是**两套独立条件** */
  sound: string;
  arm: 'on' | 'off' | 'ref';
  rep: number;
  seed: number;
  ok: boolean;
  runDir: string | null;
  error: string | null;
  verdict: string | null;
  visible: boolean | null;
  playerPremise: boolean | null;
  whyNot: string | null;
  steps: number | null;
  /** 局末眼耳对账五桶（没装耳朵/没跑出判决则 null） */
  ear: Record<string, number> | null;
}

async function armModel(args: Args): Promise<number> {
  loadEnv(join(ROOT, '.env'));
  const kind = (typeof args['brain'] === 'string' ? args['brain'] : 'openai') as BrainKind;
  const ids = list(args['mutants'], ['M01', 'M02', 'M03', 'M07'], ALL_MUTANTS.map((m) => m.id));
  // 默认只有 R0：这一项不加进来时，本臂跑的条件与已发布那批**逐字节相同**。
  // 它是"再加一维"的把手，不是一个默认就换掉实验条件的开关。
  const sounds = list(args['sound-mutants'], ['R0'] as string[], ALL_SOUND.map((m) => m.id));
  const arms = list(args['arms'], ['on', 'off'] as ('on' | 'off')[], ['on', 'off']);
  const reps = num(args['reps'], 1);
  const seeds = nums(args['seed'], [6]);
  const withControl = args['control'] === true;
  const outDir = resolve(typeof args['out'] === 'string' ? args['out'] : join(ROOT, 'runs', 'm4f-model'));
  mkdirSync(outDir, { recursive: true });

  const brain = createBrain(kind);
  log(`M4-f 真模型臂｜brain=${brain.id} 变异体=${ids.join(',')} 发声装置=${sounds.join(',')} 档位=${arms.join('/')} 每格=${reps} 局 世界seed=${seeds.join(',')}`);
  log('每局独立捕获异常：429 打断只作废这一局，绝不带走整批（M4-e 的教训）。');

  const rows: ModelRunRow[] = [];
  const plan: { mutant: string | null; sound: string; arm: 'on' | 'off' | 'ref' }[] = [];
  for (const arm of arms) for (const id of ids) for (const s of sounds) plan.push({ mutant: id, sound: s, arm });
  if (withControl) for (const arm of arms) for (const s of sounds) plan.push({ mutant: null, sound: s, arm });

  for (const p of plan) {
    for (const seed of seeds) {
      for (let rep = 1; rep <= reps; rep++) {
        const tag = p.mutant ?? 'control';
        // 只在真装了非参考版装置时才改目录名：已发布那批的路径形状（<id>/<arm>/<时间戳>）不许动
        const sfx = p.sound === 'R0' ? '' : `-${p.sound}`;
        const dir = join(outDir, `${tag}${sfx}-${p.arm}`);
        const label = `${tag}${sfx}/${p.arm}/seed${seed}/rep${rep}`;
        try {
          const r = await runArena({
            brain,
            seed,
            mutant: p.mutant,
            soundMutant: p.sound,
            config: baseConfig(args, dir, seed),
            doGoal: p.arm === 'on',
            log: (l) => log(`  ${label} ${l}`),
          });
          // 判决的输入**全部从落盘证据里读**，不从内存对象拿：
          // 尤其是被判决的那些文本——它必须与磁盘上那份一字不差，
          // 否则"我判的"和"你能复核的"就不是同一样东西（故障 #14：两个通道不许各信一份）。
          const defect = await readDefect(r.files.defect);
          const d = await detectOne({
            seed,
            actions: defect.fullWorldActions,
            mutant: p.mutant,
            claims: defect.agentClaims,
            internal: { diverged: r.notary.diverged, firstStep: r.notary.firstStep },
          });
          rows.push({
            mutant: p.mutant, sound: p.sound, arm: p.mutant ? p.arm : 'ref', rep, seed, ok: true,
            runDir: r.run.runDir, error: null,
            verdict: d.verdict, visible: d.visible.diverged, playerPremise: d.playerPremise,
            whyNot: d.whyNot, steps: r.run.steps.length,
            ear: r.ear ? r.ear.counts : null,
          });
          log(`  ${label} → 判决=${d.verdict} 可见=${d.visible.diverged} 前提=${d.playerPremise} 失败层=${d.whyNot ?? '—'} 步=${r.run.steps.length}`
            + `｜眼耳对账=${r.ear ? `${r.ear.counts['相符']}/${r.ear.counts['矛盾']}/${r.ear.counts['时钟错位']}/${r.ear.counts['无法核对']}/${r.ear.counts['容量差']}` : '（无耳朵）'}`);
        } catch (e) {
          const msg = (e as Error).message.slice(0, 160);
          rows.push({ mutant: p.mutant, sound: p.sound, arm: p.mutant ? p.arm : 'ref', rep, seed, ok: false, runDir: null, error: msg, verdict: null, visible: null, playerPremise: null, whyNot: null, steps: null, ear: null });
          log(`  ${label} ❌ 失败：${msg}（这一局作废，继续下一局）`);
        }
      }
    }
  }

  writeFileSync(join(outDir, 'model_runs.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const failed = rows.filter((r) => !r.ok).length;
  log(`\n完成 ${rows.length - failed}/${rows.length} 局（失败 ${failed} 局，逐局原因在 ${outDir}/model_runs.jsonl）。`);
  log('检出率不在这里出——汇总由 verify/detect-audit.ts 独立重算：'
    + `node verify/detect-audit.ts ${outDir}/*/*/ --ceiling runs/m4f-ceiling`);
  // 有失败就退非零：否则"批跑绿了"会被读成"全都跑完了"，那是 M4-e 踩过的坑
  return failed > 0 ? 3 : 0;
}

/**
 * 只读证据文件，取判决要用的两样东西：纯世界动作序列 + agent 主观文本。
 * 读不到就抛，绝不返回空数组冒充"这局什么都没报"——那会把缺证据变成阴性结果。
 */
async function readDefect(path: string): Promise<{
  fullWorldActions: Action[];
  agentClaims: { finishSummary: string | null; notes: string[]; hypotheses: { text: string }[] };
}> {
  const { readFileSync } = await import('node:fs');
  const d = JSON.parse(readFileSync(path, 'utf8')) as {
    fullWorldActions: Action[];
    agentClaims: { finishSummary: string | null; notes: string[]; hypotheses: { text: string }[] };
  };
  if (!Array.isArray(d.fullWorldActions) || !d.agentClaims) {
    throw new Error(`${path} 里没有 fullWorldActions / agentClaims——判决缺输入，拒绝出数`);
  }
  return { fullWorldActions: d.fullWorldActions, agentClaims: d.agentClaims };
}

async function mainAsync(args: Args): Promise<number> {
  const policy = typeof args['policy'] === 'string' ? args['policy'] : null;
  if (policy === 'random') return armRandom(args);
  if (policy === 'model') return armModel(args);
  usage();
  log('错误：必须给 --policy random|model（汇总走 verify/detect-audit.ts）。');
  return 1;
}

function main(): void {
  const args = parseArgv(process.argv.slice(2));
  if (args['help'] || args['h']) { usage(); process.exit(0); }
  mainAsync(args)
    .then((c) => process.exit(c))
    .catch((e) => {
      log(`[fatal] ${(e as Error).message}`);
      process.exit(1);
    });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
