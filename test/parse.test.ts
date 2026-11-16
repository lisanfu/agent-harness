import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, parseDecision, repairHint } from '../src/parse.ts';
import { HarnessError } from '../src/errors.ts';

test('纯 JSON 正常解析', () => {
  const d = parseDecision('{"thought":"先看看","call":{"name":"list_dir","args":{}}}');
  assert.equal(d.call.name, 'list_dir');
  assert.equal(d.thought, '先看看');
});

test('代码围栏包裹', () => {
  const d = parseDecision('```json\n{"thought":"x","call":{"name":"note","args":{"text":"a"}}}\n```');
  assert.equal(d.call.name, 'note');
  assert.equal(d.call.args['text'], 'a');
});

test('前后有散文也能扫出对象', () => {
  const d = parseDecision('好的，我认为应该这样：{"thought":"y","call":{"name":"finish","args":{"summary":"done"}}} 以上。');
  assert.equal(d.call.name, 'finish');
});

test('字符串里含大括号不会破坏平衡扫描', () => {
  const d = parseDecision('{"thought":"含 { } 和 \\" 引号","call":{"name":"note","args":{"text":"}{ {"}}}');
  assert.equal(d.call.args['text'], '}{ {');
});

test('args 被套成 JSON 字符串时能解开', () => {
  const d = parseDecision('{"call":{"name":"read_file","args":"{\\"path\\":\\"a.txt\\"}"}}');
  assert.equal(d.call.args['path'], 'a.txt');
});

test('兼容 tool/action 与 arguments 别名', () => {
  assert.equal(parseDecision('{"action":{"name":"note","arguments":{"text":"z"}}}').call.name, 'note');
  assert.equal(parseDecision('{"tool":{"tool":"finish","args":{"summary":"s"}}}').call.name, 'finish');
});

test('括号不闭合 → E_BRAIN_PARSE', () => {
  assert.throws(() => parseDecision('{"thought":"x","call":{"name":"note"'), (e: unknown) => {
    assert.ok(e instanceof HarnessError);
    assert.equal(e.code, 'E_BRAIN_PARSE');
    return true;
  });
});

test('完全没有 JSON → E_BRAIN_PARSE', () => {
  assert.throws(() => parseDecision('我不知道该做什么'), /E_BRAIN_PARSE|找不到完整的 JSON/);
});

test('缺 call → E_BRAIN_PARSE', () => {
  assert.throws(() => parseDecision('{"thought":"只想不动"}'), /call/);
});

test('call.name 为空 → E_BRAIN_PARSE', () => {
  assert.throws(() => parseDecision('{"call":{"name":"  ","args":{}}}'), /name/);
});

test('args 是数组 → E_BRAIN_PARSE', () => {
  assert.throws(() => parseDecision('{"call":{"name":"note","args":[1,2]}}'), /args/);
});

test('extractJsonObject 对不平衡返回 null', () => {
  assert.equal(extractJsonObject('{"a":1'), null);
  assert.equal(extractJsonObject('no json here'), null);
});

test('回炉提示包含错误原因、格式与可用工具', () => {
  const err = new HarnessError('E_BRAIN_PARSE', '括号不闭合');
  const hint = repairHint(err, ['list_dir', 'finish']);
  assert.match(hint, /括号不闭合/);
  assert.match(hint, /"thought"/);
  assert.match(hint, /list_dir, finish/);
});
// ── testing（M4-b）：归因目标的解析纪律 ──────────────────────
// 比 predict 更保守：predict 猜错顶多判一个 unverifiable，
// testing 猜错会把客观核对记到**另一条假设**头上，那是伪造归因。

test('testing 简写与完整形都归一化成 {id, field?}', () => {
  const base = '"thought":"t","call":{"name":"wait","args":{}}';
  assert.deepEqual(parseDecision(`{${base},"testing":"H1"}`).testing, { id: 'H1' });
  assert.deepEqual(
    parseDecision(`{${base},"testing":{"id":"H1","field":"enemyCount"}}`).testing,
    { id: 'H1', field: 'enemyCount' },
  );
  // 空白要 trim；空 field 不该留下一个空键，否则下游会以为它限定了字段
  assert.deepEqual(
    parseDecision(`{${base},"testing":{"id":"  H1  ","field":"   "}}`).testing,
    { id: 'H1' },
  );
});

test('testing 写歪：id=null + 原文留档，绝不猜也不丢', () => {
  const base = '"thought":"t","call":{"name":"wait","args":{}}';
  const cases: [string, unknown][] = [
    ['{"field":"enemyCount"}', { field: 'enemyCount' }],
    ['{"hypothesis":"H1"}', { hypothesis: 'H1' }],   // 只认 id，不接受别名
    ['42', 42],
    ['""', ''],
    ['["H1"]', ['H1']],
    ['{"id":7}', { id: 7 }],
  ];
  for (const [lit, raw] of cases) {
    const d = parseDecision(`{${base},"testing":${lit}}`);
    assert.equal(d.testing!.id, null, `${lit} 不该被猜成某条假设`);
    assert.deepEqual(d.testing!.raw, raw, `${lit} 的原文必须留档`);
    assert.equal(d.call.name, 'wait', '附加字段写歪不该让一个合法动作作废');
  }
});

test('根本没给 testing → undefined，不是 null（"没声明"与"声明写歪"必须分得开）', () => {
  const d = parseDecision('{"thought":"t","call":{"name":"wait","args":{}}}');
  assert.equal(d.testing, undefined);
  assert.ok(!('testing' in d));
});
