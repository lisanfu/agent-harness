/**
 * M4-c 接线守卫：装上耳朵之后，**已发布证据必须逐字节不变**。
 *
 * 为什么这条比它的名字听起来重要：这一轮往 `GameSession.apply()` 里加了一行
 * `frameSounds(...)`，还往 `gameTools()` 里加了一个 `listen`。这两处碰的都是
 * 30 局已发布证据的生产路径。屏幕哪怕多一个空格，M4-d 的 1171 条主张、
 * M4-f 的检出漏斗、REPRODUCTION.md 的逐字节复现就全部要重算——
 * 而"重算之后数字变了"和"数字没变"是两种完全不同的对外说法。
 *
 * 守卫的口径选的是**最硬的那一种**：不比对"看起来一样"，逐帧比对
 * `world.jsonl` 的 `hash` 与 `events`。屏幕文本 = render(状态, events)，
 * 这两样逐位相同 ⇒ 每一帧的屏幕逐字节相同（首屏另单独比了一次原文）。
 *
 * 三条纪律：
 *  1. **扫不到证据就红**（§10.13）。`runs/` 随仓库发布，找不到 defect.json 只可能是
 *     路径写错或发布被截，绝不能"没有就算通过"——那样这条守卫会变成一条永不执行的绿灯。
 *  2. **反向对照**：拿变异局用参考版能力重放，必须**对不上**。
 *     对得上才说明这条比的是真东西；一个永远返回"一致"的比较函数比没有更糟（台账 #18）。
 *  3. 耳朵这条新通道**不许改世界**：所以这里用最严的字节比对，
 *     而不是"屏幕语义相同"。语义相同而字节不同，同样让已发布数字作废。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ALL_CAPS, runSequence, type Action, type Capabilities } from '../src/world/arena.ts';
import { findMutant } from '../src/world/mutants.ts';
import { REFERENCE_RIG, soundStream } from '../src/world/sound.ts';
import { GameSession } from '../src/world/session.ts';

const ROOT = resolve(import.meta.dirname, '..');

interface PublishedRun {
  dir: string;
  seed: number;
  mutant: string | null;
  actions: Action[];
  frames: { tick: number; hash: string; events: string[] }[];
  initialScreen: string;
}

function findRuns(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (!statSync(p).isDirectory()) continue;
      if (existsSync(join(p, 'defect.json'))) out.push(p);
      else walk(p, depth + 1);
    }
  };
  const runsDir = join(ROOT, 'runs');
  if (existsSync(runsDir)) walk(runsDir, 0);
  return out;
}

function loadRun(dir: string): PublishedRun {
  const defect = JSON.parse(readFileSync(join(dir, 'defect.json'), 'utf8')) as {
    seed: number; mutant: string | null; fullWorldActions: Action[];
  };
  const header = JSON.parse(readFileSync(join(dir, 'header.json'), 'utf8')) as {
    initialState: { world?: { screen?: string } };
  };
  const frames = readFileSync(join(dir, 'world.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { tick: number; hash: string; events: string[] });
  return {
    dir, seed: defect.seed, mutant: defect.mutant ?? null,
    actions: defect.fullWorldActions ?? [], frames,
    initialScreen: header.initialState?.world?.screen ?? '',
  };
}

/** 这一局当初是用哪套能力跑的。前提错了后面全错：变异局拿参考版重放必然分叉。 */
const capsOf = (run: PublishedRun): Capabilities => (run.mutant ? findMutant(run.mutant).caps : ALL_CAPS);

const runs = findRuns().map(loadRun);

/** 逐帧重放一遍（耳朵装着）。返回 session 供各条断言复用。 */
async function replay(run: PublishedRun, caps: Capabilities = capsOf(run)): Promise<GameSession> {
  const s = new GameSession(run.seed, caps, REFERENCE_RIG);
  for (const a of run.actions) await s.apply(a);
  return s;
}

test('守卫的前提：已发布证据真的在（扫不到就红，不许"没有就算通过"）', () => {
  assert.ok(runs.length >= 30, `只找到 ${runs.length} 局已发布证据，预期 ≥30：路径或发布出了问题，这条守卫等于没跑`);
});

test('装上耳朵重放 30+ 局：逐帧哈希与 events 必须与已发布 world.jsonl 逐字节相同', async () => {
  let frames = 0;
  for (const run of runs) {
    const s = await replay(run);
    const got = s.frames();
    assert.equal(got.length, run.frames.length, `${run.dir}：帧数变了（耳朵不该改时间轴）`);
    for (let i = 0; i < run.frames.length; i++) {
      const want = run.frames[i]!;
      const have = got[i]!;
      assert.equal(have.hash, want.hash, `${run.dir} 第 ${i} 帧状态哈希变了`);
      assert.deepEqual(have.events, want.events, `${run.dir} 第 ${i} 帧"刚才发生"变了：屏幕文本由它参与渲染`);
      frames++;
    }
  }
  assert.ok(frames >= 500, `总共只比了 ${frames} 帧，这个量级不足以说明"逐字节没变"（本轮实测基线 604 帧 / 33 局）`);
});

test('首屏原文逐字节相同：header 里存的是屏幕文本，不是哈希，正好补上最前端那一格', () => {
  let compared = 0;
  for (const run of runs) {
    if (!run.initialScreen) continue; // 早期局没存首屏：没有原文可比，跳过但不假装比过
    const s = new GameSession(run.seed, capsOf(run), REFERENCE_RIG);
    assert.equal(s.screen(), run.initialScreen, `${run.dir}：首屏文本变了`);
    compared++;
  }
  assert.ok(compared >= 20, `只有 ${compared} 局存了首屏原文，这一格基本没被覆盖`);
});

test('耳朵确实接在这条重放路径上（不是"比对了半天其实没产声流"）', async () => {
  // 上面那条即使成立，也可能只是没走到新分支。这一条正面证明声流在产，
  // 并且**逐字节等于**纯函数那条独立路径（session 逐帧账本 vs arena 整条重放）。
  // 两个主人算出同一条声流，才说明接线没有第二套口径。
  let withSound = 0;
  for (const run of runs) {
    const caps = capsOf(run);
    const s = await replay(run, caps);
    const live = s.soundEvents();
    const pure = soundStream(runSequence(run.seed, run.actions, caps).states, [null, ...run.actions], REFERENCE_RIG);
    assert.deepEqual(live, pure, `${run.dir}：会话逐帧账本与整条声流两个主人对不上`);
    if (live.length) withSound++;
  }
  // 动过脚的局必须都产出声流。33 局里有 3 局是**零动作**（一步没走，自然一声没有），
  // 所以分母按"至少动过一步"算，而不是硬写一个跑出来的数。
  const actionable = runs.filter((r) => r.actions.length > 0);
  assert.equal(withSound, actionable.length,
    `${actionable.length} 局动过脚，只有 ${withSound} 局有声流：声流根本没接上`);
});

test('反向对照：拿参考版能力重放变异局，这条守卫**必须**对不上（否则它是个永真式）', async () => {
  const mutantRuns = runs.filter((r) => r.mutant && r.actions.length > 0);
  assert.ok(mutantRuns.length >= 3, `只有 ${mutantRuns.length} 局变异证据，反向对照做不了`);
  let caught = 0;
  for (const run of mutantRuns) {
    const s = await replay(run, ALL_CAPS); // 故意用错能力
    if (!s.frames().every((f, i) => f.hash === run.frames[i]?.hash)) caught++;
  }
  // 允许极少数"这条轨迹压根没触达缺陷"的局：那种局逐帧相同是真实现象，不是守卫失灵。
  // 但必须**大多**对不上，否则这个比对没有区分力。
  assert.ok(caught >= Math.ceil(mutantRuns.length * 0.6),
    `${caught}/${mutantRuns.length} 局变异证据用参考版重放能区分：区分力不足，上面的"逐字节不变"可能什么都没在比`);
});
