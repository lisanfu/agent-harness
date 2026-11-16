/**
 * 游戏工具测试：M1 暴露给大脑的唯一接口。
 *
 * 三条关键断言：
 *  A. 零说明书：描述只给接口（键盘上印的字母），绝不给策略（答案）。
 *  B. **游戏语义 ≠ 工具错误**：朝墙走是合法动作 + 可见后果，不是 E_TOOL_ARGS。
 *     报成参数错误会让大脑以为方向词写错了，从而乱改参数——ACI 那一课。
 *  C. 闭包绑定：同进程两个 session（参考版 + 变异版对照）绝不串台。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/rng.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { gameTools, isWorldTool, toWorldActions, WORLD_TOOL_NAMES } from '../src/tools/game.ts';
import { GameSession } from '../src/world/session.ts';
import { ALL_CAPS } from '../src/world/arena.ts';
import { ErrCode } from '../src/errors.ts';
import type { ToolContext } from '../src/types.ts';

function ctx(): ToolContext {
  const notes: string[] = [];
  return {
    sandbox: '/tmp',
    rng: createRng(1),
    note: (t) => { notes.push(t); },
    notes: () => notes,
  };
}

function rig(seed: number, caps = ALL_CAPS) {
  const session = new GameSession(seed, caps);
  const registry = new ToolRegistry();
  for (const t of gameTools(session)) registry.register(t);
  return { session, registry, c: ctx() };
}

const STRATEGY_WORDS = ['优先探索', '边界值', '未访问区域', '二分', '覆盖率', '变异', '建议', '应该先', '最优', '策略'];

// ───────────────────── A. 接口与零说明书 ─────────────────────

test('工具白名单恰好七个：眼睛一个、手四个、记忆与收手各一个', () => {
  const { registry } = rig(1);
  assert.deepEqual(registry.names().sort(), ['attack', 'finish', 'look', 'move', 'note', 'pickup', 'wait']);
  // 刻意不提供文件工具：arena 模式下 agent 不该有读文件的通道
  assert.equal(registry.has('read_file'), false);
  assert.equal(registry.has('list_dir'), false);
});

test('零说明书：所有工具描述只给接口，不含任何策略词', () => {
  const { registry } = rig(1);
  for (const spec of registry.specs()) {
    for (const w of STRATEGY_WORDS) {
      assert.ok(!spec.description.includes(w), `${spec.name} 的描述泄露了策略词「${w}」：${spec.description}`);
    }
    for (const p of Object.values(spec.params)) {
      for (const w of STRATEGY_WORDS) {
        assert.ok(!p.description.includes(w), `${spec.name} 的参数说明泄露了策略词「${w}」`);
      }
    }
  }
});

test('move 的描述给出了四个合法方向词（这是接口，不是策略）', () => {
  const { registry } = rig(1);
  const move = registry.specs().find((s) => s.name === 'move')!;
  assert.match(move.description, /up \/ right \/ down \/ left/);
  assert.equal(move.params['dir']!.required, true);
  assert.equal(move.params['dir']!.type, 'string');
});

test('isWorldTool 只认四个推进时间的动作', () => {
  assert.deepEqual([...WORLD_TOOL_NAMES], ['move', 'attack', 'pickup', 'wait']);
  for (const n of ['move', 'attack', 'pickup', 'wait']) assert.equal(isWorldTool(n), true);
  for (const n of ['look', 'note', 'finish', 'read_file']) assert.equal(isWorldTool(n), false);
});

// ───────────────────── B. 游戏语义 ≠ 工具错误 ─────────────────────

test('非法方向词：E_TOOL_ARGS + 可行动理由，且不推进游戏时间', async () => {
  const { session, registry, c } = rig(3);
  const r = await registry.execute({ name: 'move', args: { dir: 'north' } }, c);
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, ErrCode.TOOL_ARGS);
  assert.match(r.output, /up \/ right \/ down \/ left/);
  assert.ok(!/invalid/i.test(r.output));
  assert.equal(session.internalState().tick, 0, '被拒的动作不该消耗一帧');
  assert.deepEqual(session.actionSequence(), []);
});

test('朝墙走：ok=true（合法动作 + 可见后果），推进一帧但位置不变', async () => {
  // seed 3 的 (1,0) 是墙
  const { session, registry, c } = rig(3);
  const r = await registry.execute({ name: 'move', args: { dir: 'right' } }, c);
  assert.equal(r.ok, true, '撞墙是游戏语义，不是工具错误');
  assert.equal(r.error, undefined);
  assert.match(r.output, /你朝右撞上了障碍，没能移动/);
  assert.equal(session.internalState().tick, 1);
  assert.equal(session.internalState().player.x, 0);
  assert.deepEqual(session.actionSequence(), [{ kind: 'move', dir: 1 }]);
});

test('朝边界走：同样是 ok=true，不是参数错误', async () => {
  const { session, registry, c } = rig(3);
  const r = await registry.execute({ name: 'move', args: { dir: 'left' } }, c);
  assert.equal(r.ok, true);
  assert.match(r.output, /没能移动/);
  assert.equal(session.internalState().player.x, 0);
});

test('走成功：ok=true 且位置真的变了', async () => {
  const { session, registry, c } = rig(1);
  const r = await registry.execute({ name: 'move', args: { dir: 'right' } }, c);
  assert.equal(r.ok, true);
  assert.match(r.output, /你朝右走了一格/);
  assert.equal(session.internalState().player.x, 1);
});

test('look 不消耗游戏时间，且回传的就是当前屏幕', async () => {
  const { session, registry, c } = rig(6);
  const before = session.screen();
  const r = await registry.execute({ name: 'look', args: {} }, c);
  assert.equal(r.ok, true);
  assert.equal(r.output, before);
  assert.equal(session.internalState().tick, 0);
  await registry.execute({ name: 'wait', args: {} }, c);
  const r2 = await registry.execute({ name: 'look', args: {} }, c);
  assert.equal(session.internalState().tick, 1, 'look 不该推进时间');
  assert.match(r2.output, /第 1 帧/);
});

test('每个动作工具都回传新屏幕（人玩游戏就是按一下看一眼）', async () => {
  const { registry, c } = rig(6);
  for (const name of ['attack', 'pickup', 'wait'] as const) {
    const r = await registry.execute({ name, args: {} }, c);
    assert.equal(r.ok, true);
    assert.match(r.output, /HP \[/, `${name} 没回传屏幕`);
    assert.match(r.output, /刚才发生/);
  }
});

test('冷却中攻击：ok=true，文案说还没准备好（不是工具错误）', async () => {
  const { registry, c } = rig(6);
  await registry.execute({ name: 'attack', args: {} }, c);
  const r = await registry.execute({ name: 'attack', args: {} }, c);
  assert.equal(r.ok, true);
  assert.match(r.output, /你的攻击还没准备好/);
});

test('多余参数被注册表拒绝，并列出合法参数', async () => {
  const { registry, c } = rig(1);
  const r = await registry.execute({ name: 'wait', args: { times: 3 } }, c);
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, ErrCode.TOOL_ARGS);
  assert.match(r.output, /不接受参数 "times"/);
});

test('未知工具被拒绝并列出可用工具', async () => {
  const { registry, c } = rig(1);
  const r = await registry.execute({ name: 'teleport', args: {} }, c);
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, ErrCode.TOOL_UNKNOWN);
  assert.match(r.output, /look, move, attack, pickup, wait, note, finish/);
});

// ───────────────────── 眼睛不准读心 ─────────────────────

test('任何工具的输出都不含内部状态字段', async () => {
  const { registry, c } = rig(6);
  const calls = [
    { name: 'look', args: {} },
    { name: 'move', args: { dir: 'right' } },
    { name: 'attack', args: {} },
    { name: 'pickup', args: {} },
    { name: 'wait', args: {} },
  ];
  for (const call of calls) {
    const r = await registry.execute(call, c);
    for (const key of ['"enemies"', '"pickups"', '"walls"', '"cooldown"', '"maxHp"', '"alive"', '"dir"', '"id"']) {
      assert.ok(!r.output.includes(key), `${call.name} 的输出泄露了内部字段 ${key}`);
    }
  }
});

test('note 与 finish 复用通用器官，行为不变', async () => {
  const { registry, c } = rig(1);
  const n = await registry.execute({ name: 'note', args: { text: '敌人会移动' } }, c);
  assert.equal(n.ok, true);
  assert.deepEqual(c.notes(), ['敌人会移动']);
  const f = await registry.execute({ name: 'finish', args: { summary: '摸清了移动规则' } }, c);
  assert.equal(f.ok, true);
  assert.match(f.output, /摸清了移动规则/);
});

// ───────────────────── C. 闭包绑定，不串台 ─────────────────────

test('同进程两个 session 互不干扰（参考版 + 变异版对照的前提）', async () => {
  const a = rig(1);
  const b = rig(6, { ...ALL_CAPS, enemyPatrol: false });
  await a.registry.execute({ name: 'move', args: { dir: 'right' } }, a.c);
  assert.equal(a.session.internalState().tick, 1);
  assert.equal(b.session.internalState().tick, 0, 'B 被 A 的动作推进了 → 串台');

  const lookA = await a.registry.execute({ name: 'look', args: {} }, a.c);
  const lookB = await b.registry.execute({ name: 'look', args: {} }, b.c);
  assert.notEqual(lookA.output, lookB.output);
  assert.equal(lookA.output, a.session.screen());
  assert.equal(lookB.output, b.session.screen());
});

test('先建 A 后建 B，A 的工具仍绑定 A（模块级单例会有这个 bug）', async () => {
  const a = rig(3);
  const b = rig(1);
  const before = a.session.screen();
  await b.registry.execute({ name: 'wait', args: {} }, b.c);
  const after = await a.registry.execute({ name: 'look', args: {} }, a.c);
  assert.equal(after.output, before, 'A 的 look 读到了 B 的状态');
  assert.equal(a.session.internalState().tick, 0);
});

// ───────────────────── 动作序列抽取（重放的前提）─────────────────────

test('toWorldActions 滤掉 look/note/finish 与非法方向，只留世界里真发生的动作', () => {
  const calls = [
    { name: 'look', args: {} },
    { name: 'move', args: { dir: 'right' } },
    { name: 'note', args: { text: 'x' } },
    { name: 'move', args: { dir: 'north' } },   // 当时被工具层拒绝，世界里没发生
    { name: 'attack', args: {} },
    { name: 'pickup', args: {} },
    { name: 'wait', args: {} },
    { name: 'finish', args: { summary: 'done' } },
  ];
  assert.deepEqual(toWorldActions(calls), [
    { kind: 'move', dir: 1 },
    { kind: 'attack' },
    { kind: 'pickup' },
    { kind: 'wait' },
  ]);
});

test('toWorldActions 与 session 实际执行逐位一致（证据一致性）', async () => {
  const { session, registry, c } = rig(6);
  const calls = [
    { name: 'look', args: {} },
    { name: 'move', args: { dir: 'right' } },
    { name: 'move', args: { dir: 'bad' } },
    { name: 'attack', args: {} },
    { name: 'wait', args: {} },
    { name: 'note', args: { text: 'x' } },
  ];
  for (const call of calls) await registry.execute(call, c);
  assert.deepEqual(toWorldActions(calls), session.actionSequence());
});

test('大小写与空白方向词被容错，且抽取结果与执行一致', async () => {
  const { session, registry, c } = rig(1);
  const calls = [{ name: 'move', args: { dir: '  RIGHT ' } }];
  const r = await registry.execute(calls[0]!, c);
  assert.equal(r.ok, true);
  assert.deepEqual(toWorldActions(calls), session.actionSequence());
  assert.deepEqual(session.actionSequence(), [{ kind: 'move', dir: 1 }]);
});