/**
 * 错误分类测试。存在的理由：
 * 之前 Python 版捕的是内建 TimeoutError/ConnectionError，而真实异常是
 * DOMException 与 TypeError('fetch failed')，导致分支写了却从未执行。
 * 这里用真实形状 + 真实 HTTP 服务器把每条分支都跑一遍。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { classify, ErrCode, HarnessError } from '../src/errors.ts';
import { OpenAIBrain } from '../src/brain/openai.ts';
import type { DecideRequest } from '../src/types.ts';

test('AbortSignal 超时（DOMException name=TimeoutError）被识别为超时', () => {
  const e = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(classify(e).code, ErrCode.BRAIN_TIMEOUT);
});

test('AbortError 也归为超时', () => {
  const e = new DOMException('aborted', 'AbortError');
  assert.equal(classify(e).code, ErrCode.BRAIN_TIMEOUT);
});

test("fetch failed + cause.code 被识别为连接错误并保留真因", () => {
  const e = new TypeError('fetch failed');
  (e as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
  const he = classify(e);
  assert.equal(he.code, ErrCode.BRAIN_CONNECTION);
  assert.match(he.message, /ECONNREFUSED/);
});

test('HarnessError 原样透传，不被二次包装', () => {
  const orig = new HarnessError(ErrCode.TOOL_DENIED, '越界');
  assert.equal(classify(orig), orig);
});

test('未知异常落到 fallbackCode', () => {
  assert.equal(classify('炸了', ErrCode.CONFIG).code, ErrCode.CONFIG);
  assert.equal(classify(new Error('普通错误')).code, ErrCode.BRAIN_CONNECTION);
});

test('配置缺失时构造即报错', () => {
  assert.throws(
    () => new OpenAIBrain({ baseUrl: '', apiKey: 'k', model: 'm', timeoutMs: 1000 }),
    /BRAIN_BASE_URL/,
  );
  assert.throws(
    () => new OpenAIBrain({ baseUrl: 'http://x/v1', apiKey: 'k', model: '', timeoutMs: 1000 }),
    /BRAIN_MODEL/,
  );
});

const req: DecideRequest = {
  task: 't', system: 't', messages: [{ role: 'user', content: 't' }],
  tools: [], step: 1, notes: [],
};

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

test('真实 HTTP 500 → E_BRAIN_HTTP（不是异常，是 response.ok=false）', async () => {
  const s = await withServer((_q, res) => { res.writeHead(500); res.end('boom'); });
  try {
    const brain = new OpenAIBrain({ baseUrl: s.url, apiKey: 'k', model: 'm', timeoutMs: 3000 });
    await assert.rejects(() => brain.decide(req), (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.code, ErrCode.BRAIN_HTTP);
      assert.match(e.message, /500/);
      return true;
    });
  } finally { await s.close(); }
});

test('真实 HTTP 200 但内容为空 → E_BRAIN_EMPTY', async () => {
  const s = await withServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '   ' } }] }));
  });
  try {
    const brain = new OpenAIBrain({ baseUrl: s.url, apiKey: 'k', model: 'm', timeoutMs: 3000 });
    await assert.rejects(() => brain.decide(req), /E_BRAIN_EMPTY|空内容/);
  } finally { await s.close(); }
});

test('真实 HTTP 200 正常内容 → 解析成 Decision', async () => {
  const s = await withServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: '{"thought":"ok","call":{"name":"finish","args":{"summary":"s"}}}' } }],
    }));
  });
  try {
    const brain = new OpenAIBrain({ baseUrl: s.url, apiKey: 'k', model: 'm', timeoutMs: 3000 });
    const d = await brain.decide(req);
    assert.equal(d.call.name, 'finish');
  } finally { await s.close(); }
});

test('真实超时 → E_BRAIN_TIMEOUT', async () => {
  const s = await withServer((_q, res) => { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 800); });
  try {
    const brain = new OpenAIBrain({ baseUrl: s.url, apiKey: 'k', model: 'm', timeoutMs: 120 });
    await assert.rejects(() => brain.decide(req), (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.code, ErrCode.BRAIN_TIMEOUT);
      return true;
    });
  } finally { await s.close(); }
});

test('真实连接被拒 → E_BRAIN_CONNECTION', async () => {
  const brain = new OpenAIBrain({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', timeoutMs: 2000 });
  await assert.rejects(() => brain.decide(req), (e: unknown) => {
    assert.ok(e instanceof HarnessError);
    assert.equal(e.code, ErrCode.BRAIN_CONNECTION);
    return true;
  });
});