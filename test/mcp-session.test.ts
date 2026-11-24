/** MCP 业务层的并发、预算、恢复与结构边界；不依赖真实模型。 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpSessionManager } from '../src/mcp/session.ts';
import { RpcError } from '../src/mcp/protocol.ts';
import { TOOLS } from '../src/mcp/catalog.ts';

function tempOut(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'agent-harness-session-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const decision = (name: string, args: Record<string, unknown> = {}) => ({
  thought: `fixture:${name}`, call: { name, args },
});

async function code(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    assert.fail('应当拒绝');
  } catch (error) {
    assert.ok(error instanceof RpcError, String(error));
    return error.code;
  }
}

test('同一 expected_step 并发提交只执行一次，另一条明确报过期', async (t) => {
  const manager = new McpSessionManager({ outDir: tempOut(t), provenance: 'fixture', maxWallMs: 30_000 });
  const started: any = await manager.start({ seed: 6 });
  const args = {
    run_id: started.run_id,
    expected_step: started.request.step,
    decision: decision('look'),
  };
  const results = await Promise.allSettled([manager.step(args), manager.step(args)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof RpcError);
  assert.equal(rejected.reason.code, -32602);
  assert.match(rejected.reason.message, /已过期/);
  const status = await manager.status({ run_id: started.run_id });
  assert.equal(status.step, 1);
  assert.equal(status.next_step, 2);
});

test('解析回炉次数耗尽后 brain_failed，仍补齐局末证据', async (t) => {
  const manager = new McpSessionManager({ outDir: tempOut(t), provenance: 'fixture', maxWallMs: 30_000 });
  const started: any = await manager.start({ seed: 6 });
  let current = started;
  for (let attempt = 0; attempt < 3; attempt++) {
    current = await manager.step({
      run_id: started.run_id,
      expected_step: current.request.step,
      decision: { thought: '始终缺少 call' },
    });
  }
  assert.equal(current.kind, 'brain_failed');
  assert.equal(current.stop_reason, 'brain_failed');
  assert.equal(current.parse_failures, 3);
  assert.equal(current.step_count, 0);
  assert.equal(current.evidence_consistent, true);
  const trace = readFileSync(current.files.world.replace('world.jsonl', 'trace.jsonl'), 'utf8');
  assert.equal(trace.split('\n').filter((line) => line.includes('"kind":"parse_failure"')).length, 3);
  assert.match(trace, /始终缺少 call/);
  for (const file of Object.values(current.files) as string[]) {
    assert.doesNotThrow(() => readFileSync(file));
  }
});

test('墙钟预算到点后停止，并在状态口交完整结果', async (t) => {
  const manager = new McpSessionManager({ outDir: tempOut(t), provenance: 'fixture', maxWallMs: 1_000 });
  const started: any = await manager.start({ seed: 6, max_wall_ms: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const status = await manager.status({ run_id: started.run_id });
  assert.equal(status.stopped, true);
  assert.equal(status.stop_reason, 'wall_clock');
  assert.equal(status.result.evidence_consistent, true);
});

test('进行中的局数受限；收手释放名额后可以再开', async (t) => {
  const manager = new McpSessionManager({ outDir: tempOut(t), provenance: 'fixture', maxActiveRuns: 1 });
  const first = await manager.start({ seed: 6 });
  assert.equal(await code(manager.start({ seed: 7 })), -32000);
  const finished = await manager.step({
    run_id: first.run_id,
    expected_step: first.request.step,
    decision: decision('finish', { summary: '释放名额' }),
  });
  assert.equal(finished.kind, 'finished');
  const second = await manager.start({ seed: 7 });
  assert.notEqual(second.run_id, first.run_id);
});

test('恢复拒绝被篡改的状态哈希，不接受“重放后对不上”的局', async (t) => {
  const out = tempOut(t);
  const first = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const started = await first.start({ seed: 6 });
  await first.step({
    run_id: started.run_id,
    expected_step: 1,
    decision: decision('move', { dir: 'right' }),
  });
  const checkpointPath = join(out, started.run_id, 'mcp-checkpoint.json');
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  checkpoint.engine.steps[0].stateHash = 'tampered';
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`);

  const second = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  assert.equal(await code(second.status({ run_id: started.run_id })), -32603);
});

test('重启后同一 run 的并发恢复只装配一份世界，重复步仍被拒绝', async (t) => {
  const out = tempOut(t);
  const first = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const started = await first.start({ seed: 6 });
  await first.step({
    run_id: started.run_id,
    expected_step: 1,
    decision: decision('move', { dir: 'right' }),
  });

  const second = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const args = {
    run_id: started.run_id,
    expected_step: 2,
    decision: decision('look'),
  };
  const results = await Promise.allSettled([second.step(args), second.step(args)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof RpcError);
  assert.equal(rejected.reason.code, -32602);
  assert.match(rejected.reason.message, /已过期/);
  const status = await second.status({ run_id: started.run_id });
  assert.equal(status.step, 2);
});

test('重启后活跃局上限也计入磁盘上尚未收手的局', async (t) => {
  const out = tempOut(t);
  const first = new McpSessionManager({ outDir: out, provenance: 'fixture', maxActiveRuns: 1 });
  await first.start({ seed: 6 });

  const restarted = new McpSessionManager({ outDir: out, provenance: 'fixture', maxActiveRuns: 1 });
  assert.equal(await code(restarted.start({ seed: 7 })), -32000);
});

test('恢复核对初始世界哈希，尚未行动也不能悄悄换世界', async (t) => {
  const out = tempOut(t);
  const first = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const started = await first.start({ seed: 6 });
  const path = join(out, started.run_id, 'mcp-checkpoint.json');
  const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
  checkpoint.initialWorldHash = 'tampered-initial';
  writeFileSync(path, `${JSON.stringify(checkpoint)}\n`);

  const restarted = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  assert.equal(await code(restarted.status({ run_id: started.run_id })), -32603);
});

test('恢复逐帧核对，末态没变也拒绝中间帧被篡改的局', async (t) => {
  const out = tempOut(t);
  const first = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const started = await first.start({ seed: 6 });
  await first.step({ run_id: started.run_id, expected_step: 1, decision: decision('move', { dir: 'right' }) });
  await first.step({ run_id: started.run_id, expected_step: 2, decision: decision('wait') });
  const path = join(out, started.run_id, 'mcp-checkpoint.json');
  const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
  checkpoint.engine.steps[0].stateHash = 'tampered-middle';
  writeFileSync(path, `${JSON.stringify(checkpoint)}\n`);

  const restarted = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  assert.equal(await code(restarted.status({ run_id: started.run_id })), -32603);
});

test('预写动作后崩溃的局 fail-closed，恢复后不重复执行', async (t) => {
  const out = tempOut(t);
  const first = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const started = await first.start({ seed: 6 });
  const path = join(out, started.run_id, 'mcp-checkpoint.json');
  const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
  checkpoint.pending = null;
  checkpoint.inFlight = { step: 1, decision: decision('move', { dir: 'right' }) };
  writeFileSync(path, `${JSON.stringify(checkpoint)}\n`);

  const restarted = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const status = await restarted.status({ run_id: started.run_id });
  assert.equal(status.stopped, true);
  assert.equal(status.stop_reason, 'interrupted');
  assert.equal(status.step, 0);
  assert.deepEqual(status.result.action_sequence, []);
  assert.equal(status.result.evidence_consistent, false);
  assert.match(readFileSync(join(out, started.run_id, 'trace.jsonl'), 'utf8'), /"kind":"run_interrupted"/);
});

test('trace 比 checkpoint 多一步时，裁判数值明确标记未认证', async (t) => {
  const out = tempOut(t);
  const first = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const started = await first.start({ seed: 6 });
  await first.step({ run_id: started.run_id, expected_step: 1, decision: decision('move', { dir: 'right' }) });
  const path = join(out, started.run_id, 'mcp-checkpoint.json');
  const beforeCrash = JSON.parse(readFileSync(path, 'utf8'));
  await first.step({ run_id: started.run_id, expected_step: 2, decision: decision('wait') });
  beforeCrash.pending = null;
  beforeCrash.inFlight = { step: 2, decision: decision('wait') };
  beforeCrash.revision++;
  writeFileSync(path, `${JSON.stringify(beforeCrash)}\n`);

  const restarted = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const status = await restarted.status({ run_id: started.run_id });
  assert.equal(status.stop_reason, 'interrupted');
  assert.equal(status.result.action_sequence.length, 1);
  assert.equal(status.result.evidence_consistent, false);
  assert.equal(status.result.certified, false);
  assert.equal(status.result.replay_matches_live_session, false);
  assert.equal(status.result.notary.certified, false);
  assert.equal(status.result.detection.certified, false);
  assert.equal(status.result.ear.certified, false);
  const trace = readFileSync(join(out, started.run_id, 'trace.jsonl'), 'utf8');
  assert.equal(trace.split('\n').filter((line) => line.includes('"index":2')).length, 1);
});

test('动作执行前 checkpoint 必须已有 inFlight 预写', async (t) => {
  const out = tempOut(t);
  const manager = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const started: any = await manager.start({ seed: 6 });
  const entry = (manager as any).entries.get(started.run_id);
  const execute = entry.engine.execute.bind(entry.engine);
  entry.engine.execute = async (...args: unknown[]) => {
    const checkpoint = JSON.parse(readFileSync(join(out, started.run_id, 'mcp-checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.inFlight.step, 1);
    assert.equal(checkpoint.inFlight.decision.call.name, 'move');
    assert.equal(checkpoint.pending, null);
    return execute(...args);
  };
  const stepped = await manager.step({
    run_id: started.run_id, expected_step: 1, decision: decision('move', { dir: 'right' }),
  });
  assert.equal(stepped.kind, 'stepped');
  const checkpoint = JSON.parse(readFileSync(join(out, started.run_id, 'mcp-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.inFlight, undefined);
  assert.equal(checkpoint.engine.steps.length, 1);
});

test('死者留下的 run 文件锁 fail-closed，不冒险误删别人的新锁', async (t) => {
  const out = tempOut(t);
  const manager = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const started = await manager.start({ seed: 6 });
  const lockPath = join(out, started.run_id, '.mcp-lock.json');
  writeFileSync(lockPath, JSON.stringify({ owner: 'dead', pid: 2_147_483_647 }));
  assert.equal(await code(manager.status({ run_id: started.run_id })), -32000);
  assert.equal(existsSync(lockPath), true);
});

test('两个 manager 并发 start 也共享磁盘容量，不能各开一局', async (t) => {
  const out = tempOut(t);
  const first = new McpSessionManager({ outDir: out, provenance: 'fixture', maxActiveRuns: 1 });
  const second = new McpSessionManager({ outDir: out, provenance: 'fixture', maxActiveRuns: 1 });
  const results = await Promise.allSettled([first.start({ seed: 6 }), second.start({ seed: 7 })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof RpcError);
  assert.equal(rejected.reason.code, -32000);
});

test('重启后恢复解析回炉请求，合法决策仍记在原来的下一步', async (t) => {
  const out = tempOut(t);
  const first = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const started = await first.start({ seed: 6 });
  await first.step({ run_id: started.run_id, expected_step: 1, decision: decision('move', { dir: 'right' }) });

  const second = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const repair = await second.step({
    run_id: started.run_id, expected_step: 2, decision: { thought: '缺少 call' },
  });
  assert.equal(repair.request.step, 2);

  const third = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const stepped = await third.step({
    run_id: started.run_id, expected_step: 2, decision: decision('look'),
  });
  assert.equal(stepped.observation.step, 2);
  const fourth = new McpSessionManager({ outDir: out, provenance: 'fixture' });
  const status = await fourth.status({ run_id: started.run_id });
  assert.equal(status.step, 2);
});

test('别的 server 收手后，旧 manager 的容量统计以磁盘为准', async (t) => {
  const out = tempOut(t);
  const first = new McpSessionManager({ outDir: out, provenance: 'fixture', maxActiveRuns: 1 });
  const started = await first.start({ seed: 6 });
  const second = new McpSessionManager({ outDir: out, provenance: 'fixture', maxActiveRuns: 1 });
  await second.step({
    run_id: started.run_id, expected_step: 1, decision: decision('finish', { summary: '另一进程收手' }),
  });
  const next = await first.start({ seed: 7 });
  assert.notEqual(next.run_id, started.run_id);
});

test('目录与源码双重声明：没有 sampling，也没有 server 内第二大脑', () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, ['harness_start', 'harness_step', 'harness_status']);
  assert.equal(JSON.stringify(TOOLS).includes('outDir'), false);
  assert.equal(JSON.stringify(TOOLS).includes('mutant'), false);

  const entry = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../src/mcp/session.ts', import.meta.url), 'utf8');
  const source = `${entry}\n${session}`;
  assert.doesNotMatch(source, /sampling\/createMessage|\.decide\s*\(|createBrain|MockBrain|StdioBrain|OpenAI|openai/i);
});
