/**
 * 对账三件套自己的回归：**证明 recon-audit.ts 抓得住错**（台账 #8 在审计层同样成立）。
 *
 * 一套从没拒绝过任何东西的判据，和 print ✅ 没有区别。
 * 这里拿一份真语料证据（复制后逐次注入**一处**已知造假），要求审计同时满足两条：
 *   1. 退出码非 0；
 *   2. 输出里出现**对应那一条判据**的关键词——随便哪里崩一下都算抓住，等于没验。
 *
 * 反向对照一条不许少：只会拒绝的判据和只会放过的一样没用。
 *   C1 干净证据                        → 退出 0（基线不成立，整个自检作废）
 *   C2 大脑换成 mock:（假大脑）         → 整局跳过，不许把"没有样本"报成故障，也不许当"审过了"
 *   C3 thought 里加一句不含主张的话      → 判决照旧（审计只关心判决，不是"改了证据就红"的瞎子）
 *   C4 同一句话重复两遍（同形引文两处）  → 两处判决相同 → 落点无所谓，放行
 *      ↑ C4 与注入 8 是同一条判据的两侧：落点不定只在**判决随落点改变**时才出声（#14：宁可红，不许取第一个蒙过去）。
 *
 * G1 是冻结守卫的"咬合力"实测：内存里改掉正则源串/回溯表/符号表，sha 必须跟着变，
 *    改回去必须复原。只 assert 常量相等的那种写法证明不了指纹真的吃进了这张表。
 *
 * 用法: node verify/recon-selftest.ts
 * ⚠️ 需要仓库里已有一份 runs/<局>/reconciliation.json（`npm run verify:recon` 生成，零 key、零新调用）。
 *    证据不在就当场失败——"没东西可验"从来不算通过（台账 #17）。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FROZEN_SHA256, RECON_VERSION, RETRO_RULES, RULES, SYMBOL_WORDS, reconDrift, reconSha } from '../src/world/reconcile.ts';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const ROOT = resolve(HERE, '..');
const AUDIT = join(HERE, 'recon-audit.ts');
const work = mkdtempSync(join(tmpdir(), 'recon-selftest-'));

const read = (dir: string, f: string): any => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const write = (dir: string, f: string, v: unknown): void =>
  writeFileSync(join(dir, f), `${JSON.stringify(v, null, 1)}\n`);
const rowsOf = (dir: string): any[] =>
  readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const dump = (dir: string, rows: unknown[]): void =>
  writeFileSync(join(dir, 'trace.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

/** 夹具侧证据（人工期望＝三方对照的第一方）：注入只动语料副本，不动它 */
const CASES = (spawnSync(process.execPath, [join(HERE, 'recon-fixture.ts')], { encoding: 'utf8' }).stdout ?? '')
  .trim().split('\n').at(-1)!.trim();
console.log(`夹具证据：${CASES}`);

// ─────────────────────────── 语料基线：挑一局"判决种类够多"的真大脑局 ───────────────────────────

const listRunDirs = (d: string, depth = 0): string[] => {
  const out: string[] = [];
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d).sort()) {
    const p = join(d, n);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, 'reconciliation.json'))) out.push(p);
    else if (depth < 2) out.push(...listRunDirs(p, depth + 1));
  }
  return out;
};

/** 注入要的三种料：一条「相符」（改判/加回溯词都用它）、一条带引文的坐标类、若干条决策行 */
function pickBase(): string {
  for (const dir of listRunDirs(join(ROOT, 'runs'))) {
    if (!existsSync(join(dir, 'trace.jsonl')) || !existsSync(join(dir, 'header.json'))) continue;
    const rec = read(dir, 'reconciliation.json');
    if (rec.recon.recon !== RECON_VERSION) continue;
    const brain = String(rec.brain ?? '');
    if (brain.startsWith('mock:') || brain.startsWith('script:')) continue;
    const ok = (rec.detail as any[]).filter((d) => d.verdict === '相符').length;
    const un = (rec.detail as any[]).filter((d) => d.verdict === '无法核对').length;
    if (ok >= 3 && un >= 3 && rowsOf(dir).length > 3) return dir;
  }
  console.error('❌ 找不到可用证据：仓库里没有任何一份「当前判据版本 + 真大脑 + 判决种类够多」的' +
    ` runs/<局>/reconciliation.json。\n   先跑 npm run verify:recon（零 key、零新调用，只读已发布 trace）。`);
  process.exit(1);
}

const base = pickBase();
console.log(`语料基线：${base.slice(ROOT.length + 1)}`);

function runAudit(dir: string, o: { cases?: string; audit?: string } = {}): { code: number; out: string } {
  const args = [o.audit ?? AUDIT, o.cases ?? CASES, '--corpus', '--runs', dir];
  // ⚠️ 审计的话都说在 **stderr**（log 走的是 stderr），execFileSync 只回 stdout：
  //   通过的那几轮就会拿到一个空字符串，关键词永远"未命中"——反向对照当场变成假红。
  //   两个流都要收，退出码也从同一个结果里读，成败两侧走同一条路。
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const clean0 = runAudit(base);
if (clean0.code !== 0) {
  console.log(`❌ 干净证据就没通过审计，自检无效（基线不成立，下面每一条都无从证明）：\n${clean0.out}`);
  process.exit(1);
}
console.log('干净审计通过 ✅（基线成立）\n');

/** 找到第 index 条满足条件的主张（找不到就直接抛：静默跳过一条注入＝给自检开免检通道，#17） */
function find(detail: any[], pred: (d: any) => boolean, what: string, index = 0): { i: number; e: any } {
  const hits = detail.map((d, i) => ({ d, i })).filter((x) => pred(x.d));
  const hit = hits[index];
  if (hit === undefined) throw new Error(`基线局里没有第 ${index + 1} 条「${what}」的主张，注入无从下手`);
  return { i: hit.i, e: hit.d };
}

interface Case {
  name: string; keyword: string;
  mutate: (dir: string) => void;
  /** 造假不一定要动语料：动夹具证据／动审计本体在这儿给出替换后的路径 */
  prepare?: (dir: string) => { cases?: string; audit?: string };
}

const injections: Case[] = [
  {
    // 最直白的一条：把「相符」写成「矛盾」。判决是这份证据唯一的出口，改它必须被重算抓住。
    name: '一条相符判决被改成矛盾（明细造假，聚合数字看不出来）',
    keyword: '落盘=矛盾 审计=相符',
    mutate: (dir) => {
      const rec = read(dir, 'reconciliation.json');
      const { i } = find(rec.detail, (d) => d.verdict === '相符', '相符');
      rec.detail[i].verdict = '矛盾';
      write(dir, 'reconciliation.json', rec);
    },
  },
  {
    name: '抹掉一条明细但 claims 不改（分母没了身份，#21）',
    keyword: '恒等式断裂',
    mutate: (dir) => {
      const rec = read(dir, 'reconciliation.json');
      rec.detail.splice(0, 1);
      write(dir, 'reconciliation.json', rec);
    },
  },
  {
    name: '锚点屏幕指纹改成别的（判决依据的画面被换掉，#14 的锚点侧）',
    keyword: '锚点自证',
    mutate: (dir) => {
      const rec = read(dir, 'reconciliation.json');
      const { i, e } = find(rec.detail, (d) => typeof d.screenSha === 'string', '带屏幕指纹');
      rec.detail[i].screenSha = `f${e.screenSha.slice(1)}`;
      write(dir, 'reconciliation.json', rec);
    },
  },
  {
    name: '锚点帧号改成屏幕读不出的另一帧（帧号从屏幕自己读，改了就对不上）',
    keyword: '锚点自证',
    mutate: (dir) => {
      const rec = read(dir, 'reconciliation.json');
      const { i, e } = find(rec.detail, (d) => typeof d.tick === 'number', '带帧号');
      rec.detail[i].tick = e.tick + 1;
      write(dir, 'reconciliation.json', rec);
    },
  },
  {
    name: '引文换到别的行（row 指错：那句话根本不是这条主张的出处）',
    keyword: '引文不在它自己那行',
    mutate: (dir) => {
      const rec = read(dir, 'reconciliation.json');
      const { e } = find(rec.detail, (d) => d.verdict === '相符', '相符');
      const rows = rowsOf(dir);
      rows[e.row].decision.thought = '这一步继续探索，没有新信息。';
      dump(dir, rows);
    },
  },
  {
    name: '口径混用：一份 m4d-4 的落盘混进 m4d-5 的对照里（#18）',
    keyword: '版本与夹具不一致',
    mutate: (dir) => {
      const rec = read(dir, 'reconciliation.json');
      rec.recon.recon = 'm4d-4';
      write(dir, 'reconciliation.json', rec);
    },
  },
  {
    name: '给一条相符主张的原文前面塞「之前」（回溯免检这条路必须真的活着）',
    keyword: '审计也认它是回溯句',
    mutate: (dir) => {
      const rec = read(dir, 'reconciliation.json');
      const { e } = find(rec.detail, (d) => d.verdict === '相符' && typeof d.quote === 'string' && d.quote.length > 3, '相符·引文够长');
      const rows = rowsOf(dir);
      const t = String(rows[e.row].decision.thought);
      const at = t.indexOf(e.quote);
      if (at < 0) throw new Error(`引文 ${JSON.stringify(e.quote)} 不在第 ${e.row} 行里，注入无从下手`);
      rows[e.row].decision.thought = `${t.slice(0, at)}之前${t.slice(at)}`;
      dump(dir, rows);
    },
  },
  {
    name: '同形引文两处、判决不同（审计定位不了这一条到底是哪一处，#14）',
    keyword: '落点不定',
    mutate: (dir) => {
      const rec = read(dir, 'reconciliation.json');
      const { e } = find(rec.detail, (d) => d.kind === 'playerPos' && d.verdict === '相符', 'playerPos·相符');
      const rows = rowsOf(dir);
      // 「我在(2,3)。之前我在(2,3)」：前半句可核对、后半句是回溯——同一条落盘判决对不上两处落点
      rows[e.row].decision.thought = `${e.quote}。之前${e.quote}`;
      dump(dir, rows);
    },
  },
  {
    name: '证据文件里躺着内部状态字段（对账只能吃屏幕，#15 的通道侧）',
    keyword: '夹具证据里带着内部状态',
    mutate: () => { /* 这一处造假动的是夹具证据，不是语料 */ },
    prepare: (dir) => {
      const raw = readFileSync(CASES, 'utf8');
      const patched = raw.replace('"what":', '"cooldown": 3, "what":');
      if (patched === raw) throw new Error('注入 9 构造失败：夹具证据里找不到 "what" 键，写法变了得跟着改');
      const p = join(dir, 'cases-with-state.json');
      writeFileSync(p, patched);
      return { cases: p };
    },
  },
  {
    name: '审计自己 import 了判据本体（那就不是复核，是复印——自扫描必须抓住）',
    keyword: 'import 了判据本体',
    mutate: () => { /* 这一处造假动的是审计脚本本体 */ },
    prepare: (dir) => {
      const raw = readFileSync(AUDIT, 'utf8');
      let src = raw.replace(`from '../src/world/observe.ts'`, `from '${join(ROOT, 'src/world/observe.ts')}'`);
      if (src === raw) throw new Error('注入 10 构造失败：审计的 observe 导入写法变了，副本搬不动，跟着改这里');
      src = src.replace('import { existsSync,',
        `import { RECON_VERSION as _judge } from '${join(ROOT, 'src/world/reconcile.ts')}';\nimport { existsSync,`);
      if (!src.includes('_judge')) throw new Error('注入 10 构造失败：import 锚点没找到，自扫描的守门用例形同虚设');
      const p = join(dir, 'recon-audit-clone.ts');
      writeFileSync(p, src);
      return { audit: p };
    },
  },
];

interface Control { name: string; keyword?: string; mutate: (dir: string) => void }

const controls: Control[] = [
  {
    name: '假大脑（mock:）整局跳过：没有样本≠故障，也≠审过了',
    keyword: '真语料',
    mutate: (dir) => {
      const h = read(dir, 'header.json');
      h.brainId = 'mock:replay';
      write(dir, 'header.json', h);
      const rec = read(dir, 'reconciliation.json');
      rec.brain = 'mock:replay';
      write(dir, 'reconciliation.json', rec);
    },
  },
  {
    name: '同一行 thought 里追加一句不含任何主张的话：判决一条都不许变',
    mutate: (dir) => {
      const rec = read(dir, 'reconciliation.json');
      const rows = rowsOf(dir);
      const row = Number(rec.detail[0].row);
      rows[row].decision.thought = `${String(rows[row].decision.thought)}。这一步继续观察。`;
      dump(dir, rows);
    },
  },
  {
    name: '同一句话原样重复两遍：同形引文出现两处但判决相同 → 落点无所谓，必须放行（注入 8 的另一侧）',
    mutate: (dir) => {
      const rec = read(dir, 'reconciliation.json');
      const rows = rowsOf(dir);
      const row = Number(rec.detail[0].row);
      rows[row].decision.thought = `${String(rows[row].decision.thought)}。${String(rows[row].decision.thought)}`;
      dump(dir, rows);
    },
  },
];

// ─────────────────────────── 跑 ───────────────────────────

let failed = 0;
for (const [i, c] of injections.entries()) {
  const dir = join(work, `case${i}`);
  cpSync(base, dir, { recursive: true });
  let code = 1;
  let out = '';
  try {
    c.mutate(dir);
    const r = runAudit(dir, c.prepare?.(dir) ?? {});
    code = r.code; out = r.out;
  } catch (e) {
    out = `注入本身失败：${(e as Error).message}`;
  }
  const hit = out.includes(c.keyword);
  const caught = code !== 0 && hit;
  console.log(`${caught ? '✅' : '❌'} 注入 ${i + 1}. ${c.name} → 退出码=${code} 关键词「${c.keyword}」${hit ? '命中' : '未命中'}`);
  if (!caught) { failed++; console.log(out.split('\n').filter((l) => l.includes('❌') || l.includes('⚠️') || l.includes('注入本身')).join('\n')); }
}

console.log('');
for (const [i, c] of controls.entries()) {
  const dir = join(work, `control${i}`);
  cpSync(base, dir, { recursive: true });
  try { c.mutate(dir); } catch (e) { console.log(`❌ 反向对照 ${i + 1} 构造失败：${(e as Error).message}`); failed++; continue; }
  const r = runAudit(dir);
  const ok = r.code === 0 && (c.keyword === undefined || r.out.includes(c.keyword));
  console.log(`${ok ? '✅' : '❌'} 反向对照 ${i + 1}. ${c.name} → 退出码=${r.code}（应为 0）`);
  if (!ok) { failed++; console.log(r.out.split('\n').filter((l) => l.includes('❌') || l.includes('⚠️')).join('\n')); }
}

// ─────────────────────────── G1：冻结守卫的咬合力实测 ───────────────────────────

console.log('');
const frozen = reconSha();
if (frozen !== FROZEN_SHA256) {
  console.log(`❌ G0 基线：当前判据 sha 与冻结值不一致——${RECON_VERSION} 到底冻结在哪张表上？先跑 npm run verify:recon:dry`);
  failed++;
}
/**
 * ⚠️ 复原必须用**改前快照**，不许手写"原来的值"：首跑就是败在这一点上——
 *    我以为 RETRO_RULES[0] 是「原来」，实际排在最前的是「第 N 帧」那条，
 *    undo 把表改成了别的东西，sha 一路脏到 G2，红的还是 G1/G2 自己（判据没错，是自检错了）。
 *    这类"测试自己写错"的红如果放过去，下一次就变成"改坏了也能复原"的假绿。
 */
const snapRule = RULES[0]!.source;
const snapRetro = RETRO_RULES[0]!.source;
const snapSymbol = [...SYMBOL_WORDS[0]!];
const bites: [string, () => void, () => void][] = [
  ['改正则源串', () => { RULES[0]!.source = `${snapRule}?`; }, () => { RULES[0]!.source = snapRule; }],
  ['改回溯词表', () => { RETRO_RULES[0]!.source = `${snapRetro}或者`; }, () => { RETRO_RULES[0]!.source = snapRetro; }],
  ['改符号词表', () => { (SYMBOL_WORDS[0] as string[])[1] = '假符号'; }, () => { (SYMBOL_WORDS[0] as string[])[1] = snapSymbol[1]!; }],
];
for (const [name, fire, undo] of bites) {
  fire();
  const after = reconSha();
  undo();
  const ok = after !== frozen && reconSha() === frozen;
  console.log(`${ok ? '✅' : '❌'} G1 ${name} → sha ${after.slice(0, 10)}…（应与冻结值 ${frozen.slice(0, 10)}… 不同，且复原后一致）`);
  if (!ok) failed++;
}
const rest = reconDrift();
console.log(`${rest === null ? '✅' : '❌'} G2 全部复原后漂移检查必须干净（改坏了又改回去，不许留痕）：${rest ?? '无漂移'}`);
if (rest !== null) failed++;

console.log(`\n===== 注入 ${injections.length} 处造假、反向对照 ${controls.length} 组、守卫实测 ${bites.length + 2} 条：漏抓 ${failed} 处 =====`);
process.exit(failed === 0 ? 0 : 1);
