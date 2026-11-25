import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const entry = join(root, 'business/main.ts');

interface RpcResponse {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

class McpClient {
  private readonly waiting = new Map<number, (response: RpcResponse) => void>();
  private readonly notifications: RpcResponse[] = [];
  private nextId = 1;
  private stderr = '';
  readonly child: ChildProcessWithoutNullStreams;

  constructor(outDir: string) {
    this.child = spawn(process.execPath, [entry], {
      cwd: root,
      env: { ...process.env, BUSINESS_AGENT_OUT: outDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const response = JSON.parse(line) as RpcResponse;
      if (response.method !== undefined) {
        this.notifications.push(response);
        return;
      }
      const pending = this.waiting.get(response.id as number);
      if (pending !== undefined) {
        this.waiting.delete(response.id as number);
        pending(response);
      }
    });
  }

  private meta() {
    return {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { tools: {}, resources: {}, prompts: {} },
      'io.modelcontextprotocol/clientInfo': { name: 'business-server-test', version: '1' },
    };
  }

  send(method: string, params: Record<string, unknown> = {}): number {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: this.meta() } })}\n`);
    return id;
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
    const id = this.send(method, params);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} 超时；stderr=${this.stderr.trim()}`));
      }, 10_000);
      this.waiting.set(id, (response) => {
        clearTimeout(timer);
        resolvePromise(response);
      });
    });
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const response = await this.request('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(response.result?.isError, false);
    return response.result?.structuredContent;
  }

  get acknowledged(): RpcResponse[] {
    return this.notifications.filter((item) => item.method === 'notifications/subscriptions/acknowledged');
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    const exited = once(this.child, 'exit');
    const killer = setTimeout(() => this.child.kill(), 3000);
    const [code] = await exited;
    clearTimeout(killer);
    assert.equal(code, 0, this.stderr);
  }
}

test('业务 MCP 真实入口：现代目录、订阅、分步修复、草稿、状态与 finish', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'business-server-test-'));
  const client = new McpClient(outDir);
  t.after(async () => {
    await client.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  const discovered = await client.request('server/discover');
  assert.equal(discovered.result?.resultType, 'complete');
  assert.deepEqual(discovered.result?.capabilities, {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
  });

  const listenId = client.send('subscriptions/listen', { notifications: { toolsListChanged: true } });
  const tools = await client.request('tools/list');
  assert.deepEqual(tools.result?.tools.map((tool: any) => tool.name), ['case_start', 'case_step', 'case_status']);
  assert.equal(tools.result?.ttlMs, 0);
  assert.equal(tools.result?.cacheScope, 'private');
  assert.equal(client.acknowledged.length, 1);
  assert.equal(client.acknowledged[0]?.params?._meta?.['io.modelcontextprotocol/subscriptionId'], listenId);

  const resources = await client.request('resources/list');
  assert.deepEqual(resources.result?.resources, []);
  assert.equal(resources.result?.cacheScope, 'private');
  const templates = await client.request('resources/templates/list');
  assert.deepEqual(templates.result?.resourceTemplates, []);
  const prompts = await client.request('prompts/list');
  assert.deepEqual(prompts.result?.prompts, []);

  const started = await client.call('case_start', { ticketId: 'T-1001', maxSteps: 5 });
  assert.equal(started.kind, 'started');
  assert.equal(started.request.tools.some((tool: any) => tool.effect === 'external'), false);

  const repaired = await client.call('case_step', {
    runId: started.runId,
    expectedStep: 1,
    decision: { thought: 'fixture：缺少 query', call: { name: 'knowledge.search', args: {} } },
  });
  assert.equal(repaired.kind, 'repair_required');
  assert.equal(repaired.request.step, 1);

  const drafted = await client.call('case_step', {
    runId: started.runId,
    expectedStep: 1,
    decision: {
      thought: 'fixture：保存草稿',
      call: { name: 'ticket.draftReply', args: { expectedRevision: 1, text: '您好，退款将在仓库验收后 1 至 3 个工作日原路退回。' } },
    },
  });
  assert.equal(drafted.kind, 'stepped');
  assert.equal(drafted.observation.ok, true);
  assert.equal(drafted.request.ticket.revision, 2);

  const status = await client.call('case_status', { runId: started.runId });
  assert.equal(status.kind, 'status');
  assert.equal(status.request.step, 2);

  const finished = await client.call('case_step', {
    runId: started.runId,
    expectedStep: 2,
    decision: { thought: 'fixture：收手', call: { name: 'finish', args: { summary: '已保存草稿，未发送。' } } },
  });
  assert.equal(finished.kind, 'finished');
  assert.equal(finished.result.stopReason, 'finish');
  assert.equal(finished.result.resultWritten, true);
  assert.ok(existsSync(finished.result.auditPath));
  assert.ok(existsSync(finished.result.resultPath));
  const persisted = JSON.parse(readFileSync(finished.result.resultPath, 'utf8'));
  assert.equal(persisted.stopReason, 'finish');
  assert.equal(persisted.resultWritten, true);
  const audit = readFileSync(finished.result.auditPath, 'utf8');
  assert.equal(audit.includes('您好，退款将在'), false);

  const missing = await client.request('tools/call', {
    name: 'case_status', arguments: { runId: 'biz-00000000-0000-4000-8000-000000000000' },
  });
  assert.equal(missing.error?.code, -32002);
});
