/**
 * verify/reproduction.ts 的篡改自检：往复现包的证据里注入已知错误，逐条确认审计**抓得住**，
 * 再放几组**必须放行**的反向对照，确认它不过火。
 *
 * 为什么必须配这个：reproduction.ts 是对外交付面（大赛 6-C 看的就是这份文档）。
 * 交付面的审计一旦没牙，错的就不是一个数字，而是"别人照着复现却复现不出来"——
 * 那会把整个量具的可信度赔进去。台账 #17（零样本假通过）与 #21（分母没身份）都在这条线上。
 *
 * 用法: node verify/reproduction-selftest.ts
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(join(resolve(new URL('.', import.meta.url).pathname), '..'));
const SCRIPT = join(ROOT, 'verify', 'reproduction.ts');

/** 被篡改的样本局：M01 有完整四层判决，M02 是 M4-f 之前的旧证据（detection 缺席） */
const SRC_M01 = 'runs/m4f-model/M01-on/20261116-230249-s6';
const SRC_M02 = 'runs/m1b-M02/20261113-084119-s6';
const SRC_M07 = 'runs/m4f-model/M07-on/20261116-230713-s6';

const readJson = (dir: string, f: string): any => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const writeJson = (dir: string, f: string, v: unknown): void => writeFileSync(join(dir, f), JSON.stringify(v, null, 2), 'utf8');

function caseDir(src: string): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'repro-selftest-'));
  const dir = join(root, 'run');
  cpSync(join(ROOT, src), dir, { recursive: true });
  return { dir: `${dir}/`, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 跑一次审计，返回退出码与合并输出 */
function run(dir: string | null, extra: string[] = []): { code: number; out: string } {
  const args = [SCRIPT, ...(dir ? [dir] : []), ...extra];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

interface Case { name: string; src: string; expect: 'fail' | 'pass'; keyword: string; mutate?: (dir: string) => void }

const CASES: Case[] = [
  // ── 注入：每一条都必须被抓 ──
  {
    name: '1. 公证器首分叉步 +1（把第 6 步说成第 7 步）', src: SRC_M01, expect: 'fail', keyword: '[分叉]',
    mutate: (d) => { const j = readJson(d, 'defect.json'); j.notary.firstStep += 1; writeJson(d, 'defect.json', j); },
  },
  {
    name: '2. 分叉帧数 -1（少报一帧也是撒谎）', src: SRC_M01, expect: 'fail', keyword: '[分叉]',
    mutate: (d) => { const j = readJson(d, 'defect.json'); j.notary.divergedFrames -= 1; writeJson(d, 'defect.json', j); },
  },
  {
    name: '3. 初始哈希被换（header 与 defect 一起改，重放仍不许放行）', src: SRC_M01, expect: 'fail', keyword: '[初始]',
    mutate: (d) => {
      const h = readJson(d, 'header.json'); h.initialState.world.hash = 'deadbeefdeadbeef'; writeJson(d, 'header.json', h);
      const j = readJson(d, 'defect.json'); j.initialHash = 'deadbeefdeadbeef'; writeJson(d, 'defect.json', j);
    },
  },
  {
    name: '4. header.seed 与 defect.seed 不一致（种子被偷换）', src: SRC_M01, expect: 'fail', keyword: '[初始]',
    mutate: (d) => { const h = readJson(d, 'header.json'); h.seed = 8; writeJson(d, 'header.json', h); },
  },
  {
    name: '5. world.jsonl 中间一帧哈希被改（落盘证据被剪过）', src: SRC_M01, expect: 'fail', keyword: '[重放]',
    mutate: (d) => {
      const lines = readFileSync(join(d, 'world.jsonl'), 'utf8').trim().split('\n');
      const f = JSON.parse(lines[3]!); f.hash = 'aaaaaaaaaaaaaaaa'; lines[3] = JSON.stringify(f);
      writeFileSync(join(d, 'world.jsonl'), lines.join('\n'), 'utf8');
    },
  },
  {
    name: '6. 最小序列换成"根本不复现"的 4 步（证物是假的）', src: SRC_M01, expect: 'fail', keyword: '[最小化]',
    mutate: (d) => {
      const j = readJson(d, 'defect.json');
      j.notary.minimized.actions = j.fullWorldActions.slice(1, 5).filter((a: any) => !(a.kind === 'move' && a.dir === 1));
      writeJson(d, 'defect.json', j);
    },
  },
  {
    name: '7. 最小序列里插入完整轨迹没有的动作（手编证物）', src: SRC_M01, expect: 'fail', keyword: '保序删除',
    mutate: (d) => {
      const j = readJson(d, 'defect.json');
      j.notary.minimized.actions = [{ kind: 'pickup' }, ...j.notary.minimized.actions];
      writeJson(d, 'defect.json', j);
    },
  },
  {
    name: '8. detection.json 屏幕首分叉步被改（判决层与重放层脱钩）', src: SRC_M01, expect: 'fail', keyword: '[分叉]',
    mutate: (d) => { const j = readJson(d, 'detection.json'); j.visible.firstStep = 3; writeJson(d, 'detection.json', j); },
  },
  {
    name: '9. 判决口径戳被改（跑后补写口径）', src: SRC_M01, expect: 'fail', keyword: '[口径]',
    mutate: (d) => { const j = readJson(d, 'detection.json'); j.judgementVersion = 'm4f-9+lex-m4f-9'; writeJson(d, 'detection.json', j); },
  },
  {
    name: '10. 变异体 id 被换（把 M01 说成 M03）', src: SRC_M01, expect: 'fail', keyword: '[初始]',
    mutate: (d) => {
      const h = readJson(d, 'header.json'); h.initialState.world.mutant = 'M03'; writeJson(d, 'header.json', h);
      const j = readJson(d, 'defect.json'); j.mutant = 'M03'; j.notary.mutant = 'M03'; writeJson(d, 'defect.json', j);
    },
  },
  {
    name: '11. 真大脑 brainId 改成测试替身（#21 的冒充路径）', src: SRC_M01, expect: 'fail', keyword: '零案入库',
    mutate: (d) => { const h = readJson(d, 'header.json'); h.brainId = 'mock:TEST-DOUBLE'; writeJson(d, 'header.json', h); },
  },
  {
    name: '12. 动作序列里塞一个非结构化动作（kind 取值外的自由文本）', src: SRC_M01, expect: 'fail', keyword: '[接口]',
    mutate: (d) => { const j = readJson(d, 'defect.json'); j.fullWorldActions[1] = { kind: 'teleport' }; writeJson(d, 'defect.json', j); },
  },
  {
    name: '13. 删掉 world.jsonl（证据不全必须说人话）', src: SRC_M01, expect: 'fail', keyword: '证据缺失',
    mutate: (d) => rmSync(join(d, 'world.jsonl')),
  },
  // ── 反向对照：这些必须放行（不许把"没有"读成"有罪"）──
  { name: 'R1. 原始 M01 局（四层齐全）', src: SRC_M01, expect: 'pass', keyword: '不一致 0 处' },
  { name: 'R2. M4-f 之前的旧证据 M02 局（无 detection.json，不许报错）', src: SRC_M02, expect: 'pass', keyword: '不一致 0 处' },
];

let failed = 0;
console.log('===== reproduction.ts 篡改自检 =====\n');
for (const c of CASES) {
  const { dir, cleanup } = caseDir(c.src);
  try {
    c.mutate?.(dir);
    const r = run(dir);
    const caught = r.code !== 0;
    const kw = r.out.includes(c.keyword);
    const ok = c.expect === 'fail' ? (caught && kw) : (!caught && kw);
    if (!ok) failed++;
    console.log(`${ok ? '✅' : '❌'} ${c.name} → 退出码=${r.code}${kw ? '' : `（关键词「${c.keyword}」没出现）`}` +
      `${c.expect === 'fail' ? `（应抓 ${caught ? '✔' : '✘ 漏抓'}）` : `（应放行 ${caught ? '✘ 过火' : '✔'}）`}`);
  } finally {
    cleanup();
  }
}

// ── 三组单独跑的边界对照：不走"复制一局"的路径 ──
const empty = run(null, ['--no-default']);
const emptyOk = empty.code !== 0 && empty.out.includes('零样本');
if (!emptyOk) failed++;
console.log(`${emptyOk ? '✅' : '❌'} 14. 一个目录都不给（--no-default）→ 必须拒绝零样本 → 退出码=${empty.code}`);

const ctrl = run('runs/20261113-203623-s6'); // 对照组：无缺陷可复现
const ctrlOk = ctrl.code !== 0 && ctrl.out.includes('对照组') && ctrl.out.includes('零案入库');
if (!ctrlOk) failed++;
console.log(`${ctrlOk ? '✅' : '❌'} 15. 只给对照组 → 必须出声拒绝且不许凑出一份复现包 → 退出码=${ctrl.code}`);

const invisible = run(SRC_M07); // 从未分叉
const invOk = invisible.code !== 0 && invisible.out.includes('从未分叉');
if (!invOk) failed++;
console.log(`${invOk ? '✅' : '❌'} 16. 只给"这条轨迹没踩到缺陷"的局 → 必须拒绝编造最小证物 → 退出码=${invisible.code}`);

// --check 的漂移检测：一致必须放行，手改一个字必须红
const root = mkdtempSync(join(tmpdir(), 'repro-drift-'));
const doc = join(root, 'REPRO.md');
try {
  const gen = spawnSync(process.execPath, [SCRIPT, '--emit', doc], { encoding: 'utf8', cwd: ROOT });
  const genOk = (gen.status ?? -1) === 0;
  const same = spawnSync(process.execPath, [SCRIPT, '--check', doc], { encoding: 'utf8', cwd: ROOT });
  const sameOk = (same.status ?? -1) === 0 && `${same.stdout}${same.stderr}`.includes('逐字节一致');
  writeFileSync(doc, readFileSync(doc, 'utf8').replace('随机种子', '随机种籽'), 'utf8');
  const drift = spawnSync(process.execPath, [SCRIPT, '--check', doc], { encoding: 'utf8', cwd: ROOT });
  const driftOk = (drift.status ?? -1) !== 0 && `${drift.stdout}${drift.stderr}`.includes('漂移');
  if (!(genOk && sameOk && driftOk)) failed++;
  console.log(`${genOk && sameOk && driftOk ? '✅' : '❌'} 17. 文档一致须放行、手改一字须报漂移 → 生成=${gen.status} 一致=${same.status} 改后=${drift.status}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const total = CASES.length + 4;
const injections = CASES.filter((c) => c.expect === 'fail').length;
const reverses = CASES.filter((c) => c.expect === 'pass').length;
console.log(`\n===== reproduction 自检：注入 ${injections} 处｜反向对照 ${reverses} 组｜边界与漂移 4 例；合计 ${total} 例，失败 ${failed} 例 =====`);
process.exit(failed === 0 ? 0 : 1);
