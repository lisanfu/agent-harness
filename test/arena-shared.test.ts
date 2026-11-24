/** CLI 连续门面与 MCP 式分步装配必须共用同一套世界和局末证据。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness } from '../src/loop.ts';
import { parseDecision } from '../src/parse.ts';
import type { Brain, Decision, DecideRequest, HarnessConfig } from '../src/types.ts';
import { judgeStamp } from '../src/world/detect.ts';
import {
  createArenaWorld,
  finalizeArenaWorld,
  runArena,
  type ArenaRunResult,
} from '../src/world/harness.ts';

class ScriptedBrain implements Brain {
  readonly id = 'script:FIXTURE-arena-shared';
  private seen = 0;
  private readonly script: Decision[];
  constructor(script: Decision[]) { this.script = script; }
  decide(req: DecideRequest): Promise<Decision> {
    void req;
    const decision = this.script[this.seen++] ?? { thought: '收', call: { name: 'finish', args: { summary: '剧本用完' } } };
    return Promise.resolve(parseDecision(JSON.stringify(decision)));
  }
}

const d = (name: string, args: Record<string, unknown> = {}): Decision => ({ thought: 't', call: { name, args } });
const SCRIPT: Decision[] = [
  d('move', { dir: 'right' }), d('move', { dir: 'down' }), d('move', { dir: 'left' }),
  d('move', { dir: 'up' }), d('attack'), d('wait'), d('listen'),
  d('note', { id: 'H1', text: '敌人移动异常', status: 'confirmed', why: '观察' }),
  d('goal', { id: 'G1', text: '保持满血', doneWhen: { hp: 10 }, status: 'open', why: '探索' }),
  d('finish', { summary: '敌人不再巡逻，画面异常' }),
];

function config(root: string, arm: string): HarnessConfig {
  const sandbox = join(root, arm, 'sandbox');
  const outDir = join(root, arm, 'out');
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  return {
    task: '零说明书试玩', sandbox, seed: 6, maxSteps: 20, maxWallMs: 30_000,
    maxContextChars: 20_000, keepRecent: 20, maxParseRetry: 2, repeatLimit: 20, outDir,
    provenance: 'fixture',
  };
}

/** 只排除运行身份、路径与耗时；其余返回值（含逐步 trace 记录）全量比较。 */
function stableResult(r: ArenaRunResult): unknown {
  const { files: _files, ...result } = r;
  const { runId: _runId, runDir: _runDir, durationMs: _durationMs, steps, ...run } = r.run;
  return {
    ...result,
    run: {
      ...run,
      steps: steps.map(({ at: _at, brainMs: _brainMs, toolMs: _toolMs, ...step }) => step),
    },
  };
}

test('createArenaWorld 保留默认接缝与消融开关，工具/首屏不泄漏裁判字段', () => {
  const world = createArenaWorld({ seed: 6, mutant: 'M02', soundMutant: 'S09' });
  assert.equal(world.mutantId, 'M02');
  assert.equal(world.soundMutantId, 'S09');
  assert.equal(world.ear, true);
  assert.ok(world.prediction);
  assert.ok(world.goal);
  assert.equal(world.registry.has('listen'), true);
  assert.equal(world.worldHash(), world.initialWorld.hash);
  assert.equal(world.screen(), world.initialWorld.screen);
  const visible = JSON.stringify({ tools: world.registry.specs(), screen: world.screen() });
  assert.doesNotMatch(visible, /M02|S09|coverage|internalState|detection|mutant/i);

  const off = createArenaWorld({ seed: 6, doPredict: false, doGoal: false, doEar: false });
  assert.equal(off.prediction, undefined);
  assert.equal(off.goal, undefined);
  assert.equal(off.registry.has('listen'), false);
  assert.equal(off.soundMutantId, 'R0');
  assert.equal(off.mutantId, null);
});

test('共享 finalizer 与 runArena 同 seed 短局的判决、返回值及六份证据逐字节等价', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arena-shared-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sharedLogs: string[] = [];
  const cliLogs: string[] = [];
  const log = (line: string) => sharedLogs.push(line);

  const world = createArenaWorld({ seed: 6, mutant: 'M02', soundMutant: 'S09' });
  const run = await runHarness({
    brain: new ScriptedBrain(SCRIPT),
    registry: world.registry,
    config: config(root, 'shared'),
    log,
    judgement: judgeStamp(),
    worldHash: world.worldHash,
    loopFingerprint: world.loopFingerprint,
    initialWorld: world.initialWorld,
    screen: world.screen,
    prediction: world.prediction,
    goal: world.goal,
  });
  // 故意不传 doMinimize：两条路径都必须保留原来的默认 true。
  const shared = await finalizeArenaWorld(world, run, { ddMaxTests: 20, log });
  const cli = await runArena({
    brain: new ScriptedBrain(SCRIPT),
    seed: 6,
    mutant: 'M02',
    soundMutant: 'S09',
    config: config(root, 'cli'),
    ddMaxTests: 20,
    log: (line) => cliLogs.push(line),
  });

  assert.equal(shared.evidenceConsistent, true);
  assert.equal(shared.replayMatchesLiveSession, true);
  assert.equal(shared.notary.diverged, true);
  assert.ok(shared.notary.minimized?.reverified, '夹具必须走到默认最小化与独立复核');
  assert.ok(shared.ear && shared.ear.counts['矛盾'] > 0, '夹具必须产出非空耳朵判决');
  assert.equal(shared.agentClaims.hypotheses.length, 1);
  assert.equal(shared.agentClaims.goals.length, 1);
  assert.deepEqual(stableResult(shared), stableResult(cli));
  assert.deepEqual(sharedLogs, cliLogs);

  for (const name of ['world', 'coverage', 'defect', 'detection', 'sound', 'ear'] as const) {
    const sharedPath = shared.files[name];
    const cliPath = cli.files[name];
    assert.ok(sharedPath && cliPath, `${name} 证据应存在`);
    assert.deepEqual(readFileSync(sharedPath), readFileSync(cliPath), `${name} 证据字节发生变化`);
  }
});
