/**
 * arena 运行器：M1（眼睛和手）+ M3（差分公证器）的合流点。
 *
 * 这是 6-C 要求的完整链路：
 *   agent 自主玩 → 代码抽出纯动作序列 → 公证器客观判定分叉 → ddmin 最小化 → 可重放证据
 *
 * 评估诚实性的关键设计：**主观与客观分开记，绝不混为一谈**。
 *   - agentClaims：agent 自己说的（finish 结论 + 假设板）。它可能说错、可能什么都没发现。
 *   - notary：代码算出来的客观分叉。它不看 agent 说了什么，也不告诉 agent 缺陷在哪。
 * 两者一致才算"agent 真发现了缺陷"；只有 notary 分叉而 agent 没提，那是"走过了但没看懂"。
 * 把这两种情况分开统计，评测才有意义。
 *
 * 另一条纪律：agent 全程不知道自己在玩变异版，也不知道变异体 id。
 * 任务文本只给目标，不给策略，更不给答案。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHarness } from '../loop.ts';
import { minimize } from '../notary/ddmin.ts';
import { runDifferential } from '../notary/diff.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { gameTools, isWorldTool, toWorldActions } from '../tools/game.ts';
import type { Brain, GoalSeam, HarnessConfig, PredictionSeam, RunResult } from '../types.ts';
import { ALL_CAPS, type Action } from './arena.ts';
import { findMutant } from './mutants.ts';
import { detectOne, judgeStamp, type Detection } from './detect.ts';
import { GOAL_SEAM } from './goal.ts';
import { PREDICT_SPEC, checkPrediction, describeCheck } from './predict.ts';
import { GameSession, type Coverage } from './session.ts';

/** 零说明书任务：只给目标，不给策略，不给答案。 */
export const ARENA_TASK =
  '你在玩一个陌生的小游戏，没有说明书。自己玩、自己摸清规则。' +
  '如果你发现任何不正常或不合理的地方，给出结论和依据。';

export interface ArenaRunOptions {
  brain: Brain;
  seed: number;
  /** 变异体 id；null / 省略 = 参考版（对照组） */
  mutant?: string | null;
  config: HarnessConfig;
  log?: (line: string) => void;
  /** 是否对分叉做 ddmin 最小化。默认 true */
  doMinimize?: boolean;
  ddMaxTests?: number;
  /**
   * 是否启用预测-对照（M4）。默认 true。
   * 留这个开关是为了**可比性**：关掉它就退回 M1 的契约条件，
   * 消融对照（M4-e）和复现 M1 那四局都需要一个"没有预测字段"的对照组。
   */
  doPredict?: boolean;
  /**
   * 是否启用目标通道（M4-b2）。默认 true。
   * 与 doPredict 同一条理由：**接口给了不等于模型会用，但给了就必须能证明它给了**。
   * 关掉它 → goal 工具不注册、契约里不出现、产物里没有 goal_* 事件，
   * 消融对照（M4-e）才有一个"没有目标导向意图"的真对照组。
   */
  doGoal?: boolean;
}

export interface NotaryVerdict {
  mutant: string | null;
  /** 公证器客观判定：同一动作序列下参考版与变异版是否分叉 */
  diverged: boolean;
  firstStep: number | null;
  firstFields: string[];
  masked: boolean;
  divergedFrames: number;
  /** 最小化后的可重放序列（未分叉则为 null） */
  minimized: {
    actions: Action[];
    originalLength: number;
    tests: number;
    oneMinimal: boolean;
    budgetExhausted: boolean;
    /** 独立复核：最小化后重新跑差分，仍分叉才算数 */
    reverified: boolean;
  } | null;
}

export interface ArenaRunResult {
  run: RunResult;
  coverage: Coverage;
  /** 初始世界哈希：重放三要素之一，必须能直接打印/比对 */
  initialHash: string;
  /** agent 主观陈述。与 notary 客观判定分开，不可互相替代 */
  agentClaims: {
    finishSummary: string | null;
    notes: string[];
    /**
     * 结构化假设的**主观部分**：id / 正文 / 状态 / 理由。
     * 刻意不含核对计数——那是代码数出来的客观量，混进来就没法对账了。
     */
    hypotheses: { id: string; text: string; status: string; statusWhy: string }[];
    /** 目标的主观声明（M4-b2）：正文 / 完成条件 / 状态 / 理由。判定计数在 goalChecks 那侧 */
    goals: { id: string; text: string; doneWhen: Record<string, unknown> | null; status: string; statusWhy: string }[];
  };
  notary: NotaryVerdict;
  /**
   * M4-f 检出判决漏斗（可见分叉 / 玩家侧前提 / 主观上报与归因）。
   * 与 notary 并列但**不是同一个东西**：notary 只答"这条序列在两个版本里分叉了吗"，
   * detection 才答"agent 有没有看见、有没有报、报得对不对"。
   */
  detection: Detection;
  /** 判决器重放的缺陷版覆盖 vs agent 真玩的 session 覆盖，必须逐字段相同 */
  replayMatchesLiveSession: boolean;
  /** 证据一致性：session 实际执行的动作 vs 从 trace 抽出的动作，必须逐位相同 */
  evidenceConsistent: boolean;
  worldActions: number;
  files: { world: string; coverage: string; defect: string; detection: string };
}

export async function runArena(opts: ArenaRunOptions): Promise<ArenaRunResult> {
  const mutantId = opts.mutant ?? null;
  const caps = mutantId ? findMutant(mutantId).caps : ALL_CAPS;
  const session = new GameSession(opts.seed, caps);
  const log = opts.log ?? (() => {});

  const registry = new ToolRegistry();
  for (const t of gameTools(session)) registry.register(t);

  const initialWorld = {
    kind: 'arena',
    seed: opts.seed,
    hash: session.initialHash(),
    screen: session.screen(),
    mutant: mutantId,
  };

  // ── 预测-对照接缝（M4）─────────────────────────────
  // 分工：模型预测 → **代码拿屏幕算 diff** → 模型判断是否意外。中间那步不能交给模型，
  // M1 实测它连续 4 次声称"我脚下有 +"，而客观账本 stoodOnPickup=false——自述会替自己圆场。
  const prediction: PredictionSeam | undefined = (opts.doPredict ?? true) ? {
    spec: PREDICT_SPEC,
    // 核对的前提是「这一步产生了可核对的画面事实」，**不是「画面必须推进」**。
    // 真跑 M08 那局换来的修正：agent 第一步 look 就断言自己在 [1,1]、2 个敌人，
    // 实际是 [0,0]、3 个——它最大的一次感知错误恰恰发生在不推进画面的步上。
    // 旧闸门把 look 整个排除，等于把最有价值的校准信号扔了。
    // 现在 look 也核对，但 advanced=false 会把这类步单独标出来，准确率可分开算，不灌水。
    // note / finish 仍不核对：那不是在断言世界，是在写记忆和收手。
    applies: (call, result) => (isWorldTool(call.name) || call.name === 'look') && result.ok,
    check: checkPrediction,
    describe: describeCheck,
  } : undefined;

  // ── 目标完成条件接缝（M4-b2）─────────────────────────
  // 分工：模型声明"要把局面制造成哪个状态" → **代码每步拿画面客观判定** → 模型决定收口。
  // 中间那步同样不能交给模型自述（"我达成了"不算数），但判据与假设不同：
  // 完成条件是画面上的**等值状态**，代码判得出；假设是规律，判不出。
  // 刻意**没有 applies**：目标断言的是状态，静止帧上"是不是 hp=0"同样是可核对的事实
  // （故障 #10：闸门按"有没有可核对的事实"划，不按"这步有没有动"划）。
  const goal: GoalSeam | undefined = (opts.doGoal ?? true) ? GOAL_SEAM : undefined;
  // 画面是这两条通道共同的输入。谁开着就得给谁——漏了另一个会静默降级成
  // "接缝存在但一步都没判过"，那是最难查的假阴性（故障 #8 的第三种形态）。
  const needScreen = prediction !== undefined || goal !== undefined;

  const run = await runHarness({
    brain: opts.brain,
    registry,
    config: opts.config,
    log,
    // M4-f：判决口径戳随 header.json 一起落盘，早于 agent 的第一步。
    // 世界层在这里组装戳（它才认识词表），循环层只负责抄——分工见 types.ts 的 JudgementStamp。
    judgement: judgeStamp(),
    worldHash: () => session.stateHash(),
    // 死循环判据用**不含 tick** 的局势指纹：帧哈希每帧都变，拿它判循环会永远判不出；
    // 只比动作签名又会把直线走图误判成循环（真跑三局全被砍在 7~12 步）。
    loopFingerprint: () => session.situationHash(),
    initialWorld,
    ...(needScreen ? { screen: () => session.screen() } : {}),
    ...(prediction ? { prediction } : {}),
    ...(goal ? { goal } : {}),
  });

  // ── 抽纯动作序列：look/note/finish 不推进时间，非法方向当时被拒，都要滤掉 ──
  const fromTrace = toWorldActions(run.actionSequence);
  const fromSession = session.actionSequence();
  const evidenceConsistent = JSON.stringify(fromTrace) === JSON.stringify(fromSession);
  if (!evidenceConsistent) {
    // 这不是小瑕疵：两份证物不一致意味着重放会错位，整个缺陷报告不可信
    log(`[evidence] 严重：trace 抽出 ${fromTrace.length} 个动作，session 实际执行 ${fromSession.length} 个，不一致`);
  }

  // ── 公证器客观判定。它不看 agent 说了什么，也不知道缺陷在哪 ──
  const diff = runDifferential(opts.seed, fromTrace, caps);
  let minimized: NotaryVerdict['minimized'] = null;
  if (diff.diverged && (opts.doMinimize ?? true)) {
    const m = minimize(opts.seed, fromTrace, caps, { maxTests: opts.ddMaxTests ?? 400 });
    // 独立复核：不信 minimize 自己的说法，重新跑一遍
    const reverified = runDifferential(opts.seed, m.minimized, caps).diverged;
    minimized = {
      actions: m.minimized,
      originalLength: m.originalLength,
      tests: m.tests,
      oneMinimal: m.oneMinimal,
      budgetExhausted: m.budgetExhausted,
      reverified,
    };
    log(`[notary] 分叉于第 ${diff.first!.step} 步，最小化 ${m.originalLength}→${m.minimized.length} 步，复核=${reverified}`);
  } else if (diff.diverged) {
    log(`[notary] 分叉于第 ${diff.first!.step} 步（未做最小化）`);
  } else {
    log(`[notary] 未分叉（${mutantId ? '变异体未被这条序列触达' : '参考版对照组，应当不分叉'}）`);
  }

  const notary: NotaryVerdict = {
    mutant: mutantId,
    diverged: diff.diverged,
    firstStep: diff.first?.step ?? null,
    firstFields: diff.first?.fields.map((f) => f.path) ?? [],
    masked: diff.masked,
    divergedFrames: diff.divergedSteps.length,
    minimized,
  };

  const coverage = session.coverage();
  const agentClaims = {
    finishSummary: run.finishSummary ?? null,
    notes: [...run.notes],
    hypotheses: run.hypotheses.map((h) => ({ id: h.id, text: h.text, status: h.status, statusWhy: h.statusWhy })),
    // 目标的主观侧：正文 + 完成条件 + 状态 + 理由。判定计数一律不抄过来，
    // 否则对账时两侧是同一份数据复读，"自称达成 vs 画面达成"就永远核不出矛盾。
    goals: run.goals.map((g) => ({
      id: g.id, text: g.text, doneWhen: g.doneWhen, status: g.status, statusWhy: g.statusWhy,
    })),
  };
  // 客观侧：只有 id 与计数。id 是连接两侧的唯一钥匙，正文与状态一律不抄过来。
  const hypothesisChecks = run.hypotheses.map((h) => ({
    id: h.id, checks: h.checks, supported: h.supported, contradicted: h.contradicted, unverifiable: h.unverifiable,
  }));
  const goalChecks = run.goals.map((g) => ({
    id: g.id, checks: g.checks, met: g.met, unmet: g.unmet, unverifiable: g.unverifiable,
    firstMetStep: g.firstMetStep, lastCheckedStep: g.lastCheckedStep,
  }));

  // ── M4-f 检出判决：可见分叉 / 玩家侧前提 / 主观上报与归因 ──
  // 判决发生在**局末**，输入是已落盘口径的动作序列与主观文本。
  // 变异体 id、被删能力、词表全部只在这里出现，一次都不进契约、不进工具返回。
  const detection = await detectOne({
    seed: opts.seed,
    actions: fromTrace,
    mutant: mutantId,
    claims: agentClaims,
    internal: { diverged: notary.diverged, firstStep: notary.firstStep },
  });
  // 顺带一条免费的一致性检查：判决器自己重放出来的缺陷版覆盖，
  // 必须与刚才 agent 真玩的那个 session 逐字段相同。不同＝重放错位，整个判决不可信。
  const replayMatchesLiveSession = JSON.stringify(detection.coverage.mutant) === JSON.stringify(coverage);
  const detectionPath = join(run.runDir, 'detection.json');
  writeFileSync(detectionPath, `${JSON.stringify({ ...detection, replayMatchesLiveSession }, null, 2)}\n`);
  log(
    `[检出判决] 屏幕可见分叉=${detection.visible.diverged ? `是（第 ${detection.visible.firstStep} 帧首见，共 ${detection.visible.frames} 帧）` : '否'}`
    + ` 玩家侧前提=${detection.playerPremise ? '达成' : '未达成'} 判决=${detection.verdict}`
    + ` 失败层=${detection.whyNot ?? '—'}`
    + `${replayMatchesLiveSession ? '' : ' ❌判决器重放与实玩 session 覆盖不一致——重放错位，本判决不可信'}`,
  );

  // ── 落盘：逐帧哈希 + 覆盖账本 + 缺陷报告 ──
  const worldPath = join(run.runDir, 'world.jsonl');
  writeFileSync(worldPath, session.frames().map((f) => JSON.stringify(f)).join('\n') + '\n');
  const coveragePath = join(run.runDir, 'coverage.json');
  writeFileSync(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`);
  const defectPath = join(run.runDir, 'defect.json');
  writeFileSync(defectPath, `${JSON.stringify({
    // 重放三要素：seed + initialState(在 header.json) + 动作序列
    seed: opts.seed,
    initialHash: session.initialHash(),
    mutant: mutantId,
    agentClaims,
    notary,
    evidenceConsistent,
    coverage,
    // 预测-对照账本：代码算的客观量，和 notary / coverage 同侧。
    // 刻意不放进 agentClaims——那是模型自述，两者混在一起就没法对账了。
    predictionStats: run.predictionStats ?? null,
    // 假设板账本：与 predictionStats / notary / coverage 同侧，都是代码数出来的。
    // 假设的正文与状态在 agentClaims.hypotheses 里，两侧靠 id 对账。
    hypothesisChecks,
    hypothesisStats: run.hypothesisStats,
    // 目标通道两侧同表：主观声明在 agentClaims.goals，客观判定在 goalChecks / goalStats。
    goalChecks,
    goalStats: run.goalStats ?? null,
    fullWorldActions: fromTrace,
  }, null, 2)}\n`);

  return {
    run, coverage, initialHash: session.initialHash(), agentClaims, notary, detection,
    replayMatchesLiveSession, evidenceConsistent,
    worldActions: fromTrace.length,
    files: { world: worldPath, coverage: coveragePath, defect: defectPath, detection: detectionPath },
  };
}