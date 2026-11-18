/**
 * M4-d 主客观对账：把 agent 自己说过的话，拿它**当时看到的那一帧屏幕**逐条核对。
 *
 * 它回答一个问题：agent 的自述和它实际踩到的东西，是不是一回事？
 * M4-f 对账的是「仪器能不能发现缺陷」，这里对账的是「它说的一定对吗」——
 * M4 里唯一一条「主观 vs 客观」的独立异常源，两者不能互相代劳。
 *
 * 三条铁律：
 *  1. **客观侧只读屏幕文本，绝不读 WorldState。** 一律走 observe()（render 的逆投影）。
 *     读了内部状态就成了「拿答案对答案」：agent 数错格子这种最真实的感知误差会被内部坐标
 *     当场"纠正"，对账退化成自证。（M1 手数的 19 次越界，就是靠这条才敢再数一遍。）
 *  2. **每条抽出来的主张必须落进且只落进一个桶**：相符 / 矛盾 / 约定存疑 / 无法核对。
 *     恒等式 主张总数 = 四桶之和 由单测与独立审计双向核（#21 家族：分母要有身份）。
 *     抽不出主语的数字对**不许丢**，进「无法核对·主语不明」——丢了就等于免检。
 *  3. **屏幕没规定的东西，不许替屏幕规定。** 屏幕上没有坐标轴也没有刻度（render 的 grid()
 *     只画 `+---+` 和一行图例），所以 "(a,b)" 读作 (x,y) 还是 (row,col) **不是 agent
 *     查得到的信息**。只在另一读法下相符的主张记「约定存疑」：那是屏幕契约的洞，
 *     不是模型的错，算进矛盾率就是冤枉被试。
 *
 * 判据诚实性的边界，写在 reconCanonical() 的注释里，不假装全覆盖。
 */
import { createHash } from 'node:crypto';
import type { Observation } from './observe.ts';

export const RECON_VERSION = 'm4d-5';
/** 冻结日期。本轮全部证据产自 2026-11-13~16，早于此，所以不存在"看着这批结果改判据"。 */
export const FROZEN_AT = '2026-11-18';

/**
 * ⚠️ 版本史（留档，不许抹掉）：
 *  - `m4d-1` 是盘点阶段的口径。它只出过一张**试算表**（dry-run 打印，未落盘、未提交、
 *    未进任何报告），随后被手写真值表判出三处红：
 *    极性档（台账 #24）、回溯词「第 N 帧」的字面量转义、MOVE_HEAD 的交替组（#23 同族）。
 *  - `m4d-2` = 这三处修完后的口径。它同样**只出过 dry-run**，且没走到冻结：
 *    抽读它给出的 12 条矛盾明细时，读出台账 #25「规则抢跑吞句」——排在前的规则把
 *    后面更合适的主张整段吞掉。三处：GAP 放过标点吞掉「…：最近的可拾取物是(3,5)」；
 *    playerPos 第二支不要求「位置/坐标」，把「现在向右移动一格到(3,2)」「目前还剩余2个敌人E(6,0)」
 *    当成位置自述；cellSymbol 形状 2 吞掉「3 个敌人」这条本该数的量。
 *  - `m4d-3` = 上面三处修完 + 回溯词补上「初始/开局/一开始/开始时/最初」（「初始@在(0,0)」
 *    不带过去时标记，曾被拿当下屏幕核对成矛盾）后的口径。它**冻结并落过盘**
 *    （30 份 reconciliation.json + summary.json，1165 条主张），随后被第三只脚——
 *    verify/recon-fixture.ts 的手写夹具——判出三处**漏收**（台账 #26：修饰语只许挂一个词，
 *    于是「血量目前是7/10」「地图大小为6x6」「攻击还没就绪」整条规则静默失效，
 *    抽不出主张＝这条主张根本没被核对过）。
 *  - `m4d-4` = 三处漏收修完 + 极性词表补「没就绪/没准备好/不就绪」后的口径。
 *    **m4d-3 那一份落盘数字作废**（作废＝留在 runs/ 之外，不进任何统计表），
 *    对外只出 m4d-4 重跑之后的数。它落过盘（30 局 1171 条），随后被第四只脚——
 *    verify/recon-audit.ts 的**独立重算**——在真语料上判出 19 处分歧，17 分出自同一个口径：
 *    回溯判定用的是"命中段左右各 18 字符"的**窗口**。窗口既不是从句也不是句子，连自己都不自洽
 *    （台账 #27）：同一句话里「我在[0,0]」「HP 10/10」被标成回溯，紧挨着的「分数0」「攻击就绪」
 *    却没有（20261113-220900-s6 第 4 行）；反过来「玩家右移一格到(1,0)后」被子句外的词判成回溯。
 *    全语料这样的分裂有 112 处。两边代码不同、结论相同，说明这是**共同的口径**错了，
 *    不是某一边的实现 bug——这正是第三只脚唯一能抓到的那类错（台账 #14）。
 *  - `m4d-5` = 回溯口径换成**主张自己所在的子句**（分隔符表进冻结指纹；冒号引导句并入自己的子句），
 *    并给回溯词表加上**帧号归位**：「第 N 帧」捕获 N、「初始/开局」族指第 0 帧，
 *    说不准帧号的（之前/原来/当时…）仍是无法核对。归位后指向的那一帧**正是锚点帧**时
 *    就不算回溯，照常核对——「已获取初始状态：我在(2,3)，分数2」在第 0 帧本来就该核。
 *    **m4d-4 那一份落盘数字作废**，对外只出 m4d-5 重跑之后的数。
 *    ⚠️ 这一刀自己又带出两处旧疤，都是新写的子句真值表**首跑当场拦下**的（不是跑完数再补的）：
 *      ① 分隔符表只列了全角「。」，而匹配跑在归一化文本上——半角「.」根本没在表里，
 *         整类句号静默不切分（#24 同族：两张表各说各话）；
 *      ② GAP 同样只堵全角句号，于是 playerPos 的命中段自己跨过句读吃掉上一句
 *         （「上一帧我朝右走。我在(2,3)」成了一条主张＝#25 抢跑吞句换了个地方复发）；
 *      ③ 子句扫描会把坐标字面中间的逗号当分隔符，从 `(1` 与 `1)` 之间锯开，
 *         同一句话里只有前半句背上回溯——正好复刻它要修的不自洽。现在括号内部整体受保护，
 *         这条也进指纹（bracketsProtected）。
 *  ⚠️ 修的方向由夹具的手写期望与人工读句限定，不是回去翻语料凑率。
 *     m4d-4 那三处只**增加**能核对的主张；m4d-5 改的是**回溯的范围单位**，
 *     两个方向都会动：子句化让一部分主张从「无法核对」回到可核对，
 *     冒号引导句并入与"整句无标点时子句＝整句"又会让另一部分反过来。
 *     正因为双向都可能动，它不能被写成"只会更好"——落盘后要人工抽读**两个方向**的明细，
 *     各看几条才知道这一刀切得对不对（见 verify/recon-audit.ts 的分歧清单）。
 *     四桶、双读法、图层覆盖这些判决口径一处都没动。
 *  为什么升版本而不是就地改指纹：判据改一次，此前那张表上的数就全部失去身份；
 *  版本号是台账 #19/#18 要求的分箱方式——旧数留在注释里当反面教材，不混进新统计。
 */

/** 四桶。互斥且穷尽——恒等式右边就是这四个。 */
export type Verdict = '相符' | '矛盾' | '约定存疑' | '无法核对';
export const VERDICTS: readonly Verdict[] = ['相符', '矛盾', '约定存疑', '无法核对'];

export type Kind =
  | 'playerPos'    // 我在 (a,b)——对**决策前**那一帧核对
  | 'movedTo'      // 我已移动到 (a,b)——同样对**决策前**那一帧核对（thought 永远在动作之前）
  | 'moveIntent'   // 我要移动到 (a,b)——意图，屏幕无从反驳
  | 'cellSymbol'   // (a,b) 这格是墙/敌人/物品/空地
  | 'pickupHere'   // 脚下有没有可拾取物
  | 'hp'           // HP n/m
  | 'hpValue'      // HP n
  | 'score'        // 分数 n
  | 'alive'        // 我活着 / 我倒下了
  | 'attack'       // 攻击就绪 / 冷却中
  | 'enemyCount'   // 画面有 n 个敌人
  | 'pickupCount'  // 画面有 n 个可拾取物
  | 'gridSize'     // 地图 n×m
  | 'barePair';    // 数字对没被任何具主语规则收编——无法核对，但必须计数

export const KINDS: readonly Kind[] = [
  'playerPos', 'movedTo', 'moveIntent', 'cellSymbol', 'pickupHere', 'hp', 'hpValue',
  'score', 'alive', 'attack', 'enemyCount', 'pickupCount', 'gridSize', 'barePair',
];


export interface Claim {
  kind: Kind;
  /** 规则名。报告里显示它，人工复核一眼看出"它凭什么算这条" */
  rule: string;
  /** 命中原文（从原始文本切出，保留大小写全角） */
  quote: string;
  /** 数值：坐标 [a,b]；单值 [n]；双值 [n,m]；布尔类为空 */
  value: number[];
  /** 布尔类极性；null = 判不出（原因见 polarity），绝不猜 */
  positive: boolean | null;
  /**
   * 极性判决的四态。**分开存**是因为"正反同现"和"整句没极性词"是两种缺陷：
   * 前者是模型说得含混（该出声），后者是判据的词表覆盖不到（那是我的洞）。
   * 非布尔类主张这里是 'none'，不参与判决。
   */
  polarity: Polarity;
  /** 符号类主张的符号（# E + . @） */
  symbol: string | null;
  /** 命中下标（归一化文本），用于去重与兜底 */
  at: number;
  /**
   * 是否为**回溯性陈述**（回溯线索词命中在**主张自己所在的子句**里，不是左右各 18 字的窗口）。
   * 「原来敌人在(1,0)但刚刚被消除」说的是更早那一帧，拿当下屏幕判它必错。
   * ⚠️ m4d-5 起窗口口径作废（台账 #27）：窗口会把同一句话里挨着的两条主张分成
   * "一条算回溯、一条不算"，那种判决连自己都不自洽。
   */
  retro: boolean;
  /** 命中的回溯线索（字面词，或「第 N 帧」这类匹配到的原文；没命中则空串） */
  retroWord: string;
  /**
   * 这句回溯**指的是哪一帧**：说不准就是 null（永远无法核对）；
   * 「第 3 帧」→3，「初始/开局」族→0。
   * 有了它，「已获取初始状态：我在(2,3)」在第 0 帧就不必推给无法核对——
   * 它说的正是锚点这一帧，不叫回溯，叫现状。
   */
  retroTick: number | null;
}

export interface Judged extends Claim {
  verdict: Verdict;
  /** 判决理由：必含屏幕侧的实际值，便于人工复核而不是信代码 */
  why: string;
}

// ─────────────────────────── 归一化 ───────────────────────────

/**
 * 全角→半角的**成对**映射表。
 * 为什么不用两条等长字符串对照：m4d-1 就是那么写的，两条串差了一个字符，
 * 于是从「】」往后全部错位、「０」不映射、最后一个字符返回 undefined——
 * 归一化函数照样"看起来能用"（半角 ASCII 全对），只有全角数字坐标静默抽不出主张。
 * 台账 #24 同族：长度对、内容错的静默偏移比报错难查十倍。
 * 现在改成显式配对 + 单测逐对核对，漏一个键就红。
 */
export const FULLWIDTH_MAP: readonly [string, string][] = [
  ['，', ','], ['。', '.'], ['：', ':'], ['；', ';'], ['！', '!'], ['？', '?'], ['、', ','],
  ['（', '('], ['）', ')'],
  ['［', '['], ['］', ']'], ['【', '('], ['】', ')'],
  ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
  ['０', '0'], ['１', '1'], ['２', '2'], ['３', '3'], ['４', '4'],
  ['５', '5'], ['６', '6'], ['７', '7'], ['８', '8'], ['９', '9'],
  ['　', ' '],
];

const FULLWIDTH = new Map<string, string>(FULLWIDTH_MAP);

/**
 * 全角 ASCII 区（U+FF01–U+FF5E）整块平移：模型写「ＨＰ 7/10」「（２，３）」时
 * 不该因为一个字母没登记就整句免检。区首区尾与偏移量进冻结指纹，看得见。
 * ⚠️ 表里的 `［（【` 等键与这块重叠（同一目标），表优先：因为「、」「　」不在 ASCII 区，
 * 而【】要映射成 () 而不是全角区原样的 ［ ］。
 */
export const FULLWIDTH_ASCII: { readonly first: string; readonly last: string; readonly offset: number } = {
  first: '！', last: '～', offset: 0xfee0,
};

/**
 * 长度不变的归一化：小写 + 全角→半角。
 * 必须等长：quote 要从**原始**文本切出来给人看，归一化文本只用于匹配。
 * 删空格那类改长度的做法会让下标全部错位（#13 家族：静默偏移比报错难查十倍）。
 */
export function normalizeText(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const mapped = FULLWIDTH.get(ch);
    if (mapped !== undefined) { out += mapped; continue; }
    const cp = ch.charCodeAt(0);
    if (cp >= 0xff01 && cp <= 0xff5e) { out += String.fromCharCode(cp - FULLWIDTH_ASCII.offset); continue; }
    out += ch;
  }
  return out.toLowerCase();
}

// ─────────────────────────── 规则表（判决标准本体） ───────────────────────────

export interface RuleDef {
  kind: Kind;
  name: string;
  /** 正则源串（进冻结指纹） */
  source: string;
  /** pair=前两个数字；two=双值都要比；one=第一个数字；bool=极性；sym=数字对+符号 */
  parse: 'pair' | 'two' | 'one' | 'bool' | 'sym';
  words?: { positive?: readonly string[]; negative?: readonly string[] };
  /** 可核对性说明：这条主张在屏幕上的**唯一**依据（进冻结指纹） */
  basis: string;
}

/** 坐标对字面：`[a,b]` 或 `(a,b)`，容忍空格与全角（已归一化）。 */
const PAIR = String.raw`[\[(]\s*(\d{1,2})\s*[,，]\s*(\d{1,2})\s*[\])]`;

/**
 * 意图动词头。列出来是为了让「什么算计划」这件事在冻结指纹里可见。
 * ⚠️ 用之前必须**自己包一组**（MOVE_HEAD_GROUP）：`(?:${MOVE_HEAD}\s*x)` 里的 `\s*x`
 * 只挂在最后一条 alternation「将」上——和 SYM_ALT 那次是同一个坑（台账 #23 同族）。
 * m4d-1 就这么写着「我下一步移动到(2,2)」抽不出意图主张，整句掉进 barePair。
 */
const MOVE_HEAD = String.raw`移动到|移到|走到|回到|前往|进入|下一步|打算|准备|尝试|应该|计划|试图|预计|将要|将`;
const MOVE_HEAD_GROUP = `(?:${MOVE_HEAD})`;

/**
 * 主语与介词之间的短促限定（≤8 字）：**不吃标点、不吃括号、允许数字**。
 * 为什么允许数字：「我在第2次尝试后位于(2,3)」要收，而句子里的数字绝不能当坐标——
 * 取值只认坐标对字面本身（firstPairIn），所以两头都要堵：光放宽会编出假矛盾，
 * 光收紧会漏收（#24）。
 * 为什么**不许**吃标点与括号：抽样复核矛盾明细时发现，放过「：」之后
 * 「现在想测试pickup：最近的可拾取物是(3,5)」整句被 playerPos 抢走——
 * 一句本该归 pickupCount/cellSymbol 的话，被更靠前的规则吞掉（#25 抢跑吞句）。
 * ⚠️ 标点必须按**归一化之后**的形状堵：这里原先只堵全角「。」，而匹配跑在归一化文本上，
 * 「。」已经变成半角「.」，于是「上一帧我朝右走。我在(2,3)」被当成一条位置自述——
 * 命中段自己跨了句（m4d-5 的子句测试抓出来的，台账 #24/#25 同族：两张表各说各话）。
 * ⚠️ 反引号必须拼接：`String.raw` 的模板串里放不进一个裸反引号——
 *    上一版直接写进去，整份文件当场语法错误（模板在 `` `'` `` 处提前结束）。
 */
const GAP = String.raw`(?:[^。，.,；;：:！!？?、（）()【】\[\]{}"'` + '`' + String.raw`]{0,8}?)?`;

/** 符号字面：屏幕图例里 5 个字符 + 中文说法。长的排前，避免「可拾取物」被「物品」截断。 */
export const SYMBOL_WORDS: readonly [string, string][] = [
  ['可拾取物', '+'], ['可拾取', '+'], ['拾取物', '+'], ['物品', '+'], ['障碍物', '#'],
  ['敌人', 'E'], ['怪物', 'E'], ['空地', '.'], ['空格', '.'],
  ['#', '#'], ['e', 'E'], ['+', '+'], ['.', '.'], ['@', '@'],
  ['墙', '#'], ['敌', 'E'], ['怪', 'E'],
];

/** 只有正则元字符需要转义；中文词原样。 */
const esc = (w: string): string => w.replace(/[.#@+*?^${}()|[\]\\]/g, '\\$&');

const SYM_ALT = SYMBOL_WORDS.map(([w]) => esc(w)).join('|');
/**
 * 包好非捕获组的符号交替。裸 SYM_ALT 直接拼进 `a|b|c\s*(…)` 时，后面的量词与组
 * 只会挂到最后一条 alternatives 上——cellSymbol 的「X在(a,b)」形状就是这么静默失效的
 * （命中了光秃秃的「可拾取物」，因为拿不到数字对而被丢弃）。台账 #23。
 */
const SYM_ALT_GROUP = `(?:${SYM_ALT})`;
const SYM_MAP = new Map<string, string>(SYMBOL_WORDS);

export const RULES: readonly RuleDef[] = [
  {
    kind: 'playerPos', name: '玩家位置自述（现在时）',
    // gap = 主语与介词之间的短促限定，且**不许吃进数字与坐标括号**（见 const GAP 的注释）；
    // **介词必须紧贴坐标**——这是防「我移动到有3个敌人的(2,3)」这类误绑的关键。
    // 第二支（现在/当前开头）**必须挨着「位置/坐标」这个名词**：GAP 允许数字（见 const GAP），
    // 名词一可选就会让 playerPos 抢走计划句与计数句——
    // 「现在向右移动一格到(3,2)」「目前还剩余2个敌人E(6,0)」都曾因此被误绑成位置主张（#25 抢跑吞句）。
    // 真正的位置自述离不开「位置/坐标」这个词：「现在位置(2,3)」「目前坐标为(2,3)」才收。
    source: String.raw`(?:我|自己|玩家|角色|本人)${GAP}(?:位于|处于|就在|就是|是|为|在)\s*(?:于|在)?\s*${PAIR}|(?:现在|当前|此刻|目前|此时)${GAP}(?:位置|坐标)(?:位于|处于|是|为|在)?\s*${PAIR}`,
    parse: 'pair',
    basis: 'observe().player：数屏幕上「@」在网格里的位置。屏幕未标轴，故双读法核对。',
  },
  {
    kind: 'movedTo', name: '已到达位置自述（完成时）',
    source: String.raw`(?:我|自己|玩家|角色)?\s*(?:已|已经|刚刚|刚才)\s*(?:成功)?\s*(?:移动)?\s*(?:移动到|移到|走到|到达|抵达|到了|进入|站在)\s*${PAIR}`,
    parse: 'pair',
    basis: '完成时自述的也是**决策前最后一帧**：thought 永远排在动作之前，"动作后的画面"在它说话时还不存在。',
  },
  {
    kind: 'moveIntent', name: '移动意图（非事实主张）',
    // 两种语序：「移动到/准备/先 … (a,b)」与「向右移动一格到 (a,b)」——后者方向在前，
    // 早期版本漏了它，于是全语料 800 多条计划句掉进「主语不明」，把意图误报成"说不清"。
    source: String.raw`(?:${MOVE_HEAD_GROUP}\s*(?:朝?[上下左右])?\s*(?:走|移动)?\s*(?:一格)?\s*(?:到|至|去|入)?\s*${PAIR})|(?:(?:朝|向|往)\s*[上下左右]{1,2}\s*(?:移动|走)?\s*(?:一格|两步)?\s*(?:到|至|去)?\s*${PAIR})|(?:(?:先|再)\s*(?:朝|向|往)?\s*[上下左右]{1,2}\s*(?:移动|走)?\s*(?:一格)?\s*(?:到|至|去)?\s*${PAIR})`,
    parse: 'pair',
    basis: '意图不陈述世界状态，屏幕无从反驳；它由 M4-a 的 predict 通道核对，这里只计数不判决。',
  },
  {
    kind: 'cellSymbol', name: '某格内容断言',
    // 四种写法：(a,b)是X / X在(a,b) / (a,b)处有X / (a,b)有X
    // ⚠️ 形状 2 前面挂了个**否定语序**：「3个敌人在(2,3)」说的是**数量**顺带指个位置，
    // 不是「(2,3)这一格里有敌人」。cellSymbol 排在 enemyCount 之前，一命中就把整段吞掉，
    // 后面那条真正该核对的数量主张当场消失（overlap 屏蔽，台账 #25 吞句的第二种形状）。
    // 拦下它之后剩下的数字对落进 barePair（无法核对·主语不明），**不判**——
    // 位置那半句确实说不清，宁可少判也不编造。
    // 边界：只有「阿拉伯数字 + 量词」才让位（「3个敌人」）。「两个敌人」的「两」enemyCount
    // 本来就数不出来（它只认 \d），此时 cellSymbol 不许跟着让位，否则是拿一个洞补另一个洞。
    source: String.raw`(?:${PAIR}\s*(?:是|为|=|是格|是个)\s*(?:一?格)?\s*['"]?(?:${SYM_ALT_GROUP})['"]?)|(?<!\d{1,2}\s*(?:个|只|名|枚))(?:${SYM_ALT_GROUP}\s*(?:位于|在|在坐标|位于坐标|就是)\s*${PAIR})|(?:${PAIR}\s*(?:处|格|这一格|这个格子)\s*(?:是|为|有|上有)\s*['"]?(?:${SYM_ALT_GROUP})['"]?)|(?:${PAIR}\s*(?:处|格)?\s*(?:有一个|有个|有|停着|站着)\s*['"]?(?:${SYM_ALT_GROUP})['"]?)`,
    parse: 'sym',
    basis: 'observe() 的 walls/enemies/pickups/player 坐标，按 render 图层顺序还原格子内容。',
  },
  {
    kind: 'pickupHere', name: '脚下有无拾取物',
    source: String.raw`(?:脚下|站的位置|此处|这一格|这格|我所在的格子?)\s*(?:正|又|也)?\s*(没有|没|无|不见|有|踩着|是)\s*(?:一个|一枚|个)?\s*(?:可拾取物|拾取物|物品|\+)|(?:可拾取物|拾取物|物品|\+)\s*(?:并|根本)?\s*不\s*(?:在|位于|踩着)\s*(?:我|自己)?(?:的)?\s*(?:脚下|身上|所在格|这一格|这格)`,
    parse: 'bool',
    words: {
      positive: ['有', '踩着', '是'],
      // ⚠️ 从长到短消耗，短词不吃进长词内部（#24）。裸「不」也收：第二支形状本身就要求有「不」。
      negative: ['并不是', '不位于', '不踩着', '没有', '不是', '并不', '不在', '不见', '没', '无', '不'],
    },
    basis: '只能看现象行：render 先画物品后画玩家，「@」盖掉「+」，格子里看不到脚下物品。',
  },
  {
    kind: 'hp', name: '血量绝对值(n/m)',
    // ⚠️ 修饰语从「可选的一个词」改成「可重复的若干个词」（台账 #26）：
    // 旧写法 `(?:是|为|目前|…)?` 只允许挂**一个**，于是「血量**目前是**7/10」这种最自然的
    // 说法整条规则静默失效——抽不出主张，比判错更隐蔽（#24 是漏一整类，这是漏一种状语组合）。
    // 白名单仍然是白名单：只列出来的词能重复，「血量与分数都是10/10」里的「与」不在表内就断掉，
    // 不许退化成 `[^。，]{0,6}?` 那种什么都吃的通配（那会把名词短语也吞进来）。
    source: String.raw`(?:hp|血量|血条|生命值|生命|血)(?:[\s]|是|为|=|:|目前|现在|当前|满值|剩|剩余|降到|掉到|恢复|还是|变成|变到)*(\d{1,3})\s*/\s*(\d{1,3})`,
    parse: 'two',
    basis: 'observe().hp 与 maxHp，HUD 原文「HP [####] n/m」。无坐标，故无约定歧义。',
  },
  {
    kind: 'hpValue', name: '血量绝对值(n)',
    source: String.raw`(?:hp|血量|生命值|血条)(?:[\s]|是|为|=|:|目前|现在|当前|满值|剩|剩余|降到|掉到|有|还|只)*(\d{1,3})(?!\s*/)(?=\D|$)`,
    parse: 'one',
    basis: '同 hp；分母由屏幕上限补齐，自述只说 n 也能核对。',
  },
  {
    kind: 'score', name: '分数绝对值',
    source: String.raw`分数\s*(?:是|为|=|仍为|仍|保持|还是|变到|变成|涨到|涨|:)?\s*(\d{1,3})`,
    parse: 'one',
    basis: 'observe().score，HUD 原文「分数 n」。只收绝对值；「分数+1」属增量，计入「未纳入」。',
  },
  {
    kind: 'alive', name: '存活状态自述',
    // 修饰语必须容下「已经/早已」「不会」「还没」：m4d-1 只收了 (?:没|未)?，
    // 于是「我不会死」「我已经死了」一条主张都抽不出——漏收比错收更隐蔽（#24）。
    source: String.raw`我(?:还|仍|依然|现在|目前|已经|已|早已|早就)?\s*(?:没|未|不)?\s*(?:会|能|再)?\s*(没有?|未)?\s*(活着|存活|死|倒下|阵亡|被击败)(?:了|过|掉)?`,
    parse: 'bool',
    words: {
      positive: ['没有死', '没死', '未死', '不会死', '没有倒下', '没倒下', '未倒下', '不会倒', '活着', '存活'],
      negative: ['被击败', '已死', '阵亡', '死亡', '倒下', '死了', '死过', '死'],
    },
    basis: 'observe().alive，状态行原文「状态：活着/已倒下」。主语必须是「我」，否则是机制讨论。',
  },
  {
    kind: 'attack', name: '攻击就绪自述',
    // 必须紧贴：早期版本用 `攻击[^。，]{0,6}?(冷却)` 会吃到「攻击验证得分与冷却逻辑」，
    // 那是**动作+名词**，不是状态主张。假阳性比漏报更毒：它会虚高相符率。
    // 但"紧贴"不等于"只许挂一个状语"：夹具判出「攻击**还没**就绪」整条失效（#26），
    // 所以这里改成**白名单词可重复**——「还」「没」各自在表里才连得起来，
    // 表外的字（验、得、分）仍然一处都吃不进。
    // 与之配套：否定词表补「没就绪/没准备好/不就绪」。少了它们，「还没就绪」抽得出却会被
    // 极性判成肯定（"就绪"两个字确实在段里），一句没错的自述就被冤枉成矛盾（#24 同族）。
    source: String.raw`(?:攻击|技能)(?:[\s]|状态|是|为|:|处于|仍|还|已经|已|尚未|未|不|没|且|并)*(就绪|冷却中|准备好|未就绪|还在冷却|在冷却)`,
    parse: 'bool',
    words: { positive: ['就绪', '准备好'], negative: ['冷却中', '未就绪', '还在冷却', '在冷却', '没就绪', '没准备好', '不就绪'] },
    basis: 'observe().attackReady，状态行原文「攻击：就绪/冷却中」。屏幕只给状态不给剩余计数。',
  },
  {
    kind: 'enemyCount', name: '敌人数量自述',
    source: String.raw`(?:还?剩余|剩下|有|共有|计|画面上?有|屏幕上有?|场上|地图上?有)\s*(\d{1,2})\s*(?:个|只|名|枚)?\s*(?:敌人|敌|怪物|怪)|(\d{1,2})\s*(?:个|只|名|枚)\s*(?:敌人|敌|怪物|怪)`,
    parse: 'one',
    basis: 'observe().enemies.length：数屏幕上的「E」。死敌从画面消失，所以这是**可见数**，不是内部存活数。',
  },
  {
    kind: 'pickupCount', name: '可拾取物数量自述',
    source: String.raw`(?:还?剩余|剩下|有|共有|画面上?有|屏幕上有?|地图上?有)\s*(\d{1,2})\s*(?:个|枚|只)?\s*(?:可拾取物|拾取物|物品|\+)|(\d{1,2})\s*(?:个|枚)\s*(?:可拾取物|拾取物|物品|\+)`,
    parse: 'one',
    basis: 'observe().pickups.length：数屏幕上的「+」。已拾走的不上屏，被「@」覆盖的看不到（同 pickupHere）。',
  },
  {
    kind: 'gridSize', name: '地图尺寸自述',
    source: String.raw`(?:地图|网格|棋盘)(?:[\s]|是|为|大小|尺寸|约|宽|高|的)*(\d{1,2})\s*[x×*]\s*(\d{1,2})|(?:宽度|宽)\s*(\d{1,2})\s*格?\s*,?\s*(?:高度|高)\s*(\d{1,2})`,
    parse: 'two',
    basis: 'observe().size：网格行列数。屏幕网格恒为正方，故两值都必须等于 size。',
  },
  {
    kind: 'barePair', name: '主语不明的数字对（兜底，不丢）',
    source: PAIR, parse: 'pair',
    basis: '没被任何具主语规则收编的数字对。绝不静默丢弃：进「无法核对·主语不明」并计入恒等式。',
  },
];

/** 「未纳入核对」的形状：判据不收，但必须报数量，不许假装没看见。 */
export const EXCLUDED_RULES: readonly { name: string; source: string; why: string }[] = [
  {
    name: '增量自述', why: '说的是帧间变化量，需要前后两帧；本轮判据只对绝对值（M4-a 的 predict 通道已在核对它）',
    source: String.raw`(?:分数|得分)\s*[+＋]\s*\d+|[+＋]\s*\d+\s*分|[-－]\s*\d+\s*(?:hp|点血|点生命|血)|掉\s*\d+\s*(?:点|血|hp)|扣\s*\d+\s*(?:点|血|hp)|血量?[上下](?:涨|降|减少?|增加?)\s*\d+`,
  },
  {
    name: '机制假设', why: '假设句不是当下事实主张，由 M4-b 假设板与 M4-f 归因通道负责',
    source: String.raw`可能|推测|假设|也许|大概|应该(?:是)?会|说明|意味着|似乎`,
  },
  {
    name: '方位词位置', why: '以自身方位描述，与坐标系读法纠缠，机械判决会误伤；只能人工读',
    source: String.raw`(?:左|右|上|下)(?:边|侧|方|面)\s*(?:是|有|为|的|相邻|紧邻)?\s*(?:${PAIR})?|(?:相邻|紧邻)\s*(?:位置|格)?\s*(?:是|为|有)?\s*${PAIR}`,
  },
];

// ─────────────────────────── 冻结指纹 ───────────────────────────

/**
 * 进指纹：规则名、正则源串、词表、可核对性说明、四桶、类别表、排除表、回溯表与子句分隔符。
 * 不进指纹：judgeClaim 的实现。它由 verify/recon-fixture.ts 的手写真值表与
 * verify/recon-audit.ts 的独立重算两头约束，不靠这段文本。
 * 把覆盖边界写出来，比假装全覆盖诚实。
 */
export function reconCanonical(): string {
  return JSON.stringify({
    version: RECON_VERSION,
    verdicts: VERDICTS,
    kinds: KINDS,
    fullwidth: FULLWIDTH_MAP,
    fullwidthAscii: FULLWIDTH_ASCII,
    rules: RULES.map((r) => ({
      kind: r.kind, name: r.name, source: r.source, parse: r.parse,
      words: r.words ?? null, basis: r.basis,
    })),
    retro: RETRO_RULES,
    // m4d-5：回溯的**范围单位**进指纹。判"哪句话算回溯"这件事和词表本身一样是口径，
    // 只在代码里活着就是个没人认领的标准（台账 #27 之所以难查，正因为它藏在切片下标里）。
    retroScope: { delimiters: SUB_CLAUSE_DELIMS, colonLeadIn: true, bracketsProtected: true },
    symbols: SYMBOL_WORDS,
    excluded: EXCLUDED_RULES,
  });
}

export function reconSha(): string {
  return createHash('sha256').update(reconCanonical(), 'utf8').digest('hex');
}

/**
 * 冻结时的指纹（m4d-5）。改任何一个词/一条正则/一个分隔符，test/reconcile.test.ts 立刻红。
 * ⚠️ 冻结的根据是**人工判读**，四批全对过之后才写下这一行：
 *    真值表（极性档 #24、回溯词转义、MOVE_HEAD 交替组＝#23 同族）→
 *    抽读矛盾明细（抢跑吞句 #25 三处）→ 手写夹具（修饰语只挂一个词＝#26 三处漏收）→
 *    独立重算在真语料上判出的 19 处分歧（#27：±18 字符的回溯窗口连自己都不自洽）。
 *    19 处的原句是人逐条读的，读完才去数"同一句话里分裂的形状全语料共 112 处"——
 *    顺序倒过来就变成拿统计定口径（#19）。
 *    期望值全部是人对着屏幕逐格定的，没有一处从统计里回填。
 *    m4d-1/m4d-2 的 dry-run 与 m4d-3（1165 条）、m4d-4（1171 条）的落盘一律作废，见文件顶部版本史。
 * 📌 冻结顺序：先写下这一行 → 单测全绿 → **才**跑 verify/recon.ts 出数。
 *    倒过来就变成"看着数字调判据"（台账 #19）。
 */
export const FROZEN_SHA256 = '30bb9ffb08a1b219e324daeb453a8a98ed26cf79bd3faf900037edd1160651b4';

export function reconDrift(): string | null {
  const now = reconSha();
  return now === FROZEN_SHA256 ? null
    : `对账判据与冻结时不一致（frozen=${FROZEN_SHA256.slice(0, 12)}… now=${now.slice(0, 12)}…），version=${RECON_VERSION}`;
}

export function reconStamp(): { recon: string; sha: string; frozenAt: string } {
  return { recon: RECON_VERSION, sha: reconSha(), frozenAt: FROZEN_AT };
}

/**
 * 回溯线索**表**（m4d-5；台账 #27）。句子说的是**更早**那一帧，而不是 agent 刚看到的那一帧。
 * 为什么必须有这一档：早期版本把「原来敌人在(1,0)但刚刚被消除」拿当下屏幕核对，
 * 判成矛盾——那是判据的错，不是模型的错。核对当下已经足够硬，回溯就让给它不核对，
 * 但要**计数并说出口**，不许混进相符/矛盾任一侧。（台账 #23）
 *
 * 为什么从"词表"升格成"表格"：光认出"这是句回溯"还不够，还得问**它说的是哪一帧**。
 * 「第 5 帧敌人在(4,3)」把帧号说死了，锚点恰好是第 5 帧时它就是在说现状，没理由放过不核对；
 * 「之前敌人在(1,1)」说不出帧号，只能不核对。这一区分让「初始/第 N 帧」两族从
 * 一律免检变成有条件核对——方向由真语料里那 112 处窗口分裂人工读句定，不看统计。
 */
export interface RetroRule {
  /** 字面词；match==='frame' 时是**带一个捕获组**的正则源串 */
  source: string;
  match: 'literal' | 'frame';
  /** 这句指的是哪一帧：'unknown'=子句里读不出来（永不核对）；'first'=第 0 帧；'captured'=捕获组里的帧号 */
  frame: 'unknown' | 'first' | 'captured';
}

export const RETRO_RULES: readonly RetroRule[] = [
  // ⚠️ 必须 String.raw：写成普通字符串时 `\s`→"s"、`\d`→"d"，m4d-1 存进去的是「第sds*s帧」，
  // 于是「第 2 帧时敌人在(1,1)」一条回溯都没命中，拿当下屏幕核对成矛盾——冤枉被试（#24 同族）。
  // m4d-5 起这里的 `\d+` 变成 `(\d+)`：捕获组是判据的一部分，不是实现的私货，所以进指纹。
  { source: String.raw`第\s*(\d+)\s*帧`, match: 'frame', frame: 'captured' },
  { source: '原来', match: 'literal', frame: 'unknown' },
  { source: '先前', match: 'literal', frame: 'unknown' },
  { source: '之前', match: 'literal', frame: 'unknown' },
  { source: '上一帧', match: 'literal', frame: 'unknown' },
  { source: '前一帧', match: 'literal', frame: 'unknown' },
  { source: '曾经', match: 'literal', frame: 'unknown' },
  { source: '原本', match: 'literal', frame: 'unknown' },
  { source: '早先', match: 'literal', frame: 'unknown' },
  { source: '那时', match: 'literal', frame: 'unknown' },
  { source: '当时', match: 'literal', frame: 'unknown' },
  { source: '此前', match: 'literal', frame: 'unknown' },
  { source: '上一步', match: 'literal', frame: 'unknown' },
  { source: '上一次', match: 'literal', frame: 'unknown' },
  // 「初始/开局」这一族远指比「之前」更隐蔽：它不带"过去时"标记，句子读起来像在陈述现状
  // （「初始@在(0,0)」）。由真值表 T 组「初始」两例守着（#25 抽样复核时发现）。
  // m4d-5：这一族自己就把帧号说成第 0 帧了，所以它是 'first' 不是 'unknown'——
  // 第 0 帧正是首条决策行的锚点（header.initialState.world.screen），该核对。
  { source: '初始', match: 'literal', frame: 'first' },
  { source: '开局', match: 'literal', frame: 'first' },
  { source: '一开始', match: 'literal', frame: 'first' },
  { source: '开始时', match: 'literal', frame: 'first' },
  { source: '最初', match: 'literal', frame: 'first' },
];

/**
 * ⚠️ 刻意**不含**「刚才/刚刚」：它们指的通常就是上一步，而上一步的结果画面
 * 正是本判据的锚点（决策前最后一帧）。把它们当回溯词，会把最该核对的一类
 * ——「我刚刚移动到了 X」——全部推给「无法核对」，对账当场失去一半样本。
 * 这种"看起来更保守其实更空"的修法，由 verify/recon-fixture.ts 的 T 组夹具守着。
 */

/**
 * 子句分隔符（进冻结指纹——"回溯算到哪一句"这件事必须有身份，否则又是一处只活在代码里的口径）。
 * ⚠️ 括号**故意不在里面**：坐标字面自己就用括号（「(2,3)」），把括号当分隔符等于把每条坐标主张
 * 从中间切开，下标全乱（#13 家族：静默偏移比报错难查十倍）。
 * ⚠️ 半角句点「.」**必须在里面**：归一化把「。」换成「.」，分隔符表只列全角那一套就静默漏掉
 * 整类句号——「之前敌人在(1,1)。分数2」会被并成一句，回溯连坐到下半句（首跑就是这么红的，
 * 台账 #24 同族：两张表各说各话）。全角那套仍留着：万一拿到没归一化的文本也不漏。
 */
export const SUB_CLAUSE_DELIMS = String.raw`[，,.。;；:：、!！?？\n]`;
const SUB_SPLIT = new RegExp(SUB_CLAUSE_DELIMS);

/**
 * 主张**自己所在的那个子句**——回溯判定的范围单位（m4d-5 换掉 ±18 字符窗口）。
 *
 * 为什么是子句而不是句子：一句「我在(2,3)，之前敌人在(1,1)」里前半句在说现状、后半句在说过去，
 * 拿整句当范围会把前半句也推给"无法核对"（模型明明说对了，判据却不敢对账）。
 * 为什么不是固定字符窗口：窗口切在哪由**字符数**决定，跟语义没关系，于是同一句话里
 * 挨着的两条主张一条算回溯一条不算（#27 的实证：全语料 112 处这种自相矛盾）。
 * 剩下的边界情况走保守：整句没标点时子句＝整句，此时确实读不出线索词管到哪儿，就不核对。
 *
 * ⚠️ 括号**内部**的分隔符不算分隔符。坐标字面自己就带逗号（「(1,1)」），
 * 不保护的话「之前敌人在(1,1)我在(2,3)」的后半句会从 `(1` 与 `1)` 之间被劈开，
 * 于是同一句话里只有前半句背上回溯——正好复刻了窗口口径那种"半句算半句不算"的不自洽（#27）。
 * 保护范围用「开括号…最近的闭括号」这一段，进冻结指纹登记为 `bracketsProtected`。
 */
export function subClauseOf(norm: string, start: number, end: number): string {
  const inside = bracketMask(norm);
  const isDelim = (i: number): boolean => !inside[i]! && SUB_SPLIT.test(norm[i]!);
  let a = start;
  while (a > 0 && !isDelim(a - 1)) a--;
  let b = end;
  while (b < norm.length && !isDelim(b)) b++;
  // 冒号引导句并入自己：「已获取初始状态：我在(2,3)」里「初始」管的是冒号后面整句，
  // 只算冒号后那一小截会把这句话当成可核对的现状——它其实说的是开局那一帧。
  // 只在**紧邻的前一段正好以冒号结尾**时并入；句号、逗号不是引导，那是另一句话。
  // （isDelim 为假的那个冒号是括号内部的，不算引导句尾，见 bracketMask 的注释。）
  for (;;) {
    if (a === 0 || norm[a - 1] !== ':' || !isDelim(a - 1)) break;
    let c = a - 1;
    while (c > 0 && !isDelim(c - 1)) c--;
    a = c;
  }
  return norm.slice(a, b);
}

/** 括号内部（含括号本身）标记：这一段里的逗号/冒号不当子句分隔符。不成对的开括号不设保护。 */
function bracketMask(norm: string): boolean[] {
  const inside = new Array<boolean>(norm.length).fill(false);
  const re = /[([][^)\]]*[\])]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    for (let i = m.index; i < m.index + m[0].length; i++) inside[i] = true;
  }
  return inside;
}

export interface Retro { retro: boolean; retroWord: string; retroTick: number | null }

function retroOf(scope: string): Retro {
  let unknown: string | null = null;
  let captured: { word: string; tick: number } | null = null;
  let first: string | null = null;
  for (const r of RETRO_RULES) {
    if (r.match === 'literal') {
      if (!scope.includes(r.source)) continue;
      if (r.frame === 'unknown') unknown ??= r.source;
      else first ??= r.source;
    } else {
      const m = new RegExp(r.source).exec(scope);
      if (m === null || m[1] === undefined) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n)) captured ??= { word: m[0], tick: n };
    }
  }
  // 优先级：说不准 > 说得出帧号 > 第 0 帧。
  // 为什么「说不准」赢：子句里同时出现「之前」和「第 3 帧」时（「之前看过第 3 帧那张图」），
  // 句子到底指哪一帧已经读不出来了。归位到第 3 帧就是替模型编一个它没说出口的锚点，
  // 万一编对的是别的帧，产出的是一条**看起来很像**的矛盾（#24 同族：错值比抽不到更糟）。
  // 不核对的代价只是少一个样本，认错的代价是把判据的错记在被试头上。
  if (unknown !== null) return { retro: true, retroWord: unknown, retroTick: null };
  if (captured !== null) return { retro: true, retroWord: captured.word, retroTick: captured.tick };
  if (first !== null) return { retro: true, retroWord: first, retroTick: 0 };
  return { retro: false, retroWord: '', retroTick: null };
}

/**
 * 「回溯词躲在括注里」算不算命中——m4d-5 跑完后人读 10 条定下的立场（不是从聚合数字挑的）。
 *
 * 真语料里有 10 条主张的回溯线索词位于括号内部，逐条读过分成两类：
 *   ① 8 条：括号里装的**就是**那句过去时陈述——「敌人数量由1增至2(原来在(7,0)的敌人还在…)」、
 *      「敌人在持续移动(原来在(1,4)的E移到了(1,5))」、「击杀了一个紧邻的敌人(原来在我下方的(1,1))」。
 *      这类必须不判：那句话压根不是在说锚点这一帧。
 *   ② 2 条：括注只是**注脚**，主句在说现状——「攻击处于冷却中(第13帧触发)」
 *      （runs/m4e-postfix/20261114-090613-s6 第78行）就是这一类，判据把它推给了「无法核对」。
 * 两种写法只能选一种，因为模式判不出「(第13帧触发)」是原因注脚还是时间状语：
 *   把括号内部剔出回溯范围 → ②能核对了，但 ① 里那句「原来在(7,0)」会被当成现状去核对，
 *     产出一条**看起来很真**的矛盾或相符——污染的是唯一可引用的那对数字（相符+矛盾）；
 *   保留现在的口径（括注与主句同属一个子句，命中即整条不判）→ 代价是少核 ② 那一条。
 * 选后者：不核对只损失样本，认错是把判据的错记在被试头上（台账 #15/#24 同一条底线）。
 * 立场由 verify/recon-fixture.ts 的 F43（②侧）与 F44（①侧）各钉一格，改口径必须同时改这两格。
 */

// ─────────────────────────── 抽取 ───────────────────────────

function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}

/** span 里**第一个坐标对字面**的数字。用它，而不是"span 的前两个数字"。 */
function firstPairIn(span: string): [number, number] | null {
  const re = new RegExp(PAIR);
  const m = re.exec(span);
  return m === null ? null : [Number(m[1]), Number(m[2])];
}

/** 命中段里**最后一个**符号字面：坐标类句子常写成「(3,0)是敌人」，符号总在末尾。 */
function symbolIn(text: string): string | null {
  let best: { i: number; s: string; w: string } | null = null;
  for (const [w, s] of SYMBOL_WORDS) {
    // ⚠️ 不能用 `i = text.lastIndexOf(w, i - 1)`：i=0 时 fromIndex=-1 会被钳回 0，
    // 于是"命中恰好在句首"（「可拾取物在(8,7)」）就成了死循环。真跑第一次就卡死在这里。
    let i = text.length;
    for (;;) {
      i = text.lastIndexOf(w, i - 1);
      if (i < 0) break;
      if (!best || i > best.i || (i === best.i && w.length > best.w.length)) best = { i, s, w };
      if (i === 0) break;
    }
  }
  return best ? best.s : null;
}

/**
 * 极性判决：`'pos' | 'neg' | 'both' | 'none'`。
 *
 * ⚠️ 台账 #24（真值表判出来的，不是统计里翻出来的）：
 * 旧写法对肯定、否定两张词表各做一次 `includes`，于是
 *   「脚下**没有**可拾取物」→ 否定词「没有」命中，**同时**肯定词「有」也命中 → both
 *   「攻击**未**就绪」→ 否定「未就绪」命中，肯定「就绪」作为子串也命中 → both
 *   「我**没**倒下」→ 否定「倒下」命中，肯定表里根本没有「没倒下」→ neg（判成已倒下，冤枉）
 * 后果不是报错，是**整类否定式主张静默掉进无法核对**——看起来"保守"，实际是把
 * 最该核对的一档全部免检。修法：按词长**从长到短消耗**文本，命中一个词就把这一段划掉，
 * 短词不再吃进长词的内部；否定式语义（没倒下）单独进肯定表，因为它就是肯定意思。
 */
export type Polarity = 'pos' | 'neg' | 'both' | 'none';

function polarityOf(span: string, w?: { positive?: readonly string[]; negative?: readonly string[] }): Polarity {
  if (!w) return 'none';
  const all: [string, boolean][] = [
    ...(w.positive ?? []).map((x) => [x, true] as [string, boolean]),
    ...(w.negative ?? []).map((x) => [x, false] as [string, boolean]),
  ].sort((a, b) => b[0].length - a[0].length);
  let rest = span;
  let pos = false;
  let neg = false;
  for (const [word, isPos] of all) {
    if (word.length === 0) continue;
    const hits = rest.split(word).length - 1;
    if (hits === 0) continue;
    if (isPos) pos = true; else neg = true;
    rest = rest.split(word).join('');   // 划掉已消耗区间，短词不许再吃内部
  }
  if (pos && neg) return 'both';
  if (pos) return 'pos';
  if (neg) return 'neg';
  return 'none';
}

/**
 * 从一段文本抽出全部主张。**纯函数，规则顺序即优先级。**
 * 具主语规则先收编 span，barePair 只吃剩下的——于是「每个数字对恰好属于一条主张」
 * 是构造出来的，不是祈祷出来的。
 */
export function extractClaims(rawText: string): Claim[] {
  const norm = normalizeText(rawText);
  const taken: [number, number][] = [];
  const overlap = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const out: Claim[] = [];

  const collect = (rule: RuleDef): void => {
    const re = new RegExp(rule.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(norm)) !== null) {
      const end = re.lastIndex;
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (overlap(m.index, end)) continue;
      const span = norm.slice(m.index, end);
      const nums = numbersIn(span);
      let value: number[] = [];
      let positive: boolean | null = null;
      let polarity: Polarity = 'none';
      let symbol: string | null = null;
      if (rule.parse === 'pair' || rule.parse === 'sym') {
        // 只认 span 里**那个坐标对字面**的数字，不认"span 里出现的前两个数字"：
        // 「我移动到第5帧的(2,3)」这类带插入数字的写法，用 nums 会把 5 当成 x（#24 同族：
        // 抽出错值比抽不到更糟——它会造出一条**看起来很像**的矛盾主张）。
        const p = firstPairIn(span);
        if (p === null) continue;
        value = [p[0], p[1]];
      } else if (rule.parse === 'two') {
        if (nums.length < 2) continue;
        value = [nums[0]!, nums[1]!];
      } else if (rule.parse === 'one') {
        if (nums.length < 1) continue;
        value = [nums[0]!];
      } else {
        polarity = polarityOf(span, rule.words);
        positive = polarity === 'pos' ? true : polarity === 'neg' ? false : null;
      }
      if (rule.parse === 'sym') {
        symbol = symbolIn(span);
        if (symbol === null) continue;
      }
      out.push({
        kind: rule.kind, rule: rule.name, quote: rawText.slice(m.index, end),
        value, positive, polarity, symbol, at: m.index,
        // 回溯范围＝主张自己所在的子句（m4d-5；旧口径是左右各 18 字符的窗口，台账 #27）
        ...retroOf(subClauseOf(norm, m.index, end)),
      });
      taken.push([m.index, end]);
    }
  };

  // 规则顺序即优先级：具主语规则先收编 span
  for (const rule of RULES) if (rule.kind !== 'barePair') collect(rule);

  // 兜底：剩下的每个数字对都计成 barePair，一个都不许丢。
  // 数字对本身互不重叠，所以一趟扫描就够（overlap 已屏蔽被具主语规则占用的 span）。
  collect(RULES.find((r) => r.kind === 'barePair')!);

  return out.sort((x, y) => x.at - y.at);
}

/** 主张所在从句（±30 字）。报告里显示它，人工复核不必回去翻 trace。 */
const CLAUSE = /[。;!?\n]/;
export function clauseFor(rawText: string, claim: Claim): string {
  const norm = normalizeText(rawText);
  let a = claim.at;
  while (a > 0 && !CLAUSE.test(norm[a - 1]!)) a--;
  let b = claim.at + claim.quote.length;
  while (b < norm.length && !CLAUSE.test(norm[b]!)) b++;
  return rawText
    .slice(Math.max(a, claim.at - 30), Math.min(b, claim.at + claim.quote.length + 30))
    .replace(/\s+/g, ' ').trim();
}

/** 「未纳入」计数：一条都不判，但必须让读者看到有多少没被核对。 */
export function countExcluded(rawText: string): { name: string; n: number }[] {
  const norm = normalizeText(rawText);
  return EXCLUDED_RULES.map((r) => {
    const re = new RegExp(r.source, 'g');
    let n = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(norm)) !== null) {
      n++;
      if (m[0].length === 0) re.lastIndex++;
    }
    return { name: r.name, n };
  });
}

// ─────────────────────────── 判决 ───────────────────────────

const onCell = (list: readonly [number, number][], x: number, y: number): boolean =>
  list.some(([px, py]) => px === x && py === y);

/** 按 render 的图层顺序还原**可见**格子内容：墙 < 物品 < 敌人 < 玩家。越界/无网格返回 null。 */
export function cellSymbolAt(obs: Observation, x: number, y: number): string | null {
  if (obs.size === null) return null;
  if (x < 0 || y < 0 || x >= obs.size || y >= obs.size) return null;
  if (obs.player !== null && obs.player[0] === x && obs.player[1] === y) return '@';
  if (onCell(obs.enemies, x, y)) return 'E';
  if (onCell(obs.pickups, x, y)) return '+';
  if (onCell(obs.walls, x, y)) return '#';
  return '.';
}

const pairStr = (p: readonly [number, number] | null): string =>
  p === null ? '（无）' : `(${p[0]},${p[1]})`;

/** 一条主张 + 它依据的那一帧屏幕 → 四桶之一。**纯函数**。 */
export function judgeClaim(claim: Claim, obs: Observation | null): Judged {
  const base = { ...claim };
  const unver = (why: string): Judged => ({ ...base, verdict: '无法核对', why });
  if (obs === null) return unver('这一步之前没有屏幕可依据（未观察，或工具没返回画面）');

  if (claim.retro) {
    // 锚点帧的读法：屏幕自己写着「第 N 帧」，不是内部计数器（铁律 1）
    const anchor = obs.tick === null ? '（这一帧的屏幕上没有帧号）' : `第 ${obs.tick} 帧`;
    if (claim.retroTick !== null && obs.tick === claim.retroTick) {
      // 归位成功：它嘴上说"更早"，说出来的那一帧正好就是它说话时看到的这一帧。
      // 这不是回溯，是现状，照常核对。放行时不另开一档，是为了让"回溯"这件事
      // 只在抽取侧说话，判决侧的四个桶仍只由屏幕事实决定（#21：分母要有身份）。
    } else {
      return unver(claim.retroTick === null
        ? `回溯性陈述（命中「${claim.retroWord}」），子句里读不出它说的是哪一帧；本判据只对决策前最后一帧（${anchor}）负责`
        : `回溯性陈述（命中「${claim.retroWord}」）说的是第 ${claim.retroTick} 帧，锚点是${anchor}——不是同一帧，不判`);
    }
  }
  const boolKinds: Kind[] = ['pickupHere', 'alive', 'attack'];
  if (boolKinds.includes(claim.kind) && claim.positive === null) {
    // 两种"判不出"要分开出声：both 是模型说得含混，none 是我的词表没覆盖到
    return unver(claim.polarity === 'both'
      ? '命中段里肯定与否定说法同现，极性判不出——绝不猜'
      : '命中段里没有任何已登记的肯定/否定说法，极性判不出——绝不猜');
  }

  switch (claim.kind) {
    case 'playerPos':
    case 'movedTo': {  // 两者锚点相同（决策前最后一帧），分开只因为语术与时态不同
      const [a, b] = claim.value;
      if (obs.size === null) return unver('屏幕没有可解析的网格');
      if (a >= obs.size || b >= obs.size) {
        return { ...base, verdict: '矛盾', why: `越界：自称 (${a},${b})，屏幕网格只有 ${obs.size}×${obs.size}，两种读法都不可能` };
      }
      if (obs.player === null) return unver('屏幕上看不到唯一的「@」（被覆盖或多于一个）');
      const xy = obs.player[0] === a && obs.player[1] === b;
      const yx = obs.player[0] === b && obs.player[1] === a;
      if (xy) return { ...base, verdict: '相符', why: `(x,y) 读法相符：屏幕 @ 在 ${pairStr(obs.player)}` };
      if (yx) return { ...base, verdict: '约定存疑', why: `只在(y,x)/行列 读法相符：屏幕 @ 在 ${pairStr(obs.player)}，而屏幕未标轴` };
      return { ...base, verdict: '矛盾', why: `两种读法都不符：自称 (${a},${b})，屏幕 @ 在 ${pairStr(obs.player)}` };
    }
    case 'cellSymbol': {
      const [a, b] = claim.value;
      const sym = claim.symbol!;
      if (obs.size === null) return unver('屏幕没有可解析的网格');
      if (a >= obs.size || b >= obs.size) {
        return { ...base, verdict: '矛盾', why: `越界：自称 (${a},${b})，屏幕网格只有 ${obs.size}×${obs.size}，两种读法都落不到格子` };
      }
      const atPlayer = obs.player !== null && (
        (obs.player[0] === a && obs.player[1] === b) || (obs.player[0] === b && obs.player[1] === a));
      if (atPlayer && (sym === '+' || sym === 'E')) {
        return unver(`该格是玩家所在，render 用「@」覆盖「${sym}」，屏幕上看不出来`);
      }
      const r1 = cellSymbolAt(obs, a, b);
      const r2 = cellSymbolAt(obs, b, a);
      if (r1 === sym) return { ...base, verdict: '相符', why: `(x,y) 读法下该格可见「${sym}」` };
      if (r2 === sym) return { ...base, verdict: '约定存疑', why: `只在(y,x)/行列 读法下该格是「${sym}」，屏幕未标轴` };
      return { ...base, verdict: '矛盾', why: `两种读法都不是「${sym}」：屏幕上这两格是「${r1}」/「${r2}」` };
    }
    case 'pickupHere': {
      const ev = obs.events.join(' ');
      if (ev.includes('你脚下没有可拾取的东西')) {
        return claim.positive
          ? { ...base, verdict: '矛盾', why: '现象行明写「你脚下没有可拾取的东西」' }
          : { ...base, verdict: '相符', why: '现象行明写「你脚下没有可拾取的东西」' };
      }
      if (ev.includes('你拾取了地上的东西')) {
        return claim.positive
          ? { ...base, verdict: '相符', why: '现象行明写「你拾取了地上的东西」' }
          : { ...base, verdict: '矛盾', why: '现象行明写「你拾取了地上的东西」，与「脚下没有」相反' };
      }
      return unver('屏幕图层：「@」盖掉「+」，脚下有无物品不可见，本帧现象行也没说');
    }
    case 'hp': {
      const [n, m] = claim.value;
      if (obs.hp === null || obs.maxHp === null) return unver('屏幕没有 HP 行');
      return n === obs.hp && m === obs.maxHp
        ? { ...base, verdict: '相符', why: `屏幕 HP ${obs.hp}/${obs.maxHp}` }
        : { ...base, verdict: '矛盾', why: `自称 ${n}/${m}，屏幕 HP ${obs.hp}/${obs.maxHp}` };
    }
    case 'hpValue': {
      const n = claim.value[0]!;
      if (obs.hp === null) return unver('屏幕没有 HP 行');
      return n === obs.hp
        ? { ...base, verdict: '相符', why: `自称 ${n}，屏幕 HP ${obs.hp}/${obs.maxHp}` }
        : { ...base, verdict: '矛盾', why: `自称 ${n}，屏幕 HP ${obs.hp}/${obs.maxHp}` };
    }
    case 'score': {
      const n = claim.value[0]!;
      if (obs.score === null) return unver('屏幕没有分数');
      return n === obs.score
        ? { ...base, verdict: '相符', why: `自称 ${n}，屏幕分数 ${obs.score}` }
        : { ...base, verdict: '矛盾', why: `自称 ${n}，屏幕分数 ${obs.score}` };
    }
    case 'enemyCount': {
      const n = claim.value[0]!;
      return n === obs.enemies.length
        ? { ...base, verdict: '相符', why: `自称 ${n}，屏幕可见 E=${obs.enemies.length}` }
        : { ...base, verdict: '矛盾', why: `自称 ${n}，屏幕可见 E=${obs.enemies.length}` };
    }
    case 'pickupCount': {
      const n = claim.value[0]!;
      return n === obs.pickups.length
        ? { ...base, verdict: '相符', why: `自称 ${n}，屏幕可见 +=${obs.pickups.length}` }
        : { ...base, verdict: '矛盾', why: `自称 ${n}，屏幕可见 +=${obs.pickups.length}` };
    }
    case 'gridSize': {
      const [a, b] = claim.value;
      if (obs.size === null) return unver('屏幕没有可解析的网格');
      return a === obs.size && b === obs.size
        ? { ...base, verdict: '相符', why: `屏幕网格 ${obs.size}×${obs.size}` }
        : { ...base, verdict: '矛盾', why: `自称 ${a}×${b}，屏幕网格 ${obs.size}×${obs.size}` };
    }
    case 'alive': {
      if (obs.alive === null) return unver('屏幕没有状态行');
      const say = claim.positive ? '活着' : '已倒下';
      const act = obs.alive ? '活着' : '已倒下';
      return claim.positive === obs.alive
        ? { ...base, verdict: '相符', why: `自称「${say}」，屏幕状态=${act}` }
        : { ...base, verdict: '矛盾', why: `自称「${say}」，屏幕状态=${act}` };
    }
    case 'attack': {
      if (obs.attackReady === null) return unver('屏幕没有攻击状态行');
      const say = claim.positive ? '就绪' : '冷却中';
      const act = obs.attackReady ? '就绪' : '冷却中';
      return claim.positive === obs.attackReady
        ? { ...base, verdict: '相符', why: `自称「${say}」，屏幕=${act}` }
        : { ...base, verdict: '矛盾', why: `自称「${say}」，屏幕=${act}` };
    }
    case 'moveIntent':
      return unver('意图不是事实主张，屏幕无从反驳（预测由 M4-a 通道核对）');
    case 'barePair':
      return unver('同句内没有可绑定的主语，无法确定这条数字对说的是谁');
    default: {
      // 类别表外的主张**必须炸**：让它落进四桶之外，分母就静默偏小（#21 家族）。
      const k = claim.kind as string;
      throw new Error(`判据类别表外：${k}（不在 ${KINDS.join('/')} 里，拒绝出统计）`);
    }
  }
}

export interface Buckets {
  counts: Record<Verdict, number>;
  byKind: Record<Kind, Record<Verdict, number>>;
}

const zero = (): Record<Verdict, number> =>
  Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;

/**
 * 判决列表 → 四桶 + 分类四桶，并**当场核恒等式**。
 * 单独导出是为了让"断裂必出声"这条守卫能被真测到（台账 #22：测不到的分支＝没在守东西）：
 * 传一条表外判决进来就得抛，而不是算出一个偏小的分母。
 */
export function bucketize(judged: Judged[]): Buckets {
  const counts = zero();
  const byKind = Object.fromEntries(KINDS.map((k) => [k, zero()])) as Record<Kind, Record<Verdict, number>>;
  for (const j of judged) {
    if (!VERDICTS.includes(j.verdict)) throw new Error(`判决表外：${String(j.verdict)}（不在 ${VERDICTS.join('/')} 里）`);
    if (!KINDS.includes(j.kind)) throw new Error(`判据类别表外：${String(j.kind)}`);
    counts[j.verdict]++;
    byKind[j.kind][j.verdict]++;
  }
  const sum = VERDICTS.reduce((s, v) => s + counts[v], 0);
  if (sum !== judged.length) throw new Error(`恒等式断裂：四桶之和 ${sum} ≠ 主张总数 ${judged.length}`);
  for (const k of KINDS) {
    const s = VERDICTS.reduce((x, v) => x + byKind[k][v], 0);
    const n = judged.filter((j) => j.kind === k).length;
    if (s !== n) throw new Error(`分类恒等式断裂：${k} 四桶之和 ${s} ≠ 该类主张数 ${n}`);
  }
  return { counts, byKind };
}

/**
 * 一批主张 → 判决 + 四桶 + 分类四桶。
 * 恒等式不成立直接抛错：宁可崩，也不许带着断裂的分母出报告。
 * 入参按 (主张, 依据屏幕) 成对给出：锚点选择在调用侧（读得到 trace 的那一层），
 * 本文件不知道 trace 长什么样——只知道"那一帧屏幕"。
 */
export function judgeAll(pairs: { claim: Claim; obs: Observation | null }[]): { judged: Judged[] } & Buckets {
  const judged = pairs.map(({ claim, obs }) => judgeClaim(claim, obs));
  return { judged, ...bucketize(judged) };
}

/** 单文本便捷入口（夹具、单测与独立审计共用）：一帧屏幕 = 决策前最后一帧。 */
export function reconcileText(text: string, obs: Observation | null): Judged[] {
  return judgeAll(extractClaims(text).map((claim) => ({ claim, obs }))).judged;
}
