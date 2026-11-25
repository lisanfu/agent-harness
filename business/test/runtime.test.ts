import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRunJournal } from '../audit.ts';
import { BusinessError } from '../errors.ts';
import { BusinessRuntime } from '../runtime.ts';
import { createDemoStores } from '../store.ts';
import { ToolRegistry, type ApprovalGateway } from '../tools.ts';
import type { Decision, StepInput } from '../types.ts';

function decision(name: string, args: Record<string, unknown> = {}, thought = 'test decision'): Decision {
  return { thought, call: { name, args } };
}

function setup(options: {
  maxActiveRuns?: number;
  defaultMaxSteps?: number;
  defaultMaxWallMs?: number;
  toolTimeoutMs?: number;
  approval?: ApprovalGateway;
  tools?: ToolRegistry;
  now?: () => number;
  journalFactory?: (runId: string) => MemoryRunJournal;
} = {}) {
  const stores = createDemoStores();
  const journals = new Map<string, MemoryRunJournal>();
  let sequence = 0;
  const runtime = new BusinessRuntime({
    ...stores,
    ...options,
    journalFactory: (runId) => {
      const journal = options.journalFactory?.(runId) ?? new MemoryRunJournal();
      journals.set(runId, journal);
      return journal;
    },
    makeId: () => `biz-00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  });
  return { runtime, journals, ...stores };
}

test('start 只暴露安全业务视图，默认隐藏外部写入', async () => {
  const { runtime } = setup();
  const started = await runtime.start({ ticketId: 'T-1001' });
  assert.equal(started.request.step, 1);
  assert.equal(started.request.ticket.revision, 1);
  assert.equal(started.request.tools.some((tool) => tool.effect === 'external'), false);
  assert.equal(JSON.stringify(started.request).includes('internalNotes'), false);
  assert.equal(JSON.stringify(started.request).includes('示例数据：不含真实客户信息'), false);
  const status = await runtime.status(started.runId);
  assert.equal(status.kind, 'status');
  if (status.kind === 'status') assert.equal(status.request.step, 1);
});

test('未知工具和坏参数返回 repair_required，不消耗当前步', async () => {
  const { runtime } = setup();
  const started = await runtime.start({ ticketId: 'T-1001' });
  const unknown = await runtime.step({ runId: started.runId, expectedStep: 1, decision: decision('no.such.tool') });
  assert.equal(unknown.kind, 'repair_required');
  if (unknown.kind === 'repair_required') assert.equal(unknown.request.step, 1);

  const invalid = await runtime.step({
    runId: started.runId,
    expectedStep: 1,
    decision: decision('knowledge.search', { query: 123 }),
  });
  assert.equal(invalid.kind, 'repair_required');
  if (invalid.kind === 'repair_required') assert.equal(invalid.request.step, 1);

  const valid = await runtime.step({
    runId: started.runId,
    expectedStep: 1,
    decision: decision('knowledge.search', { query: '退款' }),
  });
  assert.equal(valid.kind, 'stepped');
  if (valid.kind === 'stepped') assert.equal(valid.request.step, 2);
});

test('同一 expectedStep 并发只执行一次，另一条明确过期', async () => {
  const { runtime, journals } = setup();
  const started = await runtime.start({ ticketId: 'T-1001' });
  const input: StepInput = { runId: started.runId, expectedStep: 1, decision: decision('ticket.get') };
  const results = await Promise.allSettled([runtime.step(input), runtime.step(input)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.match(String(rejected.reason), /过期|stale_step/);
  const journal = journals.get(started.runId)!;
  assert.equal(journal.events.filter((event) => event.type === 'action_completed').length, 1);
});

test('草稿与内部备注可写，finish 不触发外部发送且审计不落原文', async () => {
  const { runtime, journals, tickets } = setup();
  const started = await runtime.start({ ticketId: 'T-1001' });
  const secretDraft = '这是回复草稿原文，不应进入审计摘要。';
  const drafted = await runtime.step({
    runId: started.runId,
    expectedStep: 1,
    decision: decision('ticket.draftReply', { expectedRevision: 1, text: secretDraft }, 'thought 原文也不应进入审计'),
  });
  assert.equal(drafted.kind, 'stepped');
  if (drafted.kind === 'stepped') assert.equal(drafted.request.ticket.revision, 2);
  const noted = await runtime.step({
    runId: started.runId,
    expectedStep: 2,
    decision: decision('ticket.addNote', { expectedRevision: 2, text: '已核对 KB-REFUND-01' }),
  });
  assert.equal(noted.kind, 'stepped');
  const finished = await runtime.step({
    runId: started.runId,
    expectedStep: 3,
    decision: decision('finish', { summary: '已保存草稿和内部备注，未发送。' }),
  });
  assert.equal(finished.kind, 'finished');
  if (finished.kind === 'finished') {
    assert.equal(finished.result.stopReason, 'finish');
    assert.equal(finished.result.stepCount, 2);
    assert.equal(finished.result.outcomeCertain, true);
    assert.equal(finished.result.resultWritten, true);
    assert.equal(finished.result.ticket.status, 'open');
  }
  const stored = await tickets.get('T-1001', new AbortController().signal);
  assert.equal(stored?.draftReply, secretDraft);
  assert.deepEqual(stored?.internalNotes, ['示例数据：不含真实客户信息。', '已核对 KB-REFUND-01']);
  const audit = JSON.stringify(journals.get(started.runId)?.events);
  assert.equal(audit.includes(secretDraft), false);
  assert.equal(audit.includes('thought 原文'), false);
  assert.equal(audit.includes('已核对 KB-REFUND-01'), false);
});

test('revision 冲突消耗一步并返回可行动的 observation', async () => {
  const { runtime } = setup();
  const started = await runtime.start({ ticketId: 'T-1001' });
  const conflicted = await runtime.step({
    runId: started.runId,
    expectedStep: 1,
    decision: decision('ticket.draftReply', { expectedRevision: 99, text: '这段草稿不会覆盖最新工单。' }),
  });
  assert.equal(conflicted.kind, 'stepped');
  if (conflicted.kind === 'stepped') {
    assert.equal(conflicted.observation.ok, false);
    assert.equal(conflicted.observation.error?.code, 'conflict');
    assert.equal(conflicted.request.step, 2);
    assert.match(conflicted.observation.error?.message ?? '', /ticket.get/);
  }
});

test('max_steps 与 wall_clock 都是真实停止，不伪装成 finish', async () => {
  const stepped = setup();
  const started = await stepped.runtime.start({ ticketId: 'T-1001', maxSteps: 1 });
  const maxSteps = await stepped.runtime.step({ runId: started.runId, expectedStep: 1, decision: decision('ticket.get') });
  assert.equal(maxSteps.kind, 'finished');
  if (maxSteps.kind === 'finished') {
    assert.equal(maxSteps.result.stopReason, 'max_steps');
    assert.equal(maxSteps.result.finishSummary, null);
    assert.equal(maxSteps.result.stepCount, 1);
  }

  let now = 1000;
  const timed = setup({ now: () => now });
  const timedStart = await timed.runtime.start({ ticketId: 'T-1001', maxWallMs: 1000 });
  now += 1001;
  const wallClock = await timed.runtime.step({
    runId: timedStart.runId,
    expectedStep: 1,
    decision: decision('finish', { summary: '这个 finish 不应穿过墙钟。' }),
  });
  assert.equal(wallClock.kind, 'finished');
  if (wallClock.kind === 'finished') {
    assert.equal(wallClock.result.stopReason, 'wall_clock');
    assert.equal(wallClock.result.finishSummary, null);
    assert.equal(wallClock.result.stepCount, 0);
  }
});

test('外部写入默认拒绝；审批 token 只能消费一次', async () => {
  const denied = setup();
  const deniedStart = await denied.runtime.start({ ticketId: 'T-1001' });
  const deniedResult = await denied.runtime.step({
    runId: deniedStart.runId,
    expectedStep: 1,
    decision: decision('ticket.setStatus', { expectedRevision: 1, status: 'resolved', approvalToken: 'not-issued' }),
  });
  assert.equal(deniedResult.kind, 'stepped');
  if (deniedResult.kind === 'stepped') assert.equal(deniedResult.observation.error?.code, 'denied');

  const consumed = new Set<string>();
  const approval: ApprovalGateway = {
    async authorizeAndConsume(request) {
      if (request.token !== 'one-time-token' || consumed.has(request.token)) {
        return { allow: false, reason: 'token 无效或已消费' };
      }
      consumed.add(request.token);
      return { allow: true, reason: 'fixture 审批通过' };
    },
  };
  const allowed = setup({ approval });
  const first = await allowed.runtime.start({ ticketId: 'T-1001' });
  assert.equal(first.request.tools.some((tool) => tool.name === 'ticket.setStatus'), true);
  const changed = await allowed.runtime.step({
    runId: first.runId,
    expectedStep: 1,
    decision: decision('ticket.setStatus', { expectedRevision: 1, status: 'resolved', approvalToken: 'one-time-token' }),
  });
  assert.equal(changed.kind, 'stepped');
  if (changed.kind === 'stepped') {
    assert.equal(changed.observation.ok, true);
    assert.equal(changed.request.ticket.status, 'resolved');
  }

  const second = await allowed.runtime.start({ ticketId: 'T-1002' });
  const replay = await allowed.runtime.step({
    runId: second.runId,
    expectedStep: 1,
    decision: decision('ticket.setStatus', { expectedRevision: 1, status: 'resolved', approvalToken: 'one-time-token' }),
  });
  assert.equal(replay.kind, 'stepped');
  if (replay.kind === 'stepped') assert.equal(replay.observation.error?.code, 'denied');
  const audit = JSON.stringify(allowed.journals.get(first.runId)?.events);
  assert.equal(audit.includes('one-time-token'), false);
});

test('工具超时结果未知：会话停止且不自动重试', async () => {
  const stores = createDemoStores();
  const slowTool = {
    name: 'slow.write',
    description: 'fixture：故意忽略取消的慢写入',
    effect: 'draft' as const,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    parse(raw: Record<string, unknown>) { return raw; },
    async execute(_input: unknown, context: any) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      // 模拟不遵守 AbortSignal 的外部适配器：超时后仍可能完成写入。
      return context.tickets.update(context.ticketId, 1, { draftReply: '超时后仍可能完成的写入' }, new AbortController().signal);
    },
  };
  let sequence = 0;
  const runtime = new BusinessRuntime({
    ...stores,
    tools: new ToolRegistry([slowTool]),
    journalFactory: () => new MemoryRunJournal(),
    toolTimeoutMs: 50,
    makeId: () => `biz-00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  });
  const started = await runtime.start({ ticketId: 'T-1001' });
  const timedOut = await runtime.step({ runId: started.runId, expectedStep: 1, decision: decision('slow.write') });
  assert.equal(timedOut.kind, 'finished');
  if (timedOut.kind === 'finished') {
    assert.equal(timedOut.result.stopReason, 'tool_outcome_unknown');
    assert.equal(timedOut.result.status, 'interrupted');
    assert.equal(timedOut.result.outcomeCertain, false);
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  const stored = await stores.tickets.get('T-1001', new AbortController().signal);
  assert.equal(stored?.draftReply, '超时后仍可能完成的写入');
  const repeated = await runtime.step({ runId: started.runId, expectedStep: 1, decision: decision('slow.write') });
  assert.equal(repeated.kind, 'finished');
  if (repeated.kind === 'finished') assert.equal(repeated.result.stopReason, 'tool_outcome_unknown');
});

test('动作前审计失败则拒绝执行，当前步不消耗', async () => {
  class FailingJournal extends MemoryRunJournal {
    override async append(event: Parameters<MemoryRunJournal['append']>[0]): Promise<void> {
      if (event.type === 'decision_received') throw new Error('disk full');
      return super.append(event);
    }
  }
  const { runtime, tickets } = setup({ journalFactory: () => new FailingJournal() });
  const started = await runtime.start({ ticketId: 'T-1001' });
  await assert.rejects(
    runtime.step({
      runId: started.runId,
      expectedStep: 1,
      decision: decision('ticket.draftReply', { expectedRevision: 1, text: '审计失败时不应写入。' }),
    }),
    (error: unknown) => error instanceof BusinessError && error.code === 'audit_unavailable',
  );
  const stored = await tickets.get('T-1001', new AbortController().signal);
  assert.equal(stored?.draftReply, null);
  const status = await runtime.status(started.runId);
  assert.equal(status.kind, 'status');
  if (status.kind === 'status') assert.equal(status.request.step, 1);
});

test('动作后的审计失败标记 interrupted，不把已发生的写入说成未发生', async () => {
  class PostActionFailureJournal extends MemoryRunJournal {
    override async append(event: Parameters<MemoryRunJournal['append']>[0]): Promise<void> {
      if (event.type === 'action_completed') throw new Error('append failed');
      return super.append(event);
    }
  }
  const { runtime, tickets } = setup({ journalFactory: () => new PostActionFailureJournal() });
  const started = await runtime.start({ ticketId: 'T-1001' });
  const result = await runtime.step({
    runId: started.runId,
    expectedStep: 1,
    decision: decision('ticket.draftReply', { expectedRevision: 1, text: '写入已发生但审计失败。' }),
  });
  assert.equal(result.kind, 'finished');
  if (result.kind === 'finished') {
    assert.equal(result.result.stopReason, 'audit_failed');
    assert.equal(result.result.status, 'interrupted');
    assert.equal(result.result.outcomeCertain, false);
  }
  const stored = await tickets.get('T-1001', new AbortController().signal);
  assert.equal(stored?.draftReply, '写入已发生但审计失败。');
  const repeated = await runtime.step({
    runId: started.runId,
    expectedStep: 1,
    decision: decision('ticket.draftReply', { expectedRevision: 2, text: '不应自动重试。' }),
  });
  assert.equal(repeated.kind, 'finished');
  if (repeated.kind === 'finished') assert.equal(repeated.result.stopReason, 'audit_failed');
});

test('活跃会话上限与收手释放名额', async () => {
  const { runtime } = setup({ maxActiveRuns: 1 });
  const first = await runtime.start({ ticketId: 'T-1001' });
  await assert.rejects(runtime.start({ ticketId: 'T-1002' }), /上限/);
  await runtime.step({ runId: first.runId, expectedStep: 1, decision: decision('finish', { summary: '完成' }) });
  const second = await runtime.start({ ticketId: 'T-1002' });
  assert.equal(second.kind, 'started');
});
