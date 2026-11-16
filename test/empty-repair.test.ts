/**
 * 故障 #7 / #8 回归。
 *
 * #7 真实故障现场（runs/m1b-M02/20261113-084119-s6）：
 *   [32] 第1次失败 E_BRAIN_EMPTY: 大脑返回空内容
 *   [done] stop=brain_failed steps=31 世界动作=28
 * 局本来要跑 40 步，第 32 步模型没说活，整局就死了。
 * 这和故障 #5（429 当致命）是同一类病：**瞬时失败被归成永久失败**。
 *
 * #8 是写 #7 的测试时顺带挖出来的，比 #7 更严重：
 *   buildContext 在回炉内循环**外面**装配，提示 push 进 history 后 continue，
 *   重发的仍是旧 messages —— **回炉提示从来没进过 payload**。
 *   从 M0 起，"回炉"一直退化成"原样再问一遍"，靠 temperature 的运气碰对。
 *   旧测试用 MockBrain 按脚本吐下一条、压根不看输入，所以一直是绿的。
 *   教训：分支写了 ≠ 分支跑过；测容错必须测**线上 payload**，不能只测结局。
 *
 * 修法与归属：
 *   空回复是「内容形状错误」，和解析失败同类 → 归循环层回炉（把提示塞进 history 再问）。
 *   传输层不重试它（retry.test.ts 已钉住），因为重发同一份 payload 治不了「模型没说话」。
 *   一个失败类别只有一个重试主人。
 *
 * 纪律：真发 HTTP、真数请求次数、真读回炉提示的原话。
 * 只断言 stopReason 不够——不数请求就分不清「回炉了」和「直接放弃了」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrCode, HarnessError } from '../src/errors.ts';
import { OpenAIBrain } from '../src/brain/openai.ts';
import { repairHint } from '../src/parse.ts';
import { runHarness } from '../src/loop.ts';
import { builtinTools } from '../src/tools/builtin.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { HarnessConfig } from '../src/types.ts';

const LOOK = '{"thought":"先看看","call":{"name":"list_dir","args":{}}}';
const DONE = '{"thought":"够了","call":{"name":"finish","args":{"summary":"s"}}}';

interface Probe { url: string; bodies: string[]; close: () => Promise<void> }

function withServer(handler: (n: number, res: ServerResponse) => void): Promise<Probe> {
  return new Promise((resolve) => {
    const bodies: string[] = [];
    const srv: Server = createServer((q, res) => {
      const chunks: Buffer[] = [];
      q.on('data', (c) => chunks.push(c as Buffer));
      q.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        handler(bodies.length - 1, res);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        bodies,
        close: () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }),
      });
    });
  });
}

function ok(res: ServerResponse, content: string): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
}

/** 空回复的三种真实形态：空串、纯空白、content 字段压根不存在。 */
function empty(res: ServerResponse, shape: number): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  if (shape === 0) res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
  else if (shape === 1) res.end(JSON.stringify({ choices: [{ message: { content: '   \n\t ' } }] }));
  else res.end(JSON.stringify({ choices: [{ message: {} }] }));
}

function brain(url: string) {
  const waits: number[] = [];
  const b = new OpenAIBrain({
    baseUrl: url, apiKey: 'k', model: 'm', timeoutMs: 3000,
    sleep: async (ms) => { waits.push(ms); }, random: () => 0,
  });
  return { b, waits };
}

function cfg(over: Partial<HarnessConfig> = {}): HarnessConfig {
  const sandbox = mkdtempSync(join(tmpdir(), 'empty-sbx-'));
  writeFileSync(join(sandbox, 'a.txt'), 'hello');
  return {
    task: '测试任务', sandbox, seed: 42, maxSteps: 5, maxWallMs: 30_000,
    maxContextChars: 12_000, keepRecent: 8, maxParseRetry: 2, repeatLimit: 3,
    outDir: mkdtempSync(join(tmpdir(), 'empty-out-')),
    ...over,
  };
}

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of builtinTools()) r.register(t);
  return r;
}

/** 从请求 body 里取出最后一条 user 消息（回炉提示就塞在那）。 */
function lastUser(body: string): string {
  const wire = JSON.parse(body) as { messages: { role: string; content: string }[] };
  const users = wire.messages.filter((m) => m.role === 'user');
  return users.at(-1)?.content ?? '';
}

function events(runDir: string, kind: string): { payload: Record<string, unknown> }[] {
  return readFileSync(join(runDir, 'trace.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> })
    .filter((e) => e.kind === kind);
}

// ── A. 故障复现：空一次不该掐断整局 ─────────────────────

test('故障 #7 复现：第2步空回复 → 回炉后继续，整局跑到 finished', async () => {
  const s = await withServer((n, res) => {
    if (n === 0) { ok(res, LOOK); return; }
    if (n === 1) { empty(res, 0); return; }
    ok(res, DONE);
  });
  try {
    const { b, waits } = brain(s.url);
    const r = await runHarness({ brain: b, registry: reg(), config: cfg() });
    assert.equal(r.stopReason, 'finished', '空回复是可回炉的瞬时失败，不是致命错误');
    assert.equal(r.steps.length, 2);
    assert.equal(s.bodies.length, 3, '必须真的再问了一遍，而不是直接放弃');
    assert.deepEqual(waits, [], '空回复归循环层，传输层不该退避等待');
    assert.equal(r.brainRetries, 0, '回炉不是传输层重试，两个计数不能混');
  } finally { await s.close(); }
});

test('三种空形态都能回炉：空串 / 纯空白 / 没有 content 字段', async () => {
  for (const shape of [0, 1, 2]) {
    const s = await withServer((n, res) => {
      if (n === 0) { empty(res, shape); return; }
      ok(res, DONE);
    });
    try {
      const { b } = brain(s.url);
      const r = await runHarness({ brain: b, registry: reg(), config: cfg() });
      assert.equal(r.stopReason, 'finished', `形态 ${shape} 应能回炉`);
      assert.equal(s.bodies.length, 2);
    } finally { await s.close(); }
  }
});

// ── B. 回炉提示必须说实话 ─────────────────────────────

test('空回复的提示说「回复是空的」，不能谎称「无法解析」', async () => {
  const s = await withServer((n, res) => {
    if (n === 0) { empty(res, 0); return; }
    ok(res, DONE);
  });
  try {
    const { b } = brain(s.url);
    await runHarness({ brain: b, registry: reg(), config: cfg() });
    const hint = lastUser(s.bodies[1]!);
    assert.match(hint, /回复是空的/, '它根本没输出，不是输出了坏东西');
    assert.ok(!hint.includes('无法解析'), '对空回复说无法解析是撒谎，会把模型引向错误的自我纠正');
    assert.match(hint, /"thought"/, '仍要给出正确格式');
    assert.match(hint, /list_dir/, '仍要列出可用工具');
  } finally { await s.close(); }
});

test('解析失败的提示仍说「无法解析」——两类错误的提示不能串味', async () => {
  const s = await withServer((n, res) => {
    if (n === 0) { ok(res, '这不是 JSON'); return; }
    ok(res, DONE);
  });
  try {
    const { b } = brain(s.url);
    await runHarness({ brain: b, registry: reg(), config: cfg() });
    const hint = lastUser(s.bodies[1]!);
    assert.match(hint, /无法解析/);
    assert.ok(!hint.includes('回复是空的'));
  } finally { await s.close(); }
});

test('repairHint 单元判据：EMPTY 与 PARSE 分别给不同原因', () => {
  const tools = ['list_dir', 'finish'];
  const e = repairHint(new HarnessError(ErrCode.BRAIN_EMPTY, '大脑返回空内容'), tools);
  const p = repairHint(new HarnessError(ErrCode.BRAIN_PARSE, '括号不闭合'), tools);
  assert.match(e, /回复是空的/);
  assert.match(p, /括号不闭合/);
  assert.notEqual(e, p);
  for (const h of [e, p]) { assert.match(h, /"call"/); assert.match(h, /list_dir, finish/); }
});

// ── C. 预算共用，耗尽要诚实 ─────────────────────────────

test('空回复与解析失败共用同一份回炉预算：空→坏JSON→好，仍然救得回来', async () => {
  const s = await withServer((n, res) => {
    if (n === 0) { ok(res, LOOK); return; }
    if (n === 1) { empty(res, 1); return; }
    if (n === 2) { ok(res, '{"thought":'); return; }
    ok(res, DONE);
  });
  try {
    const { b } = brain(s.url);
    const r = await runHarness({ brain: b, registry: reg(), config: cfg({ maxParseRetry: 2 }) });
    assert.equal(r.stopReason, 'finished');
    assert.equal(s.bodies.length, 4);
    assert.equal(r.steps.length, 2);
  } finally { await s.close(); }
});

test('持续空回复：耗尽预算后 brain_failed，请求次数=预算+1，错误全部留档', async () => {
  const s = await withServer((_n, res) => empty(res, 0));
  try {
    const { b, waits } = brain(s.url);
    const r = await runHarness({ brain: b, registry: reg(), config: cfg({ maxParseRetry: 2 }) });
    assert.equal(r.stopReason, 'brain_failed');
    assert.equal(s.bodies.length, 3, '初次 + 2 次回炉 = 3 次，不能无限撞墙');
    assert.deepEqual(waits, []);
    const errs = events(r.runDir, 'brain_error');
    assert.equal(errs.length, 3);
    for (const e of errs) assert.equal((e.payload.error as { code: string }).code, ErrCode.BRAIN_EMPTY);
    assert.deepEqual(errs.map((e) => e.payload.attempt), [0, 1, 2]);
    assert.equal(events(r.runDir, 'brain_retry').length, 0, '这不是传输层重试');
  } finally { await s.close(); }
});

test('回炉预算用尽前已完成的步骤不能丢', async () => {
  const s = await withServer((n, res) => {
    if (n === 0) { ok(res, LOOK); return; }
    empty(res, 2);
  });
  try {
    const { b } = brain(s.url);
    const r = await runHarness({ brain: b, registry: reg(), config: cfg({ maxParseRetry: 1 }) });
    assert.equal(r.stopReason, 'brain_failed');
    assert.equal(r.steps.length, 1, '第1步真跑过，证据必须留下');
    assert.equal(s.bodies.length, 3);
    const result = JSON.parse(readFileSync(join(r.runDir, 'result.json'), 'utf8')) as { stopReason: string };
    assert.equal(result.stopReason, 'brain_failed');
  } finally { await s.close(); }
});

test('maxParseRetry=0 时不回炉：预算是用户说了算，不是硬编码', async () => {
  const s = await withServer((_n, res) => empty(res, 0));
  try {
    const { b } = brain(s.url);
    const r = await runHarness({ brain: b, registry: reg(), config: cfg({ maxParseRetry: 0 }) });
    assert.equal(r.stopReason, 'brain_failed');
    assert.equal(s.bodies.length, 1);
  } finally { await s.close(); }
});

// ── D. 故障 #8：回炉提示必须真的进 payload ─────────────────────
// 这条是 payload 级判据，比"整局跑完了"强得多。
// 旧测试用 MockBrain 按脚本吐下一条，压根不看输入，所以提示没送到也照样绿。

test('故障 #8 复现：回炉重发的 payload 必须带上提示，不能原样再问一遍', async () => {
  const s = await withServer((n, res) => {
    if (n === 0) { ok(res, '这不是 JSON'); return; }
    ok(res, DONE);
  });
  try {
    const { b } = brain(s.url);
    const r = await runHarness({ brain: b, registry: reg(), config: cfg() });
    assert.equal(r.stopReason, 'finished');
    assert.equal(s.bodies.length, 2);
    assert.ok(!s.bodies[0]!.includes('无法解析'), '第一次问的时候还没有提示');
    assert.notEqual(s.bodies[1], s.bodies[0], '回炉不是重发同一句话——提示必须进 payload');
    assert.match(lastUser(s.bodies[1]!), /无法解析/);
    assert.match(s.bodies[1]!, /测试任务/, '提示是追加，不是把原有上下文替换掉');
  } finally { await s.close(); }
});

test('故障 #8 对空回复同样成立：提示进 payload，且原有上下文不丢', async () => {
  const s = await withServer((n, res) => {
    if (n === 0) { empty(res, 0); return; }
    ok(res, DONE);
  });
  try {
    const { b } = brain(s.url);
    await runHarness({ brain: b, registry: reg(), config: cfg() });
    assert.notEqual(s.bodies[1], s.bodies[0]);
    assert.match(lastUser(s.bodies[1]!), /回复是空的/);
    assert.match(s.bodies[1]!, /测试任务/);
  } finally { await s.close(); }
});

test('连续两次回炉：两条提示都要在 payload 里，按顺序追加', async () => {
  const s = await withServer((n, res) => {
    if (n === 0) { empty(res, 0); return; }
    if (n === 1) { ok(res, '坏 JSON'); return; }
    ok(res, DONE);
  });
  try {
    const { b } = brain(s.url);
    const r = await runHarness({ brain: b, registry: reg(), config: cfg({ maxParseRetry: 2 }) });
    assert.equal(r.stopReason, 'finished');
    assert.equal(s.bodies.length, 3);
    const third = s.bodies[2]!;
    assert.match(third, /回复是空的/);
    assert.match(third, /无法解析/);
    assert.ok(third.indexOf('回复是空的') < third.indexOf('无法解析'), '提示按发生顺序追加');
  } finally { await s.close(); }
});