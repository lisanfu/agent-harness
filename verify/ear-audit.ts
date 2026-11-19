/**
 * M4-c 眼耳对账**独立审计**：不 import 判据（`src/world/ear.ts`），只吃证据文件，
 * 自己把每一帧的眼侧事实、每一条声音归属、每一次整族位移、每一条容量差**重算一遍**，
 * 然后要求三方一致：**人工期望（want）＝ 审计重算（mine）＝ 判据落盘（got）**。
 *
 * 为什么非要重写一遍（台账 #14：两个通道不许各信一份）：
 *   `test/ear.test.ts` 验判据本体，`verify/ear-fixture.ts` 也调判据出 `got`——两边同吃 `ear.ts` 那一段代码。
 *   判据本身错了（比如把"被 @ 盖住"当成"消失了"），两处一起绿，那是最难查的一种自洽。
 *   这一份把判决逻辑按**自己的形状**重写：自己的认族表（独特子串，不是锚定全匹配）、
 *   自己的格子差（遍历两帧键的并集，不是先遍历前帧再补新键）、自己的位移搜索
 *   （候选 D 逐个试一一对应，不是排序后逐位相减）、自己的销账结构（槽位布尔 + 眼侧已账集合）。
 *   不一致就红，而且不许取平均——要么判据错要么审计错，只能人对着打印出来的那两帧屏幕把它读一遍。
 *
 * 独立性说到哪儿为止（不吹）：两份实现出自同一个人之手，**同一种误解会一起犯**。
 *   这一层挡得住三类：①实现与登记的口径分叉（词表／区间／闸门写歪一格）；
 *   ②判据读到的屏幕与证据文件里的屏幕不是同一份（重放被改、落盘被改）；
 *   ③证据本身被篡改（改一声、改数字、挪一帧、改屏幕、改 want、改 got、改 rig 标签）。
 *   挡不住的是"眼侧依据本身就选错了"——那一层由 `want`（人对着屏幕手读的期望矩阵）挡，
 *   所以三方一个都不能少：`want`＝`mine` 而 `got` 不同 ⇒ 判据错；
 *   `mine`＝`got` 而 `want` 不同 ⇒ 人读屏幕读错了；三者两两不同 ⇒ 证据被改过。
 *
 * 允许 import 的只有 `observe.ts`（眼睛：屏幕文本→观测量，M4-a 起被四条独立通道共用并各自复核过）
 * 加 node 内置。禁止：`ear.ts`（判据本体）、`session.ts`／`arena.ts`／`sound.ts`／`mutants.ts`
 * （世界与发声层——import 它们就等于拿被测系统给自己背书）。文件末尾有自扫描守着这句。
 *
 * 用法: node verify/ear-audit.ts <ear_cases.json>
 *   <ear_cases.json> 由 node verify/ear-fixture.ts 生成（它的 stdout 就是路径）。
 *   verify/ear-selftest.ts 会把**只改过一处**的副本喂进来，要求这里既红得起来、
 *   又点得出是哪一条判据红——随便报个错等于没报。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { observe, type Observation } from '../src/world/observe.ts';

const log = (l: string): void => void process.stderr.write(`${l}\n`);

// ─────────────────── 审计侧自己登记的一套契约（与判据各自维护） ───────────────────

/** 五桶。与判据同名是**约定**，不是引用：这里少一个、多一个，比对当场炸。 */
type Bucket = '相符' | '矛盾' | '时钟错位' | '无法核对' | '容量差';
const BUCKETS: readonly Bucket[] = ['相符', '矛盾', '时钟错位', '无法核对', '容量差'];

/** 八族。 */
type Cue =
  | 'footstep' | 'wallBump' | 'swing' | 'killThud'
  | 'hurtGrunt' | 'pickupClick' | 'shuffle' | 'deathThud';
const CUES: readonly Cue[] = [
  'footstep', 'wallBump', 'swing', 'killThud', 'hurtGrunt', 'pickupClick', 'shuffle', 'deathThud',
];

/** 容量差六个词条（审计侧自己列一遍：判据那边漏登记一条，这里就会对不上）。 */
const CAPS: readonly string[] = ['playerCell', 'hpPoints', 'scorePoints', 'killCells', 'killCollapse', 'enemyCells'];

/** 审计侧登记的判据版本。判据升版必须同步改这里，并**重读一遍人工期望**——否则老证据会被新口径悄悄改判。 */
const AUDIT_EAR_VERSION = 'm4c-1';

/** 整族位移闸门：少于三次不配叫"错位"（登记的口径，这里自己写死一份）。 */
const MIN_SHIFT_OCCURRENCES = 3;

/**
 * 现象文本 → 哪一族。
 *
 * 与判据的差别是**形状**：判据把锚定的全匹配正则源串登记在词表里（`^…$`），
 * 这里用"独特子串"认族。两种写法对同一句必须给出同一个族——判据把某族的正则写松或写紧
 * （例如把「一声短促的倒地声」和「一记沉重的倒地声」认反），认出的族一变，逐条比对就炸。
 * 认不出来的文本一律抛错：静默丢掉一条声音＝这一条根本没被核对过（#17 的免检通道）。
 */
const CUE_OF: ReadonlyArray<[string, Cue]> = [
  ['短促的倒地声', 'killThud'],
  ['沉重的倒地声', 'deathThud'],
  ['脚步', 'footstep'],
  ['闷响', 'wallBump'],
  ['破风', 'swing'],
  ['闷哼', 'hurtGrunt'],
  ['咔哒', 'pickupClick'],
  ['窸窣', 'shuffle'],
];

const cueOf = (text: string): Cue => {
  const hit = CUE_OF.filter(([sub]) => text.includes(sub));
  if (hit.length !== 1) {
    throw new Error(`审计侧认不出这句声音（命中 ${hit.length} 族）：「${text}」。词表有洞就不许出统计。`);
  }
  return hit[0]![1];
};

/** 窸窣那句里的数字。审计自己取，不复用判据的捕获组。 */
const numberOf = (text: string): number | null => {
  const m = /(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
};

// ─────────────────── 眼侧：审计自己的格子差 ───────────────────

type Status = '该响' | '不该响' | '说不清';

/** 眼侧一行：状态 + 下界（只有带数字的那一族给得出下界，其余为 null）。 */
type Eye = { status: Status; lo: number | null };

const id = (c: [number, number]): string => `${c[0]}:${c[1]}`;

/** 一帧屏幕上某种符号占了哪些格。同一格叠两个符号只画一个，所以 bag 的计数恒为 1，
 *  但写成 bag 让"两帧逐键比"只有一个形状，不必为"少了一个 E 是消失还是被盖"分叉出两套代码。 */
function bag(cs: [number, number][]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cs) m.set(id(c), (m.get(id(c)) ?? 0) + 1);
  return m;
}

/**
 * 两帧之间某族符号的格子差——**按两侧键的并集**逐键算。
 * 判据那边只遍历前一帧的键、再单独补一次"新键"；形状不同，
 * 但"消失几格／其中几格被遮蔽／冒出几格"三个数必须一致。
 */
function diffBags(
  a: Map<string, number>, b: Map<string, number>, hidden: Set<string>,
): { vanished: number; masked: number; appeared: number } {
  let vanished = 0; let masked = 0; let appeared = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    if (x > y) { vanished += x - y; if (hidden.has(k)) masked += x - y; }
    if (y > x) appeared += y - x;
  }
  return { vanished, masked, appeared };
}

/**
 * 眼侧一帧八行：这一帧每一族"屏幕上说该不该响"。
 *
 * 与判据的差别：这里按**证据来源**分组写（位置类／动作类／计数类／状态类），判据按表序一族一段写。
 * 两侧读同一批画面事实，任何一条口径分叉都会在比对里炸。
 * 倒下之后整帧短路一律说不清——死后播不播声音是发声层的设计决定，不是画面事实；
 * 逐族各判各的会把"设计"读成"漏报"。
 */
function eyeRows(prev: Observation, action: { kind: string; dir?: number }, next: Observation): Map<Cue, Eye> {
  const out = new Map<Cue, Eye>();
  const put = (cue: Cue, status: Status, lo: number | null = null): void => void out.set(cue, { status, lo });

  if (prev.alive === false) {
    for (const cue of CUES) put(cue, '说不清');
    return out;
  }

  // ── 位置类：脚步、撞墙 ──
  const p0 = prev.player;
  const p1 = next.player;
  const moved = !!p0 && !!p1 && (p0[0] !== p1[0] || p0[1] !== p1[1]);
  if (!p0 || !p1) {
    put('footstep', '说不清');
    put('wallBump', '说不清');
  } else {
    put('footstep', moved ? '该响' : '不该响');
    if (action.kind !== 'move' || moved) put('wallBump', '不该响');
    else if (prev.size === null) put('wallBump', '说不清');
    else {
      // 目标格从"做了移动动作 + 人没挪"这一事实反推；画面上挡得住他的只有墙和"出界"。
      // 目标格是敌人／物品／空地却挪不动——屏幕都说不出这声闷响该不该有（眼睛不许挑一种解释硬判）。
      const tx = p0[0] + (action.dir === 1 ? 1 : action.dir === 3 ? -1 : 0);
      const ty = p0[1] + (action.dir === 0 ? -1 : action.dir === 2 ? 1 : 0);
      const offGrid = tx < 0 || ty < 0 || tx >= prev.size || ty >= prev.size;
      const onWall = prev.walls.some((c) => c[0] === tx && c[1] === ty);
      put('wallBump', offGrid || onWall ? '该响' : '说不清');
    }
  }

  // ── 动作类：出手。依据只有 HUD 那一栏就绪／冷却 ──
  if (action.kind !== 'attack') put('swing', '不该响');
  else if (prev.attackReady === null) put('swing', '说不清');
  else put('swing', prev.attackReady ? '该响' : '不该响');

  // ── 计数类：分数是屏幕上唯一数得出的击杀计数（可见「E」的增减不是：叠格与被 @ 盖住都不留痕迹）──
  const dScore = prev.score === null || next.score === null ? null : next.score - prev.score;
  const kills = dScore === null || dScore < 0 ? null : dScore;
  if (kills === null) put('killThud', '说不清');
  else put('killThud', kills >= 1 ? '该响' : '不该响');

  // ── 状态类：血条、生死 ──
  if (prev.hp === null || next.hp === null) put('hurtGrunt', '说不清');
  else put('hurtGrunt', next.hp < prev.hp ? '该响' : '不该响');
  if (prev.alive === null || next.alive === null) put('deathThud', '说不清');
  else put('deathThud', prev.alive && !next.alive ? '该响' : '不该响');

  // ── 拾取：可见的「+」净消失，或"做了拾取动作且血条上涨"。
  //    「+」会被下一帧的 @ 和 E 两层盖住，所以"消失"必须扣掉被遮蔽的那些格才算证据。──
  const coverPlus = new Set<string>([...(p1 ? [id(p1)] : []), ...next.enemies.map(id)]);
  const plus = diffBags(bag(prev.pickups), bag(next.pickups), coverPlus);
  const hpRose = prev.hp !== null && next.hp !== null && next.hp > prev.hp;
  if (plus.vanished - plus.masked > 0) put('pickupClick', '该响');
  else if (action.kind === 'pickup' && hpRose) put('pickupClick', '该响');
  else if (action.kind === 'pickup') put('pickupClick', '说不清');
  else put('pickupClick', '不该响');

  // ── 窸窣：唯一带数字的一族，且**只有下界**。
  //    一格确定空出来 = 上面那个人要么死了要么挪了；把画面记到的击杀数抵掉，剩下的就是"证明挪走的人"。
  //    上界刻意放弃：藏起来的敌人（被 @ 盖的、叠进同一格的）屏幕数不出个数，
  //    任何按可见 E 数出来的上界都会凭空造出矛盾。代价登记在案：耳朵把次数说多不会被发现。──
  if (kills === null) put('shuffle', '说不清');
  else {
    const coverEnemy = new Set<string>(p1 ? [id(p1)] : []);
    const en = diffBags(bag(prev.enemies), bag(next.enemies), coverEnemy);
    const lo = Math.max(0, en.vanished - en.masked - kills);
    if (lo >= 1) put('shuffle', '该响', lo);
    else put('shuffle', '说不清');
  }

  for (const cue of CUES) if (!out.has(cue)) throw new Error(`审计侧眼侧漏了一族：${cue}`);
  return out;
}

/**
 * 容量差：屏幕上有一件事，耳朵那条通道原理上说不出主张。
 * 这一桶不进门（既不相符也不矛盾），但必须逐条计数——登记了不数等于没登记（#21）。
 */
function capRows(prev: Observation, next: Observation): string[] {
  const hits: string[] = [];
  const p0 = prev.player;
  const p1 = next.player;
  if (p0 && p1 && (p0[0] !== p1[0] || p0[1] !== p1[1])) hits.push('cap:playerCell');
  if (prev.hp !== null && next.hp !== null && prev.hp !== next.hp) hits.push('cap:hpPoints');
  if (prev.score !== null && next.score !== null && next.score > prev.score) {
    hits.push('cap:scorePoints');
    hits.push('cap:killCells');
    // 一帧内死 ≥2 个只响一声：第 2..n 具挤进同一声，不许判成漏报
    for (let i = 1; i < next.score - prev.score; i++) hits.push('cap:killCollapse');
  }
  const en = diffBags(bag(prev.enemies), bag(next.enemies), new Set<string>());
  if (en.vanished + en.appeared > 0) hits.push('cap:enemyCells');
  return hits;
}

// ─────────────────── 证据文件读进来长这样 ───────────────────

interface CaseIn {
  id: string;
  what: string;
  provenance: string;
  ear_source?: string;
  seed: number;
  rig: { id: string; label: string; note: string };
  actions: Array<{ kind: string; dir?: number }>;
  sounds: Array<{ tick: number; seq: number; text: string }>;
  frames: Array<{ tick: number; screen: string; sha: string; heard: Array<{ seq: number; text: string }> }>;
  goal: string[];
  want: Array<{ key: string; bucket: string; n: number }>;
  wantAt: Array<{ tick: number; cue: string; side: string; verdict: string }>;
  got: Array<{ tick: number; key: string; cue: string | null; side: string; text: string | null; verdict: string; shift: number | null; why: string }>;
  gotCounts: Record<string, number>;
  consistency: { actions: number; screens: number; tickAligned: boolean; soundsBeyondScreen: number };
}

interface Doc { ear: { ear: string; sha: string; frozenAt: string }; negative?: string[]; cases: CaseIn[] }

const sha12 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

type Row = { tick: number; key: string; side: string; verdict: Bucket; shift: number | null };

/** 一行判决的比对键：帧号 + 对象 + 哪一侧 + 落哪个桶。`why` 不参与比对（措辞不是判据）。 */
const rk = (r: { tick: number; key: string; side: string; verdict: string }): string =>
  `${r.tick}|${r.key}|${r.side}|${r.verdict}`;

/** 判决矩阵：对象 → 桶 → 条数。三方（want / got / mine）都归一到这个形状再比。 */
type Matrix = Record<string, Record<string, number>>;
function toMatrix(rows: Array<{ key: string; verdict: string }>): Matrix {
  const m: Matrix = {};
  for (const r of rows) {
    m[r.key] ??= {};
    m[r.key]![r.verdict] = (m[r.key]![r.verdict] ?? 0) + 1;
  }
  return m;
}
const flat = (m: Matrix): string[] =>
  Object.entries(m)
    .flatMap(([k, row]) => Object.entries(row).filter(([, n]) => n > 0).map(([b, n]) => `${k}:${b}×${n}`))
    .sort();

/** 两个矩阵差在哪：只报"谁有谁没有"，不取平均。 */
function matrixDiff(a: Matrix, b: Matrix): string[] {
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    for (const bu of [...BUCKETS, '（表外）'] as string[]) {
      const x = a[k]?.[bu] ?? 0;
      const y = b[k]?.[bu] ?? 0;
      if (x !== y) out.push(`${k}/${bu} ${x}↔${y}`);
    }
  }
  return out;
}

/** 矩阵之外再说清"差在第几帧哪一侧"——只报差异，不报全表（全表在证据文件里）。 */
function rowDiff(mine: Row[], got: CaseIn['got']): string[] {
  const tally = (xs: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const a = tally(mine.map(rk));
  const b = tally(got.map(rk));
  const out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    if (x !== y) {
      const [tick, key, side, bucket] = k.split('|');
      out.push(`第 ${tick} 帧 ${key}[${side}]→${bucket} 审计=${x} 判据=${y}`);
    }
  }
  // 位移值也必须一致：同一个 D 才是同一次错位，D 不同就是两次不同的判决
  const sa = mine.filter((r) => r.verdict === '时钟错位').map((r) => `${rk(r)}#${r.shift}`).sort().join(',');
  const sb = got.filter((r) => r.verdict === '时钟错位').map((r) => `${rk(r)}#${r.shift}`).sort().join(',');
  if (sa !== sb) out.push(`时钟错位的位移值不一致：审计 [${sa}] vs 判据 [${sb}]`);
  return out.sort();
}

// ─────────────────── 重算：一格证据 → 审计自己的主张列表 ───────────────────

/**
 * 帧范围向两头扩到声流的实际帧号（S10 那种整体挪移会把声音推到末尾之外）：
 * 扩出来的帧屏幕账本里没有，眼睛无从说话 ⇒ 那一帧上耳朵的每一声只能记「无法核对」，
 * 不许冒充矛盾。这条口径在判据那边写在重放接线里，这里独立写一遍。
 */
function rejudge(c: CaseIn): { rows: Row[]; beyond: number; aligned: boolean } {
  const T = c.actions.length;
  const obs: Observation[] = c.frames.map((f) => observe(f.screen));
  if (obs.length !== T + 1) throw new Error(`屏幕帧数 ${obs.length} ≠ 动作数 + 1 = ${T + 1}`);
  const screenAt = (t: number): Observation => obs[Math.max(0, Math.min(T, t))]!;

  /** 耳朵的一声：一个待配对的槽位，销账就是把这个布尔翻过来。 */
  type Slot = { tick: number; cue: Cue; seq: number; text: string; used: boolean };

  let lo = 1;
  let hi = T;
  let beyond = 0;
  let aligned = true;
  for (const s of c.sounds) {
    lo = Math.min(lo, s.tick);
    hi = Math.max(hi, s.tick);
    if (s.tick > T || s.tick < 1) beyond++;
  }
  // 屏幕账本自己得说得出"第几帧"，否则"逐帧对账"这个说法就是空的
  for (let t = 1; t <= T; t++) if (obs[t]!.tick !== t) aligned = false;

  const slots = new Map<Cue, Slot[]>(new Map(CUES.map((cue) => [cue, [] as Slot[]])));
  const eyes = new Map<number, Map<Cue, Eye>>();
  const eyeTicks = new Map<Cue, number[]>(new Map(CUES.map((cue) => [cue, [] as number[]])));

  const heardAt = new Map<number, Array<{ tick: number; seq: number; text: string }>>();
  for (const s of c.sounds) {
    const l = heardAt.get(s.tick) ?? [];
    l.push(s);
    heardAt.set(s.tick, l);
  }

  for (let t = lo; t <= hi; t++) {
    const inRange = t >= 1 && t <= T;
    const rows = inRange
      ? eyeRows(screenAt(t - 1), c.actions[t - 1]!, screenAt(t))
      : new Map(CUES.map((cue) => [cue, { status: '说不清', lo: null } as Eye]));
    eyes.set(t, rows);
    for (const cue of CUES) {
      if (rows.get(cue)!.status === '该响') eyeTicks.get(cue)!.push(t);
      for (const s of (heardAt.get(t) ?? []).slice().sort((x, y) => x.seq - y.seq)) {
        if (cueOf(s.text) === cue) slots.get(cue)!.push({ tick: t, cue, seq: s.seq, text: s.text, used: false });
      }
    }
  }
  const straySounds = [...slots.values()].flat().length - c.sounds.length;
  if (straySounds !== 0) throw new Error(`${c.id}：有 ${Math.abs(straySounds)} 句声音没落进任何帧的槽位（认族与放置各丢了一次）`);

  const out: Row[] = [];
  /** 眼侧已被整族错位销过账的格子：第二遍不许再拿它记一笔漏报（一个事实两个主人，#13 家族）。 */
  const eyeClaimed = new Set<string>();

  for (let t = lo; t <= hi; t++) {
    if (!(t >= 1 && t <= T)) continue;
    for (const k of capRows(screenAt(t - 1), screenAt(t))) {
      out.push({ tick: t, key: k, side: '屏幕', verdict: '容量差', shift: null });
    }
  }

  /** 一对错位主张：眼侧记在"该响的那一帧"，耳侧记在"真响的那一帧"，两条同分母。 */
  const shiftPair = (cue: Cue, eyeTick: number, ear: Slot, d: number): void => {
    ear.used = true;
    eyeClaimed.add(`${cue}@${eyeTick}`);
    out.push({ tick: eyeTick, key: cue, side: '眼', verdict: '时钟错位', shift: d });
    out.push({ tick: ear.tick, key: cue, side: '耳', verdict: '时钟错位', shift: d });
  };

  // ── 第一遍：整族位移。搜索形状与判据不同——判据排序后逐位相减看是否恒定，
  //    这里拿"候选 D"逐个试两侧能否**一一对应且无剩余**。
  //    闸门是结构量（≥3 次），不是负载量：一缺一多的形状不配叫错位，
  //    否则一个时钟 bug 会被读成两起事实相反的事故（纪律 4）。
  const established = new Map<Cue, number>();
  for (const cue of CUES) {
    const exp = eyeTicks.get(cue)!;
    const heard = slots.get(cue)!.filter((s) => !s.used);
    if (exp.length < MIN_SHIFT_OCCURRENCES || exp.length !== heard.length) continue;
    const at = new Map<number, Slot[]>();
    for (const h of heard) {
      const l = at.get(h.tick) ?? [];
      l.push(h);
      at.set(h.tick, l);
    }
    const cands = [...new Set(heard.map((h) => h.tick - exp[0]!))].sort((x, y) => x - y);
    for (const d of cands) {
      if (d === 0) continue;
      const need = new Map<number, number>();
      for (const t of exp) need.set(t + d, (need.get(t + d) ?? 0) + 1);
      const coversAll = [...need.entries()].every(([t, n]) => (at.get(t)?.length ?? 0) === n);
      if (!coversAll) continue;
      for (const t of [...exp].sort((x, y) => x - y)) {
        const h = (at.get(t + d) ?? []).find((s) => !s.used)!;
        shiftPair(cue, t, h, d);
      }
      established.set(cue, d);
      break;
    }
  }

  // ── 第 1.5 遍：把已经证明的全局位移 D 借给没过闸门的族。
  //    D 不唯一 ⇒ 全体放弃继承（那说明"位移"不是整条录音的属性）。
  //    代价如实登记：一族自己的偶发误报若恰好落在别的族证明的 D 上，会被赦成时钟错位。
  const ds = [...new Set(established.values())];
  const D = ds.length === 1 ? ds[0]! : null;
  if (D !== null) {
    for (const cue of CUES) {
      if (established.has(cue)) continue;
      for (const t of eyeTicks.get(cue)!) {
        if (eyeClaimed.has(`${cue}@${t}`)) continue;
        const h = slots.get(cue)!.find((s) => !s.used && s.tick === t + D);
        if (h) shiftPair(cue, t, h, D);
      }
    }
  }

  // ── 第二遍：逐帧配对。表序一族一段，谁也不许多一行少一行 ──
  for (let t = lo; t <= hi; t++) {
    for (const cue of CUES) {
      const eye = eyes.get(t)!.get(cue)!;
      const hits = slots.get(cue)!.filter((s) => !s.used && s.tick === t);
      if (eye.status === '该响') {
        const first = hits[0];
        if (!first) {
          if (!eyeClaimed.has(`${cue}@${t}`)) {
            out.push({ tick: t, key: cue, side: '眼', verdict: '矛盾', shift: null });   // 漏报
          }
          continue;
        }
        first.used = true;
        const n = numberOf(first.text);
        // 只有带下界的那一族核数字，且**只核下界**：n < lo ⇒ 耳朵少报了，两侧各记一条矛盾
        const off = eye.lo !== null && !(n !== null && n >= eye.lo);
        const verdict: Bucket = off ? '矛盾' : '相符';
        out.push({ tick: t, key: cue, side: '眼', verdict, shift: null });
        out.push({ tick: t, key: cue, side: '耳', verdict, shift: null });
        // 屏幕一帧只支持一次：同族第二声起算耳侧独多（误报）
        for (const extra of hits.slice(1)) {
          extra.used = true;
          out.push({ tick: t, key: cue, side: '耳', verdict: '矛盾', shift: null });
        }
      } else {
        for (const h of hits) {
          h.used = true;
          out.push({
            tick: t, key: cue, side: '耳',
            verdict: eye.status === '说不清' ? '无法核对' : '矛盾',   // 误报
            shift: null,
          });
        }
      }
    }
  }
  const unconsumed = [...slots.values()].flat().filter((s) => !s.used);
  if (unconsumed.length) {
    throw new Error(`${c.id}：${unconsumed.length} 声没有落进任何桶（每一声都必须有归属，静默丢掉＝免检通道）`);
  }
  return { rows: out, beyond, aligned };
}

// ─────────────────── 主流程 ───────────────────

const casesPath = process.argv[2];
if (!casesPath) {
  log('用法: node verify/ear-audit.ts <ear_cases.json>（由 verify/ear-fixture.ts 生成）');
  process.exit(2);
}
const doc = JSON.parse(readFileSync(resolve(casesPath), 'utf8')) as Doc;

const bad: string[] = [];
const note = (m: string): void => bad.push(m);

if (doc.ear?.ear !== AUDIT_EAR_VERSION) {
  note(`判据版本对不上：证据文件写着 ${doc.ear?.ear}，审计侧登记的是 ${AUDIT_EAR_VERSION}（判据改过口径 ⇒ 审计必须同步改，并**重读一遍人工期望**，不许让老证据被新口径悄悄改判）`);
}

const seenCue = new Set<string>();
const seenBucket = new Set<string>();
const seenCap = new Set<string>();
const negatives: string[] = [];

log(`M4-c 眼耳独立审计：${doc.cases.length} 格｜判据登记 ${JSON.stringify(doc.ear)}`);
log('  三方对照：want＝人对着屏幕手读的期望矩阵｜got＝判据落盘的逐条判决｜mine＝本脚本从屏幕+声流重算\n');

for (const c of doc.cases) {
  // ── 0. 证据自身的形状 ──
  for (const f of c.frames) {
    if (sha12(f.screen) !== f.sha) {
      note(`${c.id}：第 ${f.tick} 帧屏幕指纹不符（落盘 sha=${f.sha}，按文本重算=${sha12(f.screen)}）——证据被改过，不是重放差异`);
    }
  }
  if (!c.provenance.startsWith('fixture')) {
    note(`${c.id}：provenance=「${c.provenance}」不是 fixture——这批判决是**裁判侧夹具**，冒充真证据就等于把自检项混进误报率的分母（A1）`);
  }
  if (!c.ear_source) note(`${c.id}：没声明 ear_source，"声音从哪来"没人认领`);
  // 逐帧 heard 与总声流必须同源：改了其中一份、留另一份"看起来没问题"，是最省事的一种造假
  for (const f of c.frames) {
    const a = f.heard.map((h) => `${h.seq}:${h.text}`).sort().join(',');
    const b = c.sounds.filter((s) => s.tick === f.tick).map((s) => `${s.seq}:${s.text}`).sort().join(',');
    if (a !== b) note(`${c.id}：第 ${f.tick} 帧的帧内 heard 与声流对不上（两份耳朵证据各说各话）`);
  }

  // ── 1. 重算 ──
  let rows: Row[];
  let beyond: number;
  let aligned: boolean;
  try {
    ({ rows, beyond, aligned } = rejudge(c));
  } catch (e) {
    note(`${c.id}：重算失败 —— ${(e as Error).message}`);
    continue;
  }

  const mine = toMatrix(rows);
  const got = toMatrix(c.got);
  const want: Matrix = {};
  for (const w of c.want) {
    if (!BUCKETS.includes(w.bucket as Bucket)) note(`${c.id}：人工期望里出现表外桶 ${w.bucket}（${w.key}）`);
    if (!(CUES as readonly string[]).includes(w.key) && !w.key.startsWith('cap:')) {
      note(`${c.id}：人工期望里出现表外对象 ${w.key}`);
    }
    want[w.key] ??= {};
    const cur = want[w.key]![w.bucket];
    if (cur !== undefined && cur !== w.n) note(`${c.id}：want 矩阵里 ${w.key}/${w.bucket} 出现两次且计数不同（${cur} vs ${w.n}）——人工期望表自己就抄乱了`);
    want[w.key]![w.bucket] = w.n;
  }

  // ── 2. 恒等式与自洽性：判据那边是抛错，这里是比对，两边都得有 ──
  for (const r of c.got) {
    if (!BUCKETS.includes(r.verdict as Bucket)) note(`${c.id}：判据落盘一条表外判决 ${r.verdict}（${r.key}）`);
    if (!(CUES as readonly string[]).includes(r.cue ?? '') && !r.key.startsWith('cap:')) {
      note(`${c.id}：判据落盘一条表外对象 ${r.key}（既不在八族里也不是容量差词条）`);
    }
  }
  const sumCounts = BUCKETS.reduce((s, b) => s + (c.gotCounts[b] ?? 0), 0);
  if (sumCounts !== c.got.length) note(`${c.id}：判据自报的五桶之和 ${sumCounts} ≠ 主张条数 ${c.got.length}（恒等式断裂）`);
  for (const b of BUCKETS) {
    const n = rows.filter((r) => r.verdict === b).length;
    if ((c.gotCounts[b] ?? 0) !== n) note(`${c.id}：${b} 桶条数 落盘=${c.gotCounts[b] ?? 0} 审计=${n}`);
  }
  if (!aligned) note(`${c.id}：屏幕帧号与账本错位（observe 出来的 tick 不等于第几帧）——逐帧对账不成立`);
  if (c.consistency.soundsBeyondScreen !== beyond) {
    note(`${c.id}：越界声音条数 落盘=${c.consistency.soundsBeyondScreen} 审计=${beyond}（"整条声流挪出屏幕账本"这件事本身对不上）`);
  }

  // ── 3. 三方对照 ──
  const dm = matrixDiff(mine, got);
  const dw = matrixDiff(mine, want);
  const diffs = dm.length ? rowDiff(rows, c.got) : [];
  const ok = dm.length === 0 && dw.length === 0;
  if (dm.length) {
    note(`${c.id}：审计重算 ≠ 判据落盘（${dm.join('、')}）`);
  }
  if (dw.length) {
    note(`${c.id}：审计重算 ≠ 人工期望（${dw.join('、')}）——要么判据与审计一起错，要么人读屏幕读错了`);
  }
  // 点名的逐条判决（帧号 + 族 + 侧 + 桶）：矩阵只保证条数，点名才保证"就在那一帧那一侧"
  for (const w of c.wantAt) {
    if (!BUCKETS.includes(w.verdict as Bucket)) note(`${c.id}：点名条目用了表外桶 ${w.verdict}`);
    const inMine = rows.some((r) => r.tick === w.tick && r.key === w.cue && r.side === w.side && r.verdict === w.verdict);
    const inGot = c.got.some((r) => r.tick === w.tick && r.key === w.cue && r.side === w.side && r.verdict === w.verdict);
    if (!inMine) note(`${c.id}：点名要第 ${w.tick} 帧 ${w.cue}[${w.side}]=${w.verdict}，审计重算里没有这一条`);
    if (!inGot) note(`${c.id}：点名要第 ${w.tick} 帧 ${w.cue}[${w.side}]=${w.verdict}，判据落盘里没有这一条`);
  }

  for (const k of Object.keys(mine)) {
    if (k.startsWith('cap:')) seenCap.add(k);
    else seenCue.add(k);
    for (const b of Object.keys(mine[k]!)) seenBucket.add(b);
  }
  const cnt = (b: Bucket): number => rows.filter((r) => r.verdict === b && !r.key.startsWith('cap:')).length;
  // 阴性对照的准入：声音必须是**发声层真放的**。人给声流那一格哪怕判决全绿也不算——
  // 它绿的是"我写的剧本和我写的判据一致"，不是"这个世界本来没毛病"。
  if (!c.ear_source?.startsWith('人给声流') && cnt('矛盾') === 0 && cnt('时钟错位') === 0 && cnt('相符') > 0) negatives.push(c.id);

  log(`  ${c.id.padEnd(5)} ${String(c.actions.length).padStart(2)} 帧｜主张 ${String(rows.length).padStart(3)}｜` +
    `${ok ? '✅ 三方一致' : '❌ 不一致'}｜${flat(mine).join('｜')}`);
  for (const m of diffs.slice(0, 6)) log(`      ↳ 逐条差异：${m}`);
  if (dw.length) log(`      ↳ 与人工期望差：${dw.join('、')}`);
}

// ─────────────────── 声明核对：rig 标签不许撒谎 ───────────────────

/**
 * 不 import 发声层，也能抓住"rig 标签与声流不符"：
 * 同一 (seed, 动作序列) 的两格，世界必须逐字节同一（rig 只改放不放这一声），
 * 所以它们的屏幕指纹序列必须一模一样；而**两格都自称"发声层真放的 R0"时，声流也必须一模一样**。
 * 把 S01 那格（脚步被删）的 rig 标签改成 R0，就会与 E04 撞成"两个 R0、两份声流"——当场出声。
 */
const groups = new Map<string, CaseIn[]>();
for (const c of doc.cases) {
  const k = `${c.seed}::${JSON.stringify(c.actions)}`;
  const l = groups.get(k);
  if (l) l.push(c);
  else groups.set(k, [c]);
}
for (const [k, cs] of groups) {
  if (cs.length < 2) continue;
  const sigs = new Set(cs.map((c) => c.frames.map((f) => f.sha).join(',')));
  if (sigs.size > 1) {
    note(`同一 (seed, 动作) 的两格屏幕不一样：${cs.map((c) => c.id).join('、')}（${k}）——rig 不该动世界一个字节，动了就是证据造假`);
  }
  const real = cs.filter((c) => !c.ear_source?.startsWith('人给声流') && c.rig.id === 'R0');
  if (real.length >= 2) {
    const streams = new Set(real.map((c) => c.sounds.map((s) => `${s.tick}:${s.text}`).sort().join(',')));
    if (streams.size > 1) {
      note(`两格都自称 R0（参考版发声层真放），声流却不同：${real.map((c) => c.id).join('、')}——rig 标签与证据不符`);
    }
  }
}

// ─────────────────── 覆盖率与阴性对照（§10 点名要求） ───────────────────

const missingCue = CUES.filter((x) => !seenCue.has(x));
const missingBucket = BUCKETS.filter((x) => !seenBucket.has(x));
const missingCap = CAPS.map((x) => `cap:${x}`).filter((x) => !seenCap.has(x));
if (missingCue.length) note(`审计重算里没有任何一条判决落在这些族上：${missingCue.join('、')}（零样本比对＝没比）`);
if (missingBucket.length) note(`审计重算里没有任何一条判决落进这些桶：${missingBucket.join('、')}`);
if (missingCap.length) note(`容量差词条里这些从没进过判决：${missingCap.join('、')}（免检的东西必须计数并说出口）`);

log(`\n族覆盖 ${CUES.length - missingCue.length}/${CUES.length}｜桶覆盖 ${BUCKETS.length - missingBucket.length}/${BUCKETS.length}｜容量差覆盖 ${CAPS.length - missingCap.length}/${CAPS.length}`);
log(`阴性对照（两通道都说对：零矛盾、零错位、有相符，且声音由发声层真放）：${negatives.length} 格 → ${negatives.join('、') || '（一格都没有）'}`);
if (negatives.length === 0) note('一批阴性对照都没有：审计只会拒绝，不会认"没错"——那和 print ✅ 没有区别（§10 点名的这条不许少）');
// 夹具自己声明的阴性对照名单，审计必须**独立算出同一份**。
// 两边名单不同 = 有一方把"有毛病"的那格认成了"没错"——那正是最要命的一类错。
if (!doc.negative) {
  note('证据文件没带顶层 negative 名单：阴性对照是谁认出来的没人说，审计只能自说自话');
} else {
  const a = [...doc.negative].sort().join('、');
  const b = [...negatives].sort().join('、');
  if (a !== b) note(`阴性对照名单不一致：夹具声明 ${a || '（空）'}｜审计重算 ${b || '（空）'}`);
}

// ─────────────────── 零泄漏自扫描 ───────────────────

const code = readFileSync(resolve(new URL(import.meta.url).pathname), 'utf8');
const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
const leaks: string[] = [];
for (const forbidden of ['world/ear', 'ear.ts', 'session.ts', 'arena.ts', 'sound.ts', 'mutants.ts']) {
  if (imports.some((p) => p.includes(forbidden))) leaks.push(`import 了 ${forbidden}（判据本体／被测系统，审计必须自己判一遍）`);
}
if (!imports.some((p) => p.includes('observe.ts'))) leaks.push('没有 import observe.ts：屏幕侧观测量从哪来？');
// 自扫描自己那一段不查（否则违禁词列表本身就是一处"命中"，红得毫无意义——detect-audit 首跑正是这样）
const cutIdx = code.indexOf('const imports =');
if (cutIdx < 0) leaks.push('扫描锚点 "const imports =" 不见了：这段自检已经失效，改结构时必须同步改它');
const judgeCode = cutIdx < 0 ? '' : code.slice(0, cutIdx);
for (const t of ['WorldState', 'internalState', 'situationHash', 'stateHash', 'coverage()', 'soundEvents()', 'GameSession']) {
  if (judgeCode.includes(t)) leaks.push(`判决逻辑里出现内部状态／被测系统字样：${t}（审计只许吃证据文件里的屏幕文本与声流）`);
}

// ─────────────────── 汇总 ───────────────────

if (leaks.length) {
  log('\n❌ 零泄漏自检：');
  for (const l of leaks) log(`   ${l}`);
}
if (bad.length) {
  log(`\n❌ ${bad.length} 处不一致／失效：`);
  for (const m of bad) log(`   ${m}`);
  process.exit(1);
}
log(`\n✅ ${doc.cases.length} 格三方一致（人工期望＝独立重算＝判据落盘），阴性对照 ${negatives.length} 格在列，且审计侧没 import 判据、没读内部状态。`);
