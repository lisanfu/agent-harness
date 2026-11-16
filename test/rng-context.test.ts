import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, seedFromString, canonical, hashState } from '../src/rng.ts';
import { buildContext, estimateChars } from '../src/context.ts';
import type { Message } from '../src/types.ts';

test('同种子产生完全相同的序列（重放地基）', () => {
  const a = createRng(42), b = createRng(42);
  const sa = Array.from({ length: 50 }, () => a());
  const sb = Array.from({ length: 50 }, () => b());
  assert.deepEqual(sa, sb);
});

test('不同种子序列不同', () => {
  const a = createRng(1), b = createRng(2);
  assert.notEqual(a(), b());
});

test('随机值落在 [0,1)', () => {
  const r = createRng(7);
  for (let i = 0; i < 500; i++) { const v = r(); assert.ok(v >= 0 && v < 1); }
});

test('字符串种子稳定且与数字种子区分', () => {
  assert.equal(seedFromString('run-42'), seedFromString('run-42'));
  assert.notEqual(seedFromString('run-42'), seedFromString('run-43'));
});

test('canonical 键序无关：{a,b} 与 {b,a} 哈希一致', () => {
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.equal(hashState({ a: 1, b: 2 }), hashState({ b: 2, a: 1 }));
});

test('嵌套与数组顺序：数组顺序敏感，对象键序不敏感', () => {
  assert.equal(hashState({ x: { a: 1, b: 2 } }), hashState({ x: { b: 2, a: 1 } }));
  assert.notEqual(hashState([1, 2]), hashState([2, 1]));
});

test('上下文截断：system 永不丢，且显式标注省略条数', () => {
  const history: Message[] = Array.from({ length: 40 }, (_, i) => ({
    role: 'user' as const, content: `消息${i} ${'x'.repeat(100)}`,
  }));
  const built = buildContext('任务契约', history, { maxContextChars: 1200, keepRecent: 4 });
  assert.equal(built.messages[0]?.role, 'system');
  assert.equal(built.messages[0]?.content, '任务契约');
  assert.ok(built.dropped > 0);
  const marker = built.messages.find((m) => m.content.includes('上下文已截断'));
  assert.ok(marker, '必须有显式截断标注，让大脑知道自己失忆了');
  assert.match(marker!.content, new RegExp(String(built.dropped)));
  // 最近 4 条必须都在
  for (let i = 36; i < 40; i++) {
    assert.ok(built.messages.some((m) => m.content.startsWith(`消息${i} `)));
  }
});

test('预算充足时不截断', () => {
  const history: Message[] = [{ role: 'user', content: '短' }];
  const built = buildContext('sys', history, { maxContextChars: 10000, keepRecent: 8 });
  assert.equal(built.dropped, 0);
  assert.equal(built.messages.length, 2);
});

test('keepRecent 大于历史长度时不越界', () => {
  const built = buildContext('sys', [{ role: 'user', content: 'a' }], { maxContextChars: 500, keepRecent: 99 });
  assert.equal(built.dropped, 0);
  assert.equal(built.messages.length, 2);
});

test('estimateChars 随内容增长', () => {
  assert.ok(estimateChars([{ role: 'user', content: 'x'.repeat(100) }]) > estimateChars([{ role: 'user', content: 'x' }]));
});

test('地板大于预算时 overBudget=true，但 system 与最近消息仍完整', () => {
  const system = '契约'.repeat(200); // 400 字符，本身就超预算
  const history: Message[] = Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
  const built = buildContext(system, history, { maxContextChars: 100, keepRecent: 2 });
  assert.equal(built.overBudget, true);
  assert.equal(built.messages[0]?.content, system);
  assert.ok(built.messages.some((m) => m.content === 'm5'));
  assert.ok(built.messages.some((m) => m.content === 'm4'));
});

test('预算充足时 overBudget=false', () => {
  const built = buildContext('sys', [{ role: 'user', content: 'a' }], { maxContextChars: 10_000, keepRecent: 8 });
  assert.equal(built.overBudget, false);
});