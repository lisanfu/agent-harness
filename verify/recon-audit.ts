/**
 * M4-d 独立审计：**不 import 判据**，只吃证据文件，自己把每条主张重判一遍。
 *
 * 为什么要第三只脚（台账 #14：两个通道不许各信一份）：
 *   test/reconcile.test.ts 验判据本体，verify/recon.ts 出数——两边都走 reconcile.ts 同一段代码。
 *   判据本身错了，两处一起"绿"，那是最难查的一种自洽。
 *   这一份把判决逻辑**重写一遍**：自己的读数字、自己的符号表、自己的极性表、
 *   自己的双读法与图层规则、自己的锚点选择，然后要求它与落盘判决逐条一致。
 *   不一致就红——并且不许"取平均"：要么判据错，要么审计错，只能人对着屏幕把那一条读一遍。
 *
 * 允许 import 的只有 observe.ts（眼睛：屏幕文本→观测量，M4-a 起就被四条独立通道共用并各自复核过）。
 * 禁止：reconcile.ts（判据本体）、arena.ts / WorldState（内部状态）。文件末尾有自扫描守着这句。
 *
 * 用法:
 *   node verify/recon-audit.ts <cases.json>                 # 只审夹具（三方对照）
 *   node verify/recon-audit.ts <cases.json> --corpus         # 夹具 + 全部已落盘的真语料
 *   node verify/recon-audit.ts <cases.json> --corpus --runs runs/<a> runs/<b>
 *   <cases.json> 由 node verify/recon-fixture.ts 生成（它的 stdout 就是路径）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { observe, type Observation } from '../src/world/observe.ts';

const log = (l: string): void => void process.stderr.write(`${l}\n`);

type Verdict = '相符' | '矛盾' | '约定存疑' | '无法核对';
type Entry = {
  kind: string; quote: string; verdict: Verdict;
  value?: number[]; polarity?: string; symbol?: string | null;
  retro?: boolean; retroWord?: string; retroTick?: number | null; anchorTick?: number | null;
  row?: number; tick?: number | null; at?: number;
  screenSha?: string | null; clause?: string;
};

// ─────────────────────────── 审计侧自己的一套词表 ───────────────────────────

/**
 * 回溯线索（m4d-5 升格成**表**：光认出"这是回溯句"不够，还得问它说的是哪一帧）。
 * 与判据表**各自维护**：判据用 String.raw 存正则源串，这里用自己的 RegExp 对象——
 * 同一个坑要掉两次才算真的踩过（#24 那次的教训就是转义形状）。
 * ⚠️ 与判据同意的立场：「刚才/刚刚」不算回溯（锚点就是它说话时看到的那一帧）。
 */
const MY_RETRO_UNKNOWN = ['原来', '先前', '之前', '上一帧', '前一帧', '曾经', '原本', '早先', '那时', '当时',
  '此前', '上一步', '上一次'];
const MY_RETRO_FIRST = ['初始', '开局', '一开始', '开始时', '最初'];
const MY_RETRO_FRAME = /第\s*(\d+)\s*帧/;   // 捕获组自己写，不复用判据那个源串

/**
 * 分隔符表（审计侧独立写一份，**带捕获组**给 split 用）。
 * ⚠️ 两边都得含半角「.」——归一化把「。」换成了「.」，只列全角那一套就静默漏掉整类句号
 * （#27 首跑红在这儿：两张表各说各话，判据那边同样挨了这一刀）。
 */
const MY_DELIM_KEEP = /([,.:;!?\n]+)/;
/** 括号内部不作分隔：坐标字面自己就带逗号 */
const MY_BRACKET = /\([^\)]*\)|\[[^\]]*\]/g;

/**
 * 审计侧的归一化。与判据那张 25 对映射表**故意不同形**：这里只列全角 ASCII 区之外的
 * 那几个标点（、。「　」），其余整块平移——两条路走到同一个结论才算独立复核（#14）。
 * ⚠️ 必须**等长**：子句范围按引文下标定位，改长度就全错位（#13 家族）。
 */
const MY_ODD_PUNCT: readonly [string, string][] = [
  // 只列**不在**全角 ASCII 区（U+FF01–FF5E）的那几个：它们整块平移够不着，必须点名
  ['、', ','], ['。', '.'], ['【', '('], ['】', ')'], ['　', ' '],
  ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
];
const myNorm = (s: string): string => {
  let out = '';
  for (const ch of s) {
    const p = MY_ODD_PUNCT.find(([f]) => f === ch);
    if (p !== undefined) { out += p[1]; continue; }
    const cp = ch.charCodeAt(0);
    out += cp >= 0xff01 && cp <= 0xff5e ? String.fromCharCode(cp - 0xfee0) : ch;
  }
  return out.toLowerCase();
};

/**
 * 审计侧的子句范围。刻意**打码 + split**（判据那边是逐字符索引扫描）：
 * 同一个结论要两条不同的路走到，才算独立复核（台账 #14）——
 * 两边都用索引扫描的话，一处 off-by-one 会一起犯，那就不是复核而是复印。
 * 做法：只把括号**内部的分隔符**换成等长的「·」（坐标字面里的逗号再也不会当分隔符），
 * 再把同一个文本按分隔符切开，找出引文落在哪一段，最后按需并入冒号引导句。
 * 引文在归一化文本里找不到时退回**整句**——宁可多算回溯（不判），也不许少算（判错）。
 *
 * ⚠️ 打码**只许打分隔符**，不许把整段括号抹成点（m4d-5 首跑就错在这儿）：
 *   - 整段抹平后 `E在(5,0)` 与 `E在(2,0)` 都成了 `E在·····`，`indexOf` 命中**第一个**
 *     ——引文被安到别的半句上，回溯词跟着错位（分歧 3）；
 *   - 抹平还吃掉了括号里**真的**分隔符之外的字，引文原样查不到，退回整句，
 *     于是远处另一句话里的「最初/之前」漏进范围（分歧 1、2）。
 *   留字打点（只换标点）两条都不会发生，且依然等长（#13 家族）。
 *
 * 返回的是**去重后的所有候选子句**：同形引文在一行里出现多次且落点不同 → 数组长度 >1，
 * 上层据此报"定位不了"（结构性失败），绝不许悄悄取第一个。
 */
function myScopesOf(thought: string, quote: string): string[] {
  const mask = (s: string): string => s.replace(MY_BRACKET, (m) => m.replace(/[,.:;!?\n]/g, '·'));
  const t = mask(myNorm(thought));
  const q = mask(myNorm(quote));
  const hits: number[] = [];
  for (let i = q.length > 0 ? t.indexOf(q) : -1; i >= 0; i = t.indexOf(q, i + 1)) hits.push(i);
  if (hits.length === 0) return [t];
  const parts = t.split(MY_DELIM_KEEP);
  const scopeAt = (at: number): string => {
    let pos = 0;
    let idx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) { pos += parts[i]!.length; continue; }   // 奇数位是分隔符本身，不计入段
      if (at >= pos && at <= pos + parts[i]!.length) { idx = i; break; }
      pos += parts[i]!.length;
    }
    if (idx < 0) return t;
    let scope = parts[idx]!;
    // 冒号引导句并入：紧邻的那串分隔符**正好以冒号结尾**才并，句号逗号不并（那是另一句话）
    while (idx >= 2 && parts[idx - 1]!.endsWith(':')) {
      scope = parts[idx - 2]! + parts[idx - 1]! + scope;
      idx -= 2;
      if (idx < 0) break;
    }
    return scope;
  };
  return [...new Set(hits.map(scopeAt))];
}

/** 审计自己的回溯判决：retroTick = 这句话指哪一帧（null＝子句里读不出来） */
function myRetro(scope: string): { retro: boolean; tick: number | null } {
  const u = MY_RETRO_UNKNOWN.find((w) => scope.includes(w));
  if (u !== undefined) return { retro: true, tick: null };
  const fm = MY_RETRO_FRAME.exec(scope);
  if (fm !== null && fm[1] !== undefined) return { retro: true, tick: Number(fm[1]) };
  const f = MY_RETRO_FIRST.find((w) => scope.includes(w));
  if (f !== undefined) return { retro: true, tick: 0 };
  return { retro: false, tick: null };
}

/** 符号表（自己写：长词在前，取片段里**最后**出现的那个） */
const MY_SYMBOLS: [string, string][] = [
  ['可拾取物', '+'], ['拾取物', '+'], ['障碍物', '#'], ['物品', '+'], ['怪物', 'E'], ['敌人', 'E'],
  ['空地', '.'], ['空格', '.'], ['墙', '#'], ['敌', 'E'], ['怪', 'E'],
  ['#', '#'], ['E', 'E'], ['+', '+'], ['.', '.'], ['@', '@'],
];

/** 极性：肯定/否定两张表**合并**按词长从长到短消耗文本，命中即划掉——短词不吃进长词内部。 */
const MY_POS = ['没有死', '没死', '未死', '不会死', '没有倒下', '没倒下', '未倒下', '不会倒',
  '活着', '存活', '就绪', '准备好', '有', '踩着'];
const MY_NEG = ['被击败', '已死', '阵亡', '死亡', '死了', '死过', '倒下', '死',
  '没就绪', '没准备好', '不就绪', '未就绪', '还在冷却', '在冷却', '冷却中',
  '没有', '不是', '不在', '不见', '没', '无', '不'];

function myPolarity(q: string): 'pos' | 'neg' | 'both' | 'none' {
  let rest = q;
  let seenPos = false, seenNeg = false;
  const all = [...MY_POS.map((w) => [w, 'p'] as const), ...MY_NEG.map((w) => [w, 'n'] as const)]
    .sort((a, b) => b[0].length - a[0].length);
  for (const [w, p] of all) {
    if (!rest.includes(w)) continue;
    if (p === 'p') seenPos = true; else seenNeg = true;
    rest = rest.split(w).join('·');
  }
  if (seenPos && seenNeg) return 'both';
  if (seenPos) return 'pos';
  if (seenNeg) return 'neg';
  return 'none';
}

const halfwidth = (s: string): string => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
/** 从片段里取坐标对——审计自己写，不用判据的 PAIR */
function pairOf(q: string): [number, number] | null {
  const m = /[\[(（［【]\s*(\d{1,2})\s*[，,]\s*(\d{1,2})\s*[\])）］】]/.exec(halfwidth(q));
  return m ? [Number(m[1]), Number(m[2])] : null;
}
const numsOf = (q: string): number[] => [...halfwidth(q).matchAll(/(\d{1,3})/g)].map((m) => Number(m[1]));
const fracOf = (q: string): [number, number] | null => {
  const m = /(\d{1,3})\s*[/／]\s*(\d{1,3})/.exec(halfwidth(q));
  return m ? [Number(m[1]), Number(m[2])] : null;
};
function mySymbol(q: string): string | null {
  let best: { i: number; s: string } | null = null;
  for (const [w, s] of MY_SYMBOLS) {
    const i = q.lastIndexOf(w);
    if (i >= 0 && (!best || i > best.i)) best = { i, s };
  }
  return best?.s ?? null;
}
/** 图层顺序自己写：墙 < 物品 < 敌人 < 玩家（与 render 的画法同，但代码是另一份） */
function myCell(o: Observation, x: number, y: number): string | null {
  if (o.size === null || x < 0 || y < 0 || x >= o.size || y >= o.size) return null;
  if (o.player && o.player[0] === x && o.player[1] === y) return '@';
  if (o.enemies.some(([a, b]) => a === x && b === y)) return 'E';
  if (o.pickups.some(([a, b]) => a === x && b === y)) return '+';
  if (o.walls.some(([a, b]) => a === x && b === y)) return '#';
  return '.';
}
const xyOrYX = (a: number, b: number, p: [number, number] | null): 'xy' | 'yx' | 'no' =>
  p === null ? 'no' : (p[0] === a && p[1] === b) ? 'xy' : (p[0] === b && p[1] === a) ? 'yx' : 'no';

const sha12 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

/**
 * 审计独立重判。
 * ⚠️ 同形引文（一句话里两处 `[1,0]`）的定位问题在这里处理，**不在**上层"取第一个"：
 *   把每个候选子句各判一遍，判决全相同 → 落点无所谓，一致；
 *   判决不同 → 这一条确实定位不了，红，人对着屏幕读那一句（台账 #14：宁可红，不许假装一致）。
 */
function rejudge(e: Entry, o: Observation | null, thought: string): { verdict: Verdict; note: string; amb?: boolean } {
  if (o === null) return { verdict: '无法核对', note: '这一步之前没有屏幕' };
  const each = myScopesOf(thought, e.quote).map((s) => rejudgeScope(e, o, s));
  const uniq = [...new Map(each.map((x) => [x.verdict, x])).values()];
  if (uniq.length > 1)
    return {
      verdict: uniq[0]!.verdict, amb: true,
      note: `本行有 ${each.length} 处同形引文、子句不同，判出来是 ${uniq.map((x) => `${x.verdict}（${x.note}）`).join(' / ')} —— 落点不定`,
    };
  return each[0]!;
}

/** 一条落盘判决 + 那一帧屏幕 + **引文所在的子句** → 审计独立重判（不含范围切分） */
function rejudgeScope(e: Entry, o: Observation, scope: string): { verdict: Verdict; note: string } {
  // 帧号归位到锚点帧就不算回溯（与判据同一立场，另一套写法）
  const r = myRetro(scope);
  if (r.retro && !(r.tick !== null && o.tick === r.tick)) {
    return r.tick === null
      ? { verdict: '无法核对', note: '审计也认它是回溯句，且帧号读不出' }
      : { verdict: '无法核对', note: `审计归位到第 ${r.tick} 帧，锚点是第 ${String(o.tick)} 帧` };
  }

  switch (e.kind) {
    case 'playerPos':
    case 'movedTo': {
      const pr = pairOf(e.quote); if (!pr) return { verdict: '无法核对', note: '审计读不出坐标' };
      const [a, b] = pr;
      if (o.size === null) return { verdict: '无法核对', note: '无网格' };
      if (a >= o.size || b >= o.size) return { verdict: '矛盾', note: `越界，网格只有 ${o.size}` };
      const r = xyOrYX(a, b, o.player);
      return r === 'xy' ? { verdict: '相符', note: `@=${o.player}` }
        : r === 'yx' ? { verdict: '约定存疑', note: `@=${o.player}` }
        : { verdict: '矛盾', note: `@=${o.player}` };
    }
    case 'cellSymbol': {
      const pr = pairOf(e.quote); if (!pr) return { verdict: '无法核对', note: '审计读不出坐标' };
      const sym = mySymbol(e.quote) ?? e.symbol;
      if (!sym) return { verdict: '无法核对', note: '审计读不出符号' };
      const [a, b] = pr;
      if (o.size === null) return { verdict: '无法核对', note: '无网格' };
      if (a >= o.size || b >= o.size) return { verdict: '矛盾', note: '越界' };
      // @ 盖掉 + 与 E：屏幕上看不出来，不判。空地「.」与玩家「@」自己就能判，不在此列。
      if ((sym === '+' || sym === 'E') && xyOrYX(a, b, o.player) !== 'no')
        return { verdict: '无法核对', note: '图层覆盖' };
      const r1 = myCell(o, a, b), r2 = myCell(o, b, a);
      return r1 === sym ? { verdict: '相符', note: `该格=${r1}` }
        : r2 === sym ? { verdict: '约定存疑', note: `两读法=${r1}/${r2}` }
        : { verdict: '矛盾', note: `两读法=${r1}/${r2}` };
    }
    case 'pickupHere': {
      const p = myPolarity(e.quote);
      if (p === 'both' || p === 'none') return { verdict: '无法核对', note: '极性判不出' };
      const ev = o.events.join(' ');
      if (ev.includes('你脚下没有可拾取的东西')) return p === 'neg' ? { verdict: '相符', note: '现象行=没有' } : { verdict: '矛盾', note: '现象行=没有' };
      if (ev.includes('你拾取了地上的东西')) return p === 'pos' ? { verdict: '相符', note: '现象行=拾取' } : { verdict: '矛盾', note: '现象行=拾取' };
      return { verdict: '无法核对', note: '图层挡住且现象行没说' };
    }
    case 'hp': {
      const f = fracOf(e.quote);
      if (!f || o.hp === null || o.maxHp === null) return { verdict: '无法核对', note: '读不出 n/m' };
      return f[0] === o.hp && f[1] === o.maxHp ? { verdict: '相符', note: `HP${o.hp}/${o.maxHp}` } : { verdict: '矛盾', note: `HP${o.hp}/${o.maxHp}` };
    }
    case 'hpValue': {
      if (o.hp === null) return { verdict: '无法核对', note: '无 HP 行' };
      const said = numsOf(e.quote)[0];
      if (said === undefined) return { verdict: '无法核对', note: '读不出数字' };
      return said === o.hp ? { verdict: '相符', note: `HP${o.hp}` } : { verdict: '矛盾', note: `HP${o.hp}` };
    }
    case 'score': {
      if (o.score === null) return { verdict: '无法核对', note: '无分数' };
      const said = numsOf(e.quote)[0];
      if (said === undefined) return { verdict: '无法核对', note: '读不出数字' };
      return said === o.score ? { verdict: '相符', note: `分数${o.score}` } : { verdict: '矛盾', note: `分数${o.score}` };
    }
    case 'enemyCount': {
      const said = numsOf(e.quote)[0];
      if (said === undefined) return { verdict: '无法核对', note: '读不出数字' };
      return said === o.enemies.length ? { verdict: '相符', note: `E=${o.enemies.length}` } : { verdict: '矛盾', note: `E=${o.enemies.length}` };
    }
    case 'pickupCount': {
      const said = numsOf(e.quote)[0];
      if (said === undefined) return { verdict: '无法核对', note: '读不出数字' };
      return said === o.pickups.length ? { verdict: '相符', note: `+=${o.pickups.length}` } : { verdict: '矛盾', note: `+=${o.pickups.length}` };
    }
    case 'gridSize': {
      const ns = numsOf(e.quote);
      if (o.size === null || ns.length < 2) return { verdict: '无法核对', note: '读不出尺寸' };
      return ns[0] === o.size && ns[1] === o.size ? { verdict: '相符', note: `${o.size}×${o.size}` } : { verdict: '矛盾', note: `${o.size}×${o.size}` };
    }
    case 'alive': {
      if (o.alive === null) return { verdict: '无法核对', note: '无状态行' };
      const p = myPolarity(e.quote);
      if (p === 'both' || p === 'none') return { verdict: '无法核对', note: '极性判不出' };
      return (p === 'pos') === o.alive ? { verdict: '相符', note: `状态=${o.alive ? '活着' : '已倒下'}` } : { verdict: '矛盾', note: `状态=${o.alive ? '活着' : '已倒下'}` };
    }
    case 'attack': {
      if (o.attackReady === null) return { verdict: '无法核对', note: '无攻击状态行' };
      const p = myPolarity(e.quote);
      if (p === 'both' || p === 'none') return { verdict: '无法核对', note: '极性判不出' };
      return (p === 'pos') === o.attackReady ? { verdict: '相符', note: `攻击=${o.attackReady ? '就绪' : '冷却中'}` } : { verdict: '矛盾', note: `攻击=${o.attackReady ? '就绪' : '冷却中'}` };
    }
    case 'moveIntent': return { verdict: '无法核对', note: '意图不陈述世界状态' };
    case 'barePair': return { verdict: '无法核对', note: '主语不明' };
    default: return { verdict: '无法核对', note: '审计侧没有这一类（表外类别）' };
  }
}

// ─────────────────────────── 比对 ───────────────────────────

type Bad = { where: string; kind: string; quote: string; theirs: Verdict; mine: Verdict; note: string };
const bad: Bad[] = [];
const byKind = new Map<string, { n: number; agree: number }>();

function check(where: string, e: Entry, o: Observation | null, thought: string): void {
  const mine = rejudge(e, o, thought);
  const c = byKind.get(e.kind) ?? { n: 0, agree: 0 };
  c.n++; if (mine.verdict === e.verdict && mine.amb !== true) c.agree++;
  byKind.set(e.kind, c);
  if (mine.amb === true)
    bad.push({ where, kind: e.kind, quote: e.quote, theirs: e.verdict, mine: '定位不了', note: `引文落点不定：${mine.note}` });
  else if (mine.verdict !== e.verdict)
    bad.push({ where, kind: e.kind, quote: e.quote, theirs: e.verdict, mine: mine.verdict, note: mine.note });
}

const argv = process.argv.slice(2);
const casesPath = argv.find((a) => !a.startsWith('--'));
if (!casesPath || !existsSync(resolve(casesPath))) {
  log('用法: node verify/recon-audit.ts <cases.json> [--corpus] [--runs 目录…]\n' +
    '  <cases.json> 由 node verify/recon-fixture.ts 生成（它的 stdout 就是路径）。');
  process.exit(2);
}
if (byKind.size !== 0) { /* 只为让上面的 map 声明不被误读成死代码 */ }

const fx = JSON.parse(readFileSync(resolve(casesPath), 'utf8')) as {
  recon: { recon: string; sha: string };
  cases: { id: string; screen: string; text: string; want: { kind: string; verdict: Verdict }[]; got: Entry[] }[];
};
log(`\n===== M4-d 独立审计（判据 ${fx.recon.recon}，sha=${fx.recon.sha.slice(0, 12)}…）=====`);

// ① 夹具：人工期望 = 独立重算 = 判据落盘，三方各走各的路
let fxN = 0;
for (const c of fx.cases) {
  const o = observe(c.screen);
  if (c.got.length !== c.want.length) {
    bad.push({ where: `夹具 ${c.id}`, kind: '—', quote: c.text, theirs: '无法核对', mine: '—', note: `判据出 ${c.got.length} 条，人工期望 ${c.want.length} 条` });
    continue;
  }
  c.got.forEach((e, i) => {
    fxN++;
    const w = c.want[i]!;
    if (e.kind !== w.kind || e.verdict !== w.verdict)
      bad.push({ where: `夹具 ${c.id}`, kind: w.kind, quote: e.quote, theirs: e.verdict, mine: `期望 ${w.verdict}`, note: `人工期望 ${w.kind}:${w.verdict}` });
    check(`夹具 ${c.id}`, e, o, c.text);
  });
}
log(`① 夹具 ${fx.cases.length} 格 ${fxN} 条：人工期望 vs 判据落盘 vs 独立重算`);

// ② 真语料：逐条重判 + 锚点自证（锚点也是审计自己算一遍）
if (argv.includes('--corpus')) {
  const ROOT = resolve(join(new URL('.', import.meta.url).pathname, '..'));
  const runsRoot = join(ROOT, 'runs');
  const listRunDirs = (d: string, depth = 0): string[] => {
    const out: string[] = [];
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (!statSync(p).isDirectory()) continue;
      if (existsSync(join(p, 'reconciliation.json'))) out.push(p);
      else if (depth < 2) out.push(...listRunDirs(p, depth + 1));
    }
    return out;
  };
  // ⚠️ --runs 既可以给仓库内相对路径，也可以给绝对路径（自检要把证据复制到临时目录再篡改）。
  //    这里不能用 join(ROOT, x)：join 不会在 x 以 / 开头时重置根，绝对路径会被拼成
  //    `<仓库>/tmp/...` 这种**不存在**的目录，于是自检"什么都没审到"却报绿（#17 的反面）。
  const dirs = argv.includes('--runs')
    ? argv.slice(argv.indexOf('--runs') + 1).filter((x) => !x.startsWith('--'))
      .map((x) => resolve(x.startsWith('/') ? x : join(ROOT, x)))
    : listRunDirs(runsRoot);
  const isScreen = (v: unknown): v is string => typeof v === 'string' && /\nHP /.test(v);
  let corpusN = 0, anchorBad = 0, versionBad = 0, identityBad = 0, contextBad = 0;
  for (const dir of dirs) {
    const recPath = join(dir, 'reconciliation.json');
    if (!existsSync(recPath)) {
      bad.push({ where: dir, kind: '—', quote: '', theirs: '无法核对', mine: '—', note: '缺 reconciliation.json：先跑 npm run verify:recon' });
      continue;
    }
    const rec = JSON.parse(readFileSync(recPath, 'utf8')) as { recon: { recon: string }; claims: number; detail: Entry[] };
    if (rec.recon.recon !== fx.recon.recon) { versionBad++; continue; }
    const tracePath = join(dir, 'trace.jsonl');
    const headerPath = join(dir, 'header.json');
    if (!existsSync(tracePath) || !existsSync(headerPath)) { anchorBad++; continue; }
    const header = JSON.parse(readFileSync(headerPath, 'utf8'));
    const brain = String(header.brainId ?? '');
    if (brain.startsWith('mock:') || brain.startsWith('script:')) continue;   // 假大脑/剧本不进这一档
    const rows = readFileSync(tracePath, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { result?: { output?: string }; decision?: { thought?: string } });
    const initScreen = isScreen(header?.initialState?.world?.screen) ? header.initialState.world.screen : null;
    const before: (string | null)[] = [];
    let last = initScreen;
    for (const r of rows) { before.push(last); if (isScreen(r.result?.output)) last = r.result!.output!; }

    const counts: Record<Verdict, number> = { 相符: 0, 矛盾: 0, 约定存疑: 0, 无法核对: 0 };
    for (const d of rec.detail) {
      if (!(d.verdict in counts)) { identityBad++; continue; }
      counts[d.verdict]++;
    }
    if (Object.values(counts).reduce((a, b) => a + b, 0) !== rec.detail.length || rec.detail.length !== rec.claims) identityBad++;

    for (const d of rec.detail) {
      const screen = before[d.row ?? -1] ?? null;
      if (screen === null) { if (d.screenSha != null) { anchorBad++; continue; } }
      else if (d.screenSha && sha12(screen) !== d.screenSha) { anchorBad++; continue; }
      const o = screen === null ? null : observe(screen);
      if (o && d.tick != null && o.tick !== d.tick) { anchorBad++; continue; }   // 锚点帧号必须与审计自己读到的同一帧
      const thought = rows[d.row ?? -1]?.decision?.thought;
      if (thought === undefined || thought === '') { contextBad++; continue; }
      // 引文必须真在那一行 thought 里：不在就是 row 指错了，回溯范围无从谈起（不许用兜底蒙过去）
      if (d.quote && !myNorm(thought).includes(myNorm(d.quote))) contextBad++;
      corpusN++;
      check(`${dir.slice(runsRoot.length + 1)} 第${d.row}行`, d, o, thought);
    }
  }
  log(`② 真语料 ${dirs.length} 局 ${corpusN} 条：独立重判 + 锚点自证（回溯范围自己从 thought 原文算）`);
  if (versionBad) log(`   ⚠️ ${versionBad} 局的落盘判据版本与夹具不一致（口径混用，台账 #18）→ 计入不一致`);
  if (anchorBad) log(`   ⚠️ ${anchorBad} 条锚点自证不过（屏幕指纹/帧号对不上）→ 计入不一致`);
  if (contextBad) log(`   ⚠️ ${contextBad} 条的引文不在它自己那行 thought 里（行号指错）→ 计入不一致`);
  if (identityBad) log(`   ⚠️ ${identityBad} 局恒等式断裂 → 计入不一致`);
  bad.push(...Array.from({ length: versionBad + anchorBad + contextBad + identityBad },
    () => ({ where: '（计数见上）', kind: '—', quote: '', theirs: '无法核对' as Verdict, mine: '锚点/行号/版本/恒等式', note: '结构性自检不过' })));
}

// ─────────────────────────── 零泄漏自扫描 ───────────────────────────
// 只扫**代码**，不扫注释：这份文件的标题注释里就写着"禁止 import reconcile.ts / WorldState"，
// 拿原文做子串比对会把自己写的免责声明当成违规（首跑就红在这，而且红得没道理）。
const me = readFileSync(new URL(import.meta.url), 'utf8');
const code = me.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'`\n]*$/gm, '');
const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
const leaks: string[] = [];
if (imports.some((p) => p.includes('reconcile.ts'))) leaks.push("import 了判据本体 reconcile.ts（审计必须自己判一遍）");
if (imports.some((p) => p.includes('arena.ts'))) leaks.push('import 了 arena.ts（世界状态）');
if (!imports.some((p) => p.includes('observe.ts'))) leaks.push('没有 import observe.ts：屏幕侧观测量从哪来？');
// 内部状态字样只在**判决逻辑那一段**里查（扫描器自己那一段 below 不查——
// 否则违禁词列表本身就是一处"命中"，红得毫无意义，首跑正是这样）。
const cutIdx = code.indexOf('const imports =');
if (cutIdx < 0) leaks.push('扫描锚点 "const imports =" 不见了：这段自检已经失效，改结构时必须同步改它');
const judgeCode = cutIdx < 0 ? '' : code.slice(0, cutIdx);
for (const t of ['WorldState', 'cooldown', '.taken', '.dir', 'fullWorldActions', 'worldHash', 'situationHash']) {
  if (judgeCode.includes(t)) leaks.push(`判决逻辑里出现内部状态字样：${t}`);
}
// 夹具证据文件里也不许躺着内部状态
const fxRaw = readFileSync(resolve(casesPath), 'utf8');
for (const t of ['"state"', '"cooldown"', '"taken"', '"walls":', '"enemies":']) {
  if (fxRaw.includes(t)) leaks.push(`夹具证据里带着内部状态：${t}`);
}

// ─────────────────────────── 汇总 ───────────────────────────
let n = 0, agree = 0;
for (const [k, v] of [...byKind].sort()) {
  n += v.n; agree += v.agree;
  log(`  ${k.padEnd(13)} ${String(v.n).padStart(5)} 条  一致 ${String(v.agree).padStart(5)}  ${v.agree === v.n ? '✅' : `❌ 差 ${v.n - v.agree}`}`);
}
log(`\n独立重算与落盘判决一致：${agree}/${n}`);
if (bad.length) {
  log(`\n❌ ${bad.length} 处不一致：`);
  for (const m of bad.slice(0, 25))
    log(`   ${m.where} ${m.kind} ${JSON.stringify(m.quote).slice(0, 44)} 落盘=${m.theirs} 审计=${m.mine}（${m.note}）`);
}
if (leaks.length) {
  log('\n❌ 零泄漏自检：');
  for (const l of leaks) log(`   ${l}`);
}
if (bad.length || leaks.length) process.exit(1);
log('\n✅ 三方一致（人工期望＝独立重算＝判据落盘），且审计侧没 import 判据、没读内部状态。');
