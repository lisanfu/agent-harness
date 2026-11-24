/**
 * 全部契约集中在这里。harness 的"五脏"都靠这些类型互相咬合。
 *
 * 约束：Node 原生类型擦除只支持「可擦除语法」——
 *   禁止 enum / namespace / 构造函数参数属性。所以这里用 const 对象 + 联合类型。
 *   类型导入一律 `import type`，否则运行时残留 import 会报错。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  /** 仅 tool 消息：对应哪一次调用 */
  toolName?: string;
}

export type ParamType = 'string' | 'number' | 'boolean';

export interface ParamSpec {
  type: ParamType;
  description: string;
  required?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * 预测-对照的一条差异。**由代码算出**，不是模型自述。
 * status 三态刻意分开：「无法核对」不等于「预测被违反」，
 * 把前者算成后者会凭空制造异常，污染 M4 的独立异常源。
 */
export interface PredictionDiff {
  field: string;
  predicted: unknown;
  actual: unknown;
  status: 'ok' | 'violated' | 'unverifiable';
}

export interface PredictionRecord {
  /** 这一步大脑有没有给预测。没给也要记——"不预测"本身是可度量的行为 */
  given: boolean;
  /**
   * 画面有没有推进一帧（由屏幕上的帧号算出，不读内部状态）。
   *
   * 为什么必须记它：look 不推进世界，但 agent 对**当前画面**的绝对量断言
   * （我在哪、有几个敌人）照样可核对，而且真跑证明那正是它错得最厉害的地方。
   * 可这类核对天然比动作步容易相符，混在一起算准确率就是灌水。
   * 分开记，才能把"感知校准"和"动作预测"两条曲线分别看。
   */
  advanced: boolean;
  predicted: Record<string, unknown>;
  diffs: PredictionDiff[];
  violated: number;
  unverifiable: number;
}

/** 模型对上一次差异的判断。判断权归模型，代码只提供事实。 */
export interface SurpriseJudgment {
  /**
   * null = 模型给了判断，但形状不可用（写了"也许"、只给了理由、整个是个字符串）。
   * **绝不猜成 false**：猜 false 会凭空制造"代码判违反、模型说不意外"，
   * 而那正是 M4 要度量的关键行为，伪造它比丢失它危险得多。
   * 也绝不静默丢弃：丢了就分不清"模型没判断"和"判断了但写歪了"，
   * 而这两者的归因完全不同（M07 那一课：没检出是因为没走到，还是因为裁判不行）。
   */
  unexpected: boolean | null;
  why: string;
}

/**
 * 预测-对照的注入接缝。和 worldHash / loopFingerprint 同一个套路：
 * 契约层不知道"屏幕"长什么样，也不知道哪些工具会推进画面，
 * 这些全由世界层给。换个游戏只换实现，循环层一行不改。
 */
export interface PredictionSeam {
  /**
   * 预测字段的**接口说明**，原样进 system 契约。
   * 为什么由世界层给：「哪些量在画面上看得见」是世界的知识，
   * 契约层不该知道 hpDelta 是什么。文件模式没有画面，整段就不该出现。
   * 纪律同工具描述：只说字段是什么，绝不说"该去测什么"。
   */
  spec: string;
  /**
   * 这一步该不该核对。**世界层才知道哪些工具真的改变了画面**。
   * 为什么必须有它：note / finish / look 不推进世界，
   * 拿"前后同一帧"去核对预测，hpDelta=0 会白送一个"相符"，
   * 预测准确率当场被灌水。工具报错那一步同理——世界里根本没发生。
   */
  applies(call: ToolCall, result: ToolResult): boolean;
  /** 由**代码**拿前后两帧屏幕算差异。绝不接受模型自述的"我预测对了" */
  check(
    predicted: Record<string, unknown> | undefined,
    prevScreen: string,
    nextScreen: string,
  ): PredictionRecord;
  /** 把差异渲染成给模型看的事实文本。只陈述事实，不下结论 */
  describe(rec: PredictionRecord): string;
}

/**
 * 一局的预测-对照账本。全部由代码统计，进 result.json。
 *
 * 为什么要记 missing / unverifiable / violatedButNotSurprised 这些"不好看"的数：
 * M1 的教训是 agent 会替自己圆场（连续 4 次声称脚下有物品，客观账本说没有）。
 * 只统计"预测准确率"会把不预测、无法核对、看见了不当回事全部藏起来，
 * 那正是我们要度量的东西。
 */
export interface PredictionStats {
  /** 真正核对过的步数（产生了可核对的画面事实，且工具没报错） */
  checked: number;
  /** 其中画面没推进的步数（look）。这类核对偏容易，必须能与动作步分开算准确率 */
  staticChecks: number;
  /** 其中给了 predict 的步数 */
  given: number;
  /** 其中没给 predict 的步数——"不预测"本身是可度量的行为 */
  missing: number;
  /** 预测字段总数 */
  fields: number;
  ok: number;
  violated: number;
  unverifiable: number;
  /** 模型给出**可用**意外判断的次数（unexpected 是布尔） */
  surpriseGiven: number;
  /** 模型判断"出乎意料"的次数 */
  surpriseUnexpected: number;
  /**
   * 给了判断但形状不可用的次数。必须单独记：
   * 混进 surpriseGiven 会虚高，静默丢弃则让"模型从不判断意外"这个结论无法归因。
   */
  surpriseMalformed: number;
  /**
   * 上一步代码判了违反、模型这一步却说"不意外"。
   * 这是"看见了却没当回事"，比不预测更值得单独记一笔。
   */
  violatedButNotSurprised: number;
}

/**
 * 假设的状态。**由模型声明，代码绝不改它。**
 *
 * 为什么必须有状态（真跑两局换来的）：旧假设板是 append-only 的 string[]，
 * 对照组与 M08-B 都独立发明了"敌人每帧会新生成"这条假规则（世界里 ENEMY_COUNT=3，
 * 从不生成），其中一局还写成"规则已确认"存进板子。于是它每一步原样回喂，永久驻留。
 * 记忆器官只进不出 = 错误单调累积。
 *
 * 为什么代码不能自己判 retired：那就成了启发式兜底，抢走大脑的判断权。
 * 代码只做两件事——客观累加核对次数、把"已被反对但仍未淘汰"这个事实说出来。
 */
export type HypothesisStatus = 'proposed' | 'confirmed' | 'retired';

/**
 * 一条可检验的假设。主观字段与客观字段刻意放在同一个记录里但**分开命名**，
 * 落盘时再拆到两侧（defect.json 的 agentClaims vs hypothesisChecks），
 * 这样"模型说了什么"与"代码数出了什么"永远能对账。
 */
export interface Hypothesis {
  id: string;
  text: string;
  status: HypothesisStatus;
  createdAtStep: number;
  statusAtStep: number;
  statusWhy: string;
  /**
   * 以下四个计数**由代码客观累加**，模型无权写。
   * checks 是字段级核对次数，恒等式 supported + contradicted + unverifiable === checks
   * 必须成立——不成立就是账本漏项，审计脚本按这条核。
   */
  checks: number;
  supported: number;
  contradicted: number;
  unverifiable: number;
}

/**
 * 模型声明"这一步的预测在检验哪条假设"。
 *
 * 为什么需要它：M4-a 实测发现，预测覆盖率决定对照覆盖率——
 * 模型没预测 scoreDelta 的那一步，差异通道就漏掉了缺陷。
 * 同理，核对结果若不归因到具体假设，假设板就永远只是散文，
 * 客观证据与长期记忆之间没有连线，假规则也就无从被反对。
 *
 * id=null 表示"给了但形状不可用"。纪律同 SurpriseJudgment：**不猜、不丢**。
 * 猜一个 id 等于伪造归因；丢掉原文则分不清"没声明"和"声明写歪了"。
 */
export interface PredictionTest {
  id: string | null;
  /** 可选：只把这一个字段的核对归给该假设。不给则整份核对都归它（粒度局限见文档）。 */
  field?: string;
  /** 形状不可用时的原文留档 */
  raw?: unknown;
}

/**
 * 一局的假设板账本。全部由代码统计。
 *
 * 为什么要记 unattributed / unknownTarget / malformed / contradictedNotRetired
 * 这些"不好看"的数：只统计"提出了几条假设"会把不检验、检验写歪、
 * 被反对了却不淘汰全部藏起来，而那正是 M4-b 要度量的行为。
 */
export interface HypothesisStats {
  /** 局末各状态的条数。状态是模型声明的，这里只是客观计数 */
  proposed: number;
  confirmed: number;
  retired: number;
  /** 改写正文的次数：模型修正自己的假设，是学习行为的客观痕迹 */
  revised: number;
  /** 无 id 的纯文本笔记条数（M1 语义，一字不改） */
  plainNotes: number;
  /** 声明了 testing 且成功归因的核对步数 */
  attributed: number;
  /** 产生了核对却没声明 testing 的步数——"预测了却不说在检验哪条假设" */
  unattributed: number;
  /** testing 指向不存在的 id 的次数 */
  unknownTarget: number;
  /** testing 形状不可用的次数 */
  malformed: number;
  /** 声明了 testing 但那一步没有可核对事实的次数 */
  notChecked: number;
  /** 指定了 field 但那一步没预测该字段的次数 */
  fieldAbsent: number;
  /** 局末快照：代码已核对出相反事实、模型仍未标 retired 的条数 */
  contradictedNotRetired: number;
  /**
   * 局末快照：模型标成 confirmed、归因到它名下的客观核对却是 0 次的条数。
   * 与 contradictedNotRetired 互斥（被反对必然 checks>0），两个量不许混：
   * "零核对"不等于"被反对"，前者是主客观脱钩，后者是客观反证。
   */
  confirmedNoChecks: number;
}

/** note 工具带 id 调用时传给假设板的原始参数。status 仍是字符串，由板子校验。 */
export interface BoardWriteInput {
  id: string;
  text?: string;
  status?: string;
  why?: string;
}

/**
 * 一次写假设板的完整事实，成功与被拒都留档。
 * 被拒也要记：否则分不清"模型没写"和"写了被拒"，而这两者的归因完全不同（故障 #9）。
 */
export interface BoardWrite {
  step: number;
  id: string;
  ok: boolean;
  created: boolean;
  textChanged: boolean;
  statusChanged: boolean;
  /** 给大脑看的可读文本：成功是确认，失败是可行动理由 */
  message: string;
  before: Hypothesis | null;
  after: Hypothesis | null;
  input: BoardWriteInput;
}

/**
 * 假设板对**工具**暴露的那一面。刻意只给写与读，不给归因与计数：
 * 归因是循环层拿客观核对结果做的事，工具（也就是模型）无权碰计数。
 */
export interface HypothesisBoard {
  write(input: BoardWriteInput): BoardWrite;
  get(id: string): Hypothesis | undefined;
  ids(): string[];
}

/**
 * 目标的状态（M4-b2）。**由模型声明，代码绝不改它**——与假设同一条铁律。
 *
 * 为什么需要目标通道（真跑逼出来的，不是设想）：M4-b1 第二局模型把
 * "需要探索：1)移动规则 2)敌人行为 3)拾取效果 4)攻击机制" 塞进了假设板正文。
 * 它有意图，却没有表达意图的地方，只能把待办清单伪装成假设。
 * 而 M3 给了硬约束：探索必须能表达"我要制造 hp=0 的局面"这类**状态条件意图**，
 * 随机游走 320 步对 M07 的检出率只有 16.7%，加长度救不回来。
 *
 * open=还在追，achieved=模型认为达成了，abandoned=模型决定放弃（仍留档）。
 */
export type GoalStatus = 'open' | 'achieved' | 'abandoned';

/**
 * 一条目标 = 模型写的意图 + 代码数的客观判定。
 *
 * 所有权与假设板完全一致：
 *   - **模型**：id / text / doneWhen / status / statusWhy
 *   - **代码**：checks / met / unmet / unverifiable / firstMetStep / lastCheckedStep
 *
 * 与假设的关键差别：假设的成立与否**不可机器判定**（"敌人每帧移动一格"是个规律），
 * 而目标的完成条件是**画面上的等值状态**，代码可以客观判定。
 * 但"判定为满足"仍然不等于"模型该收口"——收口是决策，归大脑。
 */
export interface Goal {
  id: string;
  text: string;
  /**
   * 完成条件：字段 → 期望值，**只认等值**。null = 没给或形状不可用（原文在 doneWhenRaw）。
   * 刻意用 world-agnostic 的 Record：契约层不认识 hp 是什么，
   * 词表与判定由世界层注入（见 GoalSeam / world/goal.ts）。
   */
  doneWhen: Record<string, unknown> | null;
  /** 形状不可用时的原文留档。纪律同 surprise / testing：**不猜、不丢**。 */
  doneWhenRaw?: unknown;
  status: GoalStatus;
  createdAtStep: number;
  statusAtStep: number;
  statusWhy: string;
  /**
   * 客观**判定次数**（每步一次），不是字段数——目标是合取，天然以"次"为单位。
   * 字段级明细在 goal_check 事件里，审计可逐字段重算。
   * 恒等式：met + unmet + unverifiable === checks。
   */
  checks: number;
  /** 画面满足全部条件的次数 */
  met: number;
  /** 画面明确不满足的次数（至少一个字段 violated） */
  unmet: number;
  /** 无法判定的次数（没有 violated，但至少一个字段 unverifiable）。绝不算达成，也不算不达成 */
  unverifiable: number;
  /** 首次被画面满足的步号；从未满足则 null */
  firstMetStep: number | null;
  lastCheckedStep: number | null;
}

export interface GoalWriteInput {
  id: string;
  text?: string;
  /** unknown 而不是 Record：模型会写字符串、数组、null，全都要留档而不是崩掉 */
  doneWhen?: unknown;
  status?: string;
  why?: string;
}

/** 一次目标写入的完整留痕，**含被拒的那次**。理由同 BoardWrite（故障 #9）。 */
export interface GoalWrite {
  step: number;
  id: string;
  ok: boolean;
  created: boolean;
  textChanged: boolean;
  statusChanged: boolean;
  conditionChanged: boolean;
  /**
   * 这次写入给的 doneWhen 形状不可用（字符串/数组/数值…）。
   * 单独立一个标志而不是让循环层去猜：一个事实只有一个主人，
   * 审计脚本也才能从证据里重算 conditionMalformed 这项聚合。
   */
  conditionMalformed: boolean;
  message: string;
  before: Goal | null;
  after: Goal | null;
  input: GoalWriteInput;
}

/**
 * 目标板对**工具**暴露的那一面。刻意只给写与读，不给判定与计数：
 * 判定是循环层拿屏幕做的事，工具（也就是模型）无权碰计数。
 */
export interface GoalBoard {
  write(input: GoalWriteInput): GoalWrite;
  get(id: string): Goal | undefined;
  ids(): string[];
}

/**
 * 一局的目标准账本。全部由代码统计，进 result.json。
 * 与 HypothesisStats 同一条纪律：连"不好看"的量一起记，
 * 否则"目标通道有没有真被用起来"这个问题就无从回答（M4-b1 的 testing 两局 0 次就是教训）。
 */
export interface GoalStats {
  /** 局末各状态的条数（状态是模型声明的，条数是代码数的） */
  open: number;
  achieved: number;
  abandoned: number;
  /** 成功新建的次数 */
  declared: number;
  /** 改写正文的次数 */
  revised: number;
  /** 改写完成条件的次数 */
  conditionRevised: number;
  /** 被拒的写入次数 */
  rejected: number;
  /** doneWhen 形状不可用的次数（留了原文，没猜） */
  conditionMalformed: number;
  /** 局末快照：给了可用完成条件的条数 */
  withCondition: number;
  /** 客观判定累计（全部目标求和） */
  checks: number;
  met: number;
  unmet: number;
  unverifiable: number;
  /** 局末快照：画面已满足、模型却仍标 open */
  metNotClosed: number;
  /** 局末快照：模型标 achieved、画面却从未满足过（主客观脱钩，故障 #13 的目标版） */
  closedNeverMet: number;
  /** 局末快照：open 但没有可核对的完成条件（目标通道空转） */
  uncheckable: number;
}

/**
 * 目标完成条件的注入接缝。与 PredictionSeam 同一个套路：
 * 契约层不知道"屏幕"长什么样、哪些量看得见，全由世界层给。
 *
 * 为什么判定只返回 PredictionDiff[]：三态（ok/violated/unverifiable）是通用契约，
 * **合取逻辑归器官**（src/goal.ts），这样换个游戏器官一行不改。
 */
export interface GoalSeam {
  /** 完成条件字段的**接口说明**，原样进 system 契约。只说字段是什么，绝不说"该去追什么" */
  spec: string;
  /** 词表本身。器官不解释它的含义，只在出声文案里原样印给模型（ACI：拒绝理由必须可行动） */
  fields: readonly string[];
  /** 由**代码**拿当前屏幕判定条件。绝不接受模型自述的"我达成了" */
  evaluate(condition: Record<string, unknown>, screen: string): PredictionDiff[];
}

/** 大脑一次输出 = 想法 + 一个动作。想法必须留档，它是"有大脑"的证据。 */
export interface Decision {
  thought: string;
  call: ToolCall;
  /**
   * 对本次动作**可观测结果**的预测（M4）。可选：不给就不核对，但会记 given=false。
   * 刻意用 world-agnostic 的 Record：契约层不该依赖世界层，
   * 具体字段 schema 与核对逻辑由世界层注入（见 world/predict.ts）。
   */
  predict?: Record<string, unknown>;
  /** 对**上一次**预测-对照差异的判断。代码算 diff，模型判断是否意外。 */
  surprise?: SurpriseJudgment;
  /**
   * 本次预测在检验假设板上的哪一条（M4-b）。可选。
   * 与 predict / surprise 并列的顶层字段，世界层不认识它——
   * 假设板是通用记忆器官，换个游戏照样用，不该混进世界的预测 schema。
   */
  testing?: PredictionTest;
}

export interface ErrorInfo {
  code: string;
  message: string;
  detail?: unknown;
}

export interface ToolResult {
  ok: boolean;
  /** 给大脑看的文本。失败时必须是可读理由，不能是 "invalid"。 */
  output: string;
  error?: ErrorInfo;
}

export interface ToolContext {
  /** 工具只能在这个目录内活动 */
  sandbox: string;
  /** 注入式随机源，禁止工具内部直接用 Math.random */
  rng: () => number;
  /** 写假设板的**纯文本**通道（M1 语义，一字不改） */
  note: (text: string) => void;
  /** 读假设板的纯文本部分 */
  notes: () => readonly string[];
  /**
   * 结构化假设板（M4-b）。**可选**：不传时带 id 的 note 会被可读拒绝，
   * 绝不静默降级成纯文本——那会把"模型想立一条可检验假设"这个行为抹掉。
   * 循环层永远会传；留可选是为了让只关心纯笔记的旧调用方不必认识这个器官。
   */
  board?: HypothesisBoard;
  /**
   * 目标板（M4-b2）。**可选**：文件模式没有屏幕，完成条件无从判定，
   * 此时整个目标通道不启用（goal 工具也不注册），绝不给一个永远判不出结果的装饰接口。
   */
  goals?: GoalBoard;
}

export interface Tool extends ToolSpec {
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export interface DecideRequest {
  task: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  step: number;
  /** 假设板的纯文本部分：跨步骤的长期记忆 */
  notes: readonly string[];
  /**
   * 结构化假设（M4-b）。可选，缺省即 M1 行为。
   * 刻意传**数据**而不是渲染好的文本：stdio 宿主要自己决定怎么展示，
   * 远端大脑则用与循环层同一个纯函数 notesBlock(notes, hypotheses) 渲染。
   * 两边共用一个渲染器，落盘原文与线上内容才可能逐字相同（故障 #11）。
   */
  hypotheses?: readonly Hypothesis[];
  /**
   * 目标板（M4-b2）。可选，缺省即没有目标通道。
   * 与 hypotheses 同一条纪律：传**数据**而不是渲染好的文本，
   * 远端大脑与循环层共用同一个纯函数 goalsBlock(goals, fields) 渲染，
   * 落盘原文与线上内容才可能逐字相同（故障 #11）。
   */
  goals?: readonly Goal[];
}

/** 传输层一次重试的完整事实。必须进无损证据，否则"这一步其实撞了 4 次墙"就被抹掉了。 */
export interface BrainRetryInfo {
  /** 第几次重试（从 1 开始） */
  attempt: number;
  maxRetries: number;
  waitMs: number;
  error: ErrorInfo;
}

/** 大脑接口。harness 不认识模型，只认识这个接口。 */
export interface Brain {
  readonly id: string;
  decide(req: DecideRequest): Promise<Decision>;
  /**
   * 重试出声口。可选：只有会重试的传输层（远端 HTTP）才需要。
   *
   * ⚠️ 刻意放在 brain 实例上，**不放进 DecideRequest**：
   * StdioBrain 是把整个 req 直接 JSON.stringify 发到 stdout 的，
   * 函数字段会被 JSON 静默丢掉——远端能重试、宿主模式悄悄不能，且不报任何错。
   * 契约里塞函数，遇到序列化传输就是这个下场。
   *
   * 这是「每个实例一个主人」的字段，不是模块级可变单例：
   * runHarness 独占它拿到的这个 brain，差分公证器根本不用 brain，所以不存在串台。
   */
  onRetry?: (info: BrainRetryInfo) => void;
}

export type StopReason =
  | 'finished'        // 大脑主动调 finish
  | 'max_steps'       // 步数预算耗尽
  | 'wall_clock'      // 时间预算耗尽
  | 'loop_detected'   // 重复同一动作，判定死循环
  | 'brain_failed'    // 大脑连续失败，无法继续
  | 'interrupted';    // 动作预写后进程中断；无法证明是否执行完，拒绝续跑

export interface StepRecord {
  index: number;
  at: string;
  decision: Decision;
  result: ToolResult;
  /** 本步结束时的状态哈希，用于逐位重放比对 */
  stateHash: string;
  contextChars: number;
  brainMs: number;
  toolMs: number;
  /**
   * 预测-对照结果（M4，世界模式且这一步真的推进了画面才有）。
   * 差异由代码算，不是模型自述——这是它与 decision.predict 的本质区别：
   * decision.predict 是主观意图，这里是客观核对。两者都留档，才能对账。
   */
  prediction?: PredictionRecord;
}

/**
 * 判决口径的版本戳（M4-f）。刻意是三个平铺字符串、不带任何类型依赖：
 * 契约层不该认识世界层的词表对象，否则换一款游戏/换一张表就要改契约（同 initialState.world 的纪律）。
 */
export interface JudgementStamp {
  /** 判决器实现版本（detect.ts 的 DETECTOR_VERSION） */
  detector: string;
  /** 词表版本（lexicon.ts 的 LEXICON_VERSION） */
  lexicon: string;
  /** 词表正文指纹：改任何一个词都变，用于分箱与漂移出声 */
  sha: string;
}

export interface RunHeader {
  runId: string;
  at: string;
  seed: number;
  brainId: string;
  task: string;
  sandbox: string;
  config: Record<string, unknown>;
  /**
   * 这一局到底启用了哪几条「代码客观核对」通道（M4-b2 落地；之前的证据里没有这个键）。
   *
   * 为什么要单独记：审计原先只能从"有没有 goal_* 事件"倒推通道开没开，
   * 于是"旧版证据"与"新版但关掉通道（消融对照）"两种情形在证据上长得一模一样。
   * 而**任何一种能靠删证据蒙混过去的分类，都是一条免检通道**。
   * 有了这句声明：消融局是"如实声明关掉了"，删掉事件冒充旧版会当场与声明对不上。
   *
   * ⚠️ 残余局限（写清楚，不许假装已解决）：把 seams 整块删掉仍能冒充更早的版本。
   * 证据层防得住"部分删改"，防不住"全删"——后者只能靠运行记录与 outDir 命名区分。
   */
  /** 本局启用的感知/核对接缝。`ear` 是 M4-c 才加的键，所以**缺键 = 跑在装耳朵之前**，
   *  不等于"关掉了耳朵"——消融关耳会明确写 `ear: false`。审计必须把这两档分开。 */
  seams?: { predict: boolean; goal: boolean; ear?: boolean };
  /**
   * 判决口径的版本戳（M4-f）。**开局就写，不是局末补**。
   *
   * 为什么必须在 header：detection.json 里的 judgementVersion 是局末才落盘的，
   * 它只能证明"判决器自称用了哪个版本"。header 里的这一枚在 agent 动手之前就存在，
   * 于是"判据先于输出冻结"这件事第一次变成**证据**而不是**承诺**——
   * 想伪造它就得改 header 的生成路径，而那条路径由循环层唯一拥有。
   *
   * ⚠️ 它只是戳，不是判据：本层不认识词表，也不导入世界层任何符号。
   *    词表漂移由 lexiconSha() 与 FROZEN_SHA256 在校验侧比对。
   */
  judgement?: JudgementStamp;
  /**
   * 证据来源（与 HarnessConfig.provenance 同名同义，由循环层原样抄写）。
   *
   * 分工纪律：循环层只负责**抄**，不解释什么叫夹具——它不认识世界层的任何剧本。
   * 校验侧据此把裁判侧夹具挡在"误报率"分母之外，并用 brainId / task 两条
   * 独立信号交叉核对这句声明（删掉声明就冒充真证据，是免检通道）。
   */
  provenance?: 'real' | 'fixture';
  /** 初始状态：重放三要素之一 */
  initialState: {
    notes: string[];
    /** 结构化假设板的初始状态（M4-b）。空板也要写，重放才知道起点 */
    hypotheses: Hypothesis[];
    /**
     * 目标板的初始状态（M4-b2）。**只有接缝存在时才写这个键**——
     * 它的有无本身就是"这一局有没有目标通道"的证据之一。
     */
    goals?: Goal[];
    sandboxEntries: string[];
    /**
     * 世界模式（M1）才有。刻意用扁平字段而不是引入 Capabilities 类型：
     * 契约层不该依赖世界层，否则换个游戏就要改契约。
     * mutant id 已足够决定 caps（见 world/mutants.ts），重放时按 id 还原即可。
     */
    world?: {
      kind: string;
      seed: number;
      /** 初始世界哈希：重放比对的起点 */
      hash: string;
      /** 初始屏幕：agent 当时看到的第一眼，留档以便人工复核它有没有被喂答案 */
      screen: string;
      /** 变异体 id；参考版为 null。对 agent 隐藏，只进证据 */
      mutant: string | null;
    };
  };
}

export interface RunResult {
  runId: string;
  runDir: string;
  stopReason: StopReason;
  steps: StepRecord[];
  /** 纯文本笔记（M1 语义）。结构化假设不混进来，否则跨轮对照的口径就变了 */
  notes: string[];
  /** 结构化假设板的局末快照（M4-b）：主观声明与客观计数都在，落盘时再拆两侧 */
  hypotheses: Hypothesis[];
  /** 目标板的局末快照（M4-b2）。没启用目标通道时是空数组，落盘时同样拆主客观两侧 */
  goals: Goal[];
  finishSummary?: string;
  /** 重放三要素：seed + initialState(在 header) + actionSequence */
  actionSequence: ToolCall[];
  durationMs: number;
  /**
   * 本局传输层一共重试了多少次（限流/超时/连接抖动）。
   * 为什么要进 result.json：耗时和步数一样，都是"这一局有多难跑"的客观事实。
   * 少了它，一局跑了 5 分钟会被误读成模型慢，而真相是撞了十几次限流墙。
   */
  brainRetries?: number;
  /** 本局宿主/大脑输出解析失败次数。原文与错误逐条留在 trace 的 parse_failure 事件。 */
  parseFailures?: number;
  /** 预测-对照账本（M4）。没启用接缝时不写这个字段，保持文件模式产物一字不变 */
  predictionStats?: PredictionStats;
  /**
   * 假设板账本（M4-b）。**总是写**：记忆器官没有开关，
   * 关掉预测接缝只是没有客观核对可归因，计数为 0 而不是消失。
   */
  hypothesisStats: HypothesisStats;
  /**
   * 目标准账本（M4-b2）。没启用接缝时不写这个字段——
   * 与 predictionStats 同一条纪律：文件模式没有屏幕，目标通道整个不存在，
   * 写一份全 0 的账本会让人误以为"启用了但模型没用"，那是两种完全不同的结论。
   */
  goalStats?: GoalStats;
}

export interface HarnessConfig {
  task: string;
  sandbox: string;
  seed: number;
  maxSteps: number;
  maxWallMs: number;
  /** 上下文字符预算（估算，非精确 token） */
  maxContextChars: number;
  /** 保留最近多少条消息不截断 */
  keepRecent: number;
  /** 大脑输出解析失败时，最多回炉重试几次 */
  maxParseRetry: number;
  /** 连续多少次完全相同的动作判定为死循环 */
  repeatLimit: number;
  outDir: string;
  /**
   * 这批证据是**谁产生的**：真实大脑跑出来的，还是人写剧本的裁判侧夹具。
   * 缺省视为 'real'（M4-f 之前的证据里没有这个键）。
   *
   * 为什么这个字段必须存在：`verify/detect-fixture.ts` 会造两局 `mutant=null` 的参考版局，
   * 其中一局**故意埋了"仪器过火"**用来证明审计有牙。审计原先按 `mutant===null` 收分母，
   * 于是把那个阳性样本算进"误报率"，当众打出 `1/2 = 50.0%`——一个夹具的自检项
   * 长在了仪器精度指标的名字上。分母必须只收真证据，所以来源要落进证据本身。
   *
   * ⚠️ 它只是**声明**，不是判据：单靠删掉这个键仍能冒充真证据。
   *    校验侧另有两条独立信号交叉核对（`brainId` 里的 FIXTURE 标记、task 文本前缀），
   *    冒充必须同时改三处，见 `verify/detect-audit.ts` 的 provenanceOf。
   */
  provenance?: 'real' | 'fixture';
}