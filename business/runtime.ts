import { randomUUID } from 'node:crypto';
import {
  decisionEvent, outputSummary, startedEvent, type AuditEvent, type RunJournal,
} from './audit.ts';
import { asBusinessError, BusinessError, isRecord } from './errors.ts';
import type { KnowledgeStore, TicketStore } from './store.ts';
import { toTicketView } from './store.ts';
import { createSupportTools } from './support-tools.ts';
import { requireArgs, ToolRegistry, type ApprovalGateway } from './tools.ts';
import type {
  BusinessRequest, BusinessRunResult, BusinessToolSpec, Decision, FinishedResult,
  Observation, RepairRequiredResult, StartInput, StartedResult, StepInput, StepResult,
  TicketRecord,
} from './types.ts';

export interface BusinessRuntimeOptions {
  tickets: TicketStore;
  knowledge: KnowledgeStore;
  journalFactory: (runId: string) => RunJournal;
  tools?: ToolRegistry;
  approval?: ApprovalGateway;
  maxActiveRuns?: number;
  defaultMaxSteps?: number;
  defaultMaxWallMs?: number;
  toolTimeoutMs?: number;
  now?: () => number;
  makeId?: () => string;
}

interface RunEntry {
  id: string;
  ticketId: string;
  ticket: TicketRecord;
  step: number;
  maxSteps: number;
  deadlineAt: number;
  journal: RunJournal;
  queue: Promise<unknown>;
  recent: Observation[];
  result?: BusinessRunResult;
}

export interface StatusResult {
  kind: 'status';
  request: BusinessRequest;
}

const FINISH_TOOL: BusinessToolSpec = {
  name: 'finish',
  description: '结束本次业务处理并给出摘要。不会发送消息、改变工单状态或执行其他外部副作用。',
  effect: 'draft',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary'],
    properties: { summary: { type: 'string', minLength: 1, maxLength: 1000 } },
  },
};

const SYSTEM_PROMPT =
  '你是业务 Agent 的大脑。server 只执行和校验，不替你做决策。' +
  '先读 ticket、tools 与 recentObservations，再只提交一个动作。' +
  '回复客户前应检索知识库并保存草稿；草稿不等于发送。' +
  '写入前使用 request.ticket.revision，发生冲突先 ticket.get。' +
  '外部写入默认不暴露；即使可见，也必须持有审批服务签发的一次性 token，模型不能自行伪造同意。' +
  '任务完成或无法推进时调用 finish，并如实说明未完成项。';

function boundedInt(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BusinessError('invalid_args', `${name} 必须是 ${min}..${max} 的整数。`);
  }
  return value;
}

function validateStart(input: StartInput): { ticketId: string; maxSteps?: number; maxWallMs?: number } {
  if (!isRecord(input)) throw new BusinessError('invalid_args', 'case_start 参数必须是对象。');
  for (const key of Object.keys(input)) {
    if (!['ticketId', 'maxSteps', 'maxWallMs'].includes(key)) {
      throw new BusinessError('invalid_args', `case_start 不接受参数 ${key}。`);
    }
  }
  const ticketId = input['ticketId'];
  if (typeof ticketId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(ticketId)) {
    throw new BusinessError('invalid_args', 'ticketId 必须是 1..80 位字母、数字、下划线或连字符。');
  }
  return {
    ticketId,
    ...(input['maxSteps'] === undefined ? {} : { maxSteps: boundedInt(input['maxSteps'], 0, 1, 50, 'maxSteps') }),
    ...(input['maxWallMs'] === undefined ? {} : { maxWallMs: boundedInt(input['maxWallMs'], 0, 1000, 900_000, 'maxWallMs') }),
  };
}

function parseDecision(value: unknown): Decision | { error: string } {
  if (!isRecord(value)) return { error: 'decision 必须是对象。' };
  const thought = value['thought'];
  const call = value['call'];
  if (typeof thought !== 'string' || thought.trim().length < 1 || thought.length > 2000) {
    return { error: 'decision.thought 必须是 1..2000 字符的非空字符串。' };
  }
  if (!isRecord(call) || typeof call['name'] !== 'string' || call['name'].trim() === '') {
    return { error: 'decision.call.name 必须是非空字符串。' };
  }
  if (!isRecord(call['args'])) return { error: 'decision.call.args 必须是对象。' };
  return { thought: thought.trim(), call: { name: call['name'].trim(), args: call['args'] } };
}

/** 单进程最小 runtime：每 run 串行、expectedStep 防重、审计先于动作、停止后不重放。 */
export class BusinessRuntime {
  private readonly options: BusinessRuntimeOptions;
  private readonly runs = new Map<string, RunEntry>();
  private readonly registry: ToolRegistry;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly maxActiveRuns: number;
  private readonly defaultMaxSteps: number;
  private readonly defaultMaxWallMs: number;
  private readonly toolTimeoutMs: number;

  constructor(options: BusinessRuntimeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? (() => `biz-${randomUUID()}`);
    this.maxActiveRuns = options.maxActiveRuns ?? 8;
    this.defaultMaxSteps = options.defaultMaxSteps ?? 12;
    this.defaultMaxWallMs = options.defaultMaxWallMs ?? 300_000;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 10_000;
    this.registry = options.tools ?? new ToolRegistry(createSupportTools(options.tickets, options.knowledge));
    if (!Number.isInteger(this.defaultMaxSteps) || this.defaultMaxSteps < 1 || this.defaultMaxSteps > 50) {
      throw new BusinessError('invalid_args', 'defaultMaxSteps 必须是 1..50 的整数。');
    }
    if (!Number.isInteger(this.defaultMaxWallMs) || this.defaultMaxWallMs < 1000 || this.defaultMaxWallMs > 900_000) {
      throw new BusinessError('invalid_args', 'defaultMaxWallMs 必须是 1000..900000 的整数。');
    }
    if (!Number.isInteger(this.maxActiveRuns) || this.maxActiveRuns < 1 || this.maxActiveRuns > 64) {
      throw new BusinessError('invalid_args', 'maxActiveRuns 必须是 1..64 的整数。');
    }
    if (!Number.isInteger(this.toolTimeoutMs) || this.toolTimeoutMs < 50 || this.toolTimeoutMs > 120_000) {
      throw new BusinessError('invalid_args', 'toolTimeoutMs 必须是 50..120000 的整数。');
    }
  }

  async start(input: StartInput): Promise<StartedResult> {
    const checked = validateStart(input);
    const active = [...this.runs.values()].filter((run) => run.result === undefined).length;
    if (active >= this.maxActiveRuns) throw new BusinessError('denied', `进行中的业务会话已达上限 ${this.maxActiveRuns}。`);
    const ticket = await this.options.tickets.get(checked.ticketId, AbortSignal.timeout(this.toolTimeoutMs));
    if (ticket === undefined) throw new BusinessError('not_found', `工单不存在：${checked.ticketId}`);
    const maxSteps = checked.maxSteps ?? this.defaultMaxSteps;
    const maxWallMs = checked.maxWallMs ?? this.defaultMaxWallMs;
    const runId = this.makeId();
    const journal = this.options.journalFactory(runId);
    const run: RunEntry = {
      id: runId,
      ticketId: checked.ticketId,
      ticket,
      step: 1,
      maxSteps,
      deadlineAt: this.now() + maxWallMs,
      journal,
      queue: Promise.resolve(),
      recent: [],
    };
    try {
      await journal.append(startedEvent(runId, ticket, maxSteps, maxWallMs));
    } catch (error) {
      throw new BusinessError('audit_unavailable', '业务审计不可用，未创建会话。', { cause: error });
    }
    this.runs.set(runId, run);
    return { kind: 'started', runId, request: this.request(run) };
  }

  async status(runId: string): Promise<StatusResult | FinishedResult> {
    const run = this.getRun(runId);
    return this.enqueue(run, async () => run.result === undefined
      ? { kind: 'status', request: this.request(run) }
      : { kind: 'finished', result: structuredClone(run.result) });
  }

  async step(input: StepInput): Promise<StepResult> {
    if (!isRecord(input) || typeof input['runId'] !== 'string') {
      throw new BusinessError('invalid_args', 'case_step.runId 必须是非空字符串。');
    }
    const run = this.getRun(input['runId']);
    return this.enqueue(run, async () => {
      if (run.result !== undefined) return { kind: 'finished', result: structuredClone(run.result) };
      if (typeof input['expectedStep'] !== 'number' || !Number.isInteger(input['expectedStep'])) {
        throw new BusinessError('invalid_args', 'expectedStep 必须是整数。');
      }
      if (input['expectedStep'] !== run.step) {
        throw new BusinessError('stale_step', `expectedStep=${input['expectedStep']} 已过期；当前下一步是 ${run.step}。`);
      }
      const budgetStop = await this.enforceBudget(run);
      if (budgetStop !== undefined) return budgetStop;

      const decision = parseDecision(input['decision']);
      if ('error' in decision) return this.repair(run, 'invalid_decision', decision.error, '按 request.tools 重新提交一条 Decision。');
      if (decision.call.name === 'finish') {
        const args = requireArgs(decision.call.args);
        const summary = args['summary'];
        if (typeof summary !== 'string' || summary.trim().length < 1 || summary.length > 1000 || Object.keys(args).length !== 1) {
          return this.repair(run, 'invalid_args', 'finish.summary 必须是 1..1000 字符的非空字符串，且不能有其他参数。', '保留未完成项，重新提交 finish。');
        }
        return this.finalize(run, 'finish', summary.trim(), true);
      }

      try {
        await run.journal.append(decisionEvent(run.id, run.step, decision));
      } catch (error) {
        throw new BusinessError('audit_unavailable', '动作执行前无法写入审计，已拒绝执行；当前步未消耗。', { cause: error });
      }

      const startedAt = this.now();
      const controller = new AbortController();
      let output: unknown;
      let failure: BusinessError | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new BusinessError('timeout', `工具 ${decision.call.name} 超过 ${this.toolTimeoutMs}ms；结果未知，本会话停止且不会自动重试。`, { outcomeUnknown: true });
          reject(error);
          controller.abort(error);
        }, this.toolTimeoutMs);
      });
      try {
        output = await Promise.race([
          this.registry.execute(decision.call.name, decision.call.args, {
            runId: run.id,
            ticketId: run.ticketId,
            tickets: this.options.tickets,
            knowledge: this.options.knowledge,
            approval: this.options.approval,
            signal: controller.signal,
          }),
          timeout,
        ]);
      } catch (error) {
        failure = asBusinessError(error, 'internal');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      if (failure?.outcomeUnknown === true) {
        const event = this.actionEvent(run, decision, failure, undefined, startedAt, false);
        await run.journal.append(event).catch(() => undefined);
        return this.finalize(run, 'tool_outcome_unknown', null, false);
      }
      if (failure?.code === 'invalid_args') {
        return this.repair(run, failure.code, failure.message, '修正参数后使用同一个 expectedStep 重试。');
      }

      // 动作已经返回（无论成功或失败），刷新业务视图；读不到就不能继续猜测状态。
      let latest: TicketRecord;
      try {
        const refreshed = await this.options.tickets.get(run.ticketId, AbortSignal.timeout(this.toolTimeoutMs));
        if (refreshed === undefined) throw new BusinessError('not_found', `工单不存在：${run.ticketId}`);
        latest = refreshed;
      } catch (error) {
        const storeError = asBusinessError(error, 'store_unavailable');
        await run.journal.append(this.actionEvent(run, decision, storeError, undefined, startedAt, false)).catch(() => undefined);
        return this.finalize(run, 'store_unavailable', null, false);
      }
      run.ticket = latest;
      const observation: Observation = {
        step: run.step,
        tool: decision.call.name,
        ok: failure === undefined,
        output: failure === undefined ? output : null,
        ...(failure === undefined ? {} : { error: { code: failure.code, message: failure.message.slice(0, 500) } }),
        outcomeCertain: true,
      };
      try {
        await run.journal.append(this.actionEvent(run, decision, failure, output, startedAt, true));
      } catch (error) {
        return this.finalize(run, 'audit_failed', null, false);
      }
      run.recent = [...run.recent, observation].slice(-8);
      run.step += 1;
      if (run.step > run.maxSteps) return this.finalize(run, 'max_steps', null, true);
      const budgetAfter = await this.enforceBudget(run);
      if (budgetAfter !== undefined) return budgetAfter;
      return { kind: 'stepped', observation, request: this.request(run) };
    });
  }

  private getRun(runId: string): RunEntry {
    const run = this.runs.get(runId);
    if (run === undefined) throw new BusinessError('not_found', `找不到业务会话：${runId}`);
    return run;
  }

  private enqueue<T>(run: RunEntry, operation: () => Promise<T>): Promise<T> {
    const result = run.queue.then(operation, operation);
    run.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private request(run: RunEntry): BusinessRequest {
    return {
      kind: 'business_request',
      runId: run.id,
      step: run.step,
      maxSteps: run.maxSteps,
      remainingMs: Math.max(0, run.deadlineAt - this.now()),
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `请处理工单 ${run.ticket.id}：${run.ticket.subject}。先理解客户问题，检索知识库，必要时保存回复草稿或内部备注，最后用 finish 说明结果。`,
      }],
      ticket: toTicketView(run.ticket),
      tools: [...this.registry.specs(this.options.approval !== undefined), FINISH_TOOL],
      recentObservations: structuredClone(run.recent),
    };
  }

  private async repair(run: RunEntry, code: string, message: string, hint: string): Promise<RepairRequiredResult> {
    try {
      await run.journal.append({
        at: new Date().toISOString(), runId: run.id, step: run.step,
        type: 'repair_required', errorCode: code, outcomeCertain: true,
      });
    } catch (error) {
      throw new BusinessError('audit_unavailable', '无法记录解析失败，已拒绝继续；当前步未消耗。', { cause: error });
    }
    return { kind: 'repair_required', error: { code, message: message.slice(0, 500), hint }, request: this.request(run) };
  }

  private async enforceBudget(run: RunEntry): Promise<FinishedResult | undefined> {
    if (this.now() >= run.deadlineAt) return this.finalize(run, 'wall_clock', null, true);
    if (run.step > run.maxSteps) return this.finalize(run, 'max_steps', null, true);
    return undefined;
  }

  private actionEvent(
    run: RunEntry,
    decision: Decision,
    failure: BusinessError | undefined,
    output: unknown,
    startedAt: number,
    outcomeCertain: boolean,
  ): AuditEvent {
    return {
      at: new Date().toISOString(),
      runId: run.id,
      step: run.step,
      type: 'action_completed',
      tool: decision.call.name,
      ok: failure === undefined,
      outcomeCertain,
      durationMs: this.now() - startedAt,
      ...(failure === undefined ? outputSummary(output) : { errorCode: failure.code }),
      ticketRevision: run.ticket.revision,
    };
  }

  private async finalize(
    run: RunEntry,
    reason: BusinessRunResult['stopReason'],
    summary: string | null,
    outcomeCertain: boolean,
  ): Promise<FinishedResult> {
    if (run.result !== undefined) return { kind: 'finished', result: structuredClone(run.result) };
    let finalReason = reason;
    let finalOutcomeCertain = outcomeCertain;
    try {
      await run.journal.append({
        at: new Date().toISOString(), runId: run.id, step: run.step,
        type: 'run_finished', stopReason: finalReason, outcomeCertain: finalOutcomeCertain,
        ticketRevision: run.ticket.revision,
      });
    } catch {
      finalReason = 'audit_failed';
      finalOutcomeCertain = false;
    }
    const result: BusinessRunResult = {
      kind: 'business_finished',
      runId: run.id,
      status: finalReason === 'finish' ? 'finished' : (finalReason === 'max_steps' || finalReason === 'wall_clock' ? 'stopped' : 'interrupted'),
      stopReason: finalReason,
      stepCount: run.step - 1,
      finishSummary: summary,
      outcomeCertain: finalOutcomeCertain,
      ticket: toTicketView(run.ticket),
      auditPath: run.journal.auditPath,
      resultPath: run.journal.resultPath,
      resultWritten: false,
    };
    try {
      await run.journal.finish({ ...result, resultWritten: true });
      result.resultWritten = true;
    } catch {
      result.stopReason = 'audit_failed';
      result.status = 'interrupted';
      result.outcomeCertain = false;
      result.resultWritten = false;
    }
    run.result = result;
    return { kind: 'finished', result: structuredClone(result) };
  }
}
