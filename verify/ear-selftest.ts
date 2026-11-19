/**
 * M4-c 眼耳对账**判决器自检**：证明 `verify/ear-audit.ts` 抓得住错（三件套的第三只脚）。
 *
 * 一套从没拒绝过任何东西的判据，和 print ✅ 没有区别；反过来，一套什么都拒绝的判据
 * 也等于没判——所以两头都要验：
 *   - **注入用例**：拿干净夹具，每次**只改一处**证据／落盘／声明，要求审计同时满足三条：
 *       1. 退出码非 0；
 *       2. 输出里出现**对应那一条判据**的话（随便报个错等于没报——必须点出是哪一帧、
 *          哪一族、哪一侧、落哪个桶变了，或者哪一句声明不成立）；
 *       3. 被抓的**只有该抓的那一格**（别处不许跟着红：一处改动闹出满屏红，
 *          说明比对根本没有分清是谁的账）。
 *   - **反向对照**：干净全量必须退出 0；**删掉一格有缺陷证据**也必须退出 0
 *     （少一格不是判据坏，覆盖率闸门才是管这个的）；只留阴性对照那一批必须红
 *     （五桶落不齐 = 零样本比对）。
 *
 * 注入面按"谁可能被改"分四类，一类都不许空：
 *   A 耳朵证据（删一声 / 改数字 / 挪一帧 / 只改帧内 heard）
 *   B 屏幕证据（改文本不改指纹 / 改文本并补指纹 / 改帧号）
 *   C 三方账本（改 want / 改 got / 删一条 got / 落一条表外判决）
 *   D 声明与口径（provenance / rig 标签 / 判据版本 / 越界计数 / 阴性对照名单）
 *
 * 用法: node verify/ear-selftest.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HERE = resolve(new URL('.', import.meta.url).pathname);
const AUDIT = join(HERE, 'ear-audit.ts');
const FIXTURE = join(HERE, 'ear-fixture.ts');

const sha12 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

type Any = Record<string, any>;

// ─────────────────── 干净夹具只生成一次 ───────────────────

const cleanDir = mkdtempSync(join(tmpdir(), 'ear-selftest-clean-'));
const cleanFile = join(cleanDir, 'ear_cases.json');
execFileSync(process.execPath, [FIXTURE, cleanFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const clean = JSON.parse(readFileSync(cleanFile, 'utf8')) as Any;
console.log(`干净夹具：${clean.cases.length} 格｜阴性对照 ${clean.negative.length} 格（由判据落盘的判决现场算出）`);

const clone = (): Any => JSON.parse(JSON.stringify(clean));
const put = (tag: string, doc: Any): string => {
  const dir = mkdtempSync(join(tmpdir(), `ear-selftest-${tag}-`));
  const file = join(dir, 'ear_cases.json');
  writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`);
  return file;
};
const one = (doc: Any, id: string): Any => {
  const c = (doc.cases as Any[]).find((x) => x.id === id);
  if (!c) throw new Error(`夹具里没有 ${id} 这一格，注入用例本身失效`);
  return c;
};
/** 改过总声流之后把逐帧 heard 一起同步——不然同时踩中两条判据，就测不出这一条的牙了。 */
const rebuildHeard = (c: Any): void => {
  for (const f of c.frames) {
    f.heard = c.sounds.filter((s: Any) => s.tick === f.tick)
      .slice().sort((x: Any, y: Any) => x.seq - y.seq)
      .map((s: Any) => ({ seq: s.seq, text: s.text }));
  }
};
/** 改屏幕：默认连指纹一起补（模拟"改得干干净净"），只有不补的那一条测的是指纹判据。 */
const editScreen = (c: Any, tick: number, edit: (s: string) => string, forgeSha = true): void => {
  const f = c.frames.find((x: Any) => x.tick === tick);
  f.screen = edit(f.screen);
  if (forgeSha) f.sha = sha12(f.screen);
};
const dropCase = (doc: Any, keep: string[] | null, kill: string[] = []): Any => {
  doc.cases = (doc.cases as Any[]).filter((c) => (keep ? keep.includes(c.id) : !kill.includes(c.id)));
  if (Array.isArray(doc.negative)) doc.negative = doc.negative.filter((x: string) => doc.cases.some((c: Any) => c.id === x));
  return doc;
};

// ─────────────────── 注入用例 ───────────────────

interface T {
  name: string;
  /** 必须在输出里出现的那句话（点得出"哪一条判据抓住了"，随便报错不算） */
  keyword: string;
  file: string;
  /** 只许这些格子被点名（一处改动闹出满屏红＝比对没分清谁的账） */
  cases: string[];
  /** 整段输出里不许出现的话（证明没有把 A 读成 B） */
  mustNot?: string[];
  /** 某一格的逐条日志行里不许出现某个桶（证明闸门真的拦住了） */
  lineMustNot?: [string, string];
}

const inject: T[] = [];
const add = (
  name: string, keyword: string, tag: string, cases: string[],
  mutate: (doc: Any) => void, extra: { mustNot?: string[]; lineMustNot?: [string, string] } = {},
): void => { inject.push({ name, keyword, cases, file: put(tag, mutate2(mutate)), ...extra }); };
/** 小糖：mutate 改的是深拷贝，返回它。 */
function mutate2(fn: (doc: Any) => void): Any { const d = clone(); fn(d); return d; }

// ── A 耳朵证据 ──
add('A1 删掉一声脚步（E04 第 2 帧）', 'footstep[眼]→矛盾 审计=1 判据=0', 'a1', ['E04'], (doc) => {
  const c = one(doc, 'E04');
  c.sounds = c.sounds.filter((s: Any) => !(s.tick === 2 && s.text.includes('脚步')));
  rebuildHeard(c);
});
add('A2 把窸窣的数字说小（3 处 → 1 处，屏幕下界是 3）', 'shuffle[眼]→矛盾 审计=1 判据=0', 'a2', ['E04'], (doc) => {
  const c = one(doc, 'E04');
  for (const s of c.sounds) if (s.tick === 1 && s.text.includes('窸窣')) s.text = '远处有 1 处窸窣。';
  rebuildHeard(c);
});
add('A3 只挪一声脚步晚一帧（不许被读成整族时钟错位）', 'footstep[耳]→矛盾 审计=1 判据=0', 'a3', ['E04'], (doc) => {
  const c = one(doc, 'E04');
  for (const s of c.sounds) if (s.tick === 2 && s.text.includes('脚步')) s.tick = 3;
  rebuildHeard(c);
}, { lineMustNot: ['E04', '时钟错位'] });
add('A4 只改帧内 heard、不改总声流（两份耳朵证据各说各话）', '帧内 heard 与声流对不上', 'a4', ['E02'], (doc) => {
  const c = one(doc, 'E02');
  c.frames.find((f: Any) => f.tick === 2).heard.push({ seq: 9, text: '一声脚步。' });
});

// ── B 屏幕证据 ──
add('B1 改屏幕不补指纹', '屏幕指纹不符', 'b1', ['E02'], (doc) => {
  editScreen(one(doc, 'E02'), 2, (s) => s.replace(' 10/10 ', ' 9/10 '), false);
});
add('B2 改屏幕且把指纹补圆（只能靠眼侧事实抓住）', 'hurtGrunt[眼]→矛盾 审计=1 判据=0', 'b2', ['E02'], (doc) => {
  editScreen(one(doc, 'E02'), 2, (s) => s.replace(' 10/10 ', ' 9/10 '));
});
add('B3 改屏幕上的帧号（逐帧对账的地基被抽掉）', '屏幕帧号与账本错位', 'b3', ['E04'], (doc) => {
  editScreen(one(doc, 'E04'), 2, (s) => s.replace('第 2 帧', '第 7 帧'));
});

// ── C 三方账本 ──
add('C1 改人工期望（want 少一条）', '审计重算 ≠ 人工期望', 'c1', ['E02'], (doc) => {
  const w = one(doc, 'E02').want.find((x: Any) => x.key === 'shuffle' && x.bucket === '相符');
  w.n -= 1;
}, { mustNot: ['审计重算 ≠ 判据落盘'] });
add('C2 改判据落盘（一条相符翻成矛盾）', '审计重算 ≠ 判据落盘', 'c2', ['E02'], (doc) => {
  const c = one(doc, 'E02');
  const row = c.got.find((x: Any) => x.key === 'shuffle' && x.verdict === '相符' && x.side === '眼');
  row.verdict = '矛盾';
}, { mustNot: ['审计重算 ≠ 人工期望'] });
add('C3 删掉一条落盘主张（恒等式当场断裂）', '恒等式断裂', 'c3', ['E02'], (doc) => {
  one(doc, 'E02').got.pop();
});
add('C4 落一条表外判决', '表外判决', 'c4', ['E02'], (doc) => {
  one(doc, 'E02').got[0].verdict = '约定存疑';
});

// ── D 声明与口径 ──
add('D1 夹具冒充真证据（provenance 改成 real）', '不是 fixture', 'd1', ['E02'], (doc) => {
  one(doc, 'E02').provenance = 'real（真模型跑的）';
});
add('D2 把 S01（脚步丢失）的 rig 标签改成 R0', 'rig 标签与证据不符', 'd2', [], (doc) => {
  one(doc, 'E08').rig.id = 'R0';
});
add('D3 同一世界的两格屏幕被改成不一样（rig 动了世界）', '两格屏幕不一样', 'd3', ['E19'], (doc) => {
  editScreen(one(doc, 'E19'), 2, (s) => s.replace(' 10/10 ', ' 9/10 '));
});
add('D4 判据版本号被改（老证据会被新口径悄悄改判）', '判据版本对不上', 'd4', [], (doc) => {
  doc.ear.ear = 'm4c-9';
});
add('D5 越界声音计数落盘造假', '越界声音条数', 'd5', ['E06'], (doc) => {
  one(doc, 'E06').consistency.soundsBeyondScreen = 0;
});
add('D6 顶层阴性对照名单整块缺失', '没带顶层 negative 名单', 'd6', [], (doc) => {
  delete doc.negative;
});
add('D7 把有毛病的那格塞进阴性对照名单（名单与判决对不上）', '阴性对照名单不一致', 'd7', [], (doc) => {
  doc.negative = [...(doc.negative as string[]), 'E08'];
});
add('D8 只留一格（零样本比对＝没比）', '零样本比对', 'd8', [], (doc) => {
  dropCase(doc, ['E01']);
});

// ─────────────────── 反向对照 ───────────────────

interface R { name: string; file: string; keyword: string }
const control: R[] = [
  { name: 'R1 干净夹具全量', file: cleanFile, keyword: '三方一致（人工期望＝独立重算＝判据落盘）' },
  {
    // 少一格**有缺陷**的证据不是判据坏：覆盖率闸门才管"少不少"（R3 就是那一面）。
    // 这一条拦的是"审计恒红"——恒红的审计和恒绿的审计一样没用。
    name: 'R2 删掉一格误报证据（E05）→ 其余照旧放行',
    file: put('r2', mutate2((doc) => { dropCase(doc, null, ['E05']); })),
    keyword: '三方一致（人工期望＝独立重算＝判据落盘）',
  },
  {
    name: 'R3 只留阴性对照那一批 → 必须当零样本红',
    file: put('r3', mutate2((doc) => { dropCase(doc, (clean.negative as string[])); })),
    keyword: '',
  },
];

// ─────────────────── 跑 ───────────────────

function runAudit(file: string): { code: number; out: string } {
  // 用 spawnSync 而不是 execFileSync：审计的话**全在 stderr**（stdout 只留给出路径的约定），
  // execFileSync 成功时只回 stdout——首跑就是栽在这儿：R1/R2 退出 0 却"看不见"✅ 那行。
  const r = spawnSync(process.execPath, [AUDIT, file], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 被点名的格子：失败明细行是 `   E04：…`（三格缩进 + 冒号），逐格日志行是 `  E04  …`，两者不会混。 */
const flagged = (out: string): string[] =>
  [...new Set([...out.matchAll(/^ {3}(E\d+)：/gm)].map((m) => m[1]))].sort();
const caseLine = (out: string, id: string): string =>
  out.split('\n').find((l) => l.startsWith(`  ${id} `)) ?? '';

let failed = 0;
console.log('\n── 注入用例：每处都必须被对应的判据抓住，且只抓住该抓的那一格 ──');
for (const t of inject) {
  const { code, out } = runAudit(t.file);
  const hit = out.includes(t.keyword);
  const who = flagged(out);
  const problems: string[] = [];
  if (code === 0) problems.push('退出码 0（没抓住）');
  if (!hit) problems.push(`输出里没有「${t.keyword}」`);
  if (who.join() !== [...t.cases].sort().join()) problems.push(`点名的格子是 ${who.join('、') || '（无）'}，预期只有 ${t.cases.join('、') || '（无）'}`);
  for (const m of t.mustNot ?? []) if (out.includes(m)) problems.push(`还冒出了不该出现的话「${m}」`);
  if (t.lineMustNot) {
    const [id, word] = t.lineMustNot;
    if (caseLine(out, id).includes(word)) problems.push(`${id} 那一行的落点里出现了「${word}」（闸门没拦住）`);
  }
  if (problems.length) {
    failed++;
    console.log(`  ❌ ${t.name}：${problems.join('；')}`);
    console.log(out.split('\n').filter((l) => l.includes('❌') || l.includes('↳')).slice(0, 6).map((l) => `      ${l}`).join('\n'));
  } else console.log(`  ✅ ${t.name} → 退出 ${code}，抓到于「${t.keyword}」`);
}

console.log('\n── 反向对照：这些都必须按预期放行／拦下 ──');
for (const c of control) {
  const { code, out } = runAudit(c.file);
  const wantRed = c.name.startsWith('R3');
  const shown = c.keyword === '' || out.includes(c.keyword);
  const ok = wantRed ? (code !== 0 && out.includes('落进这些桶')) : (code === 0 && shown);
  if (!ok) {
    failed++;
    console.log(`  ❌ ${c.name}：退出码=${code}${c.keyword ? `，含「${c.keyword}」=${shown}` : ''}`);
    console.log(out.split('\n').filter((l) => l.includes('❌')).slice(0, 6).map((l) => `      ${l}`).join('\n'));
  } else {
    console.log(`  ✅ ${c.name} → 退出 ${code}${wantRed ? '，并如实说"落不齐五桶"' : `，说了「${c.keyword}」`}`);
  }
}

console.log(`\n===== ear-audit 自检：${inject.length} 处注入 + ${control.length} 条反向对照，失败 ${failed} 处 =====`);
if (failed) console.log('审计抓不住错，就等于没有审计——先修审计，再谈"眼耳对账通过了多少格"。');
process.exit(failed > 0 ? 1 : 0);
