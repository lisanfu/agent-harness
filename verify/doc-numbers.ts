/**
 * verify/doc-numbers.ts —— 把**文档自己印出的数字**当成被测对象，逐格重算并比对。
 *
 * 为什么必须存在（#35 → #44 → #45 三条同族故障换来的）：
 *   #35 字节/字符两个口径混用；#44 文档写 `world.jsonl` 603 字节、磁盘实际 703；
 *   #45 终局验收第五次在干净克隆里重算：文档印「测试 8828 行」而实测 8840
 *   ——最后一次代码改动（+12 行 Buffer 比对）发生在我抄数字**之后**。
 *   前两条靠人记得重算，第三条证明"记得重算"本身不可靠：**只要数字是抄进文档的，它就会腐化**。
 *   于是把"重算一遍"变成一条命令：`npm run verify:docs`。零 key、零网络、干净克隆里同样能跑。
 *
 * 纪律（和这套仓库其它审计脚本一样）：
 *   1) 每格自带**口径**（一段可复制的命令），不许出现"我记得是"；
 *   2) 锚点必须**唯一命中**：命中 0 次 = 文档句式被改了，检查器不许装作没看见；命中多次 = 有歧义；
 *   3) 核不了就**当众说不核**（例如"540 例"只有 `npm test` 本身能证），绝不悄悄跳过；
 *   4) 只核**当前**数字。历史段落（"终局验收第 N 次当时测得 491/491"）是当时的记录，不在射程内；
 *   5) 五脏清单表逐行核「文件 → 行数」：解析不到就报**哪一行**、为什么。
 *
 * 用法:
 *   node verify/doc-numbers.ts            # 审计：任一不符 exit=1
 *   node verify/doc-numbers.ts --print    # 只输出实测值：改完代码照这里更新文档，不靠记忆
 *   node verify/doc-numbers.ts --json     # 机器可读（测试与 CI 用）
 */
import { readFileSync, readdirSync, statSync, globSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(resolve(new URL('.', import.meta.url).pathname), '..'));

// ───────────────────────── 度量原语（口径写死在这里，文档只许引用） ─────────────────────────

/**
 * 与 `wc -l` **逐字节同口径**：只数换行符。
 * （第一次跑这个检查器时就给自己找出一条故障：写成了 `split('\n')` + "最后一行没换行符也算一行"，
 *   于是 29/38 个 src 文件各多 1 行，"文档 src 9642 / 实测 9671" 一片红——
 *   文档没错，是检查器不忠于它自己声明的口径。口径必须先于结论。）
 */
export function lineCount(path: string): number {
  return countMatches(readFileSync(path, 'utf8'), '\n');
}

/** 与 `find <dir> -name '*.ts'` 同口径：递归、只看后缀 */
export function tsFiles(dir: string, suffix = '.ts'): string[] {
  const abs = join(ROOT, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs).sort()) {
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(join(dir, name), suffix));
    else if (name.endsWith(suffix)) out.push(p);
  }
  return out;
}

export const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);

/** 中位数口径：升序后取下标 floor((n-1)/2)（奇数个就是正中间那一个） */
export function median(ns: number[]): number {
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] ?? 0;
}

export function countMatches(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** `runs/` 的**项数**（不是局数、不是文件数）：口径 = `find runs -maxdepth 1 -mindepth 1 | wc -l` */
export function runsEntries(): number {
  return readdirSync(join(ROOT, 'runs')).length;
}

export function runsEarFiles(): number {
  return globSync('runs/**/ear.json', { cwd: ROOT, useFsEvents: false }).length;
}

/** 中文数词 → 数字（只覆盖文档用得着的 1–99） */
export function chineseToNumber(s: string): number | null {
  const digit: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? digit[m[1]]! : 1) * 10 + (m[2] ? digit[m[2]]! : 0);
  if (s.length === 1 && digit[s] !== undefined) return digit[s];
  return null;
}

// ───────────────────────── 活文档里"当前数字"的锚点 ─────────────────────────

type Value = number | string;

/** 一格：文档捕获组 vs 实测值。measure=null 表示**不核**，必须写清理由。 */
export interface Group {
  name: string;
  measure: (() => Value) | null;
  why?: string;
}

export interface Claim {
  id: string;
  label: string;
  doc: string;
  pattern: RegExp;
  caliber: string;
  groups: Group[];
}

const srcFiles = () => tsFiles('src');
const testFiles = () => tsFiles('test');
const verifyFiles = () => tsFiles('verify');
const listOf = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const checklistCount = () => countMatches(listOf('KNOWLEDGE.md'), '- [ ] ');
const ledgerCount = () => countMatches(listOf('README.md'), '\n### #');

/** README §1 结尾点名的"大文件"——算区间/中位数时要按同一口径排除 */
const BIG_THREE = ['src/world/reconcile.ts', 'src/world/ear.ts', 'src/types.ts'];

export const CLAIMS: Claim[] = [
  {
    id: 'D1', label: 'README 源码/测试/复核合计句', doc: 'README.md',
    pattern: /源码合计 (\d+) 行（(\d+) 个文件），测试 (\d+) 行（(\d+) 个文件 \/ (\d+) 例），独立复核脚本 (\d+) 行（(\d+) 个文件）/,
    caliber: "find {src,test,verify} -name '*.ts' | xargs wc -l；例数 = npm test",
    groups: [
      { name: 'src 行', measure: () => sum(srcFiles().map(lineCount)) },
      { name: 'src 文件数', measure: () => srcFiles().length },
      { name: 'test 行', measure: () => sum(testFiles().map(lineCount)) },
      { name: 'test 文件数', measure: () => testFiles().length },
      { name: 'test 例数', measure: null, why: '只有 `npm test` 能证（约 26 秒），本脚本不重跑，避免"用慢的核快的"' },
      { name: 'verify 行', measure: () => sum(verifyFiles().map(lineCount)) },
      { name: 'verify 文件数', measure: () => verifyFiles().length },
    ],
  },
  {
    id: 'D2', label: 'HAND-CODING §1 参考仓库真实数字', doc: 'HAND-CODING.md',
    pattern: /参考仓库的真实数字：`src\/` (\d+) 个文件 \*\*(\d+) 行\*\*，`test\/` (\d+) 个文件 \*\*(\d+) 行 \/ (\d+) 测试\*\*，`verify\/` (\d+) 个文件 \*\*(\d+) 行\*\*/,
    caliber: "find {src,test,verify} -name '*.ts' | xargs wc -l（与 D1 同一批命令，只是这句话写在 HAND-CODING §1）",
    groups: [
      { name: 'src 文件数', measure: () => srcFiles().length },
      { name: 'src 行', measure: () => sum(srcFiles().map(lineCount)) },
      { name: 'test 文件数', measure: () => testFiles().length },
      { name: 'test 行', measure: () => sum(testFiles().map(lineCount)) },
      { name: 'test 例数', measure: null, why: '同 D1：交给 `npm test`' },
      { name: 'verify 文件数', measure: () => VERIFY_COUNT() },
      { name: 'verify 行', measure: () => sum(verifyFiles().map(lineCount)) },
    ],
  },
  {
    id: 'D3', label: 'README 三个大文件的行数', doc: 'README.md',
    pattern: /`reconcile\.ts`（(\d+)）、`ear\.ts`（(\d+)）、`types\.ts`（(\d+)）/,
    caliber: 'wc -l src/world/reconcile.ts src/world/ear.ts src/types.ts',
    groups: [
      { name: 'reconcile.ts 行', measure: () => lineCount(join(ROOT, BIG_THREE[0]!)) },
      { name: 'ear.ts 行', measure: () => lineCount(join(ROOT, BIG_THREE[1]!)) },
      { name: 'types.ts 行', measure: () => lineCount(join(ROOT, BIG_THREE[2]!)) },
    ],
  },
  {
    id: 'D4', label: 'README 其余 src 文件的区间与中位数', doc: 'README.md',
    pattern: /其余 (\d+) 个文件全在 \*\*(\d+)～(\d+) 行\*\*之间（中位数 (\d+)）/,
    caliber: "find src -name '*.ts'，排除 D3 那三个，逐个数行数后排序；中位数取下标 floor((n-1)/2)",
    groups: [
      { name: '其余文件数', measure: () => restOfSrc().length },
      { name: '最小行数', measure: () => sortedRest()[0] ?? 0 },
      { name: '最大行数', measure: () => sortedRest().at(-1) ?? 0 },
      { name: '中位数', measure: () => median(restOfSrc()) },
    ],
  },
  {
    id: 'D5', label: 'README 已发布证据的项数', doc: 'README.md',
    pattern: /已发布的 (\d+) 项 `runs\/`/,
    caliber: 'find runs -maxdepth 1 -mindepth 1 | wc -l',
    groups: [{ name: 'runs 项数', measure: () => runsEntries() }],
  },
  {
    id: 'D6', label: 'KNOWLEDGE 标题的中文条数', doc: 'KNOWLEDGE.md',
    pattern: /^## 今天真实学到的([一二三四五六七八九十]+)条（优先掌握）$/m,
    caliber: "grep -c '^- \\[ \\] ' KNOWLEDGE.md（标题必须与自测清单实际条数同数）",
    groups: [{ name: '标题条数 == 清单条数', measure: () => checklistCount() }],
  },
  {
    id: 'D7', label: 'KNOWLEDGE 清单结尾的阿拉伯条数', doc: 'KNOWLEDGE.md',
    pattern: /^(\d+) 条。全过 = 这套东西你真的懂了，可以开始改它。$/m,
    caliber: "同 D6：grep -c '^- \\[ \\] ' KNOWLEDGE.md",
    groups: [{ name: '清单条数', measure: () => checklistCount() }],
  },
  {
    id: 'D8', label: '耳侧上限表两份产物的字节数', doc: 'HAND-CODING.md',
    pattern: /（不落盘）：(\d+) \/ (\d+) 字节/,
    caliber: 'wc -c runs/m4c-ear/ear_ceiling.jsonl runs/m4c-ear/ear_ceiling_summary.json',
    groups: [
      { name: 'jsonl 字节', measure: () => statSync(join(ROOT, 'runs/m4c-ear/ear_ceiling.jsonl')).size },
      { name: 'summary 字节', measure: () => statSync(join(ROOT, 'runs/m4c-ear/ear_ceiling_summary.json')).size },
    ],
  },
];

function restOfSrc(): number[] {
  return srcFiles().filter((p) => !BIG_THREE.some((b) => p.endsWith(b))).map(lineCount);
}
function sortedRest(): number[] {
  return [...restOfSrc()].sort((a, b) => a - b);
}
function VERIFY_COUNT(): number {
  return verifyFiles().length;
}

// ───────────────────────── 不依赖文档句式的恒等式 ─────────────────────────

export interface Invariant {
  id: string;
  label: string;
  caliber: string;
  check: () => { ok: boolean; detail: string };
}

export const INVARIANTS: Invariant[] = [
  {
    id: 'I1', label: '故障台账条数 == 自测清单条数',
    caliber: "grep -c '^### #' README.md == grep -c '^- \\[ \\] ' KNOWLEDGE.md",
    check: () => ({
      ok: ledgerCount() === checklistCount(),
      detail: `台账 ${ledgerCount()} 条｜清单 ${checklistCount()} 条`,
    }),
  },
  {
    id: 'I2', label: "test/ 的两个口径没分家（*.ts 与 *.test.ts 同数）",
    caliber: "find test -name '*.ts' | wc -l == find test -name '*.test.ts' | wc -l",
    check: () => {
      const all = tsFiles('test').length;
      const only = tsFiles('test', '.test.ts').length;
      return { ok: all === only, detail: `*.ts ${all} 个｜*.test.ts ${only} 个${all === only ? '' : '｜文档按 .ts 口径计数，多出来的助手文件必须另行说明'}` };
    },
  },
  {
    id: 'I3', label: '文档若声称"一份 ear.json 都没有"，磁盘必须真的为零',
    caliber: 'find runs -name ear.json | wc -l',
    check: () => {
      const claims = /一份 `ear\.json` 都没有/.test(listOf('README.md'));
      const n = runsEarFiles();
      if (!claims) return { ok: true, detail: `文档已不再这样声称；实测 runs/ 里 ear.json ${n} 份（记录用）` };
      return { ok: n === 0, detail: `文档声称"一份都没有"，实测 ${n} 份` };
    },
  },
  {
    id: 'I4', label: 'src/ 里每个 .ts 都被 test/ 或 verify/ 点到名（谁也不服务的文件不许留着）',
    caliber: "对 src/**/*.ts 逐个在 test/**/*.ts + verify/**/*.ts 的文本里查它的文件名（去目录去后缀）",
    check: () => {
      const names = [...tsFiles('test'), ...tsFiles('verify')].map((p) => readFileSync(p, 'utf8')).join('\n');
      const orphan = srcFiles().map((p) => p.slice(ROOT.length + 1)).filter((rel) => !names.includes(rel.split('/').pop()!.replace('.ts', '')));
      return { ok: orphan.length === 0, detail: orphan.length === 0 ? `${srcFiles().length} 个 src 文件全部出现在 test/ 或 verify/ 里` : `没人引用：${orphan.join('、')}` };
    },
  },
];

// ───────────────────────── 五脏清单表格：文件 → 行数 逐行核 ─────────────────────────

export interface RowAudit {
  organ: string;
  fileCell: string;
  lineCell: string;
  status: 'ok' | 'bad' | 'skip';
  detail: string;
}

function expandBraces(token: string): string[] {
  const m = /^(.*)\{([^}]*)\}(.*)$/.exec(token);
  if (!m) return [token];
  return m[2]!.split(',').map((part) => `${m[1]}${part.trim()}${m[3]}`);
}

/** 从"文件"格里掏出仓库里真实存在的 .ts 路径；`{a,b}` 展开，裸文件名沿用上一个目录 */
export function resolvePaths(cell: string): string[] {
  const tokens = cell.match(/[A-Za-z0-9_./{},-]+\.ts/g) ?? [];
  const out: string[] = [];
  let lastDir = '';
  for (const raw of tokens) {
    for (const expanded of expandBraces(raw)) {
      let p = expanded;
      if (p.includes('/')) lastDir = p.split('/').slice(0, -1).join('/');
      else if (lastDir) p = `${lastDir}/${p}`;
      if (!/^(src|verify|test)\//.test(p)) continue;
      if (statSync(join(ROOT, p), { throwIfNoEntry: false })?.isFile()) out.push(p);
    }
  }
  return out;
}

/** 只取「## 1. 五脏清单」那一张表，别把 README 其它表格卷进来 */
export function organTableLines(readme: string): string[] {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => l.startsWith('| 器官 | 职责 | 文件 | 行数'));
  if (start < 0) return [];
  const rows: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i]!.startsWith('|')) break;
    rows.push(lines[i]!);
  }
  return rows;
}

export function auditOrganTable(readme: string): RowAudit[] {
  const rows: RowAudit[] = [];
  for (const line of organTableLines(readme)) {
    const cells = line.split('|').map((c) => c.trim());
    const organ = cells[1] ?? '';
    const fileCell = cells[3] ?? '';
    const lineCell = cells[4] ?? '';
    if (!/\.ts/.test(fileCell)) continue;
    const claimed = (lineCell.match(/\d+/g) ?? []).map(Number);
    if (claimed.length === 0) {
      rows.push({ organ, fileCell, lineCell, status: 'skip', detail: '行数格里没有阿拉伯数字（散文写法），本脚本不核' });
      continue;
    }
    const files = resolvePaths(fileCell);
    if (files.length === 0) {
      rows.push({ organ, fileCell, lineCell, status: 'skip', detail: '文件格里解析不到仓库里真实存在的 .ts，本脚本不核' });
      continue;
    }
    const measured = files.map(lineCount);
    let ok = false;
    let detail = '';
    if (claimed.length === measured.length) {
      ok = claimed.every((c, i) => c === measured[i]);
      detail = files.map((f, i) => `${f}=${measured[i]}${claimed[i] === measured[i] ? '' : `（文档印 ${claimed[i]}）`}`).join(' ');
    } else if (claimed.length === 1) {
      // 一格一个数、文件列里却有两个路径：文档可能只数主文件，也可能数合计——两个都算通过，但要说清是哪一个
      ok = claimed[0] === measured[0] || claimed[0] === sum(measured);
      detail = `${files.map((f, i) => `${f}=${measured[i]}`).join(' ')}｜文档印 ${claimed[0]}（${claimed[0] === measured[0] ? '与第一个文件同数' : claimed[0] === sum(measured) ? '与合计同数' : '两者都不是'}）`;
    } else {
      ok = sum(claimed) === sum(measured);
      detail = ok ? `${files.join(' + ')} → 实测 ${measured.join('/')}，合计 ${sum(measured)}`
        : `${files.join(' + ')} 实测 ${measured.join('/')}，合计 ${sum(measured)}；文档印 ${claimed.join(' + ')} = ${sum(claimed)}`;
    }
    rows.push({ organ, fileCell, lineCell, status: ok ? 'ok' : 'bad', detail });
  }
  return rows;
}

// ───────────────────────── 审计主体（测试可喂"篡改后的文档文本"） ─────────────────────────

export interface GroupResult { name: string; claimed: string; measured: string | null; ok: boolean; skipped: boolean; why?: string }
export interface ClaimResult { id: string; label: string; doc: string; status: 'ok' | 'bad' | 'missing' | 'ambiguous'; reason: string; groups: GroupResult[] }
export interface InvariantResult { id: string; label: string; ok: boolean; detail: string }
export interface DocNumbersResult { claims: ClaimResult[]; invariants: InvariantResult[]; rows: RowAudit[]; mismatches: number }

function groupEquals(g: Group, claimed: string): { ok: boolean; measured: string } {
  const m = g.measure!();
  const c = claimed.trim();
  if (typeof m === 'number' && /^[一二三四五六七八九十]+$/.test(c)) {
    const parsed = chineseToNumber(c);
    return { ok: parsed === m, measured: `${m}（数词「${c}」解析为 ${parsed}）` };
  }
  return { ok: String(m) === c, measured: String(m) };
}

export function auditDocs(docText: Record<string, string>): DocNumbersResult {
  const claims: ClaimResult[] = [];
  let mismatches = 0;
  for (const c of CLAIMS) {
    const text = docText[c.doc] ?? '';
    const hits = text.match(new RegExp(c.pattern.source, c.pattern.flags.includes('g') ? c.pattern.flags : `${c.pattern.flags}g`)) ?? [];
    if (hits.length === 0) {
      mismatches++;
      claims.push({ id: c.id, label: c.label, doc: c.doc, status: 'missing', reason: `锚点在 ${c.doc} 里命中 0 次：句式被改了或被删了，检查器不许装作没看见`, groups: [] });
      continue;
    }
    if (hits.length > 1) {
      mismatches++;
      claims.push({ id: c.id, label: c.label, doc: c.doc, status: 'ambiguous', reason: `锚点在 ${c.doc} 里命中 ${hits.length} 次，无法确定哪一处才是"当前数字"`, groups: [] });
      continue;
    }
    const one = c.pattern.exec(text)!;
    const groups: GroupResult[] = [];
    let bad = 0;
    c.groups.forEach((g, i) => {
      const claimed = one[i + 1] ?? '';
      if (g.measure === null) {
        groups.push({ name: g.name, claimed, measured: null, ok: true, skipped: true, why: g.why });
        return;
      }
      const r = groupEquals(g, claimed);
      if (!r.ok) bad++;
      groups.push({ name: g.name, claimed, measured: r.measured, ok: r.ok, skipped: false });
    });
    if (bad > 0) mismatches++;
    claims.push({ id: c.id, label: c.label, doc: c.doc, status: bad === 0 ? 'ok' : 'bad', reason: bad === 0 ? '' : `${bad} 格与实测不符（口径：${c.caliber}）`, groups });
  }
  const invariants: InvariantResult[] = [];
  for (const inv of INVARIANTS) {
    const r = inv.check();
    if (!r.ok) mismatches++;
    invariants.push({ id: inv.id, label: inv.label, ok: r.ok, detail: r.detail });
  }
  const rows = auditOrganTable(docText['README.md'] ?? '');
  mismatches += rows.filter((r) => r.status === 'bad').length;
  return { claims, invariants, rows, mismatches };
}

function readDocs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ['README.md', 'HAND-CODING.md', 'KNOWLEDGE.md']) out[f] = listOf(f);
  return out;
}

/** --print：把"该抄进文档的数"一次算全，杜绝第二次凭记忆 */
export function measuredSnapshot(): Record<string, Value> {
  return {
    'src 行': sum(srcFiles().map(lineCount)),
    'src 文件数': srcFiles().length,
    'test 行': sum(testFiles().map(lineCount)),
    'test 文件数': testFiles().length,
    'verify 行': sum(verifyFiles().map(lineCount)),
    'verify 文件数': verifyFiles().length,
    'reconcile.ts 行': lineCount(join(ROOT, BIG_THREE[0]!)),
    'ear.ts 行': lineCount(join(ROOT, BIG_THREE[1]!)),
    'types.ts 行': lineCount(join(ROOT, BIG_THREE[2]!)),
    '其余 src 文件数': restOfSrc().length,
    '其余最小行数': sortedRest()[0] ?? 0,
    '其余最大行数': sortedRest().at(-1) ?? 0,
    '其余中位数': median(restOfSrc()),
    'runs 项数': runsEntries(),
    '自测清单条数': checklistCount(),
    'README 台账条数': ledgerCount(),
    'ear_ceiling.jsonl 字节': statSync(join(ROOT, 'runs/m4c-ear/ear_ceiling.jsonl')).size,
    'ear_ceiling_summary.json 字节': statSync(join(ROOT, 'runs/m4c-ear/ear_ceiling_summary.json')).size,
  };
}

// ───────────────────────── CLI ─────────────────────────
// 直接运行才打印并决定退出码；被 test/ import 时只交出函数。
// （这条不是洁癖：第一版把 CLI 写在顶层，测试一 import 就替整个 test 进程 process.exit(1)，
//   表现为"测试文件莫名只有一行输出"——审计脚本把自己的退出码带进了别人的进程。）

function main(): void {
  const MODE = process.argv.slice(2);

  if (MODE.includes('--print')) {
    console.log('===== 实测值（改文档照这里抄，不许凭记忆；口径见 CLAIMS 里的 caliber） =====');
    for (const [k, v] of Object.entries(measuredSnapshot())) console.log(`${String(v).padStart(7)}  ${k}`);
    process.exit(0);
  }

  if (MODE.includes('--json')) {
    console.log(JSON.stringify(auditDocs(readDocs())));
    process.exit(0);
  }

  const res = auditDocs(readDocs());
  console.log('===== 文档数字独立重算（doc-numbers） =====\n');
  for (const c of res.claims) {
    console.log(`${c.status === 'ok' ? '✅' : '❌'} ${c.id} ${c.label}  [${c.doc}]`);
    if (c.reason) console.log(`     └─ ${c.reason}`);
    for (const g of c.groups) {
      if (g.skipped) { console.log(`     ⚪ 不核 ${g.name}（文档印 ${g.claimed}）｜理由：${g.why}`); continue; }
      console.log(`     ${g.ok ? '·' : '✘'} ${g.name}：文档 ${g.claimed} vs 实测 ${g.measured}`);
    }
  }
  console.log('\n----- 恒等式（不依赖文档句式） -----');
  for (const i of res.invariants) console.log(`${i.ok ? '✅' : '❌'} ${i.id} ${i.label}｜${i.detail}`);

  console.log('\n----- 五脏清单表格逐行（文件 → 行数） -----');
  for (const r of res.rows) {
    if (r.status === 'ok') continue;
    console.log(`${r.status === 'bad' ? '❌' : '⚪'} ${r.organ}｜${r.fileCell}｜文档 ${r.lineCell} → ${r.detail}`);
  }
  const okRows = res.rows.filter((r) => r.status === 'ok').length;
  const badRows = res.rows.filter((r) => r.status === 'bad').length;
  console.log(`表格合计 ${res.rows.length} 行：相符 ${okRows}｜不符 ${badRows}｜当众声明不核 ${res.rows.length - okRows - badRows}`);

  console.log(`\n===== doc-numbers：${res.mismatches === 0 ? '全部相符 ✅' : `不符 ${res.mismatches} 处 ❌`} =====`);
  console.log('注：本脚本不 import 任何判据，只做"文档文本 vs 磁盘实测"；历史段落里的数字是当时的记录，不在射程内。');
  process.exit(res.mismatches === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
