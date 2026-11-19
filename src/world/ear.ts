/**
 * 眼耳矛盾判据（M4-c 下半）：拿**屏幕**逐帧核对**声流**，把每一条主张落进五桶之一。
 *
 * 它回答的问题和 M4-f 不一样。M4-f 问「仪器能不能发现这个缺陷」，这里问
 * **「耳朵说的这句话，画面上对不对」**——这是本项目里唯一一条不需要知道正确答案、
 * 也不需要参考版就能出声的异常源：单局、无对照，只要两个通道互相打架就够（S09 的形状）。
 *
 * 五条纪律：
 *  1. **眼侧只认几何与 HUD，绝不认文案。** 判决输入是 `observe(屏幕)` 的逆投影量，
 *     而且**刻意不读 `刚在屏幕上出现的「刚才发生」那几行**——那是 `describe()` 的产物，
 *     与渲染层同源；读了它，"眼耳对账"就退化成"两段旁白互相抄"。
 *     这条由 `test/ear.test.ts` D3 静态守着（不 import sound/render、不出现 `.events`、不出现 `WorldState`）。
 *  2. **五桶互斥且穷尽，恒等式由抛错保证**（`bucketizeEar`）：
 *     主张总数 = 相符 + 矛盾 + 时钟错位 + 无法核对 + 容量差。
 *     分族之和同样必须等于总数。表外判决一律炸，不许静默丢掉一条（台账 #21 家族）。
 *  3. **耳朵能说的只有"次序与次数"，说得出数字的地方才核数字。**
 *     窸窣那句带数字（几处），于是它有一个**屏幕给得出的区间**可以卡；
 *     倒地声不带数字（死几个都只响一声），于是第二具尸体只能进**容量差**，
 *     判它"漏报"是判据在撒谎。血量掉几点、走到哪一格，同理。
 *  4. **时钟错位必须自己成一桶，且分母不变。** 内容对、时刻错的整族流（S10）若被逐帧读，
 *     每一帧都是"一缺一多"，满屏假矛盾——那正是路线图 M4 那一栏预言过的故障。
 *     所以先做整族位移解释，成则整族落「时钟错位」，每对仍记 2 条主张（两侧各一条），
 *     与「漏报 1 条 + 误报 1 条」**同一个分母**：换一种说法不许换一把尺子。
 *  5. **先注册词表、写死指纹，再计数**（与 `m4d-5` / `m4f-1` 同一条纪律，台账 #19）。
 *     顺序是：手写 `test/ear.test.ts` 真值表 → 实现 → 真值表全绿 → 才把 sha 写进
 *     `FROZEN_SHA256` → 才允许出任何统计。倒过来就变成看着数字调判据。
 *
 * ⚠️ 本文件与 `SOUND_MUTANTS` 里的变异体 id、`cue` 字段毫无关系：判决**不看**这一局是不是缺陷局。
 *    变异体归属只在汇总侧用（`src/m4f.ts` / `verify/ear-*.ts`），和 `lexicon.ts` 同一侧。
 */
import { createHash } from 'node:crypto';
import type { Action, Capabilities } from './arena.ts';
import { observe, type Observation } from './observe.ts';
import { GameSession } from './session.ts';

export const EAR_VERSION = 'm4c-1';
/** 冻结日期：真值表与指纹先于任何统计写下（纪律 5）。 */
export const FROZEN_AT = '2026-11-19';

// ─────────────────────────── 五桶与八族（先注册） ───────────────────────────

export type EarVerdict = '相符' | '矛盾' | '时钟错位' | '无法核对' | '容量差';
export const EAR_VERDICTS: readonly EarVerdict[] = ['相符', '矛盾', '时钟错位', '无法核对', '容量差'];

/**
 * 判决口径里「矛盾」只有两种形状，`why` 必须说清是哪一种：
 *  - **漏报**：眼睛看见这件事发生了，耳朵没出声。
 *  - **误报**：耳朵出声了，眼睛说这一帧不该有。
 * 两者的修法完全不同（触发条件写窄 vs 写宽），混成一个数就只是"不对"，不叫诊断。
 */
export type EarSide = '眼' | '耳' | '屏幕';

export type EarCue =
  | 'footstep' | 'wallBump' | 'swing' | 'killThud'
  | 'hurtGrunt' | 'pickupClick' | 'shuffle' | 'deathThud';

/** 表序即判决序：一帧固定产出这 8 行，谁也不许多一行、少一行。 */
export const EAR_CUES: readonly EarCue[] = [
  'footstep', 'wallBump', 'swing', 'killThud', 'hurtGrunt', 'pickupClick', 'shuffle', 'deathThud',
];

export interface CueDef {
  cue: EarCue;
  name: string;
  /** 现象文本的**全匹配**正则源串（进冻结指纹）。带捕获组的那一条同时登记"耳朵会说数字"。 */
  pattern: string;
  /** 眼侧依据：这一声到底凭什么画面事实才算"该响"。一句话，写不出来的族就不该存在。 */
  basis: string;
}

/**
 * 八族发声事件 → 眼侧依据。
 *
 * ⚠️ 这些文本是**判据自己登记的一份词表**，不是 import 自发声层：
 *    两侧同文本是"对得上"的前提，不是"各说各话"的证据——独立性体现在**依据**那一列，
 *    它只认屏幕，一句都不引用发声层的分支条件。
 */
export const EAR_CUE_TABLE: readonly CueDef[] = [
  { cue: 'footstep', name: '脚步', pattern: '一声脚步。', basis: '两帧屏幕上「@」所在格子不同（人确实挪了）。' },
  {
    cue: 'wallBump', name: '撞墙闷响', pattern: '一声闷响，像撞上了硬物。',
    basis: '动作是移动、屏幕上人没挪，且目标格在上一帧画面上是墙或压根不在图上。目标格是空地却挪不动 ⇒ 说不清。',
  },
  { cue: 'swing', name: '挥击破风', pattern: '一下破风声。', basis: '动作是攻击，且上一帧 HUD 写着「攻击：就绪」。' },
  {
    cue: 'killThud', name: '敌人倒地', pattern: '一声短促的倒地声。',
    basis: 'HUD 分数在帧间上涨（世界契约：一次击杀 +1 分，分数是屏幕上唯一能被"数出来"的击杀计数）。'
      + '⚠️ 可见「E」变少**不是**击杀证据：敌人可以走进玩家脚下被 @ 盖住，也可以叠到另一个敌人那一格上（首跑 C3 第 37 帧实测）。',
  },
  { cue: 'hurtGrunt', name: '受伤闷哼', pattern: '一声闷哼。', basis: 'HUD 血量在帧间下降。' },
  {
    cue: 'pickupClick', name: '拾取咔哒', pattern: '一声咔哒，像什么东西被拿了起来。',
    basis: '画面上有可见的「+」净消失，或做了拾取动作且血条上涨。⚠️ 脚下那格的「+」永远被「@」盖住（render 图层序），所以满血拾取原理上无法核对。',
  },
  {
    cue: 'shuffle', name: '敌人挪动的窸窣', pattern: '远处有 (\\d+) 处窸窣。',
    basis: '屏幕上有「E」的格子**确定空出来了**（既没被 @ 盖住、这一帧也没记到击杀）⇒ 那个人必定挪了位置。'
      + '数字只按 intervalRule 的**下界**核；集合一模一样 ⇒ 说不清（敌人没有名字，互换位置、叠进同一格都不留痕迹）。',
  },
  { cue: 'deathThud', name: '玩家倒地', pattern: '一记沉重的倒地声。', basis: 'HUD 状态从「活着」变成「已倒下」。' },
];

export interface CapacityDef {
  id: string;
  name: string;
  /** 为什么这一条耳朵原理上给不出主张 */
  basis: string;
}

/**
 * 容量差词条（进冻结指纹）。
 *
 * 这一桶是判据的**免检声明**：屏幕上明摆着有一件事，耳朵那条通道原理上说不出对应的主张，
 * 于是它既不是相符也不是矛盾。不登记它就会发生最坏的事——
 * 拿"死了两个只响一声"判出一条漏报，然后对外宣称发现了一个缺陷。
 * 台账 #21/#34 同族：**免检的东西必须计数并说出口，丢了就等于没这回事。**
 */
export const CAPACITY_ITEMS: readonly CapacityDef[] = [
  { id: 'playerCell', name: '走到哪一格', basis: '屏幕上「@」换了格子。耳朵只有"有没有脚步"，说不出走向哪一格。' },
  { id: 'hpPoints', name: '血量的点数', basis: 'HUD 血量在帧间变了 n 点。耳朵只有一声闷哼，说不出是几点。' },
  { id: 'scorePoints', name: '分数的增量', basis: 'HUD 分数在帧间涨了。涨几点这件事耳朵说不出来（倒地声不带数字），所以增量本身进容量差；至于"有没有击杀"，那是 killThud 那一族依分数判的主张，不在这里。' },
  { id: 'killCells', name: '死的是哪几格', basis: '分数涨了＝画面记到击杀。死了几个、死在哪一格，耳朵只有一声倒地，说不出。' },
  {
    id: 'killCollapse', name: '多具尸体挤进同一声',
    basis: '一帧内死 ≥2 个时只响一声（发声层按"有没有击杀"分支）。第 2..n 具进容量差，不许判成漏报。',
  },
  { id: 'enemyCells', name: '谁挪到了哪一格', basis: '屏幕上「E」的格子集合变了。耳朵只报"几处"，报不出是谁、挪到哪。' },
];

/** 窸窣数字的区间口径（写死进指纹：这套算法本身就是判决口径，藏在代码里就没人认领）。 */
export const EAR_INTERVAL_RULE = {
  cue: 'shuffle',
  vacated: 'Σ max(0, 前帧该格可见E − 后帧该格可见E)（按格子计数，同一格挤两个敌人只算一格）',
  occluded: 'vacated 里那些"后一帧被 @ 盖住"的格子数：人可能还在原地，不算证据',
  kills: 'max(0, 后帧分数 − 前帧分数)（屏幕上唯一数得出的击杀计数，见 EAR_CUE_TABLE.killThud）',
  lo: 'max(0, vacated − occluded − kills)',
  hi: null as number | null,
  whyInterval: 'lo 的算法：一个「E」格子确定空出来了、又没被 @ 盖住，那格上的敌人只可能"死了"或"挪走了"；'
    + 'kills 至多抵掉同样多个格子（死亡也可能发生在"前后都有 E"的格子上——别人挪了进去），所以至少 lo 个人挪了位置。',
  whyNoUpper: '⚠️ **刻意放弃上界**。屏幕上的「E」是"哪些格上有敌人"，不是"有几个敌人"：'
    + '两个敌人挤进同一格只画一个 E（首跑 C3 第 37 帧实测），所以藏起来的敌人数量屏幕永远数不出来，'
    + '任何按可见 E 数出来的上界都会凭空造出矛盾。第一版拿可见 E 的净减少当死亡数、第二版拿它当区间上界，'
    + '两版各在 40 帧的阴性对照里造出一条假矛盾（第 12 帧、第 37 帧）——已按"宁可放过，不许编造"改掉，代价见 blindSpot。',
  blindSpot: '盲区登记：耳朵把次数说多（例如"远处有 9 处窸窣"而画面只证明 1 处）在这一族**不会被发现**，只记相符。',
  positive: 'lo ≥ 1 ⇒ 眼睛证明有人挪了（该响）；耳朵那句里的数字 n < lo ⇒ 矛盾（少报），n ≥ lo ⇒ 相符',
  silent: 'lo = 0 ⇒ 说不清（屏幕说不出这一帧到底有没有人挪过：换位、叠格、原地待着，三种形状画面上一样）',
} as const;

/** 整族位移解释的口径（纪律 4）。 */
export const EAR_SHIFT_RULE = {
  scope: '逐族（cue）整体核对，**先于**逐帧配对',
  require: '该族「眼睛说该响的帧号多重集」+ D = 「耳朵听到该族的帧号多重集」，且 D ≠ 0',
  minOccurrences: 3,
  claimsPerPair: 2,
  why: '少于 3 次无从区分"整族挪 D 帧"与"两笔互不相干的一缺一多"；每对记 2 条主张（两侧各一条），保证与「漏报+误报」同分母。',
  inherit: '闸门只认次数，不认"这一局一共响了几声"。倒地声、破风声一局往往只响一两次，永远够不着 3 次。'
    + '所以过闸的族若**全部指向同一个 D**（D 不唯一 ⇒ 放弃继承），就把同一个 D 借给没过闸的族：'
    + '该响的帧 t 上没有声、而 t+D 上有一声还没被销账的同类 ⇒ 两侧各记一条时钟错位并销账；配不上的照旧落进逐帧配对。',
  whyInherit: '位移是**整条录音**的属性，不是每一族各自的属性：S10 那种"晚一帧"对所有族都是同一个 D。'
    + '不继承，样本少的族就会把一缺一多各判成一条矛盾——一个时钟 bug 被读成两起事实矛盾，正是纪律 4 要防的事。',
  inheritCost: '代价如实登记：一族自己的偶发误报，若恰好落在别的族证明的 D 上，会被赦成时钟错位。'
    + '换到的是"整局错位不再冒充事实矛盾"，付出的是"错位局里的小族误报不再单独出声"。',
} as const;

/** 玩家倒下之后那一族帧的口径（写进指纹，别让它只活在 if 分支里）。 */
export const EAR_AFTER_DEATH = {
  status: '说不清',
  why: '倒下之后世界仍在推进（tick 会走），但"死后还播不播声音"是发声层的设计决定，不是画面事实。硬判成漏报＝判据替屏幕规定规矩。',
} as const;

// ─────────────────────────── 眼侧：两帧屏幕 + 一个动作 ───────────────────────────

export type EyeStatus = '该响' | '不该响' | '说不清';

export interface EyeRow {
  cue: EarCue;
  status: EyeStatus;
  /** 人话：这一行的依据是什么、为什么核不了 */
  note: string;
  /** 只有窸窣族带区间：耳朵那句里的数字要落在这里面。`hi = null` = 屏幕给不出上界（见 EAR_INTERVAL_RULE.whyNoUpper）。 */
  interval: [number, number | null] | null;
}

const key = (c: [number, number]): string => `${c[0]},${c[1]}`;

function tally(cells: [number, number][]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cells) m.set(key(c), (m.get(key(c)) ?? 0) + 1);
  return m;
}

interface CellDiff {
  /** 前一帧画得出来、这一帧没了的格数（含被玩家踩住的那种） */
  vacated: number;
  /** 其中"其实是被人/怪盖住、不能说消失"的格数 */
  occluded: number;
  arrived: number;
  stayed: number;
  prevTotal: number;
  nextTotal: number;
}

/** 两帧屏幕上某一族符号的格子差。occluders = 这一帧会把下层符号盖住的格子。 */
function diffCells(prev: [number, number][], next: [number, number][], occluders: Set<string>): CellDiff {
  const a = tally(prev);
  const b = tally(next);
  let vacated = 0; let occluded = 0; let arrived = 0; let stayed = 0;
  for (const [k, n] of a) {
    const m = b.get(k) ?? 0;
    if (n > m) {
      vacated += n - m;
      if (occluders.has(k)) occluded += n - m;
    }
    stayed += Math.min(n, m);
  }
  for (const [k, n] of b) if (!a.has(k)) arrived += n;
  return {
    vacated, occluded, arrived, stayed,
    prevTotal: [...a.values()].reduce((s, n) => s + n, 0),
    nextTotal: [...b.values()].reduce((s, n) => s + n, 0),
  };
}

const row = (cue: EarCue, status: EyeStatus, note: string, interval: [number, number | null] | null = null): EyeRow =>
  ({ cue, status, note, interval });

/**
 * 眼侧"这一帧死了几个敌人"。
 *
 * 屏幕上唯一数得出击杀的东西是 **HUD 分数**（世界契约 `scoreOnKill`：一次击杀 +1 分）。
 * 可见「E」的个数**不能**当击杀计数，两种隐藏都留不下痕迹：
 *  - 敌人走进玩家脚下，被最后画的「@」盖住；
 *  - 敌人叠到另一个敌人那一格上，两个 E 只画一个（首跑 C3 第 37 帧实测，判据据此凭空造出一条假矛盾）。
 * 分数读不出来或倒挂 ⇒ null：眼睛在这一项上失明，宁可说不清，不许猜。
 */
function killCount(prev: Observation, next: Observation): number | null {
  if (prev.score === null || next.score === null) return null;
  const d = next.score - prev.score;
  return d < 0 ? null : d;
}

/**
 * 一帧的眼侧判决表：八族各一行，顺序固定 = `EAR_CUES`。
 *
 * ⚠️ 只看 `observe()` 给得出的东西，且**只认净变化**：
 *    屏幕是有损投影（render 的图层序：物品 → 敌人 → 玩家，而且同一格只画一个符号），
 *    所以"少了一个符号"有四种解释（真没了 / 被玩家盖住 / 被同族的另一个敌人盖住 / 被别的符号换走），
 *    分不开就必须说"说不清"，不许挑一种解释硬判（纪律 3 的另一面）。
 */
export function eyeFrame(prev: Observation, action: Action, next: Observation): EyeRow[] {
  // ── 倒下之后一律说不清（EAR_AFTER_DEATH）──
  if (prev.alive === false) {
    return EAR_CUES.map((cue) => row(cue, '说不清', '玩家已经倒下：这一帧之后的声音契约是设计决定，不是画面事实'));
  }

  const out: EyeRow[] = [];

  // ── footstep / wallBump：靠「@」的格子 ──
  const p0 = prev.player;
  const p1 = next.player;
  if (!p0 || !p1) {
    out.push(row('footstep', '说不清', '屏幕上数不出玩家在哪个格子'));
    out.push(row('wallBump', '说不清', '屏幕上数不出玩家在哪个格子'));
  } else {
    const moved = p0[0] !== p1[0] || p0[1] !== p1[1];
    out.push(moved
      ? row('footstep', '该响', `屏幕上玩家从 (${p0[0]},${p0[1]}) 换到 (${p1[0]},${p1[1]})`)
      : row('footstep', '不该响', '屏幕上玩家没有换格子'));

    if (action.kind !== 'move') out.push(row('wallBump', '不该响', '这一帧没做移动动作'));
    else if (moved) out.push(row('wallBump', '不该响', '人挪了，就不算撞上'));
    else {
      const size = prev.size;
      const tx = p0[0] + (action.dir === 1 ? 1 : action.dir === 3 ? -1 : 0);
      const ty = p0[1] + (action.dir === 0 ? -1 : action.dir === 2 ? 1 : 0);
      if (size === null) out.push(row('wallBump', '说不清', '屏幕边长读不出来，判不了"出界"'));
      else if (tx < 0 || ty < 0 || tx >= size || ty >= size) out.push(row('wallBump', '该响', `目标格 (${tx},${ty}) 压根不在画面上`));
      else {
        const k = `${tx},${ty}`;
        const shown = (list: [number, number][]) => list.some((c) => key(c) === k);
        if (shown(prev.walls)) out.push(row('wallBump', '该响', `目标格 (${tx},${ty}) 画面上是墙，人却没挪`));
        else if (shown(prev.enemies) || shown(prev.pickups)) {
          out.push(row('wallBump', '说不清', `目标格 (${tx},${ty}) 画面上是敌人/物品，眼睛说不出它挡不挡路`));
        } else out.push(row('wallBump', '说不清', `目标格 (${tx},${ty}) 是空地却挪不动：眼睛说不出这声闷响该不该有`));
      }
    }
  }

  // ── swing ──
  if (action.kind !== 'attack') out.push(row('swing', '不该响', '这一帧没出手'));
  else if (prev.attackReady === null) out.push(row('swing', '说不清', 'HUD 上读不出攻击是否就绪'));
  else if (prev.attackReady) out.push(row('swing', '该响', '上一帧 HUD「攻击：就绪」，这一帧出了手'));
  else out.push(row('swing', '不该响', '上一帧 HUD「攻击：冷却中」，这一下没结算'));

  // ── 敌人格子差（玩家会盖住 E；E 自己也会盖住 E）──
  const playerNext = p1 ? new Set([key(p1)]) : new Set<string>();
  const eDiff = diffCells(prev.enemies, next.enemies, playerNext);
  /** 确定空出来的格子：原先画着 E、这一帧没画，而且不是被玩家站上去盖住的 */
  const definitelyLeft = eDiff.vacated - eDiff.occluded;
  const kills = killCount(prev, next);

  // ── killThud：只认分数，不认"少了一个 E"（见 killCount 那段注释）──
  if (kills === null) {
    out.push(row('killThud', '说不清', 'HUD 分数那一栏读不出来（或倒挂）：眼睛数不出这一帧有没有击杀'));
  } else if (kills >= 1) {
    out.push(row('killThud', '该响', `分数从 ${prev.score} 涨到 ${next.score}：画面记到 ${kills} 次击杀`));
  } else {
    out.push(row('killThud', '不该响', eDiff.vacated > 0
      ? `分数没有涨＝画面没记到击杀；可见「E」少了 ${eDiff.vacated} 格只说明那些格上没敌人了（死了、被 @ 盖住、叠进另一格、单纯挪走，画面分不开）`
      : '分数没有涨＝画面没记到击杀'));
  }

  // ── hurtGrunt ──
  if (prev.hp === null || next.hp === null) out.push(row('hurtGrunt', '说不清', 'HUD 血量读不出来'));
  else if (next.hp < prev.hp) out.push(row('hurtGrunt', '该响', `血条从 ${prev.hp} 掉到 ${next.hp}`));
  else out.push(row('hurtGrunt', '不该响', '血条没有下降'));

  // ── pickupClick ──
  // '+' 会被 E 和 @ 两层盖住，所以"消失"必须扣掉这些遮蔽才算证据。
  const coverNext = new Set<string>(playerNext);
  for (const c of next.enemies) coverNext.add(key(c));
  const plusDiff = diffCells(prev.pickups, next.pickups, coverNext);
  const takenVisibly = plusDiff.vacated - plusDiff.occluded > 0;
  const hpRose = prev.hp !== null && next.hp !== null && next.hp > prev.hp;
  if (takenVisibly) out.push(row('pickupClick', '该响', `画面上有 ${plusDiff.vacated - plusDiff.occluded} 格「+」净消失了`));
  else if (action.kind === 'pickup' && hpRose) out.push(row('pickupClick', '该响', `做了拾取动作且血条从 ${prev.hp} 涨到 ${next.hp}`));
  else if (action.kind === 'pickup') out.push(row('pickupClick', '说不清', '做了拾取动作，但血条没涨、脚下那格又被 @ 盖着：画面说不出拿没拿'));
  else out.push(row('pickupClick', '不该响', '这一帧没做拾取动作，画面上也没有物品净消失'));

  // ── shuffle（唯一带数字的一族，且**只有下界**）──
  // 一格确定空出来 = 上面那个人要么死了、要么挪了；把画面记到的击杀数抵掉，剩下的就是"证明挪走的人"。
  // 上界给不出：藏起来的敌人（被 @ 盖的、叠格的）屏幕数不出个数，所以数字只核 n ≥ lo。
  if (kills === null) {
    out.push(row('shuffle', '说不清', 'HUD 分数读不出来：空出来的那一格是死了还是挪了，眼睛分不开'));
  } else {
    const lo = Math.max(0, definitelyLeft - kills);
    out.push(lo >= 1
      ? row('shuffle', '该响', `画面上至少 ${lo} 个敌人确定离开了原来那一格（屏幕给不出上界，见 EAR_INTERVAL_RULE.whyNoUpper）`, [lo, null])
      : row('shuffle', '说不清', eDiff.vacated === 0
        ? '两帧的「E」格子集合看不出差别：敌人没有名字，互换位置、叠进同一格都不留痕迹'
        : `空出来 ${eDiff.vacated} 格里 ${eDiff.occluded} 格是被 @ 盖住的，其余又能被 ${kills} 次击杀抵掉：眼睛说不出还有没有人挪动`));
  }

  // ── deathThud ──
  if (prev.alive === null || next.alive === null) out.push(row('deathThud', '说不清', 'HUD 状态行读不出来'));
  else if (prev.alive && !next.alive) out.push(row('deathThud', '该响', 'HUD 状态从「活着」变成「已倒下」'));
  else out.push(row('deathThud', '不该响', '这一帧没有倒下'));

  // 表序必须等于 EAR_CUES（真值表 A15 钉着这条）
  return EAR_CUES.map((cue) => out.find((r) => r.cue === cue)!);
}

// ─────────────────────────── 容量差：屏幕有数、耳朵无数 ───────────────────────────

export interface CapacityHit { id: string; count: number; note: string }

/** 这一帧里，屏幕上发生了、而耳朵那条通道原理上说不出主张的事。 */
export function capacityFrame(prev: Observation, next: Observation): CapacityHit[] {
  const hits: CapacityHit[] = [];
  const p0 = prev.player;
  const p1 = next.player;
  if (p0 && p1 && (p0[0] !== p1[0] || p0[1] !== p1[1])) {
    hits.push({ id: 'playerCell', count: 1, note: `屏幕上看得出走到了 (${p1[0]},${p1[1]})，这声脚步之外耳朵说不出格子` });
  }
  if (prev.hp !== null && next.hp !== null && prev.hp !== next.hp) {
    hits.push({ id: 'hpPoints', count: 1, note: `血条帧间差 ${next.hp - prev.hp} 点：耳朵只有一声闷哼，没有刻度` });
  }
  if (prev.score !== null && next.score !== null && next.score > prev.score) {
    hits.push({ id: 'scorePoints', count: 1, note: `分数涨了 ${next.score - prev.score} 点：倒地声不带数字` });
  }
  const playerNext = p1 ? new Set([key(p1)]) : new Set<string>();
  const eDiff = diffCells(prev.enemies, next.enemies, playerNext);
  const kills = killCount(prev, next);
  if (kills !== null && kills >= 1) {
    hits.push({ id: 'killCells', count: 1, note: `画面记到 ${kills} 次击杀（分数 +${kills}）：耳朵说不出死的是哪一格` });
    if (kills >= 2) hits.push({ id: 'killCollapse', count: kills - 1, note: `${kills} 次击杀挤进同一声倒地声，第 2..${kills} 次没有对应的声音` });
  }
  if (eDiff.vacated + eDiff.arrived > 0) {
    hits.push({ id: 'enemyCells', count: 1, note: '「E」的格子集合变了，变成什么样耳朵报不出来' });
  }
  return hits;
}

// ─────────────────────────── 主张、判决与恒等式 ───────────────────────────

export interface EarSound { tick: number; seq: number; text: string }

export interface FrameInput {
  tick: number;
  /** false = 这一帧在屏幕账本里不存在（声流被整体挪到了末尾之外，或挪到了第 0 帧之前） */
  inRange: boolean;
  prev: Observation;
  action: Action;
  next: Observation;
  heard: EarSound[];
}

export interface EarClaim {
  /** 判决对象的身份：发声族 id，或容量差词条 id（`cap:xxx`） */
  key: string;
  cue: EarCue | null;
  tick: number;
  side: EarSide;
  /** 耳朵听到的原文；眼侧/屏幕侧主张为 null */
  text: string | null;
  verdict: EarVerdict;
  /** 人话判决理由：把用到的画面事实原样写进去，人工复核一眼能读懂"它凭什么这么判" */
  why: string;
  /** 时钟错位的位移帧数（其余桶为 null） */
  shift: number | null;
}

const COMPILED: Map<EarCue, RegExp> = new Map(
  EAR_CUE_TABLE.map((d) => [d.cue, new RegExp(`^(?:${d.pattern})$`)]),
);
/** 带捕获组的同一批正则：只用来把「远处有 N 处」里的 N 取出来。 */
const CAPTURED: Map<EarCue, RegExp> = new Map(
  EAR_CUE_TABLE.map((d) => [d.cue, new RegExp(`^${d.pattern}$`)]),
);

/** 现象文本 → 哪一族。认不出来必须炸：那是判据词表有洞，静默丢掉＝这一条根本没被核对过。 */
function cueOfText(text: string): EarCue {
  const hit = EAR_CUE_TABLE.find((d) => COMPILED.get(d.cue)!.test(text));
  if (!hit) {
    throw new Error(`耳朵听见一句判据词表之外的话：「${text}」。表外文本一律拒绝出统计（要么登记进 EAR_CUE_TABLE，要么修发声层，不许悄悄丢掉它）`);
  }
  return hit.cue;
}

/** 带数字的那一句里的数字（窸窣几处）。词表登记了捕获组却取不出来 = 词表与实现分叉，炸。 */
function cueNumber(cue: EarCue, text: string): number | null {
  const m = CAPTURED.get(cue)!.exec(text);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n)) throw new Error(`现象文本「${text}」里的「${m[1]}」换算不出整数`);
  return n;
}

export interface EarBuckets {
  counts: Record<EarVerdict, number>;
  byKey: Record<string, Record<EarVerdict, number>>;
}

const zero = (): Record<EarVerdict, number> =>
  Object.fromEntries(EAR_VERDICTS.map((v) => [v, 0])) as Record<EarVerdict, number>;

/**
 * 判决列表 → 五桶 + 分族五桶，并**当场核恒等式**。
 * 表外判决、分族断裂、总数对不上，一律抛错：宁可崩，也不许带着偏小的分母出报告。
 */
export function bucketizeEar(claims: readonly EarClaim[]): EarBuckets {
  const counts = zero();
  const byKey: Record<string, Record<EarVerdict, number>> = {};
  for (const c of claims) {
    if (!EAR_VERDICTS.includes(c.verdict)) throw new Error(`判决表外：${String(c.verdict)}（不在 ${EAR_VERDICTS.join('/')} 里）`);
    if (!(EAR_CUES as readonly string[]).includes(c.cue ?? '') && !c.key.startsWith('cap:')) {
      throw new Error(`判决对象表外：${c.key}（既不在八族 ${EAR_CUES.join('/')} 里，也不是容量差词条）`);
    }
    counts[c.verdict]++;
    (byKey[c.key] ??= zero())[c.verdict]++;
  }
  const sum = EAR_VERDICTS.reduce((s, v) => s + counts[v], 0);
  if (sum !== claims.length) throw new Error(`恒等式断裂：五桶之和 ${sum} ≠ 主张总数 ${claims.length}`);
  const perKey = Object.values(byKey).reduce((s, r) => s + EAR_VERDICTS.reduce((x, v) => x + r[v], 0), 0);
  if (perKey !== claims.length) throw new Error(`分族恒等式断裂：各族之和 ${perKey} ≠ 主张总数 ${claims.length}`);
  return { counts, byKey };
}

/**
 * 整族位移解释（纪律 4 的实现）。成 → 返回位移帧数 D；不成 → null，交回逐帧配对。
 *
 * 刻意要求**多重集逐位相等**：只缺一两声、只多一两声的形状不配叫"错位"。
 * 闸门次数（`minOccurrences`）是结构量、不是负载量——它随轨迹长度单调，不随机器忙闲变化。
 */
function wholeStreamShift(expected: readonly number[], heard: readonly number[]): number | null {
  if (expected.length < EAR_SHIFT_RULE.minOccurrences) return null;
  if (expected.length !== heard.length) return null;
  const a = [...expected].sort((x, y) => x - y);
  const b = [...heard].sort((x, y) => x - y);
  const d = b[0]! - a[0]!;
  if (d === 0) return null;
  for (let i = 1; i < a.length; i++) if (b[i]! - a[i]! !== d) return null;
  return d;
}

/** 一次待配对：耳朵的一声 + 它归属的那一族。 */
interface Heard {
  sound: EarSound;
  cue: EarCue;
  tick: number;
}

const identity = (h: Heard): string => `${h.cue}@${h.tick}#${h.sound.seq}`;

/**
 * 一批帧 → 逐条主张 + 五桶。
 *
 * 主张的**计量单位**：一次通道发声（channel occurrence）。
 * 两通道在同一帧对同一族说上了 ⇒ 2 条主张、都记「相符」；
 * 只剩一侧 ⇒ 1 条（漏报记在眼侧、误报记在耳侧）；
 * 整族错位 ⇒ 仍然 2 条（一侧一条），与"一缺一多"同分母；
 * 屏幕独有的量化事实 ⇒ 1 条，记「容量差」，不占上面那个等式，单独列明。
 */
export function judgeEar(frames: readonly FrameInput[]): { claims: EarClaim[] } & EarBuckets {
  const seen = new Set<number>();
  for (const f of frames) {
    if (seen.has(f.tick)) throw new Error(`帧号重复：第 ${f.tick} 帧在账本里出现了两次——两份逐帧证据错位，判决不可信`);
    seen.add(f.tick);
  }

  const claims: EarClaim[] = [];
  const rowsByTick = new Map<number, EyeRow[]>();
  const heardByCue = new Map<EarCue, Heard[]>();
  for (const cue of EAR_CUES) heardByCue.set(cue, []);

  for (const f of frames) {
    const rows: EyeRow[] = f.inRange
      ? eyeFrame(f.prev, f.action, f.next)
      // 这一帧在屏幕账本里不存在：眼睛无从说话，耳朵的每一声都只能记无法核对
      : EAR_CUES.map((cue) => row(cue, '说不清', `第 ${f.tick} 帧不在屏幕账本里：眼睛没有这一帧，谁也无从核对`));
    rowsByTick.set(f.tick, rows);

    if (f.inRange) {
      for (const cap of capacityFrame(f.prev, f.next)) {
        const def = CAPACITY_ITEMS.find((d) => d.id === cap.id)!;
        for (let i = 0; i < cap.count; i++) {
          claims.push({
            key: `cap:${cap.id}`, cue: null, tick: f.tick, side: '屏幕', text: null,
            verdict: '容量差', why: `${def.name}：${cap.note}`, shift: null,
          });
        }
      }
    }

    for (const s of [...f.heard].sort((x, y) => x.seq - y.seq)) {
      const cue = cueOfText(s.text);
      heardByCue.get(cue)!.push({ sound: s, cue, tick: f.tick });
    }
  }

  const pushEar = (h: Heard, verdict: EarVerdict, why: string, shift: number | null = null): void => {
    claims.push({
      key: h.cue, cue: h.cue, tick: h.tick, side: '耳', text: h.sound.text, verdict, shift, why,
    });
  };

  // ── 第一遍：每一族先试整族位移解释；不成才落到逐帧配对（纪律 4）──
  // 两侧都要销账：只销耳侧的话，第二遍会拿同一个事件再记一笔"漏报"，
  // 一处分叉落进两个桶（台账 #13 家族：一个事实两个主人）。
  const consumed = new Set<string>();
  const consumedEye = new Set<string>();
  const established = new Map<EarCue, number>();
  const shiftClaim = (cue: EarCue, eyeTick: number, h: Heard, d: number, note: string): void => {
    consumed.add(identity(h));
    consumedEye.add(`${cue}@${eyeTick}`);
    claims.push({
      key: cue, cue, tick: eyeTick, side: '眼', text: null, verdict: '时钟错位', shift: d,
      why: `第 ${eyeTick} 帧眼睛说该响（${note}），这一声却落在了第 ${h.tick} 帧`,
    });
    pushEar(h, '时钟错位', `第 ${h.tick} 帧听到「${h.sound.text}」，屏幕上对得上的是第 ${eyeTick} 帧（整族差 ${d > 0 ? `+${d}` : d} 帧）`, d);
  };
  for (const cue of EAR_CUES) {
    const expected: number[] = [];
    for (const f of frames) {
      if (rowsByTick.get(f.tick)!.find((x) => x.cue === cue)!.status === '该响') expected.push(f.tick);
    }
    const heard = heardByCue.get(cue)!;
    const d = wholeStreamShift(expected, heard.map((h) => h.tick));
    if (d === null) continue;
    established.set(cue, d);
    const expSorted = [...expected].sort((x, y) => x - y);
    const heardSorted = [...heard].sort((x, y) => x.tick - y.tick);
    for (let i = 0; i < expSorted.length; i++) {
      const t = expSorted[i]!;
      const h = heardSorted[i]!;
      shiftClaim(cue, t, h, d, rowsByTick.get(t)!.find((x) => x.cue === cue)!.note);
    }
  }

  // ── 第 1.5 遍：把已经证明的整局位移 D 借给没过闸门的族（EAR_SHIFT_RULE.inherit）──
  const ds = [...new Set(established.values())];
  const D = ds.length === 1 ? ds[0]! : null;
  if (D !== null) {
    for (const cue of EAR_CUES) {
      if (established.has(cue)) continue;
      const pool = heardByCue.get(cue)!.filter((h) => !consumed.has(identity(h)));
      const eyeTicks: number[] = [];
      for (const f of frames) {
        if (!f.inRange || consumedEye.has(`${cue}@${f.tick}`)) continue;
        const r = rowsByTick.get(f.tick)!.find((x) => x.cue === cue)!;
        if (r.status === '该响') eyeTicks.push(f.tick);
      }
      for (const t of eyeTicks.sort((x, y) => x - y)) {
        const h = pool.find((x) => x.tick === t + D && !consumed.has(identity(x)));
        if (!h) continue;
        shiftClaim(cue, t, h, D, `${rowsByTick.get(t)!.find((x) => x.cue === cue)!.note}（本族没过闸门，D 取自 ${[...established.keys()].join('/')}）`);
      }
    }
  }

  // ── 第二遍：逐帧配对 ──
  for (const f of frames) {
    const rows = rowsByTick.get(f.tick)!;
    const pending = heardByCueGet(heardByCue, f.tick).filter((h) => !consumed.has(identity(h)));
    for (const cue of EAR_CUES) {
      const r = rows.find((x) => x.cue === cue)!;
      const hits = pending.filter((h) => h.cue === cue);
      if (r.status === '该响') {
        const first = hits[0];
        if (!first) {
          if (consumedEye.has(`${cue}@${f.tick}`)) continue;   // 已由整族错位销账
          claims.push({
            key: cue, cue, tick: f.tick, side: '眼', text: null, verdict: '矛盾', shift: null,
            why: `漏报：${r.note}，耳朵这一帧一声不响`,
          });
        } else {
          const n = cueNumber(cue, first.sound.text);
          const lo = r.interval?.[0] ?? 0;
          const hi = r.interval?.[1] ?? null;
          const off = cue === 'shuffle' && r.interval !== null && (n === null || n < lo || (hi !== null && n > hi));
          const eyeWhy = off
            ? `数字对不上：${first.sound.text} 落在画面下界之外（屏幕至少证明 ${lo} 处，它说 ${n}）`
            : `${r.note}，耳朵这一帧也说上了（数字 ${n} 未低于下界；上界屏幕给不出，见 EAR_INTERVAL_RULE.whyNoUpper）`;
          claims.push({ key: cue, cue, tick: f.tick, side: '眼', text: null, verdict: off ? '矛盾' : '相符', shift: null, why: eyeWhy });
          pushEar(first, off ? '矛盾' : '相符', off
            ? `「${first.sound.text}」：${eyeWhy}`
            : `听到「${first.sound.text}」，与这一帧的画面事实同一`);
        }
        // 屏幕一帧只支持一次：多出来的同族声音一律耳侧独多
        for (const h of hits.slice(1)) pushEar(h, '矛盾', `误报：同一帧的第二声「${h.sound.text}」，屏幕上这一帧只有一次依据`);
      } else if (r.status === '不该响') {
        for (const h of hits) pushEar(h, '矛盾', `误报：${r.note}`);
      } else {
        for (const h of hits) pushEar(h, '无法核对', r.note);
      }
    }
  }

  return { claims, ...bucketizeEar(claims) };
}

/** 某一帧上耳朵响过的所有声（跨族收集，配对时再按族切）。 */
function heardByCueGet(heardByCue: Map<EarCue, Heard[]>, tick: number): Heard[] {
  const out: Heard[] = [];
  for (const cue of EAR_CUES) for (const h of heardByCue.get(cue)!) if (h.tick === tick) out.push(h);
  return out.sort((x, y) => x.sound.seq - y.sound.seq);
}

// ─────────────────────────── 重放接线（只取屏幕） ───────────────────────────

export interface EarRunInput {
  seed: number;
  actions: readonly Action[];
  /** 耳朵那份证据（sound.jsonl 的内容）。判据不参与生成它。 */
  sounds: readonly EarSound[];
  /** 世界能力（缺陷局与参考局共用同一段判决代码） */
  caps?: Capabilities;
}

export interface EarFramesResult {
  frames: FrameInput[];
  claims: EarClaim[];
  counts: Record<EarVerdict, number>;
  byKey: Record<string, Record<EarVerdict, number>>;
  /** 证据自洽性：屏幕流、动作流、帧号三者必须对齐，对不上时判决全部不可信 */
  consistency: { actions: number; screens: number; tickAligned: boolean; soundsBeyondScreen: number };
}

/**
 * 用动作序列重放出屏幕流，配上已落盘的声流，出一次判决。
 *
 * 为什么这里可以复用 `GameSession`：它是**被测的世界**，不是判决者（与 `detect.ts` 同一条理由）。
 * 判据只从它身上取 `screen()` 这一样东西，然后立刻交给 `observe()` 逆投影；
 * 内部状态、逐帧现象文案、声音账本一概不读——所以 session 里装着发声层这件事
 * 不会让"眼耳对账"变成自我复读：耳朵那侧的证据是**调用方从 sound.jsonl 传进来的**。
 *
 * 帧范围会向两头扩到声流的实际帧号（S10 那种整体挪移会把声音推到末尾之外）：
 * 扩出来的那些帧 `inRange=false`，眼睛根本没这一帧 ⇒ 一律无法核对，不许冒充矛盾。
 */
export async function earFrames(opts: EarRunInput): Promise<EarFramesResult> {
  const session = new GameSession(opts.seed, opts.caps);
  const screens = [session.screen()];
  for (const a of opts.actions) screens.push((await session.apply(a)).screen);
  const T = opts.actions.length;
  const screenAt = (t: number): Observation => observe(screens[Math.max(0, Math.min(T, t))]!);

  let lo = 1;
  let hi = T;
  const byTick = new Map<number, EarSound[]>();
  for (const s of opts.sounds) {
    lo = Math.min(lo, s.tick);
    hi = Math.max(hi, s.tick);
    const list = byTick.get(s.tick);
    if (list) list.push(s);
    else byTick.set(s.tick, [s]);
  }

  const frames: FrameInput[] = [];
  let tickAligned = true;
  for (let t = lo; t <= hi; t++) {
    const inRange = t >= 1 && t <= T;
    const next = screenAt(t);
    if (inRange && next.tick !== t) tickAligned = false;
    frames.push({
      tick: t, inRange,
      prev: screenAt(t - 1), next,
      action: inRange ? opts.actions[t - 1]! : { kind: 'wait' },
      heard: (byTick.get(t) ?? []).slice().sort((x, y) => x.seq - y.seq),
    });
  }

  const judged = judgeEar(frames);
  return {
    frames, ...judged,
    consistency: {
      actions: T, screens: screens.length, tickAligned,
      soundsBeyondScreen: opts.sounds.filter((s) => s.tick > T || s.tick < 1).length,
    },
  };
}

// ─────────────────────────── 冻结指纹 ───────────────────────────

/**
 * 进指纹：八族的现象文本与眼侧依据、六条容量差词条、窸窣区间算法、整族位移口径、
 * 倒下之后的口径、五桶名单、版本。
 * 不进指纹：`eyeFrame` / `judgeEar` 的实现。它们由两头夹住——
 *   test/ear.test.ts 的手写真值表（写表在前、实现随后）
 *   verify/ear-audit.ts 的独立重放重判（不 import 本文件）
 * 改任何一个字都得先升版本、重出统计（台账 #19）。
 */
export function earCanonical(): string {
  return JSON.stringify({
    version: EAR_VERSION,
    buckets: EAR_VERDICTS,
    cues: EAR_CUE_TABLE.map((d) => ({ cue: d.cue, name: d.name, pattern: d.pattern, basis: d.basis })),
    capacityItems: CAPACITY_ITEMS.map((d) => ({ id: d.id, name: d.name, basis: d.basis })),
    intervalRule: EAR_INTERVAL_RULE,
    shiftRule: EAR_SHIFT_RULE,
    afterDeath: EAR_AFTER_DEATH,
  });
}

export function earSha(): string {
  return createHash('sha256').update(earCanonical(), 'utf8').digest('hex');
}

/**
 * 冻结时的指纹（m4c-1）。
 * ⚠️ 冻结依据：`test/ear.test.ts` 的 31 条真值表 / 判决表**先写先红**（模块不存在 → 实现 → 逐条读屏幕修正），
 *    A1～A15 每一格期望值都是人对着两帧屏幕手工读出来的；没有一条从本文件的输出里回填。
 *    📌 顺序：写死这一行 → 单测全绿 → **才**跑出任何统计（§ear 纪律 5）。
 *    这份口径在冻结前被自己的阴性对照打回来过两次（可见 E 净减少 ≠ 死亡数、叠格数不出来），
 *    两次都改的是判据而不是期望值 —— 细节见 M4-C-FINDINGS.md §10 与故障台账。
 */
export const FROZEN_SHA256 = '13b13bb75f7b0a0ea7f20c822656dbc4b9574819745047bb30776c825f7ef2ee';

export function earDrift(): string | null {
  const now = earSha();
  return now === FROZEN_SHA256 ? null
    : `眼耳判据与冻结时不一致（frozen=${FROZEN_SHA256.slice(0, 12)}… now=${now.slice(0, 12)}…），version=${EAR_VERSION}`;
}

/** 落盘戳：写进 ear.json / header.json，让任何人在克隆里重算时能核对同一份口径。 */
export function earStamp(): { ear: string; sha: string; frozenAt: string } {
  return { ear: EAR_VERSION, sha: earSha(), frozenAt: FROZEN_AT };
}
