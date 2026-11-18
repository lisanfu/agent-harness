/**
 * 传输层重试回归测试。
 *
 * 存在的理由（真实故障换来的）：
 *   真模型对照组跑到第 11 步，端点返回 HTTP 429（免费额度限流），
 *   而当时所有 !res.ok 都被抛成同一个 E_BRAIN_HTTP，循环层只给 E_BRAIN_PARSE 回炉机会，
 *   于是**可重试的限流被当成致命协议错误**，整局被掐断。
 *   429 和 400 是两类东西：400 是"你话说错了"，429 是"你说得对但现在轮不到你"。
 *
 * 纪律：每条分支都真发 HTTP、真数请求次数。
 * 只断言"抛了什么错"是不够的——不数请求次数，就分不清"重试了"和"直接放弃了"。
 * 睡眠用注入点记录，不真等（否则一个测试要睡 7 秒，而且测不到退避数值）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrCode, HarnessError, httpFailure, parseRetryAfter } from '../src/errors.ts';
import { OpenAIBrain, type OpenAIBrainOptions } from '../src/brain/openai.ts';
import { runHarness } from '../src/loop.ts';
import { builtinTools } from '../src/tools/builtin.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { BrainRetryInfo, DecideRequest, HarnessConfig } from '../src/types.ts';

const DECISION = '{"thought":"ok","call":{"name":"finish","args":{"summary":"s"}}}';

const req: DecideRequest = {
  task: 't', system: 't', messages: [{ role: 'user', content: 't' }],
  tools: [], step: 1, notes: [],
};

interface Probe {
  url: string;
  /** 每次请求的原始 body，按到达顺序。用来证明"重试重发的是同一句话"。 */
  bodies: string[];
  close: () => Promise<void>;
}

function withServer(handler: (n: number, body: string, res: ServerResponse) => void): Promise<Probe> {
  return new Promise((resolve) => {
    const bodies: string[] = [];
    const srv: Server = createServer((q, res) => {
      const chunks: Buffer[] = [];
      q.on('data', (c) => chunks.push(c as Buffer));
      q.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        bodies.push(body);
        handler(bodies.length - 1, body, res);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        bodies,
        // closeAllConnections：fetch 默认 keep-alive，不强制断开的话 close() 会等空闲超时，
        // 测试就"跑完了却退不出"。这不是业务问题，是测试夹具必须处理的真实行为。
        close: () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }),
      });
    });
  });
}

function ok(res: ServerResponse, content: string): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
}

/** random 注入成 0 → 抖动为 0，退避数值可精确断言。 */
function brain(url: string, over: Partial<OpenAIBrainOptions> = {}) {
  const waits: number[] = [];
  const b = new OpenAIBrain({
    baseUrl: url, apiKey: 'k', model: 'm', timeoutMs: 3000,
    sleep: async (ms) => { waits.push(ms); },
    random: () => 0,
    ...over,
  });
  return { b, waits };
}

// ── A. 分类：可重试 vs 不可重试 ────────────────────────────

test('httpFailure 分类表：429/408/5xx 可重试，其余 4xx 不可', () => {
  for (const st of [429, 408, 500, 502, 503, 504]) {
    assert.equal(httpFailure(st, 'x').retryable, true, `HTTP ${st} 应当可重试`);
  }
  for (const st of [400, 401, 403, 404, 422]) {
    assert.equal(httpFailure(st, 'x').retryable, false, `HTTP ${st} 不该重试`);
  }
  // 429 必须有自己的码，不能混在 E_BRAIN_HTTP 里——上层要靠它区分限流与协议错
  assert.equal(httpFailure(429, 'x').code, ErrCode.BRAIN_RATE_LIMIT);
  assert.equal(httpFailure(500, 'x').code, ErrCode.BRAIN_HTTP);
  assert.equal(httpFailure(400, 'x').code, ErrCode.BRAIN_HTTP);
});

test('拒绝理由必须出现在 message 里，且告诉人该不该等（ACI 对人类同样适用）', () => {
  const limited = httpFailure(429, '{"error":{"message":"free tier quota"}}');
  assert.match(limited.message, /429/);
  assert.match(limited.message, /free tier quota/);
  assert.match(limited.message, /限流/);
  const bad = httpFailure(400, 'missing field `tool_call_id`');
  assert.match(bad.message, /tool_call_id/);
  assert.match(bad.message, /重试无用/);
});

test('parseRetryAfter 两种合法写法都认：延迟秒数 与 HTTP 日期', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter(' 3 '), 3000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(''), undefined);
  assert.equal(parseRetryAfter('垃圾'), undefined);
  const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:29:00 GMT', now), 60_000);
  // 过去的时间不能算出负数，否则 setTimeout(负数) 立刻触发 → 退避退化成贴墙连撞
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:27:00 GMT', now), 0);
});

// ── B. 真的重试了 ────────────────────────────────────────

test('429 两次后 200：真重发，且三次请求体逐位相同（重试不是换句话）', async () => {
  const s = await withServer((n, _body, res) => {
    if (n < 2) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"You have reached the API rate limit for free users."}}');
      return;
    }
    ok(res, DECISION);
  });
  try {
    const { b, waits } = brain(s.url);
    const events: BrainRetryInfo[] = [];
    b.onRetry = (i) => events.push(i);
    const d = await b.decide(req);
    assert.equal(d.call.name, 'finish');
    assert.equal(s.bodies.length, 3, '应当真的发了 3 次请求');
    assert.equal(s.bodies[0], s.bodies[1], '重试必须重发同一份 payload');
    assert.equal(s.bodies[1], s.bodies[2]);
    assert.deepEqual(waits, [1000, 2000], '指数退避 1s → 2s');
    assert.equal(events.length, 2, '每次重试都要出声');
    assert.deepEqual(events.map((e) => e.attempt), [1, 2]);
    assert.deepEqual(events.map((e) => e.maxRetries), [3, 3]);
    assert.ok(events.every((e) => e.error.code === ErrCode.BRAIN_RATE_LIMIT));
  } finally { await s.close(); }
});

test('500 一次后 200：服务端抖动同样可重试', async () => {
  const s = await withServer((n, _body, res) => {
    if (n === 0) { res.writeHead(500); res.end('boom'); return; }
    ok(res, DECISION);
  });
  try {
    const { b, waits } = brain(s.url);
    const d = await b.decide(req);
    assert.equal(d.call.name, 'finish');
    assert.equal(s.bodies.length, 2);
    assert.deepEqual(waits, [1000]);
  } finally { await s.close(); }
});

test('真实超时一次后成功：超时说的是"这次没赶上"，不是"这句话不该说"', async () => {
  const s = await withServer((n, _body, res) => {
    if (n === 0) {
      setTimeout(() => {
        // 客户端已 abort，这条连接可能已销毁；写之前必须判，否则测试自己抛异常
        if (!res.destroyed && !res.writableEnded) { res.writeHead(200); res.end('{}'); }
      }, 400);
      return;
    }
    ok(res, DECISION);
  });
  try {
    const { b, waits } = brain(s.url, { timeoutMs: 100 });
    const d = await b.decide(req);
    assert.equal(d.call.name, 'finish');
    assert.equal(s.bodies.length, 2);
    assert.deepEqual(waits, [1000]);
  } finally { await s.close(); }
});

test('真实连接被拒：可重试，且退避真的发生了', async () => {
  const { b, waits } = brain('http://127.0.0.1:1/v1', { maxRetries: 2 });
  await assert.rejects(() => b.decide(req), (e: unknown) => {
    assert.ok(e instanceof HarnessError);
    assert.equal(e.code, ErrCode.BRAIN_CONNECTION);
    return true;
  });
  assert.deepEqual(waits, [1000, 2000], '连不上也要退避，不能贴墙连撞');
});

// ── C. 听服务端的 Retry-After ─────────────────────────────

test('Retry-After 秒数优先于自己的指数退避', async () => {
  const s = await withServer((n, _body, res) => {
    if (n === 0) { res.writeHead(429, { 'retry-after': '7' }); res.end('slow down'); return; }
    ok(res, DECISION);
  });
  try {
    const { b, waits } = brain(s.url);
    await b.decide(req);
    assert.deepEqual(waits, [7000], '服务端说 7 秒，自己算的 1 秒必须让位');
  } finally { await s.close(); }
});

test('Retry-After 写成 HTTP 日期也能换算，不是 NaN', async () => {
  // ⚠️ 这条原来写的是 `waits[0] >= 4000 && <= 5000`，加压下（6 个 yes + 全表并发）实测红了：3982。
  // 根因不在产品代码，在**判据选错**：`toUTCString()` 只有整秒粒度，"5000ms 之后"的头
  // 落进 [4001, 5000] 是**世界**决定的；测试再手抄一遍这个区间，就等于把一个随机器忙闲漂移的量当常量断言。
  // 第二版改成"等待值 == 到期时刻 − 那一刻"并留 ±5ms 松弛量——**同一个错误掉到下一层**：
  // 加压第 6 轮实测差 6ms 又红。松弛量本身也是手挑的负载常数。
  // 现在的两条界是**结构上负载免疫**的：下界 `deadline - Date.now()` 随时间只会变小（断言只会变松，不会误红），
  // 上界 5000 由 `deadline ≤ 起算+5000` 与"换算不减负"保证。两条合起来仍然抓得住全部真故障：
  // NaN（两边都过不去）、掉回 1000ms 指数退避（过不了下界）、多睡（过上界）。
  const deadline = Math.floor((Date.now() + 5000) / 1000) * 1000;
  const header = new Date(deadline).toUTCString();
  assert.equal(Date.parse(header), deadline, '夹具前提：秒级取整后的日期必须能无损往返，否则下面测的不是换算');
  const s = await withServer((n, _body, res) => {
    if (n === 0) {
      res.writeHead(429, { 'retry-after': header });
      res.end('slow down');
      return;
    }
    ok(res, DECISION);
  });
  try {
    const { b, waits } = brain(s.url);
    await b.decide(req);
    assert.equal(waits.length, 1);
    const w = waits[0]!;
    assert.ok(!Number.isNaN(w), '日期格式换算出 NaN 会让退避失效');
    const floor = deadline - Date.now();
    assert.ok(w >= floor, `不许把服务端广告的等待时间砍成指数退避那 1 秒：w=${w}，下界=${floor}`);
    assert.ok(w <= 5000, `不许比服务端说的更久睡：w=${w}`);
  } finally { await s.close(); }
});

test('Retry-After 远超上限时夹到上限：不挂死一小时，把话说清楚后失败', async () => {
  const s = await withServer((_n, _body, res) => {
    res.writeHead(429, { 'retry-after': '3600' });
    res.end('quota exhausted for today');
  });
  try {
    const { b, waits } = brain(s.url, { maxRetries: 1 });
    await assert.rejects(() => b.decide(req), (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.code, ErrCode.BRAIN_RATE_LIMIT);
      assert.match(e.message, /已原地重试 1 次仍失败/);
      return true;
    });
    assert.deepEqual(waits, [15_000], '不能真睡 3600 秒把 wall 预算烧光');
    assert.equal(s.bodies.length, 2);
  } finally { await s.close(); }
});

// ── D. 不该重试的一次都不多撞 ─────────────────────────────

test('400 协议错：只发 1 次请求，立刻失败，不出声重试', async () => {
  const s = await withServer((_n, _body, res) => {
    res.writeHead(400);
    res.end('{"error":{"message":"messages[3]: missing field `tool_call_id`"}}');
  });
  try {
    const { b, waits } = brain(s.url);
    const events: BrainRetryInfo[] = [];
    b.onRetry = (i) => events.push(i);
    await assert.rejects(() => b.decide(req), (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.code, ErrCode.BRAIN_HTTP);
      assert.equal(e.retryable, false);
      assert.match(e.message, /400/);
      assert.match(e.message, /tool_call_id/);
      return true;
    });
    assert.equal(s.bodies.length, 1, '协议错重说一万遍也错，不许多撞');
    assert.deepEqual(waits, []);
    assert.deepEqual(events, []);
  } finally { await s.close(); }
});

test('401 key 错：只发 1 次请求', async () => {
  const s = await withServer((_n, _body, res) => { res.writeHead(401); res.end('invalid api key'); });
  try {
    const { b, waits } = brain(s.url);
    await assert.rejects(() => b.decide(req), (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.retryable, false);
      assert.match(e.message, /401/);
      return true;
    });
    assert.equal(s.bodies.length, 1);
    assert.deepEqual(waits, []);
  } finally { await s.close(); }
});

test('解析失败不在传输层重试：那是循环层的活（它要塞修复提示）', async () => {
  const s = await withServer((_n, _body, res) => ok(res, '这不是JSON'));
  try {
    const { b, waits } = brain(s.url);
    await assert.rejects(() => b.decide(req), (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.code, ErrCode.BRAIN_PARSE);
      return true;
    });
    assert.equal(s.bodies.length, 1, '一个失败类别只有一个重试主人，别两层都重试');
    assert.deepEqual(waits, []);
  } finally { await s.close(); }
});

test('空内容不在传输层重试', async () => {
  const s = await withServer((_n, _body, res) => ok(res, '   '));
  try {
    const { b, waits } = brain(s.url);
    await assert.rejects(() => b.decide(req), (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.code, ErrCode.BRAIN_EMPTY);
      return true;
    });
    assert.equal(s.bodies.length, 1);
    assert.deepEqual(waits, []);
  } finally { await s.close(); }
});

// ── E. 重试耗尽：诚实放弃，不无限撞墙 ─────────────────────

test('429 持续：重试 3 次后放弃，错误里写明撞了几次，且不再标可重试', async () => {
  const s = await withServer((_n, _body, res) => {
    res.writeHead(429);
    res.end('{"error":{"message":"You have reached the API rate limit for free users."}}');
  });
  try {
    const { b, waits } = brain(s.url);
    const events: BrainRetryInfo[] = [];
    b.onRetry = (i) => events.push(i);
    await assert.rejects(() => b.decide(req), (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.code, ErrCode.BRAIN_RATE_LIMIT);
      assert.match(e.message, /429/);
      assert.match(e.message, /已原地重试 3 次仍失败/);
      // 放弃后必须摘掉 retryable，否则上层若再套一层重试就变成 4×4 次撞墙
      assert.equal(e.retryable, false);
      assert.equal((e.detail as { attempts: number }).attempts, 4);
      return true;
    });
    assert.equal(s.bodies.length, 4, '初次 + 3 次重试');
    assert.deepEqual(waits, [1000, 2000, 4000]);
    assert.equal(events.length, 3);
  } finally { await s.close(); }
});

test('maxRetries=0：一次都不重试，但仍报限流码', async () => {
  const s = await withServer((_n, _body, res) => { res.writeHead(429); res.end('nope'); });
  try {
    const { b, waits } = brain(s.url, { maxRetries: 0 });
    await assert.rejects(() => b.decide(req), (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.code, ErrCode.BRAIN_RATE_LIMIT);
      return true;
    });
    assert.equal(s.bodies.length, 1);
    assert.deepEqual(waits, []);
  } finally { await s.close(); }
});

test('抖动有上界：random=1 时等待 = 指数值 × 1.25，不会失控', async () => {
  const s = await withServer((n, _body, res) => {
    if (n < 2) { res.writeHead(503); res.end('busy'); return; }
    ok(res, DECISION);
  });
  try {
    const waits: number[] = [];
    const b = new OpenAIBrain({
      baseUrl: s.url, apiKey: 'k', model: 'm', timeoutMs: 3000,
      sleep: async (ms) => { waits.push(ms); }, random: () => 1,
    });
    await b.decide(req);
    assert.deepEqual(waits, [1250, 2500]);
  } finally { await s.close(); }
});

// ── F. 契约防回归：差点犯的错 ─────────────────────────────

test('DecideRequest 里不许有函数字段：stdio 是 JSON.stringify 整个 req 的', () => {
  // 我差点把 onRetry 塞进 DecideRequest。StdioBrain 把整个 req 序列化发到 stdout，
  // 函数会被 JSON 静默丢掉——远端能重试、宿主模式悄悄不能，且不报任何错。
  // 这条断言就是钉住这个坑：出声口只能挂在 brain 实例上。
  assert.equal(typeof (req as unknown as Record<string, unknown>)['onRetry'], 'undefined');
  const wire = JSON.parse(JSON.stringify({ type: 'decide', ...req })) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(wire).sort(),
    ['type', 'task', 'system', 'messages', 'tools', 'step', 'notes'].sort(),
  );
  for (const v of Object.values(wire)) assert.notEqual(typeof v, 'function');
});

// ── G. 循环层集成：重试必须进无损证据 ─────────────────────

function cfg(): HarnessConfig {
  const sandbox = mkdtempSync(join(tmpdir(), 'retry-sbx-'));
  writeFileSync(join(sandbox, 'a.txt'), 'hello');
  return {
    task: '测试任务', sandbox, seed: 42, maxSteps: 5, maxWallMs: 30_000,
    maxContextChars: 12_000, keepRecent: 8, maxParseRetry: 2, repeatLimit: 3,
    outDir: mkdtempSync(join(tmpdir(), 'retry-out-')),
  };
}

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of builtinTools()) r.register(t);
  return r;
}

test('重试写进 trace.jsonl 与 result.json：不记下来就会把限流误读成模型慢', async () => {
  const s = await withServer((n, _body, res) => {
    if (n === 0) { res.writeHead(429); res.end('{"error":{"message":"rate limit"}}'); return; }
    ok(res, DECISION);
  });
  try {
    const { b } = brain(s.url);
    const r = await runHarness({ brain: b, registry: reg(), config: cfg() });
    assert.equal(r.stopReason, 'finished');
    assert.equal(r.brainRetries, 1);

    const lines = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8').trim().split('\n');
    const retries = lines.filter((l) => l.includes('brain_retry'));
    assert.equal(retries.length, 1, '重试必须留档，否则这一步看起来只请求了一次');
    const ev = JSON.parse(retries[0]!) as { kind: string; payload: { step: number; attempt: number; waitMs: number; error: { code: string } } };
    assert.equal(ev.kind, 'brain_retry');
    assert.equal(ev.payload.step, 1);
    assert.equal(ev.payload.attempt, 1);
    assert.equal(ev.payload.waitMs, 1000);
    assert.equal(ev.payload.error.code, ErrCode.BRAIN_RATE_LIMIT);

    const result = JSON.parse(readFileSync(join(r.runDir, 'result.json'), 'utf8')) as { brainRetries: number };
    assert.equal(result.brainRetries, 1);
  } finally { await s.close(); }
});

test('一路顺畅时 brainRetries=0，且 trace 里没有 brain_retry', async () => {
  const s = await withServer((_n, _body, res) => ok(res, DECISION));
  try {
    const { b } = brain(s.url);
    const r = await runHarness({ brain: b, registry: reg(), config: cfg() });
    assert.equal(r.stopReason, 'finished');
    assert.equal(r.brainRetries, 0);
    const trace = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8');
    assert.ok(!trace.includes('brain_retry'));
  } finally { await s.close(); }
});

test('限流耗尽 → 整局 brain_failed，但已完成步骤与重试次数都留在证据里', async () => {
  const s = await withServer((n, _body, res) => {
    if (n === 0) { ok(res, '{"thought":"先看看","call":{"name":"list_dir","args":{}}}'); return; }
    res.writeHead(429);
    res.end('{"error":{"message":"rate limit"}}');
  });
  try {
    const { b } = brain(s.url, { maxRetries: 1 });
    const r = await runHarness({ brain: b, registry: reg(), config: cfg() });
    assert.equal(r.stopReason, 'brain_failed');
    assert.equal(r.steps.length, 1, '限流前已完成的步骤不能丢');
    assert.equal(r.brainRetries, 1);
    const trace = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8');
    assert.match(trace, /brain_retry/);
    assert.match(trace, /E_BRAIN_RATE_LIMIT/);
    const result = JSON.parse(readFileSync(join(r.runDir, 'result.json'), 'utf8')) as { brainRetries: number; stopReason: string };
    assert.equal(result.stopReason, 'brain_failed');
    assert.equal(result.brainRetries, 1);
  } finally { await s.close(); }
});