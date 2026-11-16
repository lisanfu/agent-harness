/**
 * 提示词装配。
 *
 * 刻意遵守一条界线：给「接口说明」，不给「策略手册」。
 * 工具描述相当于键盘上印的字母——那是接口，人也需要知道键盘长什么样。
 * 但绝不写"优先探索未访问区域""注意边界值"这类测试策略，那等于开卷考试。
 * 发现缺陷的能力必须来自大脑自己。
 */
import { attention } from '../board.ts';
import { goalAttention, goalCheckable } from '../goal.ts';
import type { Goal, Hypothesis, ToolSpec } from '../types.ts';

/** 装配 system 只需要任务 + 工具清单（外加可选的预测接口）。刻意不要求整个 DecideRequest——循环层不该为了拼提示词去伪造消息历史。 */
export interface SystemPromptInput {
  task: string;
  tools: readonly ToolSpec[];
  /**
   * 预测接口说明（M4，世界层注入，见 PredictionSeam.spec）。
   * 不传则整段不出现：文件模式没有画面，硬塞一套预测字段等于给它一份不存在世界的说明书。
   */
  predictSpec?: string;
  /**
   * 完成条件词表（M4-b2，世界层注入，见 GoalSeam.spec）。
   * 不传则整段不出现——与 predictSpec 同一条纪律：**没有可判定的画面就没有目标接口**，
   * 注册一个永远判不出结果的工具等于给模型一件摆设。
   */
  goalSpec?: string;
}

export function renderTools(tools: readonly ToolSpec[]): string {
  return tools
    .map((t) => {
      const ps = Object.entries(t.params)
        .map(([k, v]) => `${k}${v.required ? '' : '?'}: ${v.type} — ${v.description}`)
        .join('; ');
      return `- ${t.name}: ${t.description}${ps ? `\n    参数: ${ps}` : '\n    参数: 无'}`;
    })
    .join('\n');
}

export function buildSystem(req: SystemPromptInput): string {
  return [
    '你是一个自主 agent。你通过调用工具来观察世界并改变它。',
    '',
    `任务：${req.task}`,
    '',
    '可用工具：',
    renderTools(req.tools),
    '',
    '输出契约（严格遵守）：',
    '每一步只输出一个 JSON 对象，不要加解释文字，不要加代码围栏：',
    '{"thought":"你为什么这么做","call":{"name":"工具名","args":{}}}',
    ...(req.predictSpec ? [
      '',
      '预测与对照（可选字段，格式如下）：',
      req.predictSpec,
      '在同一个 JSON 对象里加 predict 字段，写下你对本次动作**画面结果**的预期。',
      '动作执行后，代码会拿画面逐项核对你的预测，并把差异作为下一条消息给你。',
      '差异由代码算出，不是你的自述。预测不符不算失败，它是观察结果的一部分。',
      '看到差异后，请在下一步的 JSON 里加 surprise 字段，判断它是否出乎你的意料：',
      '"surprise":{"unexpected":true,"why":"你的理由"}',
      '如果这次预测是为了检验假设板上的某条假设，加 testing 字段指出是哪一条：',
      '"testing":"H1"  或  "testing":{"id":"H1","field":"enemyCount"}',
      '给了 field 就只把那个字段的核对记到它名下；不给则整份核对都记给它。',
      '代码会把核对结果客观累加到那条假设上（支持 / 反对 / 无法核对），你无权改这些计数。',
    ] : []),
    ...(req.goalSpec ? [
      '',
      '目标与完成条件（goal 工具，M4-b2）：',
      req.goalSpec,
      '你用 goal 声明"要把局面制造成哪个状态"，doneWhen 就是那个状态的画面等值条件。',
      '代码每一步拿画面客观判定它满足没有，计数由代码累加，你无权改；判定为满足**不等于**你该收手。',
      '要不要据此标 achieved、要不要 finish，由你判断。代码绝不替你宣布达成，也绝不替你放弃。',
    ] : []),
    '',
    '规则：',
    '- 一次只调一个工具。工具结果会作为下一条消息给你。',
    '- 工具失败时会告诉你原因，请据此调整，不要原样重试。',
    '- 重要的假设或已确认的事实，用 note 写进假设板，它不会随上下文截断而丢失。',
    '- note 带 id 就立了一条可检验的假设；带 id 与 status 可以改它的状态，status 只能是 proposed / confirmed / retired。',
    '- 假设可以由你淘汰（status:"retired"，并给 why）。淘汰后它只留档、不再作为依据。代码只统计客观核对次数，绝不替你判定假设真假。',
    ...(req.goalSpec ? [
      '- 目标用 goal 声明：id 由你起，status 只能是 open / achieved / abandoned，由你自己改；代码只把画面判定累加成计数，绝不改它的状态。',
    ] : []),
    '- 任务完成、证据足够、或确认无法推进时，调 finish 收手并给出结论。',
  ].join('\n');
}

/** 假设板的分区标题。导出是为了让测试与审计脚本按同一把尺子切分，不靠猜字符串。 */
export const BOARD_HEADER = '假设板（常驻不截断）：';
export const BOARD_ACTIVE_HEADER = '可检验假设（id 由你起，status 由你声明；计数由代码客观累加）：';
export const BOARD_RETIRED_HEADER = '已淘汰（留档，不再作为依据；不要重复提出同一 id）：';

/**
 * 渲染一条假设。计数与提示都由代码算出的事实驱动（判据唯一主人：board.ts 的 attention），
 * 但**措辞里必须显式把判断权交回模型**——否则就成了启发式兜底。
 */
function renderHypothesis(h: Hypothesis): string {
  const why = h.statusWhy ? `（你的理由：${h.statusWhy}）` : '';
  const lines = [
    `- ${h.id} [${h.status}] ${h.text}${why}`,
    `    客观核对 ${h.checks} 次：支持 ${h.supported} / 反对 ${h.contradicted} / 无法核对 ${h.unverifiable}`,
  ];
  // 出声的触发条件是**事实**，不是某个魔法阈值。代码到此为止：只陈述，不改 status。
  const a = attention(h);
  if (a === 'contradicted') {
    lines.push(`    代码提示：已有 ${h.contradicted} 次核对与这条假设相反，而你把它标为 ${h.status}。要不要淘汰由你判断，代码不会替你改。`);
  } else if (a === 'no_checks') {
    // 故障 #13：自称已验证、客观账本却零核对。不点出缺的接口，模型无从行动。
    lines.push(`    代码提示：你把它标为 confirmed，但归因到它名下的客观核对是 0 次。只有声明了 testing 的那次预测对照才会记到假设名下。要不要补检验由你判断，代码不会替你改。`);
  }
  return lines.join('\n');
}

/**
 * 假设板文本。**没有结构化假设时，输出与 M1 逐字相同**——
 * 跨轮对照（M1 那四局 / M4-a 那三局）的口径不能被记忆器官的升级悄悄改掉。
 *
 * 循环层与远端大脑共用这一个纯函数：循环层渲染一份落盘，大脑渲染一份上线，
 * 同输入同输出，所以"落盘原文 == 线上内容"可以被测试钉死（故障 #11）。
 */
export function notesBlock(notes: readonly string[], hypotheses?: readonly Hypothesis[]): string | null {
  const hs = hypotheses ?? [];
  if (!notes.length && !hs.length) return null;
  if (!hs.length) {
    return `假设板（你此前记下的，常驻不截断）：\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;
  }
  // 顶栏常驻：哪怕全部假设都已淘汰、活跃区为空，也要有一个稳定的抬头。
  // 否则"板上只剩淘汰区"时整块文本没有可识别的起点，宿主与审计都无从定位。
  const parts: string[] = [BOARD_HEADER];
  if (notes.length) {
    parts.push(`笔记：\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`);
  }
  const active = hs.filter((h) => h.status !== 'retired');
  const retired = hs.filter((h) => h.status === 'retired');
  if (active.length) parts.push([BOARD_ACTIVE_HEADER, ...active.map(renderHypothesis)].join('\n'));
  // 淘汰不是删除：id 与正文留在板上，模型才不会把同一条假规则再立一遍。
  if (retired.length) parts.push([BOARD_RETIRED_HEADER, ...retired.map(renderHypothesis)].join('\n'));
  return parts.join('\n\n');
}

/**
 * 目标板分区标题。导出给测试与审计脚本当尺子，同 BOARD_* 一个套路。
 * 为什么"没有目标就整块不出现"：文件模式没有画面、目标通道整个不存在，
 * 硬塞一块空板子会把 M1 那几局的产物字节改掉，跨轮对照的口径就变了。
 */
export const GOAL_BOARD_HEADER = '目标板（常驻不截断；达成与否由代码拿画面客观判定）：';
export const GOAL_ACTIVE_HEADER = '在追的目标（doneWhen 与 status 由你声明，判定计数由代码累加）：';
export const GOAL_CLOSED_HEADER = '已收口或已放弃（留档；abandoned 不等于删除，别重复立同一条 id）：';

/**
 * 渲染一条目标。事实行只有代码算得出的那些（判定次数、三态计数、首次在第几步），
 * 提示行的判据是 goalAttention()——与循环层共用同一个主人，判据不许有两条装配路径。
 *
 * 措辞同 §3.5 那条界线：陈述事实、点出缺的接口、把判断权交回模型。
 * 刻意不写"你应该标 achieved"、也不写"你该收手了"——那是替大脑做决策。
 */
function renderGoal(g: Goal): string {
  const cond = goalCheckable(g)
    ? `    完成条件 ${JSON.stringify(g.doneWhen)}`
    : `    完成条件：还没有可核对的条件${g.doneWhenRaw !== undefined ? `（你写的是 ${JSON.stringify(g.doneWhenRaw)}，代码没法核对）` : '（没给 doneWhen）'}`;
  const lines = [
    // 理由必须一起印在板上：那是模型自我修正的唯一留痕，只在写入回执里出现过一次就再也看不到了
    `- ${g.id} [${g.status}] ${g.text}${g.statusWhy ? `（你的理由：${g.statusWhy}）` : ''}`,
    cond,
    `    客观判定 ${g.checks} 次：满足 ${g.met} / 不满足 ${g.unmet} / 无法核对 ${g.unverifiable}`,
  ];
  // 「首次在第几步」是目标板独有的常驻事实：回填只在首次那一步播一句，
  // 之后每步靠这一行让模型知道"它确实达成过"，不靠重复播报（预算纪律）。
  if (g.firstMetStep !== null) lines.push(`    首次满足：第 ${g.firstMetStep} 步`);
  const a = goalAttention(g);
  if (a === 'met_not_closed') {
    lines.push(`    代码提示：画面已经满足过它的完成条件（首次在第 ${g.firstMetStep} 步），而它仍是 ${g.status}。要不要标 achieved、要不要据此收手，由你判断，代码不会替你改。`);
  } else if (a === 'closed_never_met') {
    // 故障 #13 的目标版：自称达成与画面达成是两件事，脱钩必须点出来，
    // 但"点出来"不等于"改回去"——status 的主人始终是模型。
    lines.push(`    代码提示：你把它标为 ${g.status}，而代码判定 ${g.checks} 次里从未满足过。要不要补一个可核对的完成条件、要不要改回状态，由你判断。`);
  } else if (a === 'uncheckable') {
    // 点出缺的是哪个接口（ACI：拒绝理由与提示都要可行动），但不替它写条件。
    // ⚠️ 措辞必须与**这条目标自己的形状**一致。夹具逼出来的反例：一条 {hp:10, enemyCount:3, foo:1}
    // 的合取，两个字段能判、第三个不能，于是每轮都是"无法判定"。说它"没有可核对的条件"
    // 或"字段全不在词表内"都是假话——而出声文案一旦说假话，模型据它做的任何修正都建在谎上。
    // 所以只报代码算得出的那两件事实：条件在不在，以及历轮判定的结果分布。
    const why = goalCheckable(g)
      ? `有完成条件，但判定 ${g.checks} 轮的结果全是「无法核对」——字段不在词表内、或画面上没印出那个量，都会这样`
      : '还没有可核对的完成条件（没给 doneWhen，或给的形状代码读不懂）';
    lines.push(`    代码提示：这条目标到现在判不出结果——${why}。goal 工具的 doneWhen 可用字段见上面的接口说明。补不补、怎么补由你判断，代码不会替你删目标。`);
  }
  return lines.join('\n');
}

/**
 * 目标板文本。循环层渲染一份落盘、远端大脑渲染一份上线，共用这一个纯函数，
 * 所以"落盘原文 == 线上内容"可以被测试逐字钉死（故障 #11，同 notesBlock）。
 * 一条目标都没有时返回 null：既不落盘也不上线，产物与 M1 逐字节相同。
 */
export function goalsBlock(goals: readonly Goal[]): string | null {
  if (!goals.length) return null;
  const active = goals.filter((g) => g.status === 'open');
  const closed = goals.filter((g) => g.status !== 'open');
  const parts: string[] = [GOAL_BOARD_HEADER];
  if (active.length) parts.push([GOAL_ACTIVE_HEADER, ...active.map(renderGoal)].join('\n'));
  if (closed.length) parts.push([GOAL_CLOSED_HEADER, ...closed.map(renderGoal)].join('\n'));
  return parts.join('\n\n');
}