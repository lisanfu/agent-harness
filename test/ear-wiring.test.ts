/**
 * M4-c 下半接线守卫：`--sound-mutant` 有没有真的走到装置、`ear.json` 有没有真的落盘。
 *
 * 这一档只管**接线**，不管判据对不对——判据由 `verify/ear-{fixture,audit,selftest}.ts`
 * 三件套独立复核（`test/ear.test.ts` 开头那条分工在这里同样成立：单测与复核各走各路，
 * 判据坏了两处一起红就查不动了）。
 *
 * 那三件套验的是"判决本身有没有牙"。这一档验的是它下面那一层，而那一层塌了更安静：
 *
 *  1. **装置参数是不是真的生效**。`--sound-mutant S10` 打成一句日志、runArena 里根本不看，
 *     屏幕照样一字不差（因为装置本来就不改世界），于是"跑通了"——跑的是 R0。
 *     这种错**不会有任何红灯**，除了声音流。所以这里必须正面比 sound.jsonl。
 *  2. **屏幕那侧的证据必须一个字节都不动**（反向的同一件事：装置若漏进了世界层，
 *     已发布 30 局的数字全部作废）。
 *  3. **装置标签不许造假**：入参从 `SoundRig` 对象换成 id 就是为了这条。
 *     这里用"声明与实测必须同一"来验：写 S10 的局，声流的帧号必须真的整体晚一帧。
 *  4. **判决吃的是落盘那两份证据**，不是内存里的临时对象（故障 #14 那一族）。
 *
 * ⚠️ 子进程那几条用 `--brain mock`，**只为验 argv 解析与落盘**，不产任何对外数字：
 *    脚本预写的决策量到的是脚本作者（台账 #34）。真正的成绩只从真模型臂来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseDecision } from '../src/parse.ts';
import { runArena } from '../src/world/harness.ts';
import { ALL_SOUND, findSoundMutant } from '../src/world/mutants.ts';
import { EAR_CUES, EAR_VERDICTS, earStamp } from '../src/world/ear.ts';
import type { Brain, Decision, DecideRequest, HarnessConfig } from '../src/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'src/cli.ts');
const OVERRIDE = '--i-know-mock-is-not-a-brain';

class ScriptBrain implements Brain {
  readonly id = 'script:TEST-DOUBLE';
  private readonly script: Decision[];
  private seen = 0;
  constructor(script: Decision[]) { this.script = script; }
  /** 与真跑同一条形状：决策必须过 parseDecision，否则测试替身喂的是循环层永远收不到的东西 */
  decide(req: DecideRequest): Promise<Decision> {
    this.seen++;
    void req;
    const d = this.script[this.seen - 1] ?? { thought: '收', call: { name: 'finish', args: { summary: '剧本用完' } } };
    return Promise.resolve(parseDecision(JSON.stringify(d)));
  }
}

const d = (name: string, args: Record<string, unknown> = {}): Decision => ({ thought: 't', call: { name, args } });

/**
 * 一局会同时凑齐三种形状：4 步移动（脚步族，够过整族位移的 3 次闸门）、
 * 1 次撞墙（`left` 在 (0,1) 顶到边界）、1 次出手（不一定杀掉，但破风声照放）。
 */
const SCRIPT: Decision[] = [
  d('move', { dir: 'right' }), d('move', { dir: 'down' }), d('move', { dir: 'left' }),
  d('move', { dir: 'up' }), d('attack'), d('wait'),
];

function cfg(): HarnessConfig {
  return {
    task: '零说明书试玩', sandbox: mkdtempSync(join(tmpdir(), 'earw-sbx-')), seed: 6,
    maxSteps: 14, maxWallMs: 30_000, maxContextChars: 20_000, keepRecent: 14,
    maxParseRetry: 2, repeatLimit: 9, outDir: mkdtempSync(join(tmpdir(), 'earw-out-')),
  };
}

interface Play {
  world: string;
  coverage: string;
  defect: string;
  sound: string;
  /** 磁盘字节（#35：这个仓库里的证据满是中文，"字节"有两个口径——凡承诺逐字节，比的是这一份） */
  worldBuf: Buffer;
  coverageBuf: Buffer;
  defectBuf: Buffer;
  ear: Record<string, any>;
  files: { sound: string | null; ear: string | null };
  earRun: Awaited<ReturnType<typeof runArena>>['ear'];
}

/** 跑一局并把四份证据原文读回来（断言只认磁盘上那份）。 */
async function play(soundMutant: string | null, extra: Partial<HarnessConfig> = {}): Promise<Play> {
  const r = await runArena({
    brain: new ScriptBrain(SCRIPT), seed: 6, soundMutant, config: { ...cfg(), ...extra }, doMinimize: false,
  });
  const text = (p: string | null): string => (p === null ? '' : readFileSync(p, 'utf8'));
  const bytes = (p: string | null): Buffer => (p === null ? Buffer.alloc(0) : readFileSync(p));
  return {
    world: text(r.files.world),
    coverage: text(r.files.coverage),
    defect: text(r.files.defect),
    sound: text(r.files.sound),
    worldBuf: bytes(r.files.world),
    coverageBuf: bytes(r.files.coverage),
    defectBuf: bytes(r.files.defect),
    ear: r.files.ear === null ? ({} as Record<string, any>) : JSON.parse(readFileSync(r.files.ear, 'utf8')),
    files: { sound: r.files.sound, ear: r.files.ear },
    earRun: r.ear,
  };
}

const lines = (s: string): any[] => s.split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ── 1. 装置参数真的生效：声流必须跟着装置变 ────────────────────────

test('装置生效的正证：同一条轨迹下 R0 与 S01/S09/S10 的 sound.jsonl 互不相同', async () => {
  const ref = lines((await play('R0')).sound);
  assert.ok(ref.length > 0, '夹具不成立：参考版这一局一声没响，后面全是空谈');
  const s01 = lines((await play('S01')).sound);
  const s09 = lines((await play('S09')).sound);
  const s10 = lines((await play('S10')).sound);
  assert.ok(s01.length < ref.length, `S01（脚步丢失）应当比参考版少几声：${s01.length} vs ${ref.length}`);
  assert.ok(s09.length > ref.length, `S09（移动也播闷响）应当比参考版多几声：${s09.length} vs ${ref.length}`);
  assert.equal(s10.length, ref.length, 'S10 只挪时钟，条数必须一模一样——多了少了就是它偷偷改了内容');
  assert.notEqual(JSON.stringify(s10), JSON.stringify(ref), 'S10 的声流与参考版逐字相同 = 装置参数被吞了');
});

test('S10 的声流真的整体晚一帧（声明与实测同一，装置标签没有第二条来源）', async () => {
  const ref = lines((await play('R0')).sound);
  const late = lines((await play('S10')).sound);
  const key = (e: { seq: number; text: string }) => `${e.seq}|${e.text}`;
  const byTick = (rows: any[]) => rows.reduce<Record<number, string[]>>((a, e) => ((a[e.tick] ??= []).push(key(e)), a), {});
  const base = byTick(ref);
  for (const [tick, texts] of Object.entries(byTick(late))) {
    const prev = base[Number(tick) - 1];
    assert.ok(prev !== undefined, `S10 在第 ${tick} 帧出声，而参考版第 ${Number(tick) - 1} 帧没有对应内容：这不是整体位移`);
    assert.deepEqual([...texts].sort(), [...prev].sort(), `第 ${tick} 帧的内容与第 ${Number(tick) - 1} 帧不同：位移里混进了改内容`);
  }
});

// ── 2. 反向的同一件事：屏幕那侧一个字节都不许动 ────────────────────

test('装置不改世界：R0/S01/S02/S09/S10 五局的 world.jsonl、coverage.json、defect.json 逐字节相同', async () => {
  const runs = await Promise.all(['R0', 'S01', 'S02', 'S09', 'S10'].map((id) => play(id)));
  const base = runs[0]!;
  // 夹具前提（#35）：world.jsonl 满是中文，磁盘字节数 ≠ JS 字符数。
  // 这条一旦红，说明产物变成纯 ASCII，那时"比 Buffer 还是比字符串"就再也分不出来了——要另找夹具。
  assert.notEqual(base.worldBuf.length, base.world.length,
    `world.jsonl 的字节数(${base.worldBuf.length})与字符数(${base.world.length})相同：这条对照的夹具前提没了`);
  for (const r of runs.slice(1)) {
    assert.ok(r.worldBuf.equals(base.worldBuf), 'world.jsonl 变了：发声装置漏进了世界层，已发布 30 局的数字全部作废');
    assert.ok(r.coverageBuf.equals(base.coverageBuf), 'coverage.json 变了：覆盖只从屏幕数出来，屏幕没理由跟着装置动');
    assert.ok(r.defectBuf.equals(base.defectBuf), 'defect.json 变了：那里面是主观陈述 + 公证器，都不该认识发声装置');
  }
});

test('屏幕不变的代价不在 ear.json 里：判决只认 tick/seq/text，多一列就是改了三要素的形状', async () => {
  const p = await play('R0');
  for (const l of lines(p.sound)) assert.deepEqual(Object.keys(l).sort(), ['seq', 'text', 'tick']);
  assert.equal(p.ear.sounds, lines(p.sound).length, 'ear.json 记的声流条数必须与 sound.jsonl 的行数相同（判决吃的是落盘那两份）');
  const actions = JSON.parse(p.defect).fullWorldActions as unknown[];
  assert.equal(p.ear.actions, actions.length, 'ear.json 记的动作数必须与 defect.json 的 fullWorldActions 相同');
});

// ── 3. 阴性对照与三种矛盾形状：接线之后仍然各就各位 ──────────────────

test('R0 是阴性对照：矛盾=0、时钟错位=0，而相符必须大于 0（零相符说明根本没在核对）', async () => {
  const { ear } = await play('R0');
  assert.equal(ear.counts['矛盾'], 0, `参考版发声却判出矛盾：${JSON.stringify(ear.claims.filter((c: any) => c.verdict === '矛盾'))}`);
  assert.equal(ear.counts['时钟错位'], 0, '参考版的时钟不该错位');
  assert.ok(ear.counts['相符'] > 0, '相符=0：耳朵一声都没核上，"没有矛盾"是空集而不是阴性');
});

test('三种矛盾形状分别从装置里长出来：S01 漏报、S09 误报、S10 时钟错位', async () => {
  const s01 = (await play('S01')).ear;
  assert.ok(s01.splits['漏报'] > 0, `S01 应判出漏报（眼睛看见迈步、耳朵没声）：${JSON.stringify(s01.counts)}`);
  assert.equal(s01.splits['误报'], 0, 'S01 不该有耳朵单方面多出来的声');
  const s09 = (await play('S09')).ear;
  assert.ok(s09.splits['误报'] > 0, `S09 应判出误报（屏幕说这一帧不该响）：${JSON.stringify(s09.counts)}`);
  assert.equal(s09.splits['漏报'], 0, 'S09 是触发写宽，不该掉进漏报那一桶');
  const s10 = (await play('S10')).ear;
  assert.ok(s10.counts['时钟错位'] > 0, `S10 应判出时钟错位：${JSON.stringify(s10.counts)}`);
  assert.equal(s10.counts['矛盾'], 0, 'S10 内容全对，一处都不许判成矛盾（把时钟问题报成"不干活"是最坏的一种指错）');
  assert.equal(s10.counts['相符'], 0, '整族已被时钟错位销账，不许再在第二遍里冒充相符（一事实两主人）');
});

// ── 4. ear.json 的形状与账目 ──────────────────────────────────────

test('ear.json 带冻结判据戳、装置同源声明，五桶齐、主张可数、判决全在表内', async () => {
  const { ear, earRun } = await play('S09');
  assert.deepEqual(ear.ear, earStamp(), '判据戳与在库判据不一致：改过口径却没升版本');
  assert.equal(ear.soundMutant, 'S09');
  assert.equal(ear.soundMutantLabel, findSoundMutant('S09').label, '标签必须现查，不是调用方另给一次');
  assert.deepEqual(Object.keys(ear.counts).sort(), [...EAR_VERDICTS].sort());
  assert.equal(Object.values(ear.counts).reduce((a, b) => a + b, 0), ear.claims.length, '五桶之和 ≠ 主张条数：账目断裂');
  const keys = new Set([...EAR_CUES, ...Object.keys(ear.byKey)]);
  for (const c of ear.claims) {
    assert.ok(keys.has(c.key), `主张的 key "${c.key}" 不在八族与 byKey 里`);
    assert.ok(EAR_VERDICTS.includes(c.verdict), `表外判决 "${c.verdict}"`);
  }
  assert.equal(ear.screensMatchLiveRun, true, '重放屏幕与实玩 session 不同：五桶全部不可信');
  assert.equal(ear.consistency.tickAligned, true, '帧号没对齐：证据自洽性破了');
  assert.equal(ear.consistency.screens, ear.actions + 1, '屏幕帧数 = 动作数 + 1（含初始帧）');
  assert.equal(earRun?.counts['矛盾'], ear.counts['矛盾'], '返回值与落盘那份不是同一样东西');
});

test('屏幕账本之外那一声不许二次落账：整族位移销过账的，不再记一遍"无法核对"', async () => {
  const { ear } = await play('S10');
  assert.ok(ear.consistency.soundsBeyondScreen > 0, '夹具不成立：S10 这一局没有被推到屏幕之外的声');
  const beyond = ear.claims.filter((c: any) => c.side === '耳' && c.verdict === '无法核对');
  assert.equal(beyond.length, 0, '整族位移已把这些声记成时钟错位，不该再落一遍无法核对（一事实两主人，台账 #13 家族）');
  assert.equal(ear.counts['无法核对'], 0);
});

test('没装耳朵 = 没有这份证据，而不是全 0 的判决', async () => {
  const deaf = await play(null, {});
  assert.ok(deaf.files.sound, '默认应当装耳朵');
  const off = await runArena({
    brain: new ScriptBrain(SCRIPT), seed: 6, config: cfg(), doMinimize: false, doEar: false,
  });
  assert.equal(off.files.ear, null);
  assert.equal(off.ear, null, '判决必须是 null：全 0 会被读成"核过了，一切正常"');
  assert.ok(!existsSync(join(off.run.runDir, 'ear.json')));
  assert.ok(!existsSync(join(off.run.runDir, 'sound.jsonl')), '消融对照组不该有声流');
});

test('装置 id 写错就炸，不静默退回参考版（退回等于把 S10 的证据悄悄换成 R0）', async () => {
  await assert.rejects(
    () => runArena({ brain: new ScriptBrain(SCRIPT), seed: 6, config: cfg(), doMinimize: false, soundMutant: 'S99' }),
    /未知发声/,
  );
  assert.equal(findSoundMutant('R0').id, 'R0');
  assert.equal(ALL_SOUND.length, 11, '装置名单变了（1 参考 + 10 变异）：CLI 的可用清单文案要同步');
});

// ── 5. CLI / m4f 门面层：argv 只在真命令行上被验过才算数 ──────────────

function runCli(argv: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', cwd: ROOT });
  return { status: r.status, stderr: (r.stderr ?? '') + (r.stdout ?? '') };
}

test('CLI：未知装置 id / 与非耳朵开关互斥，都必须在启动前退出码 1 并给出合法路径', () => {
  const bad = runCli(['--world', 'arena', '--brain', 'mock', OVERRIDE, '--sound-mutant', 'S99']);
  assert.equal(bad.status, 1, `期望配置错误退出码 1，实际 ${bad.status}`);
  assert.match(bad.stderr, /未知发声装置/);
  assert.match(bad.stderr, /R0, S01/, '拒绝必须把可用清单打出来，只会说不合法等于逼人砸闸门');
  const clash = runCli(['--world', 'arena', '--brain', 'mock', OVERRIDE, '--sound-mutant', 'S10', '--no-ear']);
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /互相矛盾/);
  const wrongWorld = runCli(['--world', 'files', '--brain', 'mock', OVERRIDE, '--task', 'x', '--sound-mutant', 'S01']);
  assert.equal(wrongWorld.status, 1);
  assert.match(wrongWorld.stderr, /只在 --world arena/);
});

test('CLI：--sound-mutant 放行后 ear.json 真落盘、五桶出声，且 --no-ear 那局两个文件都没有', () => {
  const out = mkdtempSync(join(tmpdir(), 'earw-cli-'));
  try {
    const on = runCli(['--world', 'arena', '--brain', 'mock', OVERRIDE, '--sound-mutant', 'S10', '--seed', '6', '--max-steps', '8', '--out', out]);
    assert.notEqual(on.status, 1, `闸门放行了却没跑起来，说明 --sound-mutant 的接线是假的：\n${on.stderr}`);
    assert.match(on.stderr, /\[眼耳对账\] 装置=S10/, '对账必须出声，还要把装置念出来');
    const dirs = readdirSync(out);
    assert.equal(dirs.length, 1);
    const run = join(out, dirs[0]!);
    assert.ok(existsSync(join(run, 'ear.json')), 'ear.json 没落盘');
    assert.ok(existsSync(join(run, 'sound.jsonl')));
    const ear = JSON.parse(readFileSync(join(run, 'ear.json'), 'utf8'));
    assert.equal(ear.soundMutant, 'S10', '命令行说 S10、证据里写的却是别的：装置与标签必须同源');
    assert.equal(ear.ear.ear, earStamp().ear);

    const off = mkdtempSync(join(tmpdir(), 'earw-cli-off-'));
    const deaf = runCli(['--world', 'arena', '--brain', 'mock', OVERRIDE, '--no-ear', '--seed', '6', '--max-steps', '8', '--out', off]);
    assert.notEqual(deaf.status, 1);
    assert.match(deaf.stderr, /本局没装听觉通道/);
    const d0 = readdirSync(off)[0]!;
    assert.ok(!existsSync(join(off, d0, 'ear.json')), '消融对照组里不许出现判决文件');
    rmSync(off, { recursive: true, force: true });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('m4f：--sound-mutants 的非法取值在任何模型调用之前拒绝', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'src/m4f.ts'), '--policy', 'model', '--sound-mutants', 'S99,X9'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 1, `期望启动前退出码 1，实际 ${r.status}；stderr=\n${r.stderr}`);
  assert.match(r.stderr, /无法识别的取值/);
  assert.match(r.stderr, /R0/, '拒绝文案要给出合法取值（参数写错却照样出表 = 台账 #17 那一族）');
});

test('m4f 帮助与 CLI 帮助都念得出这一维，且都点明"装置不改世界"', () => {
  const cli = runCli(['--help']);
  assert.match(cli.stderr, /--sound-mutant/);
  assert.match(cli.stderr, /只改放不放这一声/);
  const m4f = spawnSync(process.execPath, [join(ROOT, 'src/m4f.ts'), '--help'], { encoding: 'utf8', cwd: ROOT });
  assert.match(m4f.stdout + m4f.stderr, /--sound-mutants/);
});
