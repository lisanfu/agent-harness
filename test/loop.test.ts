/**
 * harness 集成测试。用 MockBrain（测试替身，不是大脑）驱动，
 * 目的是把五种停止条件、解析回炉、证据完整性全部真跑一遍。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockBrain } from '../src/brain/mock.ts';
import { runHarness } from '../src/loop.ts';
import { builtinTools } from '../src/tools/builtin.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { Decision, HarnessConfig } from '../src/types.ts';

function cfg(over: Partial<HarnessConfig> = {}): HarnessConfig {
  const sandbox = mkdtempSync(join(tmpdir(), 'harness-sbx-'));
  writeFileSync(join(sandbox, 'a.txt'), 'hello');
  return {
    task: '测试任务', sandbox, seed: 42, maxSteps: 10, maxWallMs: 30_000,
    maxContextChars: 12_000, keepRecent: 8, maxParseRetry: 2, repeatLimit: 3,
    outDir: mkdtempSync(join(tmpdir(), 'harness-out-')),
    ...over,
  };
}

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of builtinTools()) r.register(t);
  return r;
}

const d = (name: string, args: Record<string, unknown> = {}, thought = 't'): Decision =>
  ({ thought, call: { name, args } });

test('finished：大脑主动收手，证据三件套齐全', async () => {
  const c = cfg();
  const r = await runHarness({
    brain: new MockBrain([d('list_dir'), d('note', { text: '假设A' }), d('finish', { summary: '结论X' })]),
    registry: reg(), config: c,
  });
  assert.equal(r.stopReason, 'finished');
  assert.equal(r.finishSummary, '结论X');
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.notes, ['假设A']);
  assert.deepEqual(r.actionSequence.map((a) => a.name), ['list_dir', 'note', 'finish']);
  assert.ok(existsSync(join(r.runDir, 'header.json')));
  assert.ok(existsSync(join(r.runDir, 'trace.jsonl')));
  assert.ok(existsSync(join(r.runDir, 'result.json')));

  const header = JSON.parse(readFileSync(join(r.runDir, 'header.json'), 'utf8'));
  assert.equal(header.seed, 42);
  // 文件模式没有画面 → 预测与目标两条通道都不存在；没有世界 → 也就没有耳朵。
  // seams 写 false 而不是省略，是为了让"这局没这器官"和"器官在但没跑"在证据里是两件事。
  assert.deepEqual(header.seams, { predict: false, goal: false, ear: false }, '没有屏幕的 harness 不许声明自己有感知校验通道');
  assert.ok(Array.isArray(header.initialState.sandboxEntries));
  assert.ok(header.initialState.sandboxEntries.some((e: string) => e.includes('a.txt')));

  const rows = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  // 判据是"每一步恰好一条步记录"，不是"总行数等于步数"。
  // M4-b 起假设板原文也逐步落盘（故障 #11：渲染了 ≠ 能从证据里证明它上了线），
  // 所以 trace 里本来就该有事件行。把两者分开断言，意图才不被行数掩盖。
  const stepRows = rows.filter((x) => x['index'] !== undefined);
  assert.equal(stepRows.length, 3);
  const boardRows = rows.filter((x) => x['kind'] === 'hypothesis_board');
  assert.equal(boardRows.length, 1, '第 2 步才写下笔记，所以只有第 3 步的板子非空');
  assert.equal((boardRows[0]!['payload'] as { step: number }).step, 3);
  const first = stepRows[0]!;
  assert.equal(first['index'], 1);
  assert.ok(first['stateHash']);
  assert.equal((first['decision'] as { thought: string }).thought, 't');
});

test('max_steps：步数预算耗尽', async () => {
  const r = await runHarness({
    brain: new MockBrain([d('note', { text: '1' }), d('note', { text: '2' }), d('note', { text: '3' }), d('note', { text: '4' })]),
    registry: reg(), config: cfg({ maxSteps: 3, repeatLimit: 99 }),
  });
  assert.equal(r.stopReason, 'max_steps');
  assert.equal(r.steps.length, 3);
});

test('loop_detected：连续重复同一动作被拦下', async () => {
  const same = d('note', { text: '重复' });
  const r = await runHarness({
    brain: new MockBrain([same, same, same, same]),
    registry: reg(), config: cfg({ repeatLimit: 3 }),
  });
  assert.equal(r.stopReason, 'loop_detected');
  assert.equal(r.steps.length, 3);
  const trace = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8');
  assert.match(trace, /loop_detected/);
});

test('不同 args 不算重复', async () => {
  const r = await runHarness({
    brain: new MockBrain([d('note', { text: 'a' }), d('note', { text: 'b' }), d('note', { text: 'c' }), d('finish', { summary: 's' })]),
    registry: reg(), config: cfg({ repeatLimit: 3 }),
  });
  assert.equal(r.stopReason, 'finished');
});

test('解析失败会回炉重试，并在成功后继续', async () => {
  const r = await runHarness({
    brain: new MockBrain(['这不是JSON', d('finish', { summary: '回炉后成功' })]),
    registry: reg(), config: cfg({ maxParseRetry: 2 }),
  });
  assert.equal(r.stopReason, 'finished');
  assert.equal(r.finishSummary, '回炉后成功');
  const trace = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8');
  assert.match(trace, /brain_error/);
  assert.match(trace, /E_BRAIN_PARSE/);
});

test('回炉次数用尽 → brain_failed，且失败被留档', async () => {
  const r = await runHarness({
    brain: new MockBrain(['坏1', '坏2', '坏3', '坏4']),
    registry: reg(), config: cfg({ maxParseRetry: 2 }),
  });
  assert.equal(r.stopReason, 'brain_failed');
  assert.equal(r.steps.length, 0);
  const trace = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8');
  const errors = trace.trim().split('\n').filter((l) => l.includes('brain_error'));
  assert.equal(errors.length, 3); // 初次 + 2 次回炉
});

test('wall_clock：时间预算耗尽', async () => {
  const r = await runHarness({
    brain: new MockBrain([d('note', { text: 'a' }), d('note', { text: 'b' })]),
    registry: reg(), config: cfg({ maxWallMs: 0, repeatLimit: 99 }),
  });
  assert.equal(r.stopReason, 'wall_clock');
  assert.equal(r.steps.length, 0);
});

test('工具失败不会中断循环，失败理由进入上下文', async () => {
  const r = await runHarness({
    brain: new MockBrain([d('read_file', { path: '不存在.txt' }), d('finish', { summary: '改用别的办法' })]),
    registry: reg(), config: cfg(),
  });
  assert.equal(r.stopReason, 'finished');
  assert.equal(r.steps[0]?.result.ok, false);
  assert.match(r.steps[0]!.result.output, /list_dir/);
});

test('假设板独立于消息历史：上下文极小也不会丢', async () => {
  const r = await runHarness({
    brain: new MockBrain([
      d('note', { text: '关键假设' }),
      ...Array.from({ length: 6 }, (_, i) => d('list_dir', { path: '.' }, `第${i}步`)),
      d('finish', { summary: 's' }),
    ]),
    registry: reg(), config: cfg({ maxContextChars: 400, keepRecent: 2, repeatLimit: 99, maxSteps: 20 }),
  });
  assert.deepEqual(r.notes, ['关键假设']);
  // 预算 400 装不下「完整契约 + 最近 2 条」这个地板。
  // 正确行为不是硬截断把契约砍掉，而是保住地板并显式报告超预算——沉默失效才是 bug。
  assert.ok(r.steps.every((s) => s.contextChars > 400));
  const trace = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8');
  assert.match(trace, /context_over_budget/);
});

test('预算充足时不报超预算', async () => {
  const r = await runHarness({
    brain: new MockBrain([d('list_dir'), d('finish', { summary: 's' })]),
    registry: reg(), config: cfg({ maxContextChars: 12_000 }),
  });
  const trace = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8');
  assert.ok(!trace.includes('context_over_budget'));
});

test('同种子同脚本 → stateHash 序列完全一致（可重放）', async () => {
  const script = [d('list_dir'), d('note', { text: 'x' }), d('finish', { summary: 's' })];
  const a = await runHarness({ brain: new MockBrain(script), registry: reg(), config: cfg({ seed: 7 }) });
  const b = await runHarness({ brain: new MockBrain(script), registry: reg(), config: cfg({ seed: 7 }) });
  assert.deepEqual(a.steps.map((s) => s.stateHash), b.steps.map((s) => s.stateHash));
  assert.deepEqual(a.actionSequence, b.actionSequence);
});