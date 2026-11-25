#!/usr/bin/env node
/** 业务底座 fixture 冒烟：真实 MCP stdio，只证明接线，不证明模型能力。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = join(here, 'main.ts');
const out = mkdtempSync(join(tmpdir(), 'business-agent-fixture-'));
const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: { ...process.env, BUSINESS_AGENT_OUT: out },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
const waiting = new Map<number, (response: any) => void>();
const acknowledgements: any[] = [];
let nextId = 1;
createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  const response = JSON.parse(line);
  if (response.method === 'notifications/subscriptions/acknowledged') {
    acknowledgements.push(response);
    return;
  }
  waiting.get(response.id)?.(response);
  waiting.delete(response.id);
});

function meta() {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': { tools: {}, resources: {}, prompts: {} },
    'io.modelcontextprotocol/clientInfo': { name: 'business-agent-fixture', version: '1' },
  };
}

function request(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`${method} 超时；stderr=${stderr.trim()}`));
    }, 10_000);
    waiting.set(id, (response) => {
      clearTimeout(timer);
      if (response.error) reject(new Error(`${method}: ${JSON.stringify(response.error)}`));
      else resolvePromise(response.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta() } })}\n`);
  });
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await request('tools/call', { name, arguments: args });
  assert.equal(result.isError, false, `${name} 返回工具错误`);
  return result.structuredContent;
}

async function main(): Promise<void> {
  const discovered = await request('server/discover');
  assert.equal(discovered.resultType, 'complete');
  assert.deepEqual(discovered.capabilities, {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
  });

  const listenId = nextId++;
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: listenId, method: 'subscriptions/listen',
    params: { notifications: { toolsListChanged: true }, _meta: meta() },
  })}\n`);
  const listed = await request('tools/list');
  assert.deepEqual(listed.tools.map((tool: any) => tool.name), ['case_start', 'case_step', 'case_status']);
  assert.equal(listed.ttlMs, 0);
  assert.equal(listed.cacheScope, 'private');
  assert.equal(acknowledgements.length, 1);
  assert.equal(acknowledgements[0].params._meta['io.modelcontextprotocol/subscriptionId'], listenId);
  const resources = await request('resources/list');
  assert.deepEqual(resources.resources, []);
  assert.equal(resources.cacheScope, 'private');

  const started = await call('case_start', { ticketId: 'T-1001', maxSteps: 5 });
  assert.equal(started.kind, 'started');
  assert.equal(started.request.ticket.revision, 1);
  assert.equal(started.request.tools.some((tool: any) => tool.effect === 'external'), false);

  const searched = await call('case_step', {
    runId: started.runId,
    expectedStep: 1,
    decision: { thought: 'fixture：先检索退款知识', call: { name: 'knowledge.search', args: { query: '退款 到账' } } },
  });
  assert.equal(searched.kind, 'stepped');
  assert.equal(searched.observation.ok, true);
  assert.equal(searched.request.ticket.revision, 1);

  const drafted = await call('case_step', {
    runId: started.runId,
    expectedStep: 2,
    decision: {
      thought: 'fixture：根据检索结果保存草稿，不发送',
      call: { name: 'ticket.draftReply', args: { expectedRevision: 1, text: '您好，仓库签收并验收后，退款会在 1 至 3 个工作日内原路退回。' } },
    },
  });
  assert.equal(drafted.kind, 'stepped');
  assert.equal(drafted.request.ticket.revision, 2);

  const finished = await call('case_step', {
    runId: started.runId,
    expectedStep: 3,
    decision: { thought: 'fixture：草稿已保存，主动收手', call: { name: 'finish', args: { summary: '已检索退款规则并保存回复草稿，未发送或改变工单状态。' } } },
  });
  assert.equal(finished.kind, 'finished');
  assert.equal(finished.result.stopReason, 'finish');
  assert.equal(finished.result.outcomeCertain, true);
  assert.equal(finished.result.resultWritten, true);
  assert.ok(existsSync(finished.result.auditPath));
  assert.ok(existsSync(finished.result.resultPath));
  const audit = readFileSync(finished.result.auditPath, 'utf8');
  assert.doesNotMatch(audit, /仓库签收并验收后|fixture：/);
  process.stdout.write(`业务 Agent fixture 冒烟通过：${finished.result.stepCount} 个完整动作，证据目录 ${dirname(finished.result.resultPath)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`业务 Agent fixture 冒烟失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  child.stdin.end();
  const exited = once(child, 'exit');
  const killer = setTimeout(() => child.kill(), 3000);
  const [code] = await exited;
  clearTimeout(killer);
  if (code !== 0 && process.exitCode !== 1) {
    process.stderr.write(`业务 server 异常退出：${code}; stderr=${stderr.trim()}\n`);
    process.exitCode = 1;
  }
  rmSync(out, { recursive: true, force: true });
});
