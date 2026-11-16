/**
 * M4-f 预登记表词表（pre-registered lexicon）。
 *
 * 它只回答一个问题：agent 留下的自由文本，算不算「上报了一个缺陷」、算的话「指的是哪一项能力」。
 * 这是整条 M4-f 链路上**唯一一处必须用人写规则做判决**的地方，所以它的诚实性风险最高：
 * 先看模型输出、再回头挑关键词，那叫事后标注（HARKing），检出的数字当场失去意义。
 *
 * 三条防线，缺一条这份表就不可信：
 *  1. **词全部来自屏幕，不来自模型。** 下面每一个观测量词都能在 src/world/render.ts 产出的
 *     屏幕文本里找到对应说法（HP/分数/墙/敌人/冷却中/已倒下/可拾取…）。
 *     test/detect.test.ts 里有一条判据逐词核对这件事：造表时禁止引用任何一局真跑里的原话。
 *  2. **先跑已知空白样本。** 参考版（根本没有缺陷）那十局证据必须在**本轮出任何检出率之前**
 *     先过一遍这张表。它要是一上报一堆，说明表本身过火，得先修表——但修表要走版本升级，
 *     两版数字都留档，不许悄悄替换旧版（见第 3 条）。
 *  3. **冻结 = 改一个字就出声。** FROZEN_SHA256 是这份表正文的指纹，测试每次重算比对。
 *     想改词就得同时改 LEXICON_VERSION，于是旧局的 detection.json 里记着旧版本号，
 *     两版的数字天然分箱，混不到一起去。（故障 #19 的教训：分不清版本就等于免检通道。）
 *
 * ⚠️ 这张表连同变异体 id、被删能力、预期症状，**全部是作者侧知识**。
 *    它绝不进契约、不进工具返回、不进假设板——那等于把答案念给 agent 听，评测作废。
 *    零泄漏由 test/detect.test.ts 与 verify/detect-selftest.ts 双向核。
 */
import { createHash } from 'node:crypto';
import type { Capabilities } from './arena.ts';

export type Cap = keyof Capabilities;

/** 词表版本。改任何一个词都必须升版本，且旧版证据要能按版本号分箱。 */
export const LEXICON_VERSION = 'm4f-1';
/** 冻结日期——必须早于任何一次缺陷版真跑。这是给人看的承诺，不是机器判据（机器判据是下面的 sha）。 */
export const FROZEN_AT = '2026-11-16';

/**
 * 异常断言词：文本里至少出现一个，才算「agent 在说这里不对劲」。
 *
 * 为什么必须有这一层：光提"敌人""血量"是**描述**，不是**上报**。
 * 试玩报告里每局都会说几十个观测量名词，只按名词匹配会把"我看见了 HP 3/10"
 * 判成"报告了血量类缺陷"，检出率直接虚高到没有参考价值。
 * 判据是「异常断言 ∧ 观测量归因」两者都成立。
 *
 * 词源：ARENA_TASK 自己用的两个词（不正常 / 不合理）打头，其余全是同一语义的日常说法。
 */
export const ANOMALY_WORDS: readonly string[] = [
  '不正常', '不合理', '不对', '异常', '反常', '奇怪', '诡异', '违和',
  '有问题', '出错', '错误', '失效', '没生效', '不生效', '无效果', '没有效果',
  '不应该', '不该', '不符合', '不一致', '矛盾', '对不上', '说不通',
  '没变化', '无变化', '没反应', '无反应', '没有任何变化', '纹丝不动', '一动不动',
  'bug', '缺陷', '漏洞', '故障', 'bugfix',
];

/**
 * 观测量 → 能力。文本命中某个词，就把这条能力记进「agent 归因到了哪些能力」的集合。
 *
 * 一个词落在几条能力名下是**允许的**（"掉血"既可能指接触伤害也可能扣血结算）。
 * 所以这里产出的是集合，判决靠交集：
 *   归因集合 ∩ 被删能力 ≠ ∅  →  归因正确（命中）
 *   归因集合 = ∅              →  报了但没指明是哪一项
 *   归因集合 ≠ ∅ 且交集为空    →  归因错误（报了别的东西）
 * 严格档另算：归因集合 == 被删能力集合（一条不多、一条不少）。
 *
 * 每个词的来路都写在注释里，便于人工复核它是不是从屏幕上来的。
 */
export const ATTRIBUTION: Record<Cap, readonly string[]> = {
  // 屏幕上「#」=墙，现象行印「你朝X撞上了障碍，没能移动」
  wallBlocks: ['墙', '障碍', '穿墙', '边界'],
  // 敌人符号「E」；巡逻是它每帧的位置变化
  enemyPatrol: ['巡逻', '敌人不动', '敌人没动', '敌人位置', '敌人静止', '怪不动', '怪物不动', '敌人不移动', '敌人一直在', '敌人从未', '敌人不会动'],
  // 血条「HP n/10」；接触伤害表现为掉血
  contactDamage: ['掉血', '扣血', '受伤', '伤害', '血量减少', '血量没', '血没', '掉过血', '损失血量'],
  // 攻击的可见后果：敌人从画面消失（击杀）
  attackKills: ['击杀', '打死', '杀死', '杀了', '没死', '未死亡', '敌人不减', '砍不死', '打不死', '杀不死'],
  // 屏幕「攻击：就绪 / 冷却中」
  attackCooldown: ['冷却', '就绪', '连发', '攻击间隔', '连续攻击', '没有等待'],
  // 「+」=可拾取；回血表现为 HP 上涨
  pickupHeals: ['回血', '加血', '恢复血量', '血量上升', '血量增加', '拾取', '治疗', '补血'],
  // 「状态：活着 / 已倒下」；死亡前提是血量归零
  deathAtZeroHp: ['倒下', '死亡', '死掉', '阵亡', '濒死', '归零', '血量为0', '血量归', 'hp:0', 'hp0', 'hp=0', '零血', '0血'],
  // 屏幕「分数 n」
  scoreOnKill: ['分数', '得分', '计分', '加分', '积分', '分没涨', '分没有涨', '不加分'],
  // 血条上限 10/10；越界表现为超过上限或负值
  hpClamp: ['上限', '超过最大', '超出最大', '溢出', '负数', '为负', '低于0', '低于 0', '超过10', 'hp超过'],
};

/** 判决用的两个集合加上原文命中位置，人工复核时才看得出它凭什么这么判。 */
export interface ClaimMatch {
  /** 命中的异常断言词 */
  anomalies: string[];
  /** 命中的能力（去重、按能力名排序） */
  caps: Cap[];
  /** 每个命中词各自指向哪条能力，供人工复核「它到底在说什么」 */
  hits: { word: string; cap: Cap }[];
}

/** 归一化：小写 + 去空白。模型爱写 "HP = 0"、"bug（缺陷）"，空格与大小写不该改变判决。 */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

function findWords(text: string, words: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const n = normalize(w);
    if (n.length > 0 && text.includes(n) && !out.includes(w)) out.push(w);
  }
  return out;
}

/** 一条文本 → 命中了哪些异常词、指向哪些能力。**纯函数，同样的输入永远同样的判决。** */
export function matchClaim(raw: string): ClaimMatch {
  const text = normalize(raw);
  const anomalies = findWords(text, ANOMALY_WORDS);
  const hits: { word: string; cap: Cap }[] = [];
  for (const cap of Object.keys(ATTRIBUTION) as Cap[]) {
    for (const w of findWords(text, ATTRIBUTION[cap])) hits.push({ word: w, cap });
  }
  return {
    anomalies,
    caps: [...new Set(hits.map((h) => h.cap))].sort() as Cap[],
    hits,
  };
}

// ───────────────────────────── 冻结指纹 ─────────────────────────────

/** 把词表正文规范成一段与键序无关的文本，再取指纹。 */
export function lexiconCanonical(): string {
  const caps = Object.keys(ATTRIBUTION).sort() as Cap[];
  return JSON.stringify({
    version: LEXICON_VERSION,
    anomaly: [...ANOMALY_WORDS].sort(),
    attribution: caps.map((c) => [c, [...ATTRIBUTION[c]].sort()]),
  });
}

export function lexiconSha(): string {
  return createHash('sha256').update(lexiconCanonical(), 'utf8').digest('hex');
}

/**
 * 冻结时的指纹。改上面任何一词，这条测试就红：
 * 「你改了判决标准，必须升 LEXICON_VERSION，并按新版本重新出表」。
 */
export const FROZEN_SHA256 = '79662ae42474aab98d8dcef46b0a57bc0d4222b4fac66a09990a9533d28f9e54';

/** 返回 null = 表还是冻结时那张表；返回字符串 = 漂移说明，出声用。 */
export function lexiconDrift(): string | null {
  const now = lexiconSha();
  return now === FROZEN_SHA256 ? null : `词表与冻结时不一致（frozen=${FROZEN_SHA256.slice(0, 12)}… now=${now.slice(0, 12)}…），version=${LEXICON_VERSION}`;
}
