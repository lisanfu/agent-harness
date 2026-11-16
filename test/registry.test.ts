import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, resolveInSandbox, SandboxEscape } from '../src/tools/registry.ts';
import { builtinTools } from '../src/tools/builtin.ts';
import { createRng } from '../src/rng.ts';
import type { ToolContext } from '../src/types.ts';

function setup(): { reg: ToolRegistry; ctx: ToolContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'harness-reg-'));
  writeFileSync(join(dir, 'a.txt'), 'hello');
  mkdirSync(join(dir, 'sub'));
  const notes: string[] = [];
  const reg = new ToolRegistry();
  for (const t of builtinTools()) reg.register(t);
  const ctx: ToolContext = { sandbox: dir, rng: createRng(1), note: (t) => { notes.push(t); }, notes: () => notes };
  return { reg, ctx, dir };
}

test('未知工具：拒绝理由必须列出可用工具（可读、可行动）', async () => {
  const { reg, ctx } = setup();
  const r = await reg.execute({ name: 'teleport', args: {} }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'E_TOOL_UNKNOWN');
  assert.match(r.output, /list_dir/);
  assert.match(r.output, /finish/);
});

test('缺必填参数：提示参数名与说明', async () => {
  const { reg, ctx } = setup();
  const r = await reg.execute({ name: 'read_file', args: {} }, ctx);
  assert.equal(r.error?.code, 'E_TOOL_ARGS');
  assert.match(r.output, /path/);
});

test('参数类型错：告知期望类型与实际类型', async () => {
  const { reg, ctx } = setup();
  const r = await reg.execute({ name: 'read_file', args: { path: 123 } }, ctx);
  assert.equal(r.error?.code, 'E_TOOL_ARGS');
  assert.match(r.output, /string/);
  assert.match(r.output, /number/);
});

test('多余参数：告知只接受哪些', async () => {
  const { reg, ctx } = setup();
  const r = await reg.execute({ name: 'list_dir', args: { nope: 1 } }, ctx);
  assert.equal(r.error?.code, 'E_TOOL_ARGS');
  assert.match(r.output, /nope/);
});

test('沙箱越界：resolveInSandbox 抛 SandboxEscape', () => {
  const { dir } = setup();
  assert.throws(() => resolveInSandbox(dir, '../escape.txt'), SandboxEscape);
  assert.throws(() => resolveInSandbox(dir, '/etc/passwd'), SandboxEscape);
});

test('沙箱越界经工具调用：变成 E_TOOL_DENIED 且说明边界', async () => {
  const { reg, ctx } = setup();
  const r = await reg.execute({ name: 'read_file', args: { path: '../../etc/passwd' } }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'E_TOOL_DENIED');
  assert.match(r.output, /沙箱/);
});

test('文件不存在：提示先用 list_dir', async () => {
  const { reg, ctx } = setup();
  const r = await reg.execute({ name: 'read_file', args: { path: 'nope.txt' } }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /list_dir/);
});

test('把目录当文件读：提示改用 list_dir', async () => {
  const { reg, ctx } = setup();
  const r = await reg.execute({ name: 'read_file', args: { path: 'sub' } }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /list_dir/);
});

test('正常路径：list_dir / read_file / note / finish', async () => {
  const { reg, ctx } = setup();
  const ls = await reg.execute({ name: 'list_dir', args: {} }, ctx);
  assert.equal(ls.ok, true);
  assert.match(ls.output, /a\.txt/);
  const rd = await reg.execute({ name: 'read_file', args: { path: 'a.txt' } }, ctx);
  assert.equal(rd.output, 'hello');
  const nt = await reg.execute({ name: 'note', args: { text: '假设一' } }, ctx);
  assert.equal(nt.ok, true);
  assert.deepEqual(ctx.notes(), ['假设一']);
  const fin = await reg.execute({ name: 'finish', args: { summary: '完成' } }, ctx);
  assert.equal(fin.ok, true);
});

test('note 空内容被拒', async () => {
  const { reg, ctx } = setup();
  const r = await reg.execute({ name: 'note', args: { text: '   ' } }, ctx);
  assert.equal(r.ok, false);
});

test('重复注册同名工具直接抛错', () => {
  const { reg } = setup();
  assert.throws(() => reg.register(builtinTools()[0]!), /重复注册/);
});

test('工具内部抛错被兜住并给出可读理由', async () => {
  const { ctx } = setup();
  const reg = new ToolRegistry();
  reg.register({
    name: 'boom', description: 'x', params: {},
    run() { throw new Error('内部炸了'); },
  });
  const r = await reg.execute({ name: 'boom', args: {} }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'E_TOOL_RUNTIME');
  assert.match(r.output, /内部炸了/);
});