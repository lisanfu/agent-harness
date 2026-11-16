/**
 * 死循环判据回归测试（世界模式）。
 *
 * 存在的理由（真跑三局换来的故障 #6）：
 *   旧判据只比动作签名，把"直线走图"误判成死循环。
 *   真模型三局全部 stop=loop_detected，被砍在 7~12 步，而玩家每步都在前进：
 *     对照组 (4,2)→(5,2)→(6,2)→(7,2)，三步都是 move right
 *     M02    (0,1)→(1,1)→(2,1)，三步都是 move down
 *     M07    连续 move down 正朝物品靠近
 *   后果不只是步数少：agent 从没机会调 finish，M07 永远走不到 hp=0，
 *   公证器报"未分叉"——**harness 自己造成的假阴性，却会被误读成公证器无能**。
 *
 * 修法：重复动作 **且局面毫无变化** 才算卡住。
 * 关键陷阱：不能复用 worldHash，它含 tick 每帧都变，拿它判循环会永远判不出。
 * 所以这里同时钉住两件事：走图不算循环、真卡住仍算循环。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockBrain } from '../src/brain/mock.ts';
import { runHarness } from '../src/loop.ts';
import { builtinTools } from '../src/tools/builtin.ts';
import { gameTools } from '../src/tools/game.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { ALL_CAPS, createWorld, situationHash, worldHash } from '../src/world/arena.ts';
import { runArena } from '../src/world/harness.ts';
import { findMutant } from '../src/world/mutants.ts';
import { GameSession } from '../src/world/session.ts';
import type { Decision, HarnessConfig } from '../src/types.ts';

const d = (name: string, args: Record<string, unknown> = {}, thought = 't'): Decision =>
  ({ thought, call: { name, args } });

function cfg(over: Partial<HarnessConfig> = {}): HarnessConfig {
  const sandbox = mkdtempSync(join(tmpdir(), 'loopworld-sbx-'));
  writeFileSync(join(sandbox, 'a.txt'), 'hello');
  return {
    task: '零说明书试玩', sandbox, seed: 6, maxSteps: 10, maxWallMs: 30_000,
    maxContextChars: 12_000, keepRecent: 8, maxParseRetry: 2, repeatLimit: 3,
    outDir: mkdtempSync(join(tmpdir(), 'loopworld-out-')),
    ...over,
  };
}

function gameReg(session: GameSession): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of gameTools(session)) r.register(t);
  return r;
}

function fileReg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of builtinTools()) r.register(t);
  return r;
}

// ── A. 两个哈希各司其职 ──────────────────────────────────

test('局势指纹忽略 tick，帧哈希不忽略：这就是不能复用 worldHash 的原因', () => {
  const s = createWorld(6);
  const moved = { ...s, tick: s.tick + 1 };
  assert.equal(situationHash(s), situationHash(moved), 'tick 变了但局面没变 → 指纹必须相同');
  assert.notEqual(worldHash(s), worldHash(moved), '帧哈希必须含 tick，否则重放比对失去帧身份');
});

test('局势指纹对真实进展敏感：位置 / 血量 / 分数 / 敌人 / 拾取', () => {
  const s = createWorld(6);
  const base = situationHash(s);
  assert.notEqual(situationHash({ ...s, player: { ...s.player, x: s.player.x + 1 } }), base, '玩家移动必须改变指纹');
  assert.notEqual(situationHash({ ...s, player: { ...s.player, hp: s.player.hp - 1 } }), base);
  assert.notEqual(situationHash({ ...s, player: { ...s.player, score: s.player.score + 1 } }), base);
  assert.notEqual(situationHash({ ...s, player: { ...s.player, cooldown: s.player.cooldown + 1 } }), base);
  const e = s.enemies[0]!;
  assert.notEqual(situationHash({ ...s, enemies: [{ ...e, x: e.x + 1 }, ...s.enemies.slice(1)] }), base);
  const p = s.pickups[0]!;
  assert.notEqual(situationHash({ ...s, pickups: [{ ...p, taken: true }, ...s.pickups.slice(1)] }), base);
});

test('session.situationHash 与 stateHash 是两个不同出口，都随帧推进而正确变化', async () => {
  const session = new GameSession(6, ALL_CAPS);
  const fp0 = session.situationHash();
  const h0 = session.stateHash();
  await session.apply({ kind: 'wait' });
  assert.notEqual(session.stateHash(), h0, 'wait 也推进 tick，帧哈希必须变');
  // 参考版敌人会巡逻，所以 wait 之后局势通常也变；这里只断言两个出口都可用且为字符串
  assert.equal(typeof session.situationHash(), 'string');
  assert.equal(typeof fp0, 'string');
});

// ── B. 复现原故障：走图不是死循环 ────────────────────────

test('故障 #6 复现：连续同向走图且每步都在前进，不得判死循环', async () => {
  const session = new GameSession(6, ALL_CAPS);
  // 旧判据下这个脚本会在第 3 步被拦下（三步都是 move right）。
  // 真跑里对照组就是这样被砍断的，而玩家其实从 (4,2) 一路走到 (7,2)。
  const script = Array.from({ length: 6 }, () => d('move', { dir: 'right' }));
  const r = await runHarness({
    brain: new MockBrain(script), registry: gameReg(session),
    config: cfg({ maxSteps: 6, repeatLimit: 3 }),
    worldHash: () => session.stateHash(),
    loopFingerprint: () => session.situationHash(),
  });
  assert.notEqual(r.stopReason, 'loop_detected', '直线走图是合法导航，不是死循环');
  assert.equal(r.steps.length, 6, '六步都该走完');
  assert.ok(session.coverage().cellsVisited >= 4, '玩家必须真的前进了，否则这个夹具没复现到原故障');
});

test('连续同向 move down 同样不算死循环（M02/M07 真跑被砍断的那个形状）', async () => {
  const session = new GameSession(6, ALL_CAPS);
  const script = Array.from({ length: 5 }, () => d('move', { dir: 'down' }));
  const r = await runHarness({
    brain: new MockBrain(script), registry: gameReg(session),
    config: cfg({ maxSteps: 5, repeatLimit: 3 }),
    worldHash: () => session.stateHash(),
    loopFingerprint: () => session.situationHash(),
  });
  assert.notEqual(r.stopReason, 'loop_detected');
  assert.equal(r.steps.length, 5);
});

// ── C. 真卡住仍必须被拦下（别把检测修成永不触发）──────────

test('局面毫无变化时重复同一动作，仍判死循环', async () => {
  // M02 关掉敌人巡逻 → wait 不改变任何局势，只有 tick 在走。
  // 这正是"帧哈希每步都变、但 agent 确实卡住了"的情形。
  const session = new GameSession(6, findMutant('M02').caps);
  const script = Array.from({ length: 6 }, () => d('wait'));
  const r = await runHarness({
    brain: new MockBrain(script), registry: gameReg(session),
    config: cfg({ maxSteps: 6, repeatLimit: 3 }),
    worldHash: () => session.stateHash(),
    loopFingerprint: () => session.situationHash(),
  });
  assert.equal(r.stopReason, 'loop_detected', '真卡住必须拦下，否则检测被修成了永不触发');
  assert.equal(r.steps.length, 3);
  const trace = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8');
  assert.match(trace, /"situationUnchanged":true/);
});

test('卡住时帧哈希仍每步不同（tick 在走）——证明 worldHash 不能当循环判据', async () => {
  const session = new GameSession(6, findMutant('M02').caps);
  const script = Array.from({ length: 6 }, () => d('wait'));
  const r = await runHarness({
    brain: new MockBrain(script), registry: gameReg(session),
    config: cfg({ maxSteps: 6, repeatLimit: 3 }),
    worldHash: () => session.stateHash(),
    loopFingerprint: () => session.situationHash(),
  });
  const hashes = r.steps.map((s) => s.stateHash);
  assert.equal(new Set(hashes).size, hashes.length, '帧哈希必须每步不同');
  assert.equal(r.stopReason, 'loop_detected', '但局势指纹恒定，所以仍判卡住');
});

test('撞墙不动且敌人静止 → 判死循环（动作合法但毫无进展）', async () => {
  const session = new GameSession(6, findMutant('M02').caps);
  // 出生点在左上角，连续向上撞边界：位置不变、敌人静止、只有 tick 在走
  const script = Array.from({ length: 6 }, () => d('move', { dir: 'up' }));
  const r = await runHarness({
    brain: new MockBrain(script), registry: gameReg(session),
    config: cfg({ maxSteps: 6, repeatLimit: 3 }),
    worldHash: () => session.stateHash(),
    loopFingerprint: () => session.situationHash(),
  });
  assert.equal(r.stopReason, 'loop_detected');
  assert.ok(r.steps.every((s) => s.result.ok), '撞墙是合法动作，不是工具错误');
});

// ── D. 不许为了修世界模式而改坏文件模式 ──────────────────

test('不传指纹时保持文件模式原判据：重复写同一条 note 仍算卡住', async () => {
  const same = d('note', { text: '重复' });
  const r = await runHarness({
    brain: new MockBrain([same, same, same, same]),
    registry: fileReg(), config: cfg({ repeatLimit: 3 }),
  });
  assert.equal(r.stopReason, 'loop_detected');
  assert.equal(r.steps.length, 3);
  const trace = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8');
  assert.match(trace, /"situationUnchanged":false/);
});

// ── E. 全链路：修完之后 agent 才有机会自己收手 ────────────

test('arena 全链路：走图不再被误判，agent 能跑到 finish，证据一致性仍通过', async () => {
  const script = [
    d('look'),
    ...Array.from({ length: 5 }, () => d('move', { dir: 'right' })),
    d('note', { text: '连续同向移动是合法导航' }),
    d('finish', { summary: '走图完成，未发现异常' }),
  ];
  const r = await runArena({
    brain: new MockBrain(script), seed: 6, config: cfg({ maxSteps: 12, repeatLimit: 3 }),
  });
  assert.equal(r.run.stopReason, 'finished', '旧判据下这局会在第 4 步被砍断，永远到不了 finish');
  assert.equal(r.evidenceConsistent, true);
  assert.equal(r.agentClaims.finishSummary, '走图完成，未发现异常');
  assert.equal(r.notary.diverged, false, '参考版对照组不该分叉');
});