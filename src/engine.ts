/**
 * 可暂停的 harness 引擎。
 *
 * CLI 与 MCP 共用这一个状态机：CLI 在 while 里向 brain 要决策，MCP 把同一份
 * DecideRequest 交给宿主模型。决策来源不同，执行、记账、停止条件与证据只有一份实现。
 *
 * 为什么从 loop.ts 拆出来：MCP 的宿主已经是大脑，server 不能再 spawn 一个 brain；
 * 而旧 runHarness 把整个循环写成一个不可暂停的 async 函数，包一层工具并不能让它分步。
 */
import { buildContext, type BuiltContext } from './context.ts';
import { Board, describeAttribution, type AttributionOutcome } from './board.ts';
import { Goals, describeGoalCheck, goalCheckable } from './goal.ts';
import { buildSystem, goalsBlock, notesBlock } from './brain/prompt.ts';
import { canonical, createRng, hashState } from './rng.ts';
import { makeRunId, toActionSequence, TraceWriter } from './trace.ts';
import { goal as goalTool, snapshotSandbox } from './tools/builtin.ts';
import { ToolRegistry } from './tools/registry.ts';
import type {
  BrainRetryInfo, Decision, DecideRequest, ErrorInfo, GoalSeam, GoalStats, HarnessConfig,
  HypothesisStats, JudgementStamp, Message, PredictionRecord, PredictionSeam,
  PredictionStats, RunResult, StepRecord, StopReason, ToolContext,
} from './types.ts';

export interface EngineOptions {
  registry: ToolRegistry;
  config: HarnessConfig;
  brainId: string;
  log?: (line: string) => void;
  worldHash?: () => string;
  initialWorld?: { kind: string; seed: number; hash: string; screen: string; mutant: string | null };
  loopFingerprint?: () => string;
  prediction?: PredictionSeam;
  judgement?: JudgementStamp;
  screen?: () => string;
  goal?: GoalSeam;
  runId?: string;
  writer?: TraceWriter;
  restored?: EngineCheckpoint;
}

/** 进程重启恢复所需的全部状态。世界本身不存这里：由 seed + 已执行动作重建。 */
export interface EngineCheckpoint {
  version: 1;
  runId: string;
  currentStep?: number;
  startedAt: number;
  headerAt: string;
  brainId: string;
  steps: StepRecord[];
  history: Message[];
  notes: string[];
  hypotheses: RunResult['hypotheses'];
  goals: RunResult['goals'];
  predictionStats: PredictionStats;
  hypothesisStats: HypothesisStats;
  goalStats: GoalStats | null;
  lastChecked: PredictionRecord | null;
  lastCheckedStep: number | null;
  lastSig: string;
  lastFingerprint: string | null;
  repeatCount: number;
  warnedOverBudget: boolean;
  done: boolean;
  stopReason: StopReason;
  finishSummary?: string;
  brainRetries: number;
  parseFailures: number;
  snapshotsCounted: boolean;
  finalResult?: RunResult;
}

function emptyPredictionStats(): PredictionStats {
  return {
    checked: 0, staticChecks: 0, given: 0, missing: 0, fields: 0, ok: 0, violated: 0, unverifiable: 0,
    surpriseGiven: 0, surpriseUnexpected: 0, surpriseMalformed: 0, violatedButNotSurprised: 0,
  };
}

function emptyHypothesisStats(): HypothesisStats {
  return {
    proposed: 0, confirmed: 0, retired: 0, revised: 0, plainNotes: 0,
    attributed: 0, unattributed: 0, unknownTarget: 0, malformed: 0,
    notChecked: 0, fieldAbsent: 0, contradictedNotRetired: 0, confirmedNoChecks: 0,
  };
}

function emptyGoalStats(): GoalStats {
  return {
    open: 0, achieved: 0, abandoned: 0,
    declared: 0, revised: 0, conditionRevised: 0, rejected: 0,
    conditionMalformed: 0, withCondition: 0,
    checks: 0, met: 0, unmet: 0, unverifiable: 0,
    metNotClosed: 0, closedNeverMet: 0, uncheckable: 0,
  };
}

export class HarnessEngine {
  readonly runId: string;
  readonly writer: TraceWriter;
  readonly config: HarnessConfig;
  readonly system: string;
  readonly tools: DecideRequest['tools'];
  private readonly opts: EngineOptions;
  private readonly log: (line: string) => void;
  private readonly startedAt: number;
  private readonly headerAt: string;
  private readonly board: Board;
  private readonly goals: Goals | null;
  private readonly ctx: ToolContext;
  private readonly history: Message[];
  private readonly steps: StepRecord[];
  private readonly pstats: PredictionStats;
  private readonly hstats: HypothesisStats;
  private readonly gstats: GoalStats | null;
  private currentStep = 0;
  private built: BuiltContext | null = null;
  private warnedOverBudget: boolean;
  private lastChecked: PredictionRecord | null;
  private lastCheckedStep: number | null;
  private lastSig: string;
  private lastFingerprint: string | null;
  private repeatCount: number;
  private done: boolean;
  private stopReason: StopReason;
  private finishSummary?: string;
  private brainRetries: number;
  private parseFailures: number;
  private snapshotsCounted: boolean;
  private finalResult?: RunResult;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.log = opts.log ?? (() => {});
    const r = opts.restored;
    if (r && r.version !== 1) throw new Error(`不支持的 harness checkpoint 版本：${String(r.version)}`);
    this.runId = r?.runId ?? opts.runId ?? makeRunId(opts.config.seed);
    this.writer = opts.writer ?? (r ? TraceWriter.resume(joinRunDir(opts.config.outDir, this.runId)) : new TraceWriter(opts.config.outDir, this.runId));
    this.startedAt = r?.startedAt ?? Date.now();
    this.headerAt = r?.headerAt ?? new Date(this.startedAt).toISOString();
    this.history = r ? r.history.map((m) => ({ ...m })) : [{ role: 'user', content: opts.config.task }];
    this.steps = r ? r.steps.map((s) => structuredClone(s)) : [];
    this.pstats = r ? { ...r.predictionStats } : emptyPredictionStats();
    this.hstats = r ? { ...r.hypothesisStats } : emptyHypothesisStats();
    this.gstats = opts.goal ? (r?.goalStats ? { ...r.goalStats } : emptyGoalStats()) : null;
    this.lastChecked = r?.lastChecked ? structuredClone(r.lastChecked) : null;
    this.lastCheckedStep = r?.lastCheckedStep ?? null;
    this.lastSig = r?.lastSig ?? '';
    this.lastFingerprint = r?.lastFingerprint ?? null;
    this.repeatCount = r?.repeatCount ?? 0;
    this.warnedOverBudget = r?.warnedOverBudget ?? false;
    this.done = r?.done ?? false;
    this.stopReason = r?.stopReason ?? 'max_steps';
    this.finishSummary = r?.finishSummary;
    this.brainRetries = r?.brainRetries ?? 0;
    this.parseFailures = r?.parseFailures ?? 0;
    this.snapshotsCounted = r?.snapshotsCounted ?? false;
    this.finalResult = r?.finalResult ? structuredClone(r.finalResult) : undefined;
    this.currentStep = r?.currentStep ?? this.steps.length;

    this.board = new Board({
      step: () => this.currentStep,
      initialNotes: r?.notes,
      initialHypotheses: r?.hypotheses,
      onWrite: (w) => {
        if (w.ok && !w.created && w.textChanged) this.hstats.revised++;
        this.writer.event('hypothesis_write', w);
      },
    });
    this.goals = opts.goal ? new Goals({
      step: () => this.currentStep,
      fields: opts.goal.fields,
      initialGoals: r?.goals,
      onWrite: (w) => {
        if (!this.gstats) return;
        if (!w.ok) this.gstats.rejected++;
        else if (w.created) this.gstats.declared++;
        else {
          if (w.textChanged) this.gstats.revised++;
          if (w.conditionChanged) this.gstats.conditionRevised++;
        }
        if (w.conditionMalformed) this.gstats.conditionMalformed++;
        this.writer.event('goal_write', w);
      },
    }) : null;

    const rng = createRng(opts.config.seed);
    this.ctx = {
      sandbox: opts.config.sandbox,
      rng,
      note: (t) => { this.board.addPlain(t); },
      notes: () => this.board.plain(),
      board: this.board,
      ...(this.goals ? { goals: this.goals } : {}),
    };

    if (!r) {
      const initialState = {
        notes: [] as string[],
        hypotheses: this.board.all(),
        ...(this.goals ? { goals: this.goals.all() } : {}),
        sandboxEntries: snapshotSandbox(opts.config.sandbox),
        ...(opts.initialWorld ? { world: opts.initialWorld } : {}),
      };
      this.writer.header({
        runId: this.runId,
        at: this.headerAt,
        seed: opts.config.seed,
        brainId: opts.brainId,
        task: opts.config.task,
        sandbox: opts.config.sandbox,
        config: { ...opts.config },
        ...(opts.judgement ? { judgement: opts.judgement } : {}),
        ...(opts.config.provenance ? { provenance: opts.config.provenance } : {}),
        seams: { predict: opts.prediction !== undefined, goal: opts.goal !== undefined, ear: opts.registry.has('listen') },
        initialState,
      });
    }

    // goal 的注册仍由引擎唯一负责：接缝存在才有工具，文件模式不会多出一个摆设。
    if (opts.goal && !opts.registry.has('goal')) opts.registry.register(goalTool);
    this.tools = opts.registry.specs();
    this.system = buildSystem({
      task: opts.config.task,
      tools: this.tools,
      predictSpec: opts.prediction?.spec,
      goalSpec: opts.goal?.spec,
    });
  }

  get stopped(): boolean { return this.done; }
  get stop(): StopReason { return this.stopReason; }
  get stepCount(): number { return this.steps.length; }
  get notes(): readonly string[] { return this.board.plain(); }
  get hypotheses(): RunResult['hypotheses'] { return this.board.all(); }
  get goalSnaps(): RunResult['goals'] { return this.goals?.all() ?? []; }

  /**
   * 只检查停止条件，不生成请求、不写板子事件。
   * MCP 的 pending 请求可以跨宿主思考/进程重启存在，不能只在 prepare() 里检查预算。
   */
  checkBudget(): boolean {
    if (this.done) return false;
    if (this.steps.length >= this.config.maxSteps) {
      this.stopReason = 'max_steps';
      this.done = true;
      return false;
    }
    if (Date.now() - this.startedAt >= this.config.maxWallMs) {
      this.stopReason = 'wall_clock';
      this.done = true;
      this.log(`[stop] 时间预算耗尽（${this.config.maxWallMs}ms）`);
      return false;
    }
    return true;
  }

  /** 准备下一步请求；预算耗尽时只改变停止状态，不执行任何动作。 */
  prepare(): DecideRequest | null {
    if (!this.checkBudget()) return null;
    this.currentStep = this.steps.length + 1;
    this.built = buildContext(this.system, this.history, {
      maxContextChars: this.config.maxContextChars,
      keepRecent: this.config.keepRecent,
    });
    if (this.built.overBudget && !this.warnedOverBudget) {
      this.warnedOverBudget = true;
      const detail = { maxContextChars: this.config.maxContextChars, actualChars: this.built.chars, keepRecent: this.config.keepRecent };
      this.writer.event('context_over_budget', detail);
      this.log(`[context] 预算 ${this.config.maxContextChars} 字符装不下地板（system + 最近 ${this.config.keepRecent} 条 = ${this.built.chars}）。已超预算但保住契约与近期记忆；要真截断请调大 --max-context-chars 或调小 --keep-recent。`);
    }
    const boardText = notesBlock(this.board.plain(), this.board.all());
    if (boardText !== null) this.writer.event('hypothesis_board', { step: this.currentStep, text: boardText, nagging: this.board.nagging() });
    if (this.goals) {
      const goalText = goalsBlock(this.goals.all());
      if (goalText !== null) this.writer.event('goal_board', { step: this.currentStep, text: goalText, nagging: this.goals.nagging() });
    }
    return this.requestFrom(this.built);
  }

  private requestFrom(built: BuiltContext): DecideRequest {
    return {
      task: this.config.task,
      system: this.system,
      messages: built.messages.map((m) => ({ ...m })),
      tools: this.tools.map((t) => structuredClone(t)),
      step: this.currentStep,
      notes: [...this.board.plain()],
      hypotheses: this.board.all(),
      ...(this.goals ? { goals: this.goals.all() } : {}),
    };
  }

  /** 恢复已经生成过的 pending（含解析回炉请求），不重复 prepare、不重复写板面事件。 */
  resume(request: DecideRequest): void {
    if (request.step !== this.steps.length + 1) throw new Error(`恢复请求步号 ${request.step} 与下一步 ${this.steps.length + 1} 不符`);
    this.currentStep = request.step;
    this.built = buildContext(this.system, this.history, {
      maxContextChars: this.config.maxContextChars,
      keepRecent: this.config.keepRecent,
    });
  }

  /** 解析失败的回炉提示。MCP 由宿主重试，CLI 由 brain 重试，但历史更新只有这一处。 */
  addRepair(hint: string): DecideRequest {
    this.history.push({ role: 'user', content: hint });
    this.built = buildContext(this.system, this.history, {
      maxContextChars: this.config.maxContextChars,
      keepRecent: this.config.keepRecent,
    });
    return this.requestFrom(this.built);
  }

  noteBrainRetry(info: BrainRetryInfo): void {
    this.brainRetries++;
    this.writer.event('brain_retry', { step: this.currentStep, ...info });
    this.log(`[brain] 第${this.currentStep}步 服务端拒绝（${info.error.code}），第${info.attempt}/${info.maxRetries}次重试，先等 ${info.waitMs}ms`);
  }

  noteBrainError(attempt: number, error: ErrorInfo): void {
    this.writer.event('brain_error', { step: this.currentStep, attempt, error });
  }

  noteParseFailure(input: unknown, error: ErrorInfo): void {
    this.parseFailures++;
    this.writer.event('parse_failure', { step: this.currentStep, attempt: this.parseFailures, input, error });
  }
  failBrain(): void { this.stopReason = 'brain_failed'; this.done = true; }
  /** 无法证明预写动作是否执行完时只停、不续跑；宁可损失一局，也不重复一个副作用。 */
  interrupt(inFlight: unknown): void {
    this.writer.event('run_interrupted', { step: this.currentStep, inFlight });
    this.stopReason = 'interrupted';
    this.done = true;
  }

  /** 执行一条**已经由大脑给出**的决策。大脑耗时对 MCP 不可测，传 0 并如实写进 config。 */
  async execute(decision: Decision, brainMs = 0): Promise<StepRecord> {
    if (this.done) throw new Error('这一局已经停止，不能继续执行动作');
    if (!this.built) this.prepare();
    const built = this.built!;
    const step = this.currentStep;

    if (decision.surprise) {
      const sj = decision.surprise;
      if (sj.unexpected === null) this.pstats.surpriseMalformed++;
      else {
        this.pstats.surpriseGiven++;
        if (sj.unexpected) this.pstats.surpriseUnexpected++;
        else if (this.lastChecked && this.lastChecked.violated > 0) this.pstats.violatedButNotSurprised++;
      }
      this.writer.event('surprise_judgment', {
        step,
        aboutStep: this.lastCheckedStep,
        aboutViolated: this.lastChecked?.violated ?? null,
        unexpected: sj.unexpected,
        why: sj.why,
      });
      this.lastChecked = null;
      this.lastCheckedStep = null;
    }

    const prevScreen = this.opts.screen ? this.opts.screen() : null;
    const t1 = Date.now();
    const result = await this.opts.registry.execute(decision.call, this.ctx);
    const toolMs = Date.now() - t1;

    let prediction: PredictionRecord | undefined;
    if (this.opts.prediction && prevScreen !== null && this.opts.prediction.applies(decision.call, result)) {
      prediction = this.opts.prediction.check(decision.predict, prevScreen, this.opts.screen!());
      this.pstats.checked++;
      if (!prediction.advanced) this.pstats.staticChecks++;
      if (prediction.given) this.pstats.given++;
      else this.pstats.missing++;
      this.pstats.fields += prediction.diffs.length;
      this.pstats.ok += prediction.diffs.filter((d) => d.status === 'ok').length;
      this.pstats.violated += prediction.violated;
      this.pstats.unverifiable += prediction.unverifiable;
      this.lastChecked = prediction;
      this.lastCheckedStep = step;
      this.writer.event('prediction_check', { step, ...prediction });
      if (prediction.violated > 0) {
        this.log(`[predict] 第${step}步 ${prediction.violated} 项预测与画面不符（${prediction.diffs.filter((d) => d.status === 'violated').map((d) => d.field).join(', ')}）`);
      }
    }

    let goalText: string | null = null;
    if (this.goals && this.opts.goal && this.opts.screen) {
      const checks = this.goals.evaluate((cond) => this.opts.goal!.evaluate(cond, this.opts.screen!()));
      for (const c of checks) {
        if (!this.gstats) continue;
        this.gstats.checks++;
        if (c.met === true) this.gstats.met++;
        else if (c.met === false) this.gstats.unmet++;
        else this.gstats.unverifiable++;
        this.writer.event('goal_check', {
          step, id: c.goal.id, met: c.met, firstMet: c.firstMet,
          diffs: c.diffs, totals: { checks: c.goal.checks, met: c.goal.met, unmet: c.goal.unmet, unverifiable: c.goal.unverifiable },
        });
      }
      goalText = describeGoalCheck(checks);
      if (goalText !== null) this.log(`[goal] 第${step}步 ${goalText.split('\n').length} 条目标的完成条件首次被画面满足`);
    }

    let hypFeedback: string | null = null;
    if (decision.testing) {
      const t = decision.testing;
      const knownIds = this.board.ids();
      let outcome: AttributionOutcome;
      if (t.id === null) {
        this.hstats.malformed++;
        outcome = { problem: 'malformed', test: t, knownIds, result: null };
      } else if (!this.board.get(t.id)) {
        this.hstats.unknownTarget++;
        outcome = { problem: 'unknown_target', test: t, knownIds, result: null };
      } else if (!prediction) {
        this.hstats.notChecked++;
        outcome = { problem: 'not_checked', test: t, knownIds, result: null };
      } else {
        const a = this.board.attribute(t.id, prediction.diffs, t.field)!;
        if (a.fieldAbsent) {
          this.hstats.fieldAbsent++;
          outcome = { problem: 'field_absent', test: t, knownIds, result: null, predictedFields: prediction.diffs.map((x) => x.field) };
        } else {
          this.hstats.attributed++;
          outcome = { problem: null, test: t, knownIds, result: a };
        }
      }
      hypFeedback = describeAttribution(outcome);
      this.writer.event('hypothesis_check', {
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
      if (outcome.problem) this.log(`[board] 第${step}步 归因未成立（${outcome.problem}）：${t.id ?? '形状不可用'}`);
    } else if (prediction) this.hstats.unattributed++;

    const stateHash = this.opts.worldHash
      ? this.opts.worldHash()
      : hashState({
        notes: [...this.board.plain()],
        ...(this.board.ids().length ? { hypotheses: this.board.all() } : {}),
        ...(this.goals && this.goals.ids().length ? { goals: this.goals.all() } : {}),
        entries: snapshotSandbox(this.config.sandbox),
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
    this.steps.push(record);
    this.writer.step(record);
    this.log(`[${step}] ${decision.call.name}(${JSON.stringify(decision.call.args)}) → ${result.ok ? 'ok' : 'FAIL'} | ${decision.thought.slice(0, 80)}`);

    this.history.push({ role: 'assistant', content: JSON.stringify(decision) });
    const feedback = prediction && this.opts.prediction ? this.opts.prediction.describe(prediction) : null;
    const observed = [result.output, feedback, hypFeedback, goalText].filter((x): x is string => x !== null && x !== '').join('\n\n');
    this.history.push({ role: 'tool', toolName: decision.call.name, content: observed });
    if (feedback !== null) this.writer.event('prediction_feedback', { aboutStep: step, text: feedback });
    if (hypFeedback !== null) this.writer.event('hypothesis_feedback', { aboutStep: step, text: hypFeedback });
    if (goalText !== null) this.writer.event('goal_feedback', { aboutStep: step, text: goalText });
    this.parseFailures = 0;
    this.built = null;

    if (decision.call.name === 'finish') {
      this.stopReason = 'finished';
      this.finishSummary = String(decision.call.args['summary'] ?? '');
      this.done = true;
      return record;
    }

    const sig = canonical(decision.call);
    const fp = this.opts.loopFingerprint ? this.opts.loopFingerprint() : null;
    const stuck = fp === null ? sig === this.lastSig : (sig === this.lastSig && fp === this.lastFingerprint);
    if (stuck) this.repeatCount++;
    else { this.lastSig = sig; this.lastFingerprint = fp; this.repeatCount = 1; }
    if (this.repeatCount >= this.config.repeatLimit) {
      this.stopReason = 'loop_detected';
      this.done = true;
      this.writer.event('loop_detected', { step, sig, repeatCount: this.repeatCount, situationUnchanged: fp !== null, fingerprint: fp });
      this.log(`[stop] 连续 ${this.repeatCount} 次重复同一动作${fp === null ? '' : '且局面毫无变化'}，判定死循环`);
    } else if (this.steps.length >= this.config.maxSteps) {
      this.stopReason = 'max_steps';
      this.done = true;
    }
    return record;
  }

  /** 局末快照与 result.json。幂等：MCP 重复 status 不会重复累计状态条数。 */
  finalize(): RunResult {
    if (this.finalResult) return structuredClone(this.finalResult);
    if (!this.snapshotsCounted) {
      for (const h of this.board.all()) this.hstats[h.status]++;
      this.hstats.plainNotes = this.board.plain().length;
      this.hstats.contradictedNotRetired = this.board.contradictedNotRetired().length;
      this.hstats.confirmedNoChecks = this.board.confirmedNoChecks().length;
      if (this.hstats.contradictedNotRetired > 0) {
        this.log(`[board] 收手时仍有 ${this.hstats.contradictedNotRetired} 条假设被客观核对反对、却未被淘汰：${this.board.contradictedNotRetired().join(', ')}（代码不代它淘汰，只如实记一笔）`);
      }
      if (this.hstats.confirmedNoChecks > 0) {
        this.log(`[board] 收手时有 ${this.hstats.confirmedNoChecks} 条假设被标为 confirmed、归因到它名下的客观核对却是 0 次：${this.board.confirmedNoChecks().join(', ')}（自称已验证 ≠ 账本上有核对）`);
      }
      if (this.goals) {
        for (const g of this.goals.all()) {
          this.gstats![g.status]++;
          if (goalCheckable(g)) this.gstats!.withCondition++;
        }
        this.gstats!.metNotClosed = this.goals.metNotClosed().length;
        this.gstats!.closedNeverMet = this.goals.closedNeverMet().length;
        this.gstats!.uncheckable = this.goals.uncheckable().length;
        if (this.gstats!.metNotClosed > 0) this.log(`[goal] 收手时画面已满足、却仍标 open 的目标：${this.goals.metNotClosed().join(', ')}（代码只判定，要不要收口由你判断）`);
        if (this.gstats!.closedNeverMet > 0) this.log(`[goal] 收手时自称 achieved、却被画面判定从未满足过的目标：${this.goals.closedNeverMet().join(', ')}（自称达成 ≠ 画面上达成）`);
        if (this.gstats!.uncheckable > 0) this.log(`[goal] 收手时仍判不出结果的目标：${this.goals.uncheckable().join(', ')}（doneWhen 缺失、形状不可用，或字段全不在词表里）`);
      }
      this.snapshotsCounted = true;
    }
    const result: RunResult = {
      runId: this.runId,
      runDir: this.writer.runDir,
      stopReason: this.stopReason,
      steps: structuredClone(this.steps),
      notes: [...this.board.plain()],
      hypotheses: this.board.all(),
      goals: this.goals?.all() ?? [],
      ...(this.finishSummary !== undefined ? { finishSummary: this.finishSummary } : {}),
      actionSequence: toActionSequence(this.steps),
      durationMs: Date.now() - this.startedAt,
      brainRetries: this.brainRetries,
      parseFailures: this.parseFailures,
      ...(this.opts.prediction ? { predictionStats: { ...this.pstats } } : {}),
      hypothesisStats: { ...this.hstats },
      ...(this.opts.goal ? { goalStats: this.gstats ? { ...this.gstats } : undefined } : {}),
    };
    this.writer.result(result);
    this.finalResult = structuredClone(result);
    return result;
  }

  checkpoint(): EngineCheckpoint {
    return structuredClone({
      version: 1,
      runId: this.runId,
      currentStep: this.currentStep,
      startedAt: this.startedAt,
      headerAt: this.headerAt,
      brainId: this.opts.brainId,
      steps: this.steps,
      history: this.history,
      notes: [...this.board.plain()],
      hypotheses: this.board.all(),
      goals: this.goals?.all() ?? [],
      predictionStats: this.pstats,
      hypothesisStats: this.hstats,
      goalStats: this.gstats,
      lastChecked: this.lastChecked,
      lastCheckedStep: this.lastCheckedStep,
      lastSig: this.lastSig,
      lastFingerprint: this.lastFingerprint,
      repeatCount: this.repeatCount,
      warnedOverBudget: this.warnedOverBudget,
      done: this.done,
      stopReason: this.stopReason,
      ...(this.finishSummary !== undefined ? { finishSummary: this.finishSummary } : {}),
      brainRetries: this.brainRetries,
      parseFailures: this.parseFailures,
      snapshotsCounted: this.snapshotsCounted,
      ...(this.finalResult ? { finalResult: this.finalResult } : {}),
    });
  }
}

function joinRunDir(outDir: string, runId: string): string {
  // 只做字符串拼接：runId 由本模块生成/从受控 checkpoint 读取，不接收任意路径。
  return `${outDir.replace(/[\\/]+$/, '')}/${runId}`;
}
