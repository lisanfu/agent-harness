/**
 * 门禁守卫：`--brain mock` 必须**默认拒绝**，而它给出的逃生口必须**真的能用**。
 *
 * 为什么单独有一档（台账 #34 的来由）：M4-c 接线收尾时，我想跑一局"看 agent 会不会主动
 * 用耳朵"的证据局，顺手 `--world arena --brain mock`，被自家 CLI 当场拦下。
 * 那一刻最省事的"修法"是把闸门放宽或者绕过去——而那正是这条闸门存在要拦的事：
 * 脚本预写的决策测到的是**脚本作者**的想法，不是模型的。这种数字一旦进了报告，
 * 之后没法向任何人解释它凭什么算证据。
 *
 * 所以这一档测两件事，缺一不可：
 *  1. **闸门有牙**：不带显式确认就拒绝，退出码 1（配置错误那一类，不是"跑坏了"），
 *     而且**文案里必须给出合法路径**——只会拒绝、不告诉该怎么做的闸门，最后一定被人砸开（#14 的教训）。
 *  2. **它说的是实话**：加了 `--i-know-mock-is-not-a-brain` 之后确实能跑通并落证据。
 *     如果拒绝文案给了个假逃生口（加上也崩），那这条闸门本身就是在撒谎。
 *
 * 这一档刻意走**子进程**：上面两条都是 CLI 门面层的行为，`--no-ear` / `--out` 这些 argv 解析
 * 只在真命令行上被验过才算数（#3 的教训：写了、跑了、跑不起来）。
 * 而落盘一律进临时目录——`runs/` 是**已发布证据**，测试不许往里塞东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'src/cli.ts');
const OVERRIDE = '--i-know-mock-is-not-a-brain';

/** 跑一次 CLI。人类日志一律 stderr、stdout 留给 stdio 协议——断言要挑对那条流。 */
function runCli(argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', cwd: ROOT });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 在临时目录里跑一局，把 run 目录交回调用方检查（用完即删，不污染 `runs/`）。 */
function runOneGame(argv: string[], inspect: (run: string) => void): void {
  const out = mkdtempSync(join(tmpdir(), 'mock-gate-'));
  try {
    const r = runCli([...argv, '--out', out]);
    // 0=finished / 2=其他停止原因都算"跑起来了"；1=配置/启动错误，那说明逃生口是假的
    assert.notEqual(r.status, 1, `闸门放行了却没跑起来，拒绝文案给的是假路径：\n${r.stderr}`);
    const dirs = readdirSync(out);
    assert.equal(dirs.length, 1, `期望恰好一个 run 目录，实际：${dirs.join(', ')}`);
    inspect(join(out, dirs[0]!));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

test('闸门有牙：--world arena --brain mock 不带显式确认必须被拒绝（退出码 1，且不落任何证据）', () => {
  const before = readdirSync(join(ROOT, 'runs')).length;
  const r = runCli(['--world', 'arena', '--brain', 'mock']);
  assert.equal(r.status, 1, `期望配置错误退出码 1，实际 ${r.status}；stderr=\n${r.stderr}`);
  assert.match(r.stderr, /拒绝/, '拒绝必须出声，不能静默换一个大脑');
  // 人类日志不许混进协议通道：这条一旦红，将来接 MCP（M5）时 stdout 就被日志污染了
  assert.equal(r.stdout, '', '拒绝文案不许写进 stdout（stdout 是 stdio 大脑的协议通道）');
  assert.equal(readdirSync(join(ROOT, 'runs')).length, before, '被拒绝的一局不许在 runs/ 里留下半个文件');
});

test('拒绝理由可行动：文案必须给出合法路径（哪个开关、以及 mock 凭什么不算大脑）', () => {
  const r = runCli(['--brain', 'mock']);
  assert.equal(r.status, 1);
  assert.ok(
    r.stderr.includes(OVERRIDE),
    `只会拒绝、不告诉该怎么做，闸门最后一定被人砸开。实际文案：\n${r.stderr}`,
  );
  assert.match(r.stderr, /测试替身|不是大脑/, '必须说清 mock 为什么不算大脑——这是这条拒绝的全部理由');
});

test('逃生口是真的：加显式确认后能跑通，一整套证据齐活（拒绝文案不能撒谎）', () => {
  runOneGame(['--world', 'arena', '--brain', 'mock', OVERRIDE, '--seed', '6', '--max-steps', '3'], (run) => {
    for (const f of ['header.json', 'world.jsonl', 'defect.json', 'trace.jsonl', 'result.json', 'sound.jsonl']) {
      assert.ok(existsSync(join(run, f)), `缺一件产物：${f}（run=${run}）`);
    }
    const header = readJson(join(run, 'header.json'));
    assert.equal(header.brainId, 'mock:TEST-DOUBLE', '证据里必须留得下"这是替身跑的"这个身份');
    const seams = header.seams as { predict: boolean; goal: boolean; ear?: boolean };
    assert.equal(seams.ear, true, 'arena 默认装耳朵。ear 由工具清单反查、不许自述（#16）');
  });
});

test('耳朵是可选器官：--no-ear 走真命令行时同样成立（声明与产物同进同退）', () => {
  // 同一条不变量在 harness 层已有断言（goal-loop 第 330 行）；这一例补的是**argv → doEar** 那段接线：
  // `--no-ear` 拼错、解析成字符串 "1"、或者压根没传给 runArena，都只有走真命令行才抓得到。
  runOneGame(
    ['--world', 'arena', '--no-ear', '--brain', 'mock', OVERRIDE, '--seed', '6', '--max-steps', '3'],
    (run) => {
      assert.equal(existsSync(join(run, 'sound.jsonl')), false, '关耳的局不许有声流证据（否则"消融对照"是假的）');
      const seams = (readJson(join(run, 'header.json')).seams ?? {}) as { ear?: boolean };
      assert.equal(seams.ear, false, '没装耳朵，声明必须是 false 而不是缺键——缺键与 false 是两件事（#16）');
    },
  );
});

test('npm 脚本里的替身局不许落进 runs/：--brain mock 必须显式改写 --out', () => {
  // 这一条是本轮自己踩出来的：`npm run smoke` 用了默认 --out ./runs，
  // 于是 `runs/` 当场多出一局 `brainId=mock:TEST-DOUBLE`——和已发布证据同一个目录、肉眼分不出。
  // 台账 #34 讲的是"别拿替身产证据"，这条讲的是它的物理面：**别把替身的尸体放进证物间**。
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const mockScripts = Object.entries(pkg.scripts).filter(([, cmd]) => cmd.includes('--brain mock'));
  assert.ok(mockScripts.length > 0, '夹具前提：至少该有一条冒烟脚本用到替身，否则这条测试什么都没测');
  for (const [name, cmd] of mockScripts) {
    const out = /--out\s+(\S+)/.exec(cmd)?.[1];
    assert.ok(out !== undefined, `脚本 ${name} 用替身跑却没给 --out，默认就是 ./runs（证据目录）：${cmd}`);
    const abs = resolve(ROOT, out);
    assert.ok(abs !== resolve(ROOT, 'runs') && !abs.startsWith(resolve(ROOT, 'runs') + '/'),
      `脚本 ${name} 的 --out=${out} 落在 runs/ 里——替身局会污染已发布证据（#34）`);
    assert.match(out, /sandbox|tmp|\/tmp/, `脚本 ${name} 的 --out=${out} 应指向一个已忽略或临时的目录`);
  }
});
