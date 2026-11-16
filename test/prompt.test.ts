/**
 * 提示词契约测试。
 *
 * 存在的理由（真实缺陷回归）：循环层一度把 `system: config.task` 直接塞给大脑，
 * 于是「工具清单 + 输出格式」这份契约根本没送出去——stdio 宿主收到的 system 只有任务文本，
 * 远端分支因为自己又拼了一遍才侥幸没坏。单元测试全绿，因为没人断言过 system 的内容。
 * 教训：契约类字段必须有内容断言，不能只断言"跑通了"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, notesBlock, renderTools } from '../src/brain/prompt.ts';
import { OpenAIBrain, toWireMessages } from '../src/brain/openai.ts';
import { runHarness } from '../src/loop.ts';
import { builtinTools } from '../src/tools/builtin.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { Brain, Decision, DecideRequest, HarnessConfig } from '../src/types.ts';

const tools = builtinTools().map(({ name, description, params }) => ({ name, description, params }));

test('buildSystem 含任务、全部工具名、输出契约', () => {
  const s = buildSystem({ task: '找出沙箱里的秘密', tools });
  assert.match(s, /找出沙箱里的秘密/);
  for (const t of tools) assert.ok(s.includes(t.name), `system 缺少工具 ${t.name}`);
  assert.match(s, /"thought"/);
  assert.match(s, /"call"/);
  assert.match(s, /一次只调一个工具/);
});

test('buildSystem 只给接口，不给策略手册（零说明书原则）', () => {
  const s = buildSystem({ task: 't', tools });
  // 这些是"开卷考试"式的测试策略，一旦出现就等于把答案喂给大脑
  for (const banned of ['优先探索', '边界值', '未访问区域', '二分', '覆盖率', '变异']) {
    assert.ok(!s.includes(banned), `system 不该出现策略提示：${banned}`);
  }
});

test('renderTools 标注必填与可选', () => {
  const s = renderTools(tools);
  assert.match(s, /path: string/);      // read_file 的 path 必填
  assert.match(s, /path\?: string/);   // list_dir 的 path 可选
});

test('notesBlock 空板返回 null，有内容则编号常驻', () => {
  assert.equal(notesBlock([]), null);
  const s = notesBlock(['假设A', '假设B'])!;
  assert.match(s, /1\. 假设A/);
  assert.match(s, /2\. 假设B/);
});

/** 记录型大脑：只为把 DecideRequest 原样抓出来看，不做任何决策智能 */
class RecordingBrain implements Brain {
  readonly id = 'recorder:TEST-DOUBLE';
  readonly seen: DecideRequest[] = [];
  decide(req: DecideRequest): Promise<Decision> {
    this.seen.push(req);
    return Promise.resolve({
      thought: '记录完毕',
      call: { name: 'finish', args: { summary: 's' } },
    });
  }
}

function cfg(): HarnessConfig {
  const sandbox = mkdtempSync(join(tmpdir(), 'harness-prompt-'));
  writeFileSync(join(sandbox, 'a.txt'), 'hello');
  return {
    task: '看看沙箱里有什么', sandbox, seed: 1, maxSteps: 3, maxWallMs: 10_000,
    maxContextChars: 12_000, keepRecent: 8, maxParseRetry: 2, repeatLimit: 3,
    outDir: mkdtempSync(join(tmpdir(), 'harness-prompt-out-')),
  };
}

test('循环层交给大脑的 system 是完整契约，且与 messages[0] 一致', async () => {
  const brain = new RecordingBrain();
  const registry = new ToolRegistry();
  for (const t of builtinTools()) registry.register(t);
  await runHarness({ brain, registry, config: cfg() });

  const req = brain.seen[0]!;
  assert.notEqual(req.system, req.task, 'system 不能只是任务文本');
  assert.match(req.system, /list_dir/);
  assert.match(req.system, /"thought"/);
  assert.equal(req.messages[0]?.role, 'system');
  assert.equal(req.messages[0]?.content, req.system);
  assert.deepEqual(req.tools.map((t) => t.name), ['list_dir', 'read_file', 'note', 'finish']);
});

test('线上格式不得出现 tool 角色（真实 400 回归：missing field tool_call_id）', () => {
  const wire = toWireMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '任务' },
    { role: 'assistant', content: '{"thought":"t","call":{"name":"list_dir","args":{}}}' },
    { role: 'tool', toolName: 'list_dir', content: 'f a.txt' },
  ]);
  assert.ok(!wire.some((m) => m.role === 'tool'), '不用 function-calling 就不能发 role:tool');
  assert.deepEqual(wire.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(wire[3]?.content, '[工具返回 list_dir]\nf a.txt');
  // 其余角色原样保留
  assert.equal(wire[0]?.content, 'sys');
  assert.equal(wire[2]?.content, '{"thought":"t","call":{"name":"list_dir","args":{}}}');
});

test('tool 消息缺 toolName 时也要标注来源，不能静默丢信息', () => {
  const wire = toWireMessages([{ role: 'tool', content: '结果' }]);
  assert.equal(wire[0]?.role, 'user');
  assert.match(wire[0]!.content, /^\[工具返回\]\n结果$/);
});

function withServer(handler: Parameters<typeof createServer>[0]): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv: Server = createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

test('远端大脑真的把契约发出去了：system 含工具名，假设板在场，契约不重复', async () => {
  let body: { messages: { role: string; content: string }[] } | undefined;
  const s = await withServer((q, res) => {
    let raw = '';
    q.on('data', (c) => { raw += c; });
    q.on('end', () => {
      body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"thought":"ok","call":{"name":"finish","args":{"summary":"s"}}}' } }],
      }));
    });
  });
  try {
    const brain = new OpenAIBrain({ baseUrl: s.url, apiKey: 'k', model: 'm', timeoutMs: 3000 });
    const system = buildSystem({ task: '找缺陷', tools });
    await brain.decide({
      task: '找缺陷',
      system,
      messages: [
        { role: 'system', content: system },
        { role: 'system', content: '[上下文已截断：省略了中间 5 条较早的消息。]' },
        { role: 'user', content: '找缺陷' },
        { role: 'tool', toolName: 'list_dir', content: 'f a.txt' },
      ],
      tools,
      step: 2,
      notes: ['门后可能有东西'],
    });

    const msgs = body!.messages;
    assert.equal(msgs[0]?.role, 'system');
    assert.match(msgs[0]!.content, /read_file/);
    assert.match(msgs[0]!.content, /"thought"/);
    assert.equal(msgs.filter((m) => m.content === system).length, 1, '契约被发了两遍');
    assert.ok(msgs.some((m) => m.content.includes('门后可能有东西')), '假设板没送出去');
    assert.ok(msgs.some((m) => m.content.includes('上下文已截断')), '失忆标记被吞了');
    assert.ok(!msgs.some((m) => m.role === 'tool'), '线上出现 tool 角色 → 真实端点会 400');
    assert.ok(msgs.some((m) => m.role === 'user' && m.content === '[工具返回 list_dir]\nf a.txt'));
  } finally { await s.close(); }
});