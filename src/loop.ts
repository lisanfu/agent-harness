/**
 * harness 心脏：while 循环。
 *
 * 这就是 agent 的全部秘密——观察 → 决策 → 执行 → 回填 → 判断该不该停。
 * 框架把这层藏起来了，所以这里手写，一行都不藏。
 *
 * 停止条件有五种，缺一不可：
 *   finished      大脑自己调 finish（最重要的：让它自己决定何时收手）
 *   max_steps     步数预算
 *   wall_clock    时间预算
 *   loop_detected 连续重复同一动作
 *   brain_failed  大脑连续失败且回炉无效
 */
import { classify, ErrCode } from './errors.ts';
import { buildContext } from './context.ts';
import { Board, describeAttribution, type AttributionOutcome } from './board.ts';
import { Goals, describeGoalCheck, goalCheckable } from './goal.ts';
import { buildSystem, goalsBlock, notesBlock } from './brain/prompt.ts';
import { repairHint } from './parse.ts';
import { canonical, createRng, hashState } from './rng.ts';
import { makeRunId, toActionSequence, TraceWriter } from './trace.ts';
import { goal as goalTool, snapshotSandbox } from './tools/builtin.ts';
import { ToolRegistry } from './tools/registry.ts';
import type {
  Brain, Decision, GoalSeam, GoalStats, HarnessConfig, HypothesisStats, JudgementStamp,
  Message, PredictionRecord, PredictionSeam,
  PredictionStats, RunResult, StepRecord, StopReason, ToolContext,
} from './types.ts';

export interface RunOptions {
  brain: Brain;
  registry: ToolRegistry;
  config: HarnessConfig;
  log?: (line: string) => void;
  /**
   * 世界模式下提供：每步的状态哈希改用世界哈希。
   * 文件模式的哈希是 notes + 沙箱条目，那反映的是"agent 的记忆和文件"，不是世界。
   * M3 实测掩蔽 15 例，证明主证据字段必须记世界的逐帧哈希，否则重放比对没有意义。
   * 不传则完全保持原行为（已有测试依赖它）。
   */
  worldHash?: () => string;
  /** 世界模式的初始状态，写进 header 供重放 */
  initialWorld?: {
    kind: string; seed: number; hash: string; screen: string; mutant: string | null;
  };
  /**
   * 局势指纹（世界模式提供）：判"这一步有没有进展"，**必须不含 tick**。
   *
   * 为什么需要它（真跑三局换来的）：旧判据只比动作签名，把"直线走图"误判成死循环。
   * 三局全被砍在 7~12 步，而玩家每步都在前进 (4,2)→(5,2)→(6,2)→(7,2)。
   * 后果不只是步数少：agent 从没机会调 finish，M07 永远走不到 hp=0，
   * 公证器报"未分叉"——**harness 自己造成的假阴性，却被误读成公证器无能**。
   *
   * 不能直接复用 worldHash：它含 tick，每帧都不同，拿它判循环会永远判不出。
   * 不传则完全保持原行为（文件模式重复写同一条 note 确实是卡住了，已有测试依赖）。
   */
  loopFingerprint?: () => string;
  /**
   * 预测-对照接缝（M4，世界模式提供）。不传则整条链路不启用，
   * 文件模式的产物一字不变——已有测试依赖这一点。
   */
  prediction?: PredictionSeam;
  /**
   * 判决口径的版本戳（M4-f，世界模式提供）。循环层只负责抄进 header.json，
   * 它不认识词表内容也不知道判据长什么样——**判据先于输出冻结**这条承诺
   * 靠"由谁写入"落实：这一项在 agent 动手之前就写完了。
   * 不传则 header 里没有 judgement 键（文件模式、M4-f 之前的证据都是这样）。
   */
  judgement?: JudgementStamp;
  /**
   * 当前画面（M4）。核对预测要「动作前」「动作后」两帧屏幕，都从这里取。
   * 刻意不从 result.output 里认屏幕：那会把"工具返回格式"变成隐式契约，
   * 换个工具返回别的东西就悄悄失效。取画面是眼睛的事，走眼睛的通道。
   */
  screen?: () => string;
  /**
   * 目标完成条件的接缝（M4-b2，世界模式提供）。不传则整条目标链路不启用：
   * goal 工具不注册、契约里不出现、产物里没有 goal_* 事件。
   *
   * 为什么这么硬：文件模式没有画面，doneWhen 永远判不出结果。
   * 挂一个判不出来的接口给模型，等于给它一件摆设，还会污染跨轮对照的契约。
   */
  goal?: GoalSeam;
}

export async function runHarness(opts: RunOptions): Promise<RunResult> {
  const { brain, registry, config } = opts;
  const log = opts.log ?? (() => {});
  const startedAt = Date.now();
  const runId = makeRunId(config.seed);
  const writer = new TraceWriter(config.outDir, runId);

  // 步号的主人始终是循环层。提前声明，因为假设板要按步号给每次写入盖戳。
  let currentStep = 0;

  // ── 假设板账本（M4-b）────────────────────────────────
  // 与 pstats 同一条纪律：全部由代码累加，绝不问模型"你觉得自己记得怎么样"。
  const hstats: HypothesisStats = {
    proposed: 0, confirmed: 0, retired: 0, revised: 0, plainNotes: 0,
    attributed: 0, unattributed: 0, unknownTarget: 0, malformed: 0,
    notChecked: 0, fieldAbsent: 0, contradictedNotRetired: 0, confirmedNoChecks: 0,
  };
  const board = new Board({
    step: () => currentStep,
    // 写入（含被拒）必须落盘。故障 #9：静默丢弃 = 归因作废。
    // 不记被拒的那次，事后就分不清"模型没立假设"和"立了但被拒"。
    onWrite: (w) => {
      if (w.ok && !w.created && w.textChanged) hstats.revised++;
      writer.event('hypothesis_write', w);
    },
  });

  // ── 目标板账本（M4-b2）──────────────────────────────
  // 只有世界层给了接缝才存在。判据见 src/goal.ts，这里只累加与出声。
  const gstats: GoalStats = {
    open: 0, achieved: 0, abandoned: 0,
    declared: 0, revised: 0, conditionRevised: 0, rejected: 0,
    conditionMalformed: 0, withCondition: 0,
    checks: 0, met: 0, unmet: 0, unverifiable: 0,
    metNotClosed: 0, closedNeverMet: 0, uncheckable: 0,
  };
  const goals = opts.goal ? new Goals({
    step: () => currentStep,
    fields: opts.goal.fields,
    onWrite: (w) => {
      if (!w.ok) gstats.rejected++;
      else if (w.created) gstats.declared++;
      else {
        if (w.textChanged) gstats.revised++;
        if (w.conditionChanged) gstats.conditionRevised++;
      }
      if (w.conditionMalformed) gstats.conditionMalformed++;
      writer.event('goal_write', w);
    },
  }) : null;

  const rng = createRng(config.seed);
  const ctx: ToolContext = {
    sandbox: config.sandbox,
    rng,
    // 纯文本通道转发到同一个板子：一个器官只有一个真相来源，
    // 不许 ctx.note 和 board 各存一份笔记，那迟早会对不上。
    note: (t) => { board.addPlain(t); },
    notes: () => board.plain(),
    board,
    // 目标器官只在接缝存在时挂上去。goal 工具自己会拒绝"没有目标通道"的调用，
    // 但这里给 undefined 才是根子上的界线：文件模式连工具都不会注册。
    ...(goals ? { goals } : {}),
  };

  const initialState = {
    notes: [] as string[],
    hypotheses: board.all(),
    ...(goals ? { goals: goals.all() } : {}),
    sandboxEntries: snapshotSandbox(config.sandbox),
    ...(opts.initialWorld ? { world: opts.initialWorld } : {}),
  };
  writer.header({
    runId,
    at: new Date().toISOString(),
    seed: config.seed,
    brainId: brain.id,
    task: config.task,
    sandbox: config.sandbox,
    config: { ...config },
    // 通道开关进证据：审计据此分得开"旧版没这条通道"与"新版如实关掉"。
    // 判据的主人始终是循环层（它才知道接缝给没给），世界层不用重复声明一遍。
    // 判决口径戳：世界层算好了递过来，循环层只抄写、不解释（判据见 types.ts 的 JudgementStamp）
    ...(opts.judgement ? { judgement: opts.judgement } : {}),
    seams: { predict: opts.prediction !== undefined, goal: opts.goal !== undefined },
    initialState,
  });

  // ── 传输层重试的出声口 ──────────────────────────────
  // 重试不是"没发生"。不记下来，trace 里第 11 步就只有一次请求，
  // 而真实撞了 4 次限流墙——事后看 brainMs 会以为"模型慢"，归因直接错。
  // 出声口挂在 brain 实例上（不进 DecideRequest，理由见 types.ts）。
  // 所有权纪律：一个 brain 只归一次 runHarness；差分公证器根本不用 brain，所以不会串台。
  let brainRetries = 0;
  brain.onRetry = (info) => {
    brainRetries++;
    writer.event('brain_retry', { step: currentStep, ...info });
    log(`[brain] 第${currentStep}步 服务端拒绝（${info.error.code}），第${info.attempt}/${info.maxRetries}次重试，先等 ${info.waitMs}ms`);
  };

  const history: Message[] = [{ role: 'user', content: config.task }];
  // ── goal 工具的注册跟着接缝走 ────────────────────────
  // 判据只有一个："有没有能判定它的画面"。接缝给了就注册，没给就不出现在工具清单里。
  // 为什么放在循环层而不是各世界 runner 里：那条"接口存在却永远判不出结果"的界线
  // 一旦散落到每个调用方，迟早有人忘了同步注册，模型试一次拿到拒绝就再也不用它
  // ——而我们会把那误读成"这个大脑没有目标导向意图"（接口给了≠会用，反过来也成立）。
  // 已注册则不重复注册：世界 runner 可能自己带了一份同名工具。
  if (opts.goal && !registry.has('goal')) registry.register(goalTool);
  const tools = registry.specs();
  // system 只装配一次：它是契约，不该每步临时重写。
  // 装配放在循环层而不是各 brain 里，是为了让 stdio 宿主和远端模型看到「同一份」契约。
  const system = buildSystem({
    task: config.task, tools,
    predictSpec: opts.prediction?.spec,
    goalSpec: opts.goal?.spec,
  });
  const steps: StepRecord[] = [];
  let stopReason: StopReason = 'max_steps';
  let finishSummary: string | undefined;
  let lastSig = '';
  let lastFingerprint: string | null = null;
  let repeatCount = 0;
  let warnedOverBudget = false;

  // ── 预测-对照账本（M4）──────────────────────────────
  // 全部由代码累加，绝不问模型"你觉得自己预测得怎么样"。
  const pstats: PredictionStats = {
    checked: 0, staticChecks: 0, given: 0, missing: 0, fields: 0, ok: 0, violated: 0, unverifiable: 0,
    surpriseGiven: 0, surpriseUnexpected: 0, surpriseMalformed: 0, violatedButNotSurprised: 0,
  };
  // surprise 判断的是**上一次**的差异，所以要留住上一次真正核对过的记录
  let lastChecked: PredictionRecord | null = null;
  let lastCheckedStep: number | null = null;

  outer: for (let step = 1; step <= config.maxSteps; step++) {
    currentStep = step;
    if (Date.now() - startedAt >= config.maxWallMs) {
      stopReason = 'wall_clock';
      log(`[stop] 时间预算耗尽（${config.maxWallMs}ms）`);
      break;
    }

    // 上下文装配抽成可重入的一份：回炉会往 history 塞提示，塞完必须重新装配。
    const ctxOpts = { maxContextChars: config.maxContextChars, keepRecent: config.keepRecent };
    let built = buildContext(system, history, ctxOpts);
    const warnBudget = () => {
      if (!built.overBudget || warnedOverBudget) return;
      warnedOverBudget = true;
      const detail = { maxContextChars: config.maxContextChars, actualChars: built.chars, keepRecent: config.keepRecent };
      writer.event('context_over_budget', detail);
      log(`[context] 预算 ${config.maxContextChars} 字符装不下地板（system + 最近 ${config.keepRecent} 条 = ${built.chars}）。已超预算但保住契约与近期记忆；要真截断请调大 --max-context-chars 或调小 --keep-recent。`);
    };
    warnBudget();

    // ── 假设板：常驻不截断，走独立通道 ─────────────────────
    // 渲染放在 decide **之前**：这一步的写入还没发生，模型看到的必须是上一步结束时的板子。
    // 原文落盘的理由与 prediction_feedback 完全相同（故障 #11）：
    // 「板子渲染了」不等于「能从证据里证明它上了线」。存了原文，判据才是确定的。
    // 远端大脑用同一个纯函数 notesBlock(notes, hypotheses) 渲染，同输入同输出，
    // 所以"落盘原文 == 线上内容"可以被测试逐字钉死。
    const boardText = notesBlock(board.plain(), board.all());
    if (boardText !== null) {
      writer.event('hypothesis_board', {
        step, text: boardText, nagging: board.nagging(),
      });
    }

    // ── 目标板：同样在 decide **之前**渲染并落盘原文 ──────────
    // 判据与理由整套复用假设板那三课（故障 #8/#11）：
    // 「板子渲染了」不等于「送达了」，所以存原文；本步的写入还没发生，
    // 模型看到的必须是上一步结束时的板子加上**到上一步为止的判定计数**。
    // nagging 与渲染共用 goalAttention 这一个主人，两处判据不许各写一套。
    if (goals) {
      const goalText = goalsBlock(goals.all());
      if (goalText !== null) {
        writer.event('goal_board', { step, text: goalText, nagging: goals.nagging() });
      }
    }

    // ── 决策（含内容回炉：解析失败 + 空回复）──────────────
    let decision: Decision | undefined;
    let brainMs = 0;
    let attempt = 0;
    for (;;) {
      const t0 = Date.now();
      try {
        decision = await brain.decide({
          task: config.task,
          system,
          messages: built.messages,
          tools,
          step,
          // 传**快照**而不是活引用：请求是"当时发出去的东西"，
          // 若传活引用，后面的写入会篡改历史请求，证据与测试双双失真。
          notes: [...board.plain()],
          hypotheses: board.all(),
          // 同上：快照不是活引用。目标判定还会往后走，历史请求不能被篡改。
          ...(goals ? { goals: goals.all() } : {}),
        });
        brainMs += Date.now() - t0;
        break;
      } catch (e) {
        brainMs += Date.now() - t0;
        const he = classify(e);
        writer.event('brain_error', { step, attempt, error: he.toInfo() });
        log(`[brain] 第${step}步 第${attempt + 1}次失败 ${he.code}: ${he.message}`);
        // 内容形状错误归循环层修：解析失败 + 空回复。
        // 为什么不是传输层？因为修法是把提示塞进 history 再问一遍，
        // 传输层看不到 history，重发同一份 payload 治不了「模型没说话」。
        // 传输层只管服务端拒绝（429/5xx/超时/连不上）。一个类别一个主人。
        const repairable = he.code === ErrCode.BRAIN_PARSE || he.code === ErrCode.BRAIN_EMPTY;
        if (repairable && attempt < config.maxParseRetry) {
          attempt++;
          history.push({ role: 'user', content: repairHint(he, registry.names()) });
          // ⚠️ 故障 #8：塞完提示必须重新装配上下文。
          // 沿用旧 built.messages 的话，提示只进了 history、没进 payload，
          // 模型永远看不到它——"回炉"退化成"原样再问一遍"，靠 temperature 的运气碰对。
          built = buildContext(system, history, ctxOpts);
          warnBudget();
          continue;
        }
        stopReason = 'brain_failed';
        break outer;
      }
    }

    if (!decision) { stopReason = 'brain_failed'; break outer; }

    // ── 模型对上一次差异的判断（判断权归它，事实由代码给）──────
    if (decision.surprise) {
      const sj = decision.surprise;
      if (sj.unexpected === null) {
        // 给了判断但形状不可用：单独记一笔，不混进 surpriseGiven，也不猜成 false
        pstats.surpriseMalformed++;
      } else {
        pstats.surpriseGiven++;
        if (sj.unexpected) pstats.surpriseUnexpected++;
        else if (lastChecked && lastChecked.violated > 0) pstats.violatedButNotSurprised++;
      }
      // 判断与差异的对应关系必须落盘，否则"它说不意外"到底在说哪一步就无从复核
      writer.event('surprise_judgment', {
        step,
        aboutStep: lastCheckedStep,
        aboutViolated: lastChecked?.violated ?? null,
        unexpected: sj.unexpected,
        why: sj.why,
      });
      // ⚠️ 一份差异只被判断一次。不清空的话，模型连着两步都给 surprise
      // 就会把同一份违反重复计进 violatedButNotSurprised，凭空放大"看见了不当回事"。
      lastChecked = null;
      lastCheckedStep = null;
    }

    // ── 执行 ────────────────────────────────────────
    // 动作前的画面必须在 execute **之前**取：执行完再取就两帧都是新的，diff 恒为 0
    const prevScreen = opts.screen ? opts.screen() : null;
    const t1 = Date.now();
    const result = await registry.execute(decision.call, ctx);
    const toolMs = Date.now() - t1;

    // ── 预测对照：代码拿两帧屏幕算差异 ──────────────────
    let prediction: PredictionRecord | undefined;
    if (opts.prediction && prevScreen !== null && opts.prediction.applies(decision.call, result)) {
      prediction = opts.prediction.check(decision.predict, prevScreen, opts.screen!());
      pstats.checked++;
      if (!prediction.advanced) pstats.staticChecks++;
      if (prediction.given) pstats.given++;
      else pstats.missing++;
      pstats.fields += prediction.diffs.length;
      pstats.ok += prediction.diffs.filter((d) => d.status === 'ok').length;
      pstats.violated += prediction.violated;
      pstats.unverifiable += prediction.unverifiable;
      lastChecked = prediction;
      lastCheckedStep = step;
      // 没给预测也要留档："不预测"本身是可度量的行为，抹掉它就只剩好看的准确率
      writer.event('prediction_check', { step, ...prediction });
      if (prediction.violated > 0) {
        log(`[predict] 第${step}步 ${prediction.violated} 项预测与画面不符（${prediction.diffs.filter((d) => d.status === 'violated').map((d) => d.field).join(', ')}）`);
      }
    }

    // ── 目标判定：代码拿当前画面客观判定每一条目标（M4-b2）──────
    // 三条刻意的设计，都有来处：
    //  1. **没有 applies 闸门**。假设的预测核对要问"这步改没改画面"，目标不问：
    //     目标断言的是**状态**，静止帧上"我是否站在 hp=0"同样是可核对的事实。
    //     故障 #10 那一课：闸门按"有没有可核对的事实"划，不按"有没有动"划。
    //  2. **不看 status**。achieved / abandoned 的目标照样判定，
    //     否则模型声明一句就能把计数关掉，评测指标当场被被测对象控制。
    //  3. 判定发生在 execute **之后**：本步刚立的目标也要判一次，
    //     "它立的条件当场就能满足"这条事实不该被推迟一步。
    let goalText: string | null = null;
    if (goals && opts.goal && opts.screen) {
      const screen = opts.screen();
      const checks = goals.evaluate((cond) => opts.goal!.evaluate(cond, screen));
      for (const c of checks) {
        gstats.checks++;
        if (c.met === true) gstats.met++;
        else if (c.met === false) gstats.unmet++;
        else gstats.unverifiable++;
        writer.event('goal_check', {
          step, id: c.goal.id, met: c.met, firstMet: c.firstMet,
          diffs: c.diffs, totals: { checks: c.goal.checks, met: c.goal.met, unmet: c.goal.unmet, unverifiable: c.goal.unverifiable },
        });
      }
      // 只有**首次**满足才回填（预算纪律：每步播报"还没达成"是噪音，M4-b1 第 26 步已超预算）
      goalText = describeGoalCheck(checks);
      if (goalText !== null) log(`[goal] 第${step}步 ${goalText.split('\n').length} 条目标的完成条件首次被画面满足`);
    }

    // ── 假设归因（M4-b）：把客观核对记到模型指定的那条假设名下 ──────
    // 分工：模型说"这一步在检验 H1"，**代码决定记多少**。
    // 反过来（让模型自报"这条假设被支持了几次"）就是 M1 那个替自己圆场的老毛病。
    // 没声明 testing 就不记：猜一个目标等于伪造归因，宁可如实记 unattributed。
    let hypFeedback: string | null = null;
    if (decision.testing) {
      const t = decision.testing;
      const knownIds = board.ids();
      let outcome: AttributionOutcome;
      if (t.id === null) {
        hstats.malformed++;
        outcome = { problem: 'malformed', test: t, knownIds, result: null };
      } else if (!board.get(t.id)) {
        hstats.unknownTarget++;
        outcome = { problem: 'unknown_target', test: t, knownIds, result: null };
      } else if (!prediction) {
        // 这一步世界里根本没发生可核对的事（note/finish/工具报错）。
        // 绝不拿上一帧的旧差异顶替：那会把别人的账记到这一步头上。
        hstats.notChecked++;
        outcome = { problem: 'not_checked', test: t, knownIds, result: null };
      } else {
        const a = board.attribute(t.id, prediction.diffs, t.field)!;
        if (a.fieldAbsent) {
          hstats.fieldAbsent++;
          outcome = {
            problem: 'field_absent', test: t, knownIds, result: null,
            predictedFields: prediction.diffs.map((x) => x.field),
          };
        } else {
          hstats.attributed++;
          outcome = { problem: null, test: t, knownIds, result: a };
        }
      }
      hypFeedback = describeAttribution(outcome);
      // 成功与失败都落盘，且带上增量：审计脚本可以把增量加起来与局末快照对账。
      writer.event('hypothesis_check', {
        step,
        id: t.id,
        field: t.field ?? null,
        problem: outcome.problem,
        fields: outcome.result?.fields ?? [],
        supported: outcome.result?.supported ?? 0,
        contradicted: outcome.result?.contradicted ?? 0,
        unverifiable: outcome.result?.unverifiable ?? 0,
        ...(outcome.result ? { totals: { ...outcome.result.hypothesis } } : {}),
      });
      if (outcome.problem) log(`[board] 第${step}步 归因未成立（${outcome.problem}）：${t.id ?? '形状不可用'}`);
    } else if (prediction) {
      hstats.unattributed++;
    }

    const stateHash = opts.worldHash
      ? opts.worldHash()
      : hashState({
        notes: [...board.plain()],
        // 结构化假设也是记忆的一部分，文件模式的状态哈希必须含它。
        // 空板时不加这个键：M1 那几局的哈希要逐位不变，跨轮对照才成立。
        ...(board.ids().length ? { hypotheses: board.all() } : {}),
        // 同一条纪律：目标板空时不加这个键，M1 / M4-a 那几局的哈希要逐位不变。
        ...(goals && goals.ids().length ? { goals: goals.all() } : {}),
        entries: snapshotSandbox(config.sandbox),
        lastTool: decision.call.name,
        lastOk: result.ok,
      });

    const record: StepRecord = {
      index: step,
      at: new Date().toISOString(),
      decision,
      result,
      stateHash,
      contextChars: built.chars,
      brainMs,
      toolMs,
      ...(prediction ? { prediction } : {}),
    };
    steps.push(record);
    writer.step(record);
    log(`[${step}] ${decision.call.name}(${JSON.stringify(decision.call.args)}) → ${result.ok ? 'ok' : 'FAIL'} | ${decision.thought.slice(0, 80)}`);

    history.push({ role: 'assistant', content: JSON.stringify(decision) });
    // 差异紧跟在画面后面回填，合成一条观察：人玩游戏也是"按一下→看一眼→发现不对劲"。
    // 刻意不单独发一条消息：那会多占上下文预算，还把"同一帧的画面与对账"拆散。
    // trace 里两者仍分开存（result.output 是纯画面，prediction 是纯差异），证据不混。
    const feedback = prediction && opts.prediction ? opts.prediction.describe(prediction) : null;
    // 一条观察 = 画面 + 预测对照 + 假设归因。三段都是"这一步之后代码知道的事实"，
    // 合成一条消息（人玩游戏也是"按一下→看一眼→发现不对劲"），但 trace 里分开存，证据不混。
    const observed = [result.output, feedback, hypFeedback, goalText].filter((x): x is string => x !== null && x !== '').join('\n\n');
    history.push({ role: 'tool', toolName: decision.call.name, content: observed });
    // 回填的原文必须落盘。故障 #8 的教训升级到证据层：
    // 「差异进了 history」不等于「能从证据里证明它进了 payload」。
    // 单元测试能在接线处断言 payload，真跑不能——真跑只留下 trace。
    // 不存这段原文，真跑的"送达"就只能靠模型引用去反推，那是间接证据。
    // 存了之后判据是确定的：history 整份下发，所以只要存在第 step+1 步决策，
    // 这段原文就一定在大脑那次请求里。审计脚本按这条规则核，不靠猜。
    if (feedback !== null) writer.event('prediction_feedback', { aboutStep: step, text: feedback });
    if (hypFeedback !== null) writer.event('hypothesis_feedback', { aboutStep: step, text: hypFeedback });
    // 同一条证据纪律：回填的原文单独落一份，审计才能拿它跟下一步请求里的 tool 消息逐字比
    if (goalText !== null) writer.event('goal_feedback', { aboutStep: step, text: goalText });

    if (decision.call.name === 'finish') {
      stopReason = 'finished';
      finishSummary = String(decision.call.args['summary'] ?? '');
      break;
    }

    // ── 死循环检测 ──────────────────────────────────
    // 世界模式：重复动作 **且局面毫无变化** 才算卡住。
    // 只比动作签名会把"直线走图"误判成死循环——走图本来就该连续同向。
    // 文件模式（不传指纹）：保持原判据，重复写同一条 note 确实是卡住了。
    const sig = canonical(decision.call);
    const fp = opts.loopFingerprint ? opts.loopFingerprint() : null;
    const stuck = fp === null ? sig === lastSig : (sig === lastSig && fp === lastFingerprint);
    if (stuck) repeatCount++;
    else { lastSig = sig; lastFingerprint = fp; repeatCount = 1; }
    if (repeatCount >= config.repeatLimit) {
      stopReason = 'loop_detected';
      writer.event('loop_detected', { step, sig, repeatCount, situationUnchanged: fp !== null, fingerprint: fp });
      log(`[stop] 连续 ${repeatCount} 次重复同一动作${fp === null ? '' : '且局面毫无变化'}，判定死循环`);
      break;
    }
  }

  // 局末快照：状态条数与两类"主客观脱钩"都由代码数，状态本身仍是模型声明的。
  const hypotheses = board.all();
  for (const h of hypotheses) hstats[h.status]++;
  hstats.plainNotes = board.plain().length;
  hstats.contradictedNotRetired = board.contradictedNotRetired().length;
  hstats.confirmedNoChecks = board.confirmedNoChecks().length;
  if (hstats.contradictedNotRetired > 0) {
    log(`[board] 收手时仍有 ${hstats.contradictedNotRetired} 条假设被客观核对反对、却未被淘汰：${board.contradictedNotRetired().join(', ')}（代码不代它淘汰，只如实记一笔）`);
  }
  if (hstats.confirmedNoChecks > 0) {
    log(`[board] 收手时有 ${hstats.confirmedNoChecks} 条假设被标为 confirmed、归因到它名下的客观核对却是 0 次：${board.confirmedNoChecks().join(', ')}（自称已验证 ≠ 账本上有核对）`);
  }

  // 目标板局末快照（M4-b2）。同一条纪律：全部由代码数，状态本身仍是模型声明的。
  const goalSnaps = goals ? goals.all() : [];
  if (goals) {
    for (const g of goalSnaps) {
      gstats[g.status]++;
      if (goalCheckable(g)) gstats.withCondition++;
    }
    gstats.metNotClosed = goals.metNotClosed().length;
    gstats.closedNeverMet = goals.closedNeverMet().length;
    gstats.uncheckable = goals.uncheckable().length;
    if (gstats.metNotClosed > 0) {
      log(`[goal] 收手时画面已满足、却仍标 open 的目标：${goals.metNotClosed().join(', ')}（代码只判定，要不要收口由你判断）`);
    }
    if (gstats.closedNeverMet > 0) {
      log(`[goal] 收手时自称 achieved、却被画面判定从未满足过的目标：${goals.closedNeverMet().join(', ')}（自称达成 ≠ 画面上达成）`);
    }
    if (gstats.uncheckable > 0) {
      log(`[goal] 收手时仍判不出结果的目标：${goals.uncheckable().join(', ')}（doneWhen 缺失、形状不可用，或字段全不在词表里）`);
    }
  }

  const result: RunResult = {
    runId,
    runDir: writer.runDir,
    stopReason,
    steps,
    notes: [...board.plain()],
    hypotheses,
    // 空数组而不是 undefined：目标通道关着时"一条都没立"与"这个器官不存在"要能区分，
    // 而 goalStats 整个省略才是"通道没启用"的判据（见下面的三元）。
    goals: goalSnaps,
    finishSummary,
    actionSequence: toActionSequence(steps),
    durationMs: Date.now() - startedAt,
    brainRetries,
    ...(opts.prediction ? { predictionStats: pstats } : {}),
    hypothesisStats: hstats,
    ...(opts.goal ? { goalStats: gstats } : {}),
  };
  writer.result(result);
  return result;
}