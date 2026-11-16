/**
 * 检出判决审计脚本自身的回归：**证明 detect-audit.ts 抓得住错**（故障 #8 的第三层）。
 *
 * 一套从没拒绝过任何东西的判据，和 print ✅ 没有区别。
 * 所以这里拿干净夹具，逐次注入**一处**已知错误，要求审计同时满足两条：
 *   1. 退出码非 0；
 *   2. 输出里出现**对应那一条判据**的关键词——随便哪里报错都算抓住，等于没验。
 * 任何一处漏抓，本脚本失败。
 *
 * 反向对照同样一条不许少：只会拒绝的判据和只会放过的一样没用。
 *   R1 干净夹具                        → 退出 0
 *   R2 抹掉 detection.json             → 认成版本差异，出声但不算错误，退出 0
 *   R3 全部证据都没有 detection.json    → 必须当**零样本**报错，不许"没东西可验＝通过"
 *   R4 大脑自己说的话里带禁词           → 零泄漏判据不许命中（它扫的是**送给**大脑的文本，不是它说的文本）
 *   R5 一次失败的工具调用（没有屏幕）    → 屏幕重建跳过那一帧，不许算成不一致
 *
 * 用法: node verify/detect-selftest.ts
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HERE = resolve(new URL('.', import.meta.url).pathname);
const AUDIT = join(HERE, 'detect-audit.ts');
const FIXTURE = join(HERE, 'detect-fixture.ts');

const base = execFileSync(process.execPath, [FIXTURE], { encoding: 'utf8' }).trim().split('\n');
console.log(`干净夹具 ${base.length} 局：${base[0]!.replace(/\/[^/]*\/[^/]*$/, '')}…`);

const read = (dir: string, f: string): any => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const write = (dir: string, f: string, v: unknown): void =>
  writeFileSync(join(dir, f), `${JSON.stringify(v, null, 2)}\n`);
const rowsOf = (dir: string): any[] =>
  readFileSync(join(dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const dump = (dir: string, rows: unknown[]): void =>
  writeFileSync(join(dir, 'trace.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

/** 复制夹具的全部局，返回副本目录 */
function cloneSet(tag: string, mutate: (dirs: string[]) => void): string[] {
  const root = mkdemp(tag);
  const copy = base.map((d) => {
    const to = join(root, d.split('/').slice(-2).join('_'));
    cpSync(d, to, { recursive: true });
    return to;
  });
  mutate(copy);
  return copy;
}
function mkdemp(tag: string): string {
  const p = mkdtempSync(join(tmpdir(), `detect-selftest-${tag}-`));
  return p;
}

/** 找一局满足条件的（判决器口径），返回副本根目录里对应的那一份 */
function pick(pred: (dir: string) => boolean): number {
  const i = base.findIndex(pred);
  if (i < 0) throw new Error('夹具里没有满足条件的局，注入用例本身失效');
  return i;
}
const withDetection = (dir: string): any => read(dir, 'detection.json');
const idx = (name: string): number => base.findIndex((d) => d.includes(`/${name}/`));

interface Case { name: string; keyword: string; dirs: string[]; expectFail?: boolean }

const cases: Case[] = [];

// ── 注入 1：把 L1 的首次可见分叉帧改掉 ──
cases.push({
  name: 'L1 首帧被改（说成更早看见）',
  keyword: '[L1 可见分叉]',
  dirs: cloneSet('l1', (ds) => {
    const d = ds[idx('M01_visible_premise_hit')]!;
    const det = withDetection(d);
    det.visible.firstStep = det.visible.firstStep! - 1;
    write(d, 'detection.json', det);
  }),
});

// ── 注入 2：前提判据被翻（把"没自己撞过墙"说成撞过）──
cases.push({
  name: 'L2 前提被翻',
  keyword: '[L2 玩家侧前提]',
  dirs: cloneSet('l2', (ds) => {
    const d = ds[idx('M01_visible_no_premise')]!;
    const det = withDetection(d);
    det.preconditions[0].reached = true;
    det.playerPremise = true;
    det.whyNot = '未上报';
    write(d, 'detection.json', det);
  }),
});

// ── 注入 3：归因集合被换成别的能力 ──
cases.push({
  name: 'L4 归因集合被换',
  keyword: '[L4 归因集合]',
  dirs: cloneSet('l4', (ds) => {
    const d = ds[idx('M01_visible_premise_hit')]!;
    const det = withDetection(d);
    det.claim.caps = ['hpClamp'];
    write(d, 'detection.json', det);
  }),
});

// ── 注入 4：判决被改成归因正确 ──
cases.push({
  name: '判决被改（归因错误 → 归因正确）',
  keyword: '[判决]',
  dirs: cloneSet('verdict', (ds) => {
    const d = ds[idx('M05_wrong_attribution')]!;
    const det = withDetection(d);
    det.verdict = '归因正确';
    det.whyNot = null;
    write(d, 'detection.json', det);
  }),
});

// ── 注入 5：漏斗算术被改（不可检局挤进分母）──
cases.push({
  name: '漏斗被改（不可见局标成可检）',
  keyword: '[漏斗算术]',
  dirs: cloneSet('funnel', (ds) => {
    const d = ds[idx('M06_invisible')]!;
    const det = withDetection(d);
    det.detectable = true;
    det.detected = true;
    write(d, 'detection.json', det);
  }),
});

// ── 注入 6：伪造 agent 所见（屏幕帧文本改一个字符）──
cases.push({
  name: '伪造 agent 实际所见',
  keyword: '[屏幕重建]',
  dirs: cloneSet('screen', (ds) => {
    const d = ds[idx('M01_visible_premise_hit')]!;
    const rows = rowsOf(d);
    const r = rows.find((x) => x.decision && x.result?.ok === true && String(x.result.output).includes('+--------'));
    r.result.output = String(r.result.output).replace('HP [', 'HP【');
    dump(d, rows);
  }),
});

// ── 注入 7：把作者侧答案喂给大脑 ──
cases.push({
  name: '答案泄漏进送给大脑的文本',
  keyword: '[零泄漏]',
  dirs: cloneSet('leak', (ds) => {
    const d = ds[idx('M01_visible_premise_hit')]!;
    const rows = rowsOf(d);
    const r = rows.find((x) => x.decision && x.result?.ok === true && String(x.result.output).includes('+--------'));
    // 模拟 harness 手滑把变异体 id 念了出来：只改事件文本，不动屏幕，
    // 免得这条注入顺带触发屏幕重建那条，看不出是谁抓住的
    rows.push({ kind: 'prediction_feedback', at: r.at, payload: { aboutStep: r.index, text: '顺带说一句，这局是 M01 变异体，被删能力 wallBlocks。' } });
    dump(d, rows);
  }),
});

// ── 注入 8：覆盖账本被改（引擎实时那侧）──
cases.push({
  name: '覆盖账本被改',
  keyword: '[覆盖账本]',
  dirs: cloneSet('ledger', (ds) => {
    const d = ds[idx('M01_visible_premise_hit')]!;
    const def = read(d, 'defect.json');
    def.coverage.wallAttempts = def.coverage.wallAttempts + 3;
    write(d, 'defect.json', def);
  }),
});

// ── 注入 9：判决口径版本号是旧版 ──
cases.push({
  name: '判决口径版本号漂移',
  keyword: '[判决口径]',
  dirs: cloneSet('version', (ds) => {
    const d = ds[idx('M01_visible_premise_hit')]!;
    const det = withDetection(d);
    det.judgementVersion = 'm4f-0+lex-m4f-0';
    write(d, 'detection.json', det);
  }),
});

// ── 注入 9b：开局戳被局末补写（header.judgement 与 detection 的口径不再同源）──
// 这一条专门验 [口径落盘]：把 header 的戳改成旧版，detection 里的版本号不动。
// 它证明戳不是"跟着判决一起写的"——判决侧的戳即使正确也救不了 header 被改的局。
cases.push({
  name: '开局口径戳被局末改写',
  keyword: '[口径落盘]',
  dirs: cloneSet('stamp', (ds) => {
    const d = ds[idx('M01_visible_premise_hit')]!;
    const h = read(d, 'header.json');
    h.judgement = { detector: 'm4f-0', lexicon: 'm4f-0', sha: '0000000000000000000000000000000000000000000000000000000000000000' };
    write(d, 'header.json', h);
  }),
});

// ── 注入 9c：开局戳整块消失（有 detection 却没有戳 = 有人把 header 删干净冒充旧版）──
cases.push({
  name: '开局口径戳整块缺失',
  keyword: '[口径落盘]',
  dirs: cloneSet('nostamp', (ds) => {
    const d = ds[idx('M01_visible_premise_hit')]!;
    const h = read(d, 'header.json');
    delete h.judgement;
    write(d, 'header.json', h);
  }),
});// ── 注入 10：主观文本被换（原文一句没异常，改成有异常）──
cases.push({
  name: '主观文本被换',
  keyword: '[L3 上报]',
  dirs: cloneSet('claims', (ds) => {
    const d = ds[idx('M07_not_reported')]!;
    const def = read(d, 'defect.json');
    def.agentClaims.notes[0] = '血量掉得不对，接触伤害像是失效了。';
    write(d, 'defect.json', def);
  }),
});

// ── 注入 11：预登记上限表被改（把不可见说成可见）──
{
  const root = mkdemp('ceiling');
  const dir = join(root, 'ceil');
  mkdirSync(dir, { recursive: true });
  const lines = readFileSync(join(process.cwd(), 'runs/m4f-ceiling/ceiling_cases.jsonl'), 'utf8').split('\n').filter(Boolean);
  const out = lines.map((l) => {
    const r = JSON.parse(l);
    if (r.visible === false) { r.visible = true; r.firstVisibleStep = 2; return JSON.stringify(r); }
    return l;
  });
  writeFileSync(join(dir, 'ceiling_cases.jsonl'), out.join('\n') + '\n');
  cases.push({
    name: '预登记上限表造假',
    keyword: '[上限表]',
    // 这条不验 run 目录，只验上限表：run 目录用干净夹具，别让别的判据抢了话头
    dirs: [...cloneSet('ceil-clean', () => {}), '--ceiling', dir, '--ceiling-check', '300'],
  });
}

// ── 反向对照 ──
const controls: Case[] = [
  { name: 'R1 干净夹具', keyword: '', dirs: cloneSet('r1', () => {}) },
  {
    name: 'R2 抹掉一局 detection.json → 版本差异，放行',
    keyword: '版本差异',
    dirs: cloneSet('r2', (ds) => { rmSync(join(ds[0]!, 'detection.json')); }),
  },
  {
    name: 'R4 大脑自己说漏嘴（它的原话里有禁词）→ 不算泄漏',
    keyword: '',
    dirs: cloneSet('r4', (ds) => {
      const d = ds[idx('M01_visible_premise_hit')]!;
      const rows = rowsOf(d);
      const r = rows.find((x) => x.decision);
      r.decision.thought = '我在想这大概是 M01 变异体，被删能力 wallBlocks 吧。';
      dump(d, rows);
    }),
  },
  {
    name: 'R5 一次被工具层拒掉的调用（没屏幕、没推进世界）→ 跳过该帧，不误报',
    keyword: '',
    dirs: cloneSet('r5', (ds) => {
      const d = ds[idx('M01_visible_premise_hit')]!;
      const rows = rowsOf(d);
      // 关键：**新加**一步失败调用，而不是把已执行的那格改成失败。
      // 被拒的调用从来不进 fullWorldActions，也不翻页，所以帧序配对不受影响；
      // 反过来改已有那格就是两份证物互相矛盾，那是注入用例（上面第 13 条），不是对照。
      const last = rows.filter((x) => x.decision).at(-1)!;
      rows.push({
        index: last.index + 1, at: last.at,
        decision: { thought: '夹具对照：走一个不存在的方向', call: { name: 'move', args: { dir: 'sideways' } } },
        result: { ok: false, output: '方向 "sideways" 不认识。只能用 up / right / down / left 这四个词。' },
        stateHash: last.stateHash, contextChars: last.contextChars, brainMs: 1, toolMs: 0,
      });
      dump(d, rows);
    }),
  },
];

// ── 注入 12（R3 的反面）：全部局都没有 detection.json → 零样本必须出声 ──
cases.push({
  name: 'R3 全部证据都是旧版（零样本审计）',
  keyword: '[样本]',
  dirs: cloneSet('r3', (ds) => { for (const d of ds) rmSync(join(d, 'detection.json'), { force: true }); }),
});

// ── 注入 13：把一格"已成功执行并推进了世界"的动作改成失败 ──
// 这一条是首跑 R5 失败时捡出来的：证据自己矛盾了（trace 说没执行，defect 说执行了），
// 而审计当时只会顺着错位把后面 24 帧全报成不一致——报对了结局、说错了原因。
// 现在先对账动作数，矛盾当场出声，且说的是"哪两份证物对不上"。
cases.push({
  name: 'trace 与动作序列矛盾（已执行的一格被说成失败）',
  keyword: '[证据对齐]',
  dirs: cloneSet('misalign', (ds) => {
    const d = ds[idx('M01_visible_premise_hit')]!;
    const rows = rowsOf(d);
    const r = rows.find((x) => x.decision && x.result?.ok === true && String(x.result.output).includes('+--------'));
    r.result = { ok: false, output: '方向 "sideways" 不认识。只能用 up / right / down / left 这四个词。' };
    dump(d, rows);
  }),
});

function runAudit(dirs: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [AUDIT, ...dirs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

let failed = 0;
console.log('\n── 注入用例：每处都必须被对应的判据抓住 ──');
for (const c of cases) {
  const { code, out } = runAudit(c.dirs);
  const caught = code !== 0 && (c.keyword === '' || out.includes(c.keyword));
  if (!caught) {
    failed++;
    console.log(`  ❌ ${c.name}：退出码=${code}，输出含「${c.keyword}」=${out.includes(c.keyword)}`);
    console.log(out.split('\n').filter((l) => l.includes('❌')).slice(0, 4).map((l) => `      ${l}`).join('\n'));
  } else console.log(`  ✅ ${c.name} → 退出 ${code}，抓到于 ${c.keyword}`);
}

console.log('\n── 反向对照：这些都必须被放行 ──');
for (const c of controls) {
  const { code, out } = runAudit(c.dirs);
  const shown = c.keyword === '' || out.includes(c.keyword);
  if (code !== 0 || !shown) {
    failed++;
    console.log(`  ❌ ${c.name}：退出码=${code}${c.keyword ? `，输出含「${c.keyword}」=${out.includes(c.keyword)}` : ''}`);
    console.log(out.split('\n').filter((l) => l.includes('❌')).slice(0, 4).map((l) => `      ${l}`).join('\n'));
  } else console.log(`  ✅ ${c.name} → 退出 0${c.keyword ? `，并按预期说了「${c.keyword}」` : ''}`);
}

console.log(`\n===== detect-audit 自检：${cases.length + controls.length} 例，失败 ${failed} 例 =====`);
if (failed) console.log('审计抓不住错，就等于没有审计——先修审计再谈检出率。');
process.exit(failed > 0 ? 1 : 0);
