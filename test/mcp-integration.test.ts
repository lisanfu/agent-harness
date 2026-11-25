import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MCP_PROTOCOL_VERSION } from '../src/mcp/protocol.ts';
import { assertDedicatedOutputRoot } from '../src/mcp/session.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = fileURLToPath(new URL('../src/mcp.ts', import.meta.url));
const META = {
  'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': { tools: {}, resources: {}, prompts: {} },
  'io.modelcontextprotocol/clientInfo': { name: 'integration-test', version: '1' },
};

type Rpc = {
  id: string | number | null;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: unknown };
};

function tempOut(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'agent-harness-mcp-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function startServer(
  t: TestContext,
  outDir: string,
  extraEnv: Record<string, string> = {},
): {
  send(value: unknown): void;
  request(method: string, params?: Record<string, unknown>, modern?: boolean): Promise<Rpc>;
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  close(): Promise<void>;
  stdout(): string;
  stderr(): string;
} {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `/home/fuyuan/.local/node-22/bin:${process.env.PATH ?? ''}`,
      AGENT_HARNESS_MCP_OUT: outDir,
      AGENT_HARNESS_MCP_PROVENANCE: 'fixture',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const waiting = new Map<string | number, (response: Rpc) => void>();
  let terminal: Error | undefined;
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const response = JSON.parse(line) as Rpc;
    waiting.get(response.id)?.(response);
    waiting.delete(response.id);
  });
  child.on('error', (error) => { terminal = error; });
  child.on('exit', (code, signal) => {
    if (code !== 0) terminal = new Error(`MCP exited ${code ?? signal}: ${stderr}`);
    for (const resolve of waiting.values()) resolve({ id: null, error: { code: -32099, message: terminal?.message ?? 'EOF' } });
    waiting.clear();
  });
  let nextId = 1;

  async function request(
    method: string,
    params: Record<string, unknown> = {},
    modern = true,
  ): Promise<Rpc> {
    const id = nextId++;
    const response = new Promise<Rpc>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Timed out: ${method}; stderr=${stderr}`));
      }, 10_000);
      waiting.set(id, (value) => { clearTimeout(timer); resolve(value); });
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id, method,
      params: modern ? { ...params, _meta: META } : params,
    })}\n`);
    if (terminal) throw terminal;
    return response;
  }

  return {
    send: (value) => child.stdin.write(`${JSON.stringify(value)}\n`),
    request,
    async call(name, args = {}) {
      const response = await request('tools/call', { name, arguments: args });
      if (response.error) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
      assert.equal(response.result?.isError, false);
      return response.result.structuredContent as Record<string, any>;
    },
    async close() {
      child.stdin.end();
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 0);
      assert.equal(signal, null);
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function decision(name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { thought: `宿主测试决策：${name}`, call: { name, args }, ...extra };
}

function assertNoRefereeLeak(value: unknown): void {
  const text = JSON.stringify(value);
  for (const forbidden of ['M01', 'S09', 'wallBlocks', 'internalState', 'coverage', 'detection', 'mutant']) {
    assert.equal(text.includes(forbidden), false, `进行中泄漏了 ${forbidden}: ${text.slice(0, 500)}`);
  }
}

test('两个 server 进程同 run 并发步骤只执行一次，第二个进程能看到新状态', async (t) => {
  const out = tempOut(t);
  const first = startServer(t, out);
  const second = startServer(t, out);
  const started = await first.call('harness_start', { seed: 6 });
  const args = {
    run_id: started.run_id,
    expected_step: 1,
    decision: decision('move', { dir: 'right' }),
  };
  const results = await Promise.allSettled([first.call('harness_step', args), second.call('harness_step', args)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);

  const next = await second.call('harness_step', {
    run_id: started.run_id, expected_step: 2, decision: decision('look'),
  });
  assert.equal(next.observation.step, 2);
  const status = await first.call('harness_status', { run_id: started.run_id });
  assert.equal(status.step, 2);
  const trace = readFileSync(join(out, started.run_id, 'trace.jsonl'), 'utf8');
  assert.equal(trace.split('\n').filter((line) => line.includes('"index":1')).length, 1);
});

test('modern discover / catalog / prompt：server 声明能力但不出 sampling', async (t) => {
  const server = startServer(t, tempOut(t));
  const discovered = await server.request('server/discover');
  assert.equal(discovered.error, undefined);
  assert.equal(discovered.result?.resultType, 'complete');
  assert.deepEqual(discovered.result?.supportedVersions, [MCP_PROTOCOL_VERSION, '2025-11-25', '2025-06-18', '2024-11-05']);
  assert.deepEqual(Object.keys(discovered.result?.capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.equal(JSON.stringify(discovered.result).includes('sampling'), false);

  server.send({
    jsonrpc: '2.0', id: 'listen:0', method: 'subscriptions/listen',
    params: {
      notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
      _meta: META,
    },
  });
  const tools = await server.request('tools/list');
  assert.deepEqual(tools.result?.tools.map((x: any) => x.name), ['harness_start', 'harness_step', 'harness_status']);
  assert.equal(tools.result?.ttlMs, 0);
  assert.equal(tools.result?.cacheScope, 'private');
  const acknowledgement = server.stdout().trim().split('\n').map((line) => JSON.parse(line))
    .find((message) => message.method === 'notifications/subscriptions/acknowledged');
  assert.equal(acknowledgement.params._meta['io.modelcontextprotocol/subscriptionId'], 'listen:0');
  assert.deepEqual(acknowledgement.params.notifications, {});
  // 声明 resources 能力后，标准客户端还会请求固定资源列表。
  // 没有 run_id 就没有可枚举的固定 URI，但空列表本身必须是成功响应。
  const resources = await server.request('resources/list');
  assert.equal(resources.error, undefined);
  assert.deepEqual(resources.result?.resources, []);
  assert.equal(resources.result?.ttlMs, 0);
  assert.equal(resources.result?.cacheScope, 'private');
  const templates = await server.request('resources/templates/list');
  assert.equal(templates.result?.resourceTemplates[0].uriTemplate, 'harness://run/{run_id}/agent-view');
  assert.equal(templates.result?.ttlMs, 0);
  assert.equal(templates.result?.cacheScope, 'private');
  const prompts = await server.request('prompts/list');
  assert.equal(prompts.result?.prompts[0].name, 'arena-play');
  assert.equal(prompts.result?.ttlMs, 0);
  assert.equal(prompts.result?.cacheScope, 'private');
  const prompt = await server.request('prompts/get', { name: 'arena-play', arguments: {} });
  assert.match(prompt.result?.messages[0].content.text, /harness_start/);
  assert.match(prompt.result?.messages[0].content.text, /harness_step/);
  await server.close();
});

test('start→观察→note→goal→finish：同一引擎记账，局末证据齐全', async (t) => {
  const out = tempOut(t);
  const server = startServer(t, out, { AGENT_HARNESS_MCP_MUTANT: 'M01', AGENT_HARNESS_MCP_SOUND_MUTANT: 'S09' });
  const started = await server.call('harness_start', { seed: 6, max_steps: 4 });
  assert.equal(started.kind, 'started');
  assert.equal(started.request.step, 1);
  assert.deepEqual(started.request.tools.map((x: any) => x.name), ['look', 'listen', 'move', 'attack', 'pickup', 'wait', 'note', 'finish', 'goal']);
  assertNoRefereeLeak(started);

  const view = await server.request('resources/read', { uri: `harness://run/${started.run_id}/agent-view` });
  assert.equal(view.result?.ttlMs, 0);
  assert.equal(view.result?.cacheScope, 'private');
  const agentView = JSON.parse(view.result?.contents[0].text);
  assert.deepEqual(agentView.request, started.request);
  assert.match(agentView.screen, /HP|生命|血量/);
  assertNoRefereeLeak(agentView);

  const looked = await server.call('harness_step', {
    run_id: started.run_id, expected_step: 1,
    decision: decision('look', {}, { predict: { playerAt: [0, 0], hpDelta: 0 } }),
  });
  assert.equal(looked.kind, 'stepped');
  assert.equal(looked.observation.ok, true);
  assert.equal(looked.observation.prediction.given, true);
  assert.ok(looked.observation.prediction.diffs.length >= 2);
  assertNoRefereeLeak(looked);

  const noted = await server.call('harness_step', {
    run_id: started.run_id, expected_step: 2,
    decision: decision('note', { id: 'H1', text: '撞墙后的位置由代码核对', status: 'proposed' }),
  });
  assert.equal(noted.request.hypotheses[0].id, 'H1');

  const goal = await server.call('harness_step', {
    run_id: started.run_id, expected_step: 3,
    decision: decision('goal', { id: 'G1', text: '确认当前坐标', doneWhen: { playerAt: [0, 0] } }),
  });
  assert.equal(goal.request.goals[0].id, 'G1');
  assert.equal(goal.request.goals[0].checks, 1);

  const status = await server.call('harness_status', { run_id: started.run_id });
  assert.equal(status.stopped, false);
  assertNoRefereeLeak(status);

  const finished = await server.call('harness_step', {
    run_id: started.run_id, expected_step: 4,
    decision: decision('finish', { summary: '测试收手：已完成观察、记忆与目标核对' }),
  });
  assert.equal(finished.kind, 'finished');
  assert.equal(finished.stop_reason, 'finished');
  assert.equal(finished.step_count, 4);
  assert.equal(finished.evidence_consistent, true);
  assert.equal(finished.replay_matches_live_session, true);
  assert.equal(finished.notary.mutant, 'M01');
  assert.equal(finished.ear.soundMutant, 'S09');
  for (const file of Object.values(finished.files) as string[]) assert.equal(existsSync(file), true, file);

  const header = JSON.parse(readFileSync(join(finished.run_dir, 'header.json'), 'utf8'));
  assert.equal(header.brainId, 'mcp-host');
  assert.equal(header.config.provenance, 'fixture');
  assert.equal(header.initialState.world.mutant, 'M01');
  assert.equal(JSON.stringify(server.stdout()).includes('[mcp]'), false);
  await server.close();
});

test('重启恢复：seed+动作重建世界，trace append 不抹前半局', async (t) => {
  const out = tempOut(t);
  const first = startServer(t, out);
  const started = await first.call('harness_start', { seed: 7, max_steps: 5 });
  const moved = await first.call('harness_step', {
    run_id: started.run_id, expected_step: 1,
    decision: decision('move', { dir: 'right' }, { predict: { playerAt: [1, 0] } }),
  });
  assert.equal(moved.kind, 'stepped');
  await first.call('harness_step', {
    run_id: started.run_id, expected_step: 2,
    decision: decision('note', { text: '重启前写下的笔记' }),
  });
  const tracePath = join(out, started.run_id, 'trace.jsonl');
  const before = readFileSync(tracePath, 'utf8');
  const headerBefore = readFileSync(join(out, started.run_id, 'header.json'), 'utf8');
  await first.close();

  const second = startServer(t, out);
  const resumed = await second.call('harness_status', { run_id: started.run_id });
  assert.equal(resumed.step, 2);
  assert.equal(resumed.request.step, 3);
  assert.deepEqual(resumed.request.notes, ['重启前写下的笔记']);
  assert.equal(readFileSync(tracePath, 'utf8'), before);
  assert.equal(readFileSync(join(out, started.run_id, 'header.json'), 'utf8'), headerBefore);

  const finished = await second.call('harness_step', {
    run_id: started.run_id, expected_step: 3,
    decision: decision('finish', { summary: '恢复后收手' }),
  });
  assert.equal(finished.stop_reason, 'finished');
  assert.equal(finished.evidence_consistent, true);
  assert.equal(finished.replay_matches_live_session, true);
  const after = readFileSync(tracePath, 'utf8');
  assert.equal(after.startsWith(before), true);
  assert.ok(after.length > before.length);
  await second.close();
});

test('步号闸门与解析回炉：旧步不执行，坏决策不烧掉当前步', async (t) => {
  const out = tempOut(t);
  const server = startServer(t, out);
  const started = await server.call('harness_start', { seed: 6, max_steps: 3 });
  const stale = await server.request('tools/call', {
    name: 'harness_step', arguments: { run_id: started.run_id, expected_step: 2, decision: decision('wait') },
  });
  assert.equal(stale.error?.code, -32602);
  const tracePath = join(out, started.run_id, 'trace.jsonl');

  const malformed = await server.call('harness_step', {
    run_id: started.run_id, expected_step: 1, decision: { thought: '缺少 call' },
  });
  assert.equal(malformed.kind, 'repair_required');
  assert.equal(malformed.request.step, 1);
  assert.match(malformed.repair, /无法解析/);

  const looked = await server.call('harness_step', {
    run_id: started.run_id, expected_step: 1, decision: decision('look'),
  });
  assert.equal(looked.kind, 'stepped');
  assert.equal(looked.request.step, 2);
  const repeated = await server.request('tools/call', {
    name: 'harness_step', arguments: { run_id: started.run_id, expected_step: 1, decision: decision('wait') },
  });
  assert.equal(repeated.error?.code, -32602);
  const lines = readFileSync(tracePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.filter((line) => typeof line.index === 'number').length, 1);
  await server.close();
});

test('max_steps 停止也会跑完整局末收尾，不允许“退出即省略证据”', async (t) => {
  const out = tempOut(t);
  const server = startServer(t, out);
  const started = await server.call('harness_start', { seed: 6, max_steps: 1 });
  const stopped = await server.call('harness_step', {
    run_id: started.run_id, expected_step: 1, decision: decision('look'),
  });
  assert.equal(stopped.kind, 'finished');
  assert.equal(stopped.stop_reason, 'max_steps');
  assert.equal(stopped.evidence_consistent, true);
  for (const file of Object.values(stopped.files) as string[]) assert.equal(existsSync(file), true, file);
  const again = await server.call('harness_status', { run_id: started.run_id });
  assert.equal(again.stop_reason, 'max_steps');
  assert.deepEqual(again.result.files, stopped.files);
  await server.close();
});

test('legacy initialize 仍可 start/step，结果不冒充 modern complete', async (t) => {
  const server = startServer(t, tempOut(t));
  const initialized = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {}, resources: {}, prompts: {} },
    clientInfo: { name: 'legacy-test', version: '1' },
  }, false);
  assert.equal(initialized.result?.protocolVersion, '2025-06-18');
  assert.equal(initialized.result?.resultType, undefined);
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await server.request('tools/list', {}, false);
  assert.equal(listed.result?.resultType, undefined);
  assert.equal(listed.result?.tools.length, 3);
  assert.equal(listed.result?.ttlMs, undefined);
  assert.equal(listed.result?.cacheScope, undefined);
  const resources = await server.request('resources/list', {}, false);
  assert.equal(resources.error, undefined);
  assert.deepEqual(resources.result?.resources, []);
  const started = await server.request('tools/call', { name: 'harness_start', arguments: { seed: 6 } }, false);
  assert.equal(started.result?.resultType, undefined);
  assert.equal(started.result.structuredContent.request.step, 1);
  await server.close();
});

test('输出根守卫：专用 sandbox 可用，runs/ 与仓库根明确拒绝', async (t) => {
  const repo = '/tmp/repo';
  assert.equal(assertDedicatedOutputRoot('/tmp/repo/sandbox/mcp', repo), '/tmp/repo/sandbox/mcp');
  assert.equal(assertDedicatedOutputRoot('/tmp/dedicated-mcp', repo), '/tmp/dedicated-mcp');
  for (const root of ['/tmp/repo', '/tmp/repo/runs', '/tmp/repo/runs/mcp', '/tmp/repo/src/mcp', '/']) {
    assert.throws(() => assertDedicatedOutputRoot(root, repo));
  }

  // 单元守卫之外，再走真实入口：错误配置必须退出非零，stdout 不能混入启动错误。
  for (const root of [ROOT, join(ROOT, 'runs')]) {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: { ...process.env, AGENT_HARNESS_MCP_OUT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const [exitCode] = await once(child, 'exit');
    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /输出根必须是专用目录/);
  }
});
