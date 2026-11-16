/**
 * M4-f 检出判定器：把「这一局到底有没有发现缺陷」变成一条可复核的漏斗。
 *
 * 四个量，一层扣一层。**每一层都单独出数**，因为它们各自的失败原因完全不同：
 *
 *   L1 可见分叉  屏幕文本真的出现过差异吗？       —— 没出现 = 这条轨迹上根本没得看
 *   L2 玩家侧前提 agent 自己的动作引出过该能力的可核对事实吗？—— 没引出 = 探索没到位，怪策略不怪眼睛
 *   L3 主观上报  agent 说过"这里不对劲"吗？       —— 没说过 = 看见了但没当回事
 *   L4 归因正确  它指的那一项目和被删能力对得上吗？—— 对不上 = 报了但归因错
 *
 * 🟴 本轮最重要的一条设计：**L1 必须与内部状态分叉分开量**。
 * 公证器（M3）比的是 WorldState 哈希，而 agent 只看得见 render() 出来的屏幕。
 * 若某变异体改了内部状态却**从未让任何一帧画面不同**，那它在这套视网膜下**原理上不可发现**，
 * 检出率 0% 是世界的错，不是 agent 的错。把两者混成一个"分叉"，
 * 就会拿结构性天花板去指控模型能力——那正是这个项目从头反对的那种自说自话。
 *
 * 🟴 第二条，被首次实测推翻后改写的：**L2 不是分母闸门，只是分层变量**。
 * 原本想把 L2 也写进分母（"没触达就不算它能检的"），但冒烟跑立刻反例：
 * M01（墙不挡路）的画面在参考版 wallAttempts=0 的情况下第 19 帧就分叉了——
 * 因为**敌人也会穿墙**，agent 站着看就能看见墙不管用。前提按"缺陷怎么被删"定义，
 * 会系统性把"旁观可得"的证据判成不可达，那是拿我的想象当世界的性质。
 * 所以分母只由 L1 决定；L2 用来把检出率**分层**（自己撞出来的 vs 旁观到的），
 * 并给每一局未检出给出第一个不成立的层——那才是这份报告真正值钱的地方。
 *
 * 预先登记的判据（跑真模型之前定死，之后改判据要升版本并分箱重出表）：
 *   可检局   = 缺陷局 ∧ L1 成立              ← 检出率的**分母**
 *   检出     = 可检局 ∧ L4 归因正确          ← 检出率的**分子**
 *   上报     = 可检局 ∧ L3 成立（不要求归因对）
 *   误报率   = 参考版局里 L3 成立的比例       ← 与检出率成对出现，单独一个数没有意义
 *
 * ⚠️ 归属纪律：本文件与 lexicon.ts 里的变异体 id、被删能力、词表，全是**作者侧知识**，
 *    只在局末判决时用。循环层、契约、工具返回一律不得引用，否则开卷考试，全部作废。
 */
import { ALL_CAPS, type Action, type Capabilities } from './arena.ts';
import { GameSession, type Coverage } from './session.ts';
import { findMutant } from './mutants.ts';
import { LEXICON_VERSION, lexiconSha, matchClaim, type Cap } from './lexicon.ts';

export const DETECTOR_VERSION = 'm4f-1';
/** 判决口径版本与词表版本绑在一起：改了词表 = 改了判据，两者必须一起分箱。 */
export const JUDGEMENT_VERSION = `${DETECTOR_VERSION}+lex-${LEXICON_VERSION}`;

/**
 * header.json 用的版本戳：把上面两个常量 + 词表指纹摊平成一份无嵌套的对象。
 *
 * 为什么不给 header 直接写 JUDGEMENT_VERSION 字符串：那份字符串是 detect.ts 拼出来的，
 * 循环层若自己拼一遍，两处拼法迟早分叉成两个版本号（一个事实两个主人）。
 * 这里只导出**组装一次**的结果，harness 拿到就用，不再重新解释含义。
 *
 * ⚠️ 它不是判据，只是戳；写进 header 不等于判决可用。判决仍要 detection.json
 *    里的逐层布尔 + 落盘文本，由 verify/detect-audit.ts 独立重算才算复核过。
 */
export function judgeStamp(): { detector: string; lexicon: string; sha: string } {
  return { detector: DETECTOR_VERSION, lexicon: LEXICON_VERSION, sha: lexiconSha() };
}

// ─────────────────────────── 重放出观察流 ───────────────────────────

export interface Observation {
  /** 第 0 项是首屏，之后每项对应一个动作后的屏幕。这就是 agent 会看到的全部东西。 */
  screens: string[];
  coverage: Coverage;
}

/**
 * 用给定能力把一条动作序列跑一遍，产出「屏幕流 + 覆盖账本」。
 *
 * 为什么复用 GameSession 而不是重抄一份统计逻辑：
 *   覆盖账本的口径必须和真跑时**完全一致**（撞墙意图、冷却中攻击这些要看动作前的状态）。
 *   重抄一份就是第二个主人，两处迟早漂移。
 * 这不算"让被测代码给自己打分"：GameSession 是被测的**世界**，不是判决者；
 * 判决全部在这个文件里做，而它读的是世界的客观账本。
 */
export async function playSequence(seed: number, caps: Capabilities, actions: readonly Action[]): Promise<Observation> {
  const s = new GameSession(seed, caps);
  const screens = [s.screen()];
  for (const a of actions) screens.push((await s.apply(a)).screen);
  return { screens, coverage: s.coverage() };
}

// ─────────────────────────── L1：可见分叉 ───────────────────────────

export interface ScreenDivergence {
  /** 屏幕上是否出现过差异。**检出率的分母由此决定。** */
  diverged: boolean;
  /** 第几帧首次出现可见差异（0=首屏就不同）。没分叉=null */
  firstStep: number | null;
  /** 有多少帧不同（掩蔽现象的量：内部一直分叉、画面又收敛，这里会掉下来） */
  frames: number;
  /** 首次分叉那帧的差异行样本，人工复核用。每项形如 "ref: ..." / "mut: ..." */
  sample: string[];
}

/** 逐行比对两份屏幕，产出人可读的差异样本。 */
function screenDiffSample(ref: string, mut: string, max = 4): string[] {
  const a = ref.split('\n');
  const b = mut.split('\n');
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < max * 2; i++) {
    if (a[i] !== b[i]) {
      out.push(`ref: ${a[i] ?? '(无此行)'}`);
      out.push(`mut: ${b[i] ?? '(无此行)'}`);
    }
  }
  return out;
}

/**
 * 参考版屏幕流 vs 缺陷版屏幕流。
 *
 * 两条刻意的选择：
 *  1. 比**整屏文本**而不是只比 HP 行。缺陷可能只体现在地图上（敌人位置、E 消失）。
 *  2. 一旦分叉就继续数到结尾，因为"第 1 帧就看得见"和"第 40 帧才露馅"
 *     对试玩 agent 是完全不同的难度。firstStep 就是这个难度量。
 */
export function diffScreens(ref: Observation, mut: Observation): ScreenDivergence {
  let firstStep: number | null = null;
  let frames = 0;
  let sample: string[] = [];
  const n = Math.min(ref.screens.length, mut.screens.length);
  for (let i = 0; i < n; i++) {
    if (ref.screens[i] === mut.screens[i]) continue;
    frames++;
    if (firstStep === null) {
      firstStep = i;
      sample = screenDiffSample(ref.screens[i]!, mut.screens[i]!);
    }
  }
  // 长度不同本身就是分叉（少一步就多一帧），别当成"没得比"
  if (ref.screens.length !== mut.screens.length) {
    frames += Math.abs(ref.screens.length - mut.screens.length);
    if (firstStep === null) firstStep = n;
  }
  return { diverged: firstStep !== null, firstStep, frames, sample };
}

// ─────────────────────────── L2：玩家侧前提 ───────────────────────────

/** 前提读哪一版的账本。默认参考版，唯一例外见 PRECONDITION 的 hpClamp。 */
export type Side = 'ref' | 'mutant';

export interface Precondition {
  cap: Cap;
  side: Side;
  /** 人类可读：这条能力要在画面上留下可核对的事实，局面得先进到哪个状态 */
  needs: string;
  /** 该状态在**指定那一版**的同一条轨迹里出现过吗 */
  reached: boolean;
}

/**
 * 每条能力的**玩家侧前提**，全部落在覆盖账本的字段上。
 *
 * 为什么默认以**参考版**轨迹为准：缺陷版里"该发生的事"正是被删掉的那件。
 * 拿 M07（血量归零不死亡）举例，若按缺陷版判 hpZeroReached，它可能一路掉到负数从没停在 0 上，
 * "没触达"这个结论是被缺陷本身造出来的——**用缺陷版自证缺陷不可达**是循环论证。
 *
 * 🟴 唯一例外 hpClamp 走反方向，理由同一条但方向相反：
 * "越界"这个事实在**会夹取**的那一版里按定义留不下任何痕迹（参考版永远 0≤hp≤10），
 * 拿参考版判它必然恒 false，那是把判据写成了永不成立——故障 #13 的第四种形态。
 * 所以这一条读缺陷版自己的账本：只有不夹取的那一版才可能真的越过边界。
 *
 * ⚠️ 前提分层只用于**解释未检出的原因**，不参与分母（见文件头第二条）。
 */
export const PRECONDITION: Record<Cap, { side: Side; needs: string; test: (c: Coverage) => boolean }> = {
  wallBlocks: { side: 'ref', needs: 'wallAttempts>0（玩家自己试过往墙上走）', test: (c) => c.wallAttempts > 0 },
  enemyPatrol: { side: 'ref', needs: 'ticks≥2（至少跨过两帧才看得出"没在巡逻"）', test: (c) => c.ticks >= 2 },
  contactDamage: { side: 'ref', needs: 'touchedByEnemy（与敌人同过格）', test: (c) => c.touchedByEnemy },
  attackKills: { side: 'ref', needs: 'attackedWhileAdjacent（贴身时出手过）', test: (c) => c.attackedWhileAdjacent },
  attackCooldown: { side: 'ref', needs: 'attacksWhileCooldown>0（冷却中仍尝试攻击）', test: (c) => c.attacksWhileCooldown > 0 },
  pickupHeals: { side: 'ref', needs: 'stoodOnPickup（站到有物品的格子上拾取过）', test: (c) => c.stoodOnPickup },
  deathAtZeroHp: { side: 'ref', needs: 'hpZeroReached（血量到过 0）', test: (c) => c.hpZeroReached },
  scoreOnKill: { side: 'ref', needs: 'kills>0（打死过敌人）', test: (c) => c.kills > 0 },
  hpClamp: {
    side: 'mutant',
    needs: '缺陷版 own hpAboveMaxReached 或 hpBelowZeroReached（真越过界；参考版永远看不到）',
    test: (c) => c.hpAboveMaxReached || c.hpBelowZeroReached,
  },
};

/** 按各自该读的那一版核对前提。两侧覆盖都传进来，函数内部按 side 取，调用方不会拿错。 */
export function checkPreconditions(
  removed: readonly Cap[],
  coverages: { ref: Coverage; mutant: Coverage },
): Precondition[] {
  return removed.map((cap) => {
    const spec = PRECONDITION[cap];
    return {
      cap,
      side: spec.side,
      needs: spec.needs,
      reached: spec.test(spec.side === 'ref' ? coverages.ref : coverages.mutant),
    };
  });
}

// ─────────────────── L3/L4：主观上报与归因 ───────────────────

export interface ClaimSource {
  /** 出自哪个通道。分开记是因为 finish 的结论比一条笔记更有分量，复核时要先看它。 */
  where: 'finish' | 'note' | 'hypothesis';
  text: string;
}

/** 从 defect.json 的 agentClaims 结构取全部主观文本。目标正文刻意**不算**上报。 */
export function toClaimSources(claims: {
  finishSummary: string | null;
  notes: readonly string[];
  hypotheses: readonly { text: string }[];
}): ClaimSource[] {
  const out: ClaimSource[] = [];
  if (claims.finishSummary) out.push({ where: 'finish', text: claims.finishSummary });
  for (const n of claims.notes) out.push({ where: 'note', text: n });
  for (const h of claims.hypotheses) out.push({ where: 'hypothesis', text: h.text });
  return out;
}

export interface ClaimVerdict {
  /** 说过"这里不对劲"，且指到了某个具体观测量 */
  reported: boolean;
  /** 有过异常断言但没指到任何可观测量（"总觉得哪里不对"） */
  vague: boolean;
  /** 全部文本归因到的能力并集 */
  caps: Cap[];
  /** 每条命中文本的原文与命中词——人工复核全靠它，判决不许只给一个布尔 */
  quotes: { where: ClaimSource['where']; text: string; anomalies: string[]; caps: Cap[] }[];
}

/**
 * 逐条文本过词表，取并集。
 *
 * 为什么取并集而不是只看 finish 的结论：真跑见过 agent 在第 12 步的笔记里写清"攻击没冷却"，
 * 收手时总结却只写"规则摸清了"。只读结论会把那次真发现丢掉——**漏报比误报更难发现**，
 * 因为没有任何东西会疼。代价是并集会略微抬高上报率，所以误报率必须在参考版上同时量，
 * 两数成对才读得出这张表到底过火不过火。
 */
export function scoreClaims(sources: readonly ClaimSource[], removed: readonly Cap[]): ClaimVerdict {
  const caps = new Set<Cap>();
  const quotes: ClaimVerdict['quotes'] = [];
  let vague = false;
  for (const s of sources) {
    const m = matchClaim(s.text);
    if (m.anomalies.length === 0) continue;
    if (m.caps.length === 0) {
      vague = true;
      continue;
    }
    for (const c of m.caps) caps.add(c);
    quotes.push({ where: s.where, text: s.text, anomalies: m.anomalies, caps: m.caps });
  }
  const sorted = [...caps].sort() as Cap[];
  // 参考版根本没有被删能力：此时 reported 就是**误报**，判据完全对称，不额外开洞
  return { reported: sorted.length > 0, vague, caps: sorted, quotes };
}

/** 归因判决。互斥，且覆盖参考版（removed=[]）那一侧。 */
export type Verdict =
  | '无误报'      // 参考版：没上报任何东西
  | '误报'        // 参考版：上报了不存在的缺陷
  | '未上报'      // 缺陷版：没有任何一条"不对劲"落到具体观测量上
  | '报了未指明'  // 缺陷版：喊了异常但没说哪项
  | '归因错误'    // 缺陷版：指了具体项目，但与被删能力不相交
  | '归因正确';   // 缺陷版：指对了

export function decide(claim: ClaimVerdict, removed: readonly Cap[]): Verdict {
  if (removed.length === 0) return claim.reported || claim.vague ? '误报' : '无误报';
  if (!claim.reported) return claim.vague ? '报了未指明' : '未上报';
  const hit = claim.caps.some((c) => (removed as readonly string[]).includes(c));
  return hit ? '归因正确' : '归因错误';
}

// ─────────────────────────── 整局判决 ───────────────────────────

export interface Detection {
  judgementVersion: string;
  mutant: string | null;
  /** 作者侧知识，绝不回流给 agent */
  removed: Cap[];
  seed: number;
  actions: number;
  /** L1 */
  visible: ScreenDivergence;
  /** L2（分层变量，不是闸门） */
  preconditions: Precondition[];
  /** 所有被删能力的玩家侧前提都达成？双变异体要全中才算"这局是它该做到的" */
  playerPremise: boolean;
  /** 公证器的内部状态分叉（由调用方传入，这里只做并排记录，不重算） */
  internal: { diverged: boolean; firstStep: number | null };
  /** L3/L4 */
  claim: ClaimVerdict;
  verdict: Verdict;
  /** 检出率分母：这一局算"可检" */
  detectable: boolean;
  /** 检出率分子 */
  detected: boolean;
  /** 严格档：归因集合与被删集合完全相等（一条不多一条不少） */
  exactlyAttributed: boolean;
  /** 参考版专用：这一局是误报样本 */
  falsePositive: boolean;
  /** 内部状态分叉了但屏幕从没变过 = 这套视网膜下的**结构性不可见**。单列，不进分母 */
  invisibleThoughDiverged: boolean;
  /** 未检出的第一处断在哪一层——报告里最有用的一列 */
  whyNot: FailureLayer | null;
  /** 两侧覆盖账本，人工复核前提判得对不对全靠它 */
  coverage: { ref: Coverage; mutant: Coverage };
}

/** 漏斗的失败层。顺序 = 判决顺序，第一个不成立的就是归因。 */
export type FailureLayer =
  | '不可见'      // L1 不成立：这条轨迹上画面从没不同
  | '未触达'      // L2 不成立：玩家侧没引出该能力的事实
  | '未上报'      // L3 不成立：看见了但一个字没说不对劲
  | '报了未指明'  // L3 半成立：喊了异常但没落到观测量
  | '归因错误';   // L4 不成立：指错了项目

export function firstFailingLayer(d: Omit<Detection, 'whyNot' | 'coverage'>): FailureLayer | null {
  if (!d.visible.diverged) return '不可见';
  if (!d.playerPremise) return '未触达';
  if (d.verdict === '归因正确') return null;
  if (d.verdict === '归因错误') return '归因错误';
  if (d.verdict === '报了未指明') return '报了未指明';
  return '未上报';
}

export interface DetectInput {
  seed: number;
  /** 这一局实际执行过的纯世界动作序列 */
  actions: readonly Action[];
  mutant: string | null;
  claims: {
    finishSummary: string | null;
    notes: readonly string[];
    hypotheses: readonly { text: string }[];
  };
  /** 公证器的客观判定（内部状态侧），并排记录用 */
  internal: { diverged: boolean; firstStep: number | null };
}

/** 缺陷版跑的是变异能力，参考版跑的是全能力——两侧都要重放一次才能比屏幕。 */
export async function detectOne(input: DetectInput): Promise<Detection> {
  const removed: Cap[] = input.mutant ? (findMutant(input.mutant).removed as Cap[]) : [];
  const caps: Capabilities = input.mutant ? findMutant(input.mutant).caps : ALL_CAPS;

  const ref = await playSequence(input.seed, ALL_CAPS, input.actions);
  const played = input.mutant ? await playSequence(input.seed, caps, input.actions) : ref;
  // 参考版局两侧是同一次重放，比自己必然零差异——这是**内置的反向对照**，不是偷懒：
  // 它一旦报出可见分叉，说明比对函数或世界确定性出了问题，当场就该停。
  const visible = diffScreens(ref, played);

  const preconditions = checkPreconditions(removed, { ref: ref.coverage, mutant: played.coverage });
  const claim = scoreClaims(toClaimSources(input.claims), removed);
  const playerPremise = preconditions.every((p) => p.reached);
  const verdict = decide(claim, removed);
  const exactly = removed.length > 0
    && removed.length === claim.caps.length
    && removed.every((c) => claim.caps.includes(c));

  const core = {
    judgementVersion: JUDGEMENT_VERSION,
    mutant: input.mutant,
    removed,
    seed: input.seed,
    actions: input.actions.length,
    visible,
    preconditions,
    playerPremise,
    internal: input.internal,
    claim,
    verdict,
    detectable: visible.diverged,
    detected: visible.diverged && verdict === '归因正确',
    exactlyAttributed: visible.diverged && exactly,
    falsePositive: removed.length === 0 && (claim.reported || claim.vague),
    invisibleThoughDiverged: input.internal.diverged && !visible.diverged,
  };
  return {
    ...core,
    // 参考版没有"该检出却没检出"这件事，漏斗不适用；硬套会把误报样本混进失败层统计
    whyNot: input.mutant ? firstFailingLayer(core) : null,
    coverage: { ref: ref.coverage, mutant: played.coverage },
  };
}
