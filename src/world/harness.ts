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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHarness } from '../loop.ts';
import { minimize } from '../notary/ddmin.ts';
import { runDifferential } from '../notary/diff.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { gameTools, isWorldTool, toWorldActions } from '../tools/game.ts';
import type { Brain, GoalSeam, HarnessConfig, PredictionSeam, RunResult } from '../types.ts';
import { ALL_CAPS, type Action, type Capabilities } from './arena.ts';
import { findMutant, findSoundMutant } from './mutants.ts';
import { detectOne, judgeStamp, type Detection } from './detect.ts';
import { GOAL_SEAM } from './goal.ts';
import { PREDICT_SPEC, checkPrediction, describeCheck } from './predict.ts';
import { REFERENCE_RIG, type SoundEvent, type SoundRig } from './sound.ts';
import { earFrames, earStamp, type EarClaim, type EarFramesResult, type EarSound, type EarVerdict } from './ear.ts';
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
  /**
   * 是否给 agent 装耳朵（M4-c）。默认 true。
   * 与 doGoal 同一条理由：**接口给了不等于模型会用，但给了就必须能证明它给了**。
   * 关掉它 → `listen` 工具不注册、契约里不出现这个名字、产物里没有 sound.jsonl，
   * 消融对照才有一个"只有眼睛"的真对照组；开没开由 header.seams.ear 声明、审计核产物。
   */
  doEar?: boolean;
  /**
   * 发声变异体 id（M4-c）。null / 省略 = `R0` 参考版发声。
   * ⚠️ 只改"播什么"，**不改世界**：`caps` 与发声装置是两套互不影响的东西，
   *    所以这一项开起来时屏幕与缺陷版参考版完全一致——那正是本项目的靶心。
   *
   * 这里刻意收 **id** 而不是 `SoundRig` 对象（上一版收的是对象，本轮改的正是这一处）：
   *   - 收对象 ⇒ 调用方可以一边传 `REFERENCE_RIG`、一边在证据里自称 `S10`，
   *     标签与实际装置是**两次独立的输入**，审计只能事后猜（`ear-fixture.ts` 的 D2 注入
   *     专门打这一族：把 rig 标签改成 R0，运行时装置不动）。
   *   - 收 id ⇒ 装置由 `findSoundMutant(id)` 现查，标签与装置同源，**没有可造假的那条缝**。
   *     id 不认识直接抛（`findSoundMutant` 自带这条），不存在"写错了但照样跑"。
   */
  soundMutant?: string | null;
}

export interface NotaryVerdict {
  /** 只有 false 会写出：动作执行窗口中断时，下面的数值只能当未认证的现场片段。 */
  certified?: false;
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

/**
 * 局末眼耳对账的判决（写进 `ear.json`）。
 *
 * 与 `detection`（M4-f，屏幕通道的检出漏斗）并列而**不是同一件事**：
 * detection 问"agent 有没有看见并报对"，这一份问"耳朵这一局的每一声，屏幕上对不对得上"。
 * 两者都只在局末由代码算，都不进契约、不进工具返回，agent 全程读不到。
 */
export interface EarRunSummary {
  /** false=执行窗口中断，本份判决未获认证。 */
  certified?: false;
  /** 冻结判据戳：版本 + 规范化判据的 sha256。换口径必须升版本、按版本分箱重出表 */
  ear: { ear: string; sha: string; frozenAt: string };
  seed: number;
  /** 世界层变异体（null = 参考版世界） */
  mutant: string | null;
  /** 发声侧装置 id（'R0' = 参考版发声）。装置与标签同源：这一项就是查装置用的那个 key */
  soundMutant: string;
  soundMutantLabel: string;
  actions: number;
  sounds: number;
  /** 证据自洽性：屏幕流/动作流/帧号三者是否对齐（对不上时五桶全不可信） */
  consistency: EarFramesResult['consistency'];
  /** 判决用的屏幕是重放出来的，必须与实玩 session 的逐帧现象相同 */
  screensMatchLiveRun: boolean;
  counts: Record<EarVerdict, number>;
  byKey: Record<string, Record<EarVerdict, number>>;
  /** 「矛盾」拆成三种形状：修法完全不同，混成一个数不叫诊断 */
  splits: { 漏报: number; 误报: number; 数字少报: number };
  claims: EarClaim[];
}

export interface ArenaRunResult {
  /** false=保留现场证据，但本局任何裁判数值都不得当作已认证结果。 */
  certified?: false;
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
  /**
   * M4-c 眼耳对账判决（写进 `ear.json`）。与 `detection` 同侧不同事：
   * 那一份量"agent 检出没检出"，这一份量"每一声在屏幕上对不对得上"。
   * 没装耳朵的局这里是 null，**不是零计数**——消融对照组里没有这份证据。
   */
  ear: EarRunSummary | null;
  /** 判决器重放的缺陷版覆盖 vs agent 真玩的 session 覆盖，必须逐字段相同 */
  replayMatchesLiveSession: boolean;
  /** 证据一致性：session 实际执行的动作 vs 从 trace 抽出的动作，必须逐位相同 */
  evidenceConsistent: boolean;
  worldActions: number;
  files: { world: string; coverage: string; defect: string; detection: string; sound: string | null; ear: string | null };
}

export interface ArenaWorldOptions {
  seed: number;
  mutant?: string | null;
  doPredict?: boolean;
  doGoal?: boolean;
  doEar?: boolean;
  soundMutant?: string | null;
}

/**
 * 一局的可分步执行世界。裁判侧字段只供宿主装配与局末收尾使用；
 * 交给 agent 的仍然只有 registry 工具与 screen 投影。
 */
export interface ArenaWorld {
  session: GameSession;
  registry: ToolRegistry;
  caps: Capabilities;
  mutantId: string | null;
  soundMutantId: string;
  rig: SoundRig;
  ear: boolean;
  initialWorld: { kind: 'arena'; seed: number; hash: string; screen: string; mutant: string | null };
  prediction?: PredictionSeam;
  goal?: GoalSeam;
  worldHash(): string;
  loopFingerprint(): string;
  screen(): string;
}

/** 装配世界、工具与接缝；不启动循环，也不产生局末裁判证据。 */
export function createArenaWorld(opts: ArenaWorldOptions): ArenaWorld {
  const mutantId = opts.mutant ?? null;
  const caps = mutantId ? findMutant(mutantId).caps : ALL_CAPS;
  const ear = opts.doEar ?? true;
  // 发声装置**只从 id 现查**（见 ArenaRunOptions.soundMutant 的注释）：装置与标签同源，
  // 证据里写的 id 就是这一局真正装上的那个。R0 显式映射到 REFERENCE_RIG，
  // 这样"省略"与"点名 R0"是同一条实验条件，不产两种字节。
  const soundMutantId = opts.soundMutant ?? 'R0';
  const rig = soundMutantId === 'R0' ? REFERENCE_RIG : findSoundMutant(soundMutantId).rig;
  const session = new GameSession(opts.seed, caps, rig);

  const registry = new ToolRegistry();
  for (const t of gameTools(session, { ear })) registry.register(t);

  const initialWorld: ArenaWorld['initialWorld'] = {
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

  return {
    session, registry, caps, mutantId, soundMutantId, rig, ear, initialWorld, prediction, goal,
    worldHash: () => session.stateHash(),
    // 死循环判据用**不含 tick** 的局势指纹：帧哈希每帧都变，拿它判循环会永远判不出；
    // 只比动作签名又会把直线走图误判成循环（真跑三局全被砍在 7~12 步）。
    loopFingerprint: () => session.situationHash(),
    screen: () => session.screen(),
  };
}

export interface ArenaFinalizeOptions {
  doMinimize?: boolean;
  ddMaxTests?: number;
  log?: (line: string) => void;
}

/** CLI 连续执行与 MCP 分步执行共用的薄门面。 */
export async function runArena(opts: ArenaRunOptions): Promise<ArenaRunResult> {
  const world = createArenaWorld(opts);
  const log = opts.log ?? (() => {});
  const run = await runHarness({
    brain: opts.brain,
    registry: world.registry,
    config: opts.config,
    log,
    // M4-f：判决口径戳随 header.json 一起落盘，早于 agent 的第一步。
    // 世界层在这里组装戳（它才认识词表），循环层只负责抄——分工见 types.ts 的 JudgementStamp。
    judgement: judgeStamp(),
    worldHash: world.worldHash,
    loopFingerprint: world.loopFingerprint,
    initialWorld: world.initialWorld,
    // 画面是这两条通道共同的输入。谁开着就得给谁——漏了另一个会静默降级成
    // "接缝存在但一步都没判过"，那是最难查的假阴性（故障 #8 的第三种形态）。
    ...(world.prediction !== undefined || world.goal !== undefined ? { screen: world.screen } : {}),
    ...(world.prediction ? { prediction: world.prediction } : {}),
    ...(world.goal ? { goal: world.goal } : {}),
  });
  return finalizeArenaWorld(world, run, { doMinimize: opts.doMinimize, ddMaxTests: opts.ddMaxTests, log });
}

/** 局末抽动作、裁判、对账与落盘；不读改判据，也不向世界工具暴露裁判信息。 */
export async function finalizeArenaWorld(
  world: ArenaWorld,
  run: RunResult,
  opts: ArenaFinalizeOptions = {},
): Promise<ArenaRunResult> {
  const { session, caps, mutantId, soundMutantId, ear } = world;
  const uncertified = run.stopReason === 'interrupted';
  const seed = world.initialWorld.seed;
  const log = opts.log ?? (() => {});

  // ── 抽纯动作序列：look/note/finish 不推进时间，非法方向当时被拒，都要滤掉 ──
  const fromTrace = toWorldActions(run.actionSequence);
  const fromSession = session.actionSequence();
  const evidenceConsistent = run.stopReason !== 'interrupted'
    && JSON.stringify(fromTrace) === JSON.stringify(fromSession);
  if (run.stopReason === 'interrupted') {
    // 预写动作后崩溃时，trace 可能比 checkpoint 多一步、也可能没有；两者都不能证明实玩与账本对齐。
    // 这一局保留全部证据供审计，但绝不盖上"一致"的章。
    log('[evidence] 动作执行窗口被中断：拒绝续跑，证据保留但不认证为一致');
  }
  if (!evidenceConsistent) {
    // 这不是小瑕疵：两份证物不一致意味着重放会错位，整个缺陷报告不可信
    log(`[evidence] 严重：trace 抽出 ${fromTrace.length} 个动作，session 实际执行 ${fromSession.length} 个，不一致`);
  }

  // ── 公证器客观判定。它不看 agent 说了什么，也不知道缺陷在哪 ──
  const diff = runDifferential(seed, fromTrace, caps);
  let minimized: NotaryVerdict['minimized'] = null;
  if (diff.diverged && (opts.doMinimize ?? true)) {
    const m = minimize(seed, fromTrace, caps, { maxTests: opts.ddMaxTests ?? 400 });
    // 独立复核：不信 minimize 自己的说法，重新跑一遍
    const reverified = runDifferential(seed, m.minimized, caps).diverged;
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
    ...(uncertified ? { certified: false as const } : {}),
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
    seed,
    actions: fromTrace,
    mutant: mutantId,
    claims: agentClaims,
    internal: { diverged: notary.diverged, firstStep: notary.firstStep },
  });
  if (uncertified) detection.certified = false;
  // 顺带一条免费的一致性检查：判决器自己重放出来的缺陷版覆盖，
  // 必须与刚才 agent 真玩的那个 session 逐字段相同。不同＝重放错位，整个判决不可信。
  const replayMatchesLiveSession = !uncertified
    && JSON.stringify(detection.coverage.mutant) === JSON.stringify(coverage);
  const detectionPath = join(run.runDir, 'detection.json');
  writeFileSync(detectionPath, `${JSON.stringify({
    ...detection,
    ...(uncertified ? { certified: false } : {}),
    replayMatchesLiveSession,
  }, null, 2)}\n`);
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
    seed,
    ...(uncertified ? { certified: false } : {}),
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

  // ── 耳朵那份证据（M4-c）──
  // 刻意**新开一个文件**而不是往 world.jsonl / defect.json 里加列：
  // 那两份是已发布 30 局证据的逐字节基准，加字段等于让 M4-d / M4-f 的数字全部重算。
  // 新证据只在装了耳朵的局里存在；开没开由 header.seams.ear 声明（那一项直接从工具清单读出来）。
  let soundPath: string | null = null;
  let events: SoundEvent[] = [];
  if (ear) {
    events = session.soundEvents();
    soundPath = join(run.runDir, 'sound.jsonl');
    writeFileSync(soundPath, (events.length ? events.map((e) => JSON.stringify(e)).join('\n') + '\n' : ''));
    log(`[耳朵] sound.jsonl 落了 ${events.length} 条现象（listen 工具在场：${ear}）`);
  } else {
    log('[耳朵] 本局没装 listen 工具（消融对照组），不产 sound.jsonl');
  }

  // ── 眼耳对账那份判决（M4-c 下半）──
  // 输入**只有已落盘的两份证据**：声流从刚写完的 sound.jsonl 读回，屏幕由 `earFrames`
  // 拿 seed + 同一份动作序列重放。判决不读 session 的内部状态、不读发声层，
  // 所以"眼睛和耳朵各说一遍"不是同一份数据的复读——这正是 ear.ts 顶部那条分工的落地。
  // 同样刻意**新开一个文件**：world.jsonl / defect.json 是已发布 30 局的逐字节基准。
  let earPath: string | null = null;
  let earRun: EarRunSummary | null = null;
  if (ear && soundPath) {
    // 读回磁盘那一份，而不是直接交给判决内存里的 `events`：
    // 落盘序列化和判决输入之间只要丢一个字段，这里就会当场对不上（故障 #14 那一族）。
    const sounds = soundFromDisk(soundPath);
    if (sounds.length !== events.length) {
      log(`[眼耳对账] 严重：sound.jsonl 读回 ${sounds.length} 条，session 内存里是 ${events.length} 条——落盘与判决输入不是同一份，本判决不可信`);
    }
    const judged = await earFrames({ seed, actions: fromTrace, sounds, caps });
    // 重放对齐守卫：判决用的屏幕是 earFrames 自己重放出来的，必须与 agent 真玩那一局
    // 记进 world.jsonl 的现象逐帧相同。不同 ⇒ 重放错位，五桶计数全部作废（同 M4-f 的
    // replayMatchesLiveSession，一条纪律换了个通道再走一遍）。
    const live = session.frames();
    const screensMatchLiveRun = !uncertified && judged.frames.every((f) => {
      if (!f.inRange) return true;
      const rec = live.find((x) => x.tick === f.tick);
      return rec !== undefined && JSON.stringify(rec.events) === JSON.stringify(f.next.events);
    });
    const missed = judged.claims.filter((c) => c.verdict === '矛盾' && c.side === '眼' && c.why.startsWith('漏报')).length;
    const under = judged.claims.filter((c) => c.verdict === '矛盾' && c.side === '眼' && c.why.startsWith('数字对不上')).length;
    const falseAlarm = judged.claims.filter((c) => c.verdict === '矛盾' && c.side === '耳').length;
    const stamp = earStamp();
    earRun = {
      ...(uncertified ? { certified: false as const } : {}),
      ear: stamp,
      seed,
      mutant: mutantId,
      soundMutant: soundMutantId,
      soundMutantLabel: findSoundMutant(soundMutantId).label,
      actions: fromTrace.length,
      sounds: sounds.length,
      consistency: judged.consistency,
      screensMatchLiveRun,
      counts: judged.counts,
      byKey: judged.byKey,
      splits: { 漏报: missed, 误报: falseAlarm, 数字少报: under },
      claims: judged.claims,
    };
    earPath = join(run.runDir, 'ear.json');
    writeFileSync(earPath, `${JSON.stringify(earRun, null, 2)}\n`);
    log(
      `[眼耳对账] 相符 ${judged.counts['相符']}／矛盾 ${judged.counts['矛盾']}（漏报 ${missed}・误报 ${falseAlarm}・数字少报 ${under}）`
      + `／时钟错位 ${judged.counts['时钟错位']}／无法核对 ${judged.counts['无法核对']}／容量差 ${judged.counts['容量差']}`
      + `｜装置=${soundMutantId} 口径=${stamp.ear} ${stamp.sha.slice(0, 12)}`
      + `${screensMatchLiveRun ? '' : ' ❌重放屏幕与实玩 session 不同——重放错位，本判决不可信'}`
      + `${judged.consistency.tickAligned ? '' : ' ❌声流帧号与屏幕帧号没对齐'}`,
    );
  } else if (ear) {
    log('[眼耳对账] 有 sound.jsonl 才谈得上对账，本局没装耳朵，不产 ear.json');
  }

  return {
    ...(uncertified ? { certified: false as const } : {}),
    run, coverage, initialHash: session.initialHash(), agentClaims, notary, detection, ear: earRun,
    replayMatchesLiveSession, evidenceConsistent,
    worldActions: fromTrace.length,
    files: { world: worldPath, coverage: coveragePath, defect: defectPath, detection: detectionPath, sound: soundPath, ear: earPath },
  };
}

/**
 * 从落盘的 sound.jsonl 把声流读回判决输入的形状。
 * 只认 `{tick, seq, text}` 三样：多一个字段说明写盘口径变了，少一个字段说明证据残缺，
 * 两种都必须当场炸，不许静默凑出一份"看起来能判"的声流。
 */
function soundFromDisk(path: string): EarSound[] {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  return lines.map((l, i) => {
    const s = JSON.parse(l) as Partial<EarSound>;
    if (typeof s?.tick !== 'number' || typeof s?.seq !== 'number' || typeof s?.text !== 'string') {
      throw new Error(`sound.jsonl 第 ${i + 1} 行形状不对（要 tick/seq/text）：${l.slice(0, 80)}`);
    }
    return { tick: s.tick, seq: s.seq, text: s.text };
  });
}