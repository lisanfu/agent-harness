/**
 * 目标板（M4-b2）：意图器官。
 *
 * 它治的病是真跑逼出来的：M4-b1 第二局模型把
 * "需要探索：1)移动规则 2)敌人行为 3)拾取效果 4)攻击机制" 塞进了**假设板正文**。
 * 它有目标，却没有目标通道，只能把待办清单伪装成假设——而假设是要被证伪的规律，
 * 待办清单是要被达成的状态，两者混在一起，记忆器官就没法对账。
 *
 * M3 早就给了硬约束：探索必须能表达"我要制造 hp=0 的局面"这类**状态条件意图**。
 * 随机游走 320 步对 M07（血量归零）的检出率只有 16.7%，加长度救不回来——
 * 那是探索策略问题，不是预算问题。目标通道就是让"策略"变成可声明、可客观核对的东西。
 *
 * 分工铁律（与假设板、与 M4-a 的预测-对照同一条）：
 *   - 目标的**正文、完成条件、状态**归模型。代码绝不改 status，绝不替它宣布达成。
 *   - 目标的**判定计数**归代码。模型无权写，只能声明"我要达成什么状态"。
 *   - 代码发现"画面已满足却仍标 open""自称达成却从未满足""条件根本判不出"时**只出声**。
 *
 * 与假设板的关键差别：假设的成立与否不可机器判定（那是一条规律），
 * 而完成条件是画面上的**等值状态**，代码可以客观判定。
 * 但"判定为满足"仍然不等于"模型该收口"——收口是决策，归大脑。
 *
 * 契约层纪律：本文件不认识"屏幕""血量""分数"。它只认识 PredictionDiff 的三态，
 * 判定由世界层通过 GoalSeam 注入。换个游戏，这个器官一行不改。
 */
import { canonical } from './rng.ts';
import type {
  Goal, GoalBoard, GoalStatus, GoalWrite, GoalWriteInput, PredictionDiff,
} from './types.ts';

const STATUSES: readonly GoalStatus[] = ['open', 'achieved', 'abandoned'];

const isStatus = (s: string): s is GoalStatus => (STATUSES as readonly string[]).includes(s);

/** JSON 安全的深拷贝。doneWhen 里可能有数组（playerAt:[7,7]），浅拷贝会让外部改到板上的条件。 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function copy(g: Goal): Goal {
  return {
    ...g,
    doneWhen: g.doneWhen === null ? null : clone(g.doneWhen),
    ...(g.doneWhenRaw !== undefined ? { doneWhenRaw: clone(g.doneWhenRaw) } : {}),
  };
}

/** 一次客观判定的结果。met=null 表示**无法判定**，绝不是"没达成"。 */
export interface GoalCheck {
  /** 判定后的目标快照（副本，不是活引用） */
  goal: Goal;
  diffs: PredictionDiff[];
  /** true=画面满足全部条件；false=明确不满足；null=无法判定 */
  met: boolean | null;
  /** 这一步是它**首次**被画面满足。只有首次才值得往观察里回填，重复播报是噪音 */
  firstMet: boolean;
}

export interface GoalsOptions {
  /** 当前步号，由循环层注入。步号的主人始终是循环层（同 BoardOptions） */
  step: () => number;
  /**
   * 完成条件的字段词表，由世界层注入。
   * 器官**不解释**这些字段的含义，只在出声文案里原样印给模型——
   * 拒绝理由必须可行动（ACI 那一课），"条件判不出"却不告诉它有哪些字段可用，等于没说。
   */
  fields: readonly string[];
  /** 每次写入（含被拒）的出声口。循环层用它落盘 + 计数，板子自己不写文件。 */
  onWrite?: (w: GoalWrite) => void;
  /** 恢复用快照；不触发 onWrite，历史写入不该在重启时重复计数。 */
  initialGoals?: readonly Goal[];
}

/** 完成条件的归一化结果。malformed=true 时原文必须留在 raw 里（不猜、不丢）。 */
interface Condition {
  cond: Record<string, unknown> | null;
  raw?: unknown;
  malformed: boolean;
}

function normalizeCondition(v: unknown): Condition {
  if (v === undefined || v === null) return { cond: null, malformed: false };
  if (typeof v === 'object' && !Array.isArray(v)) {
    // 空对象也原样留着：它是"给了条件但一个字段都没写"，与"根本没给"是两种行为，
    // 抹平了就分不清模型是没想起来还是写歪了（故障 #9 的同一课）。
    return { cond: clone(v as Record<string, unknown>), malformed: false };
  }
  return { cond: null, raw: clone(v), malformed: true };
}

/** 条件里有没有可判定的字段。空条件不判定：绝不凭空记一次达成。 */
const hasFields = (g: Goal): boolean => g.doneWhen !== null && Object.keys(g.doneWhen).length > 0;

/**
 * 同一条判据的**对外名字**。渲染器与循环层都用它，不许各写一遍
 * （故障 #1：同一份契约不许有两条装配路径）。
 */
export const goalCheckable = hasFields;

export class Goals implements GoalBoard {
  private readonly map = new Map<string, Goal>();
  private readonly opt: GoalsOptions;

  constructor(opt: GoalsOptions) {
    this.opt = opt;
    for (const g of opt.initialGoals ?? []) {
      if (this.map.has(g.id)) throw new Error(`目标板恢复快照有重复 id：${g.id}`);
      this.map.set(g.id, copy(g));
    }
  }

  /** 交出去的一律是副本：板子外的代码不该能改到板上那条目标。 */
  get(id: string): Goal | undefined {
    const g = this.map.get(id);
    return g ? copy(g) : undefined;
  }
  ids(): string[] { return [...this.map.keys()]; }
  /** 按创建顺序返回**副本**。请求与证据都必须是快照，否则后续写入会篡改历史。 */
  all(): Goal[] { return [...this.map.values()].map(copy); }

  /**
   * 立一条 / 改一条目标。所有校验都在这里，工具层只负责把 args 变成字符串——
   * 一个类别一个主人，拒绝理由才不会两处各说一套。
   *
   * 三条不静默纪律（与假设板一致）：
   *  - 未知 id 只给 status → 拒绝，绝不悄悄新建（那会伪造"模型立过这条目标"）
   *  - 已存在 id 什么都不给 → 拒绝，绝不把空操作记成一次意图声明
   *  - 非法 status → 拒绝并列出合法值
   *
   * 一条**刻意不拒绝**的：doneWhen 形状歪了照样收下，留原文 + 记 conditionMalformed。
   * 整条拒绝会抹掉"模型确实想立一个目标"这个行为，而那正是本轮要度量的东西。
   */
  write(input: GoalWriteInput): GoalWrite {
    const step = this.opt.step();
    const id = String(input.id ?? '').trim();
    const before = this.map.has(id) ? copy(this.map.get(id)!) : null;
    const reject = (message: string): GoalWrite => {
      const w: GoalWrite = {
        step, id, ok: false, created: false, textChanged: false, statusChanged: false,
        conditionChanged: false, conditionMalformed: false,
        message, before, after: null, input,
      };
      this.opt.onWrite?.(w);
      return w;
    };

    if (!id) return reject('id 不能为空。要立一条目标，请给 id 与 text。');

    const rawStatus = input.status === undefined ? undefined : String(input.status).trim();
    if (rawStatus !== undefined && !isStatus(rawStatus)) {
      return reject(`status "${rawStatus}" 不认识。只能用 ${STATUSES.join(' / ')}：open=还在追，achieved=你认为达成了，abandoned=你决定放弃（仍留档）。`);
    }
    const rawText = input.text === undefined ? undefined : String(input.text).trim();
    if (rawText !== undefined && !rawText) return reject(`目标 ${id} 的正文不能是空白。`);
    const why = input.why === undefined ? undefined : String(input.why).trim();
    const conditionGiven = input.doneWhen !== undefined;
    const cond = normalizeCondition(input.doneWhen);

    const existing = this.map.get(id);
    if (!existing) {
      if (rawText === undefined) {
        return reject(`目标 ${id} 不存在。新建必须给 text；要改状态请先立一条。现有 id：${this.ids().join(', ') || '（还没有）'}。`);
      }
      const status: GoalStatus = rawStatus ?? 'open';
      const g: Goal = {
        id, text: rawText,
        doneWhen: cond.cond,
        ...(cond.malformed ? { doneWhenRaw: cond.raw } : {}),
        status,
        createdAtStep: step, statusAtStep: step, statusWhy: why ?? '',
        checks: 0, met: 0, unmet: 0, unverifiable: 0,
        firstMetStep: null, lastCheckedStep: null,
      };
      this.map.set(id, g);
      const w: GoalWrite = {
        step, id, ok: true, created: true, textChanged: true, statusChanged: true,
        conditionChanged: cond.cond !== null, conditionMalformed: cond.malformed,
        message: `已立目标 ${id} [${status}]。` + (hasFields(g)
          ? `完成条件 ${JSON.stringify(g.doneWhen)} 由代码每步拿画面客观判定，你无权改判定计数；达成了要不要标 achieved 由你判断。`
          : '这条目标还没有可核对的完成条件（doneWhen），代码无法客观判断它是否达成。')
          + this.hintUnknown(g.doneWhen),
        before: null, after: copy(g), input,
      };
      this.opt.onWrite?.(w);
      return w;
    }

    if (rawText === undefined && rawStatus === undefined && !conditionGiven) {
      return reject(`目标 ${id} 已存在。要改它请给 text（改写正文）、doneWhen（改完成条件）或 status（改状态：${STATUSES.join(' / ')}）。`);
    }
    const textChanged = rawText !== undefined && rawText !== existing.text;
    const statusChanged = rawStatus !== undefined && rawStatus !== existing.status;
    // 条件是否变了用 canonical 比：字段顺序不同不该被当成一次改写（那是格式差异，不是意图差异）
    const conditionChanged = conditionGiven
      && canonical({ c: cond.cond, r: cond.malformed ? cond.raw : null })
        !== canonical({ c: existing.doneWhen, r: existing.doneWhenRaw ?? null });
    if (textChanged) existing.text = rawText!;
    if (statusChanged) { existing.status = rawStatus as GoalStatus; existing.statusAtStep = step; }
    if (why !== undefined && why) existing.statusWhy = why;
    if (conditionGiven) {
      existing.doneWhen = cond.cond;
      if (cond.malformed) existing.doneWhenRaw = cond.raw;
      else delete existing.doneWhenRaw;
    }

    const w: GoalWrite = {
      step, id, ok: true, created: false, textChanged, statusChanged,
      conditionChanged, conditionMalformed: cond.malformed,
      message: `已更新 ${id} [${existing.status}]${textChanged ? '（正文已改写）' : ''}${conditionChanged ? '（完成条件已改写）' : ''}。` +
        `代码客观判定 ${existing.checks} 次：满足 ${existing.met} / 不满足 ${existing.unmet} / 无法判定 ${existing.unverifiable}。` +
        (existing.firstMetStep !== null ? `首次满足在第 ${existing.firstMetStep} 步。` : '') +
        // 换条件不清零：清零等于抹掉"它曾经追过一个判不出的条件"这段历史。
        // 代价是计数横跨两个条件，这个局限必须写在文档里，而不是偷偷重置。
        (conditionChanged ? '注意：判定计数不清零，它横跨你改过的条件。' : '') +
        (conditionGiven ? this.hintUnknown(existing.doneWhen) : ''),
      before, after: copy(existing), input,
    };
    this.opt.onWrite?.(w);
    return w;
  }

  /**
   * 条件里写了词表外的字段 → 那些字段每次都会判成"无法核对"，目标永远追不出结果。
   * 当场点出来（ACI 那一课：拒绝理由与回执都要可行动），但**不拒绝**——
   * 猜一个"它大概想写 hp"就是伪造条件，而写歪本身就是本轮要度量的行为。
   *
   * 器官只做集合归属判断，不解释 hp 是什么：换个游戏只换注入的词表，这段代码不动。
   */
  private hintUnknown(cond: Record<string, unknown> | null): string {
    if (!cond) return '';
    const bad = Object.keys(cond).filter((k) => !this.opt.fields.includes(k));
    if (!bad.length) return '';
    return ` 另：${bad.join(', ')} 不在可核对词表里，每次都会记成"无法核对"。可用字段：${this.opt.fields.join(', ')}。`;
  }

  /**
   * 拿当前画面判定**每一条**有字段的目标。**只有代码能调它**，工具接口里没有这个方法。
   *
   * 两条刻意的纪律：
   *  1. **不看 status**。标了 achieved / abandoned 的目标照样判定——
   *     否则模型只要声明一句就能把计数停掉，评测指标当场被被测对象控制。
   *  2. **合取的三态**：一个 violated 压倒 unverifiable（不满足是硬事实）；
   *     没有 violated 但有 unverifiable → 无法判定，既不算达成也不算不达成。
   *     把无法判定算成达成会凭空制造成功，算成不达成会凭空制造失败。
   */
  evaluate(evaluator: (condition: Record<string, unknown>) => PredictionDiff[]): GoalCheck[] {
    const step = this.opt.step();
    const out: GoalCheck[] = [];
    for (const g of this.map.values()) {
      if (!hasFields(g)) continue;
      const diffs = evaluator(clone(g.doneWhen!));
      const violated = diffs.some((d) => d.status === 'violated');
      const unknown = diffs.some((d) => d.status === 'unverifiable');
      // 判定器一个字段都没返回时也按"无法判定"记：宁可如实说判不出，绝不默认达成
      const met: boolean | null = diffs.length === 0 ? null : violated ? false : unknown ? null : true;
      const firstMet = met === true && g.firstMetStep === null;
      g.checks++;
      if (met === true) { g.met++; if (firstMet) g.firstMetStep = step; }
      else if (met === false) g.unmet++;
      else g.unverifiable++;
      g.lastCheckedStep = step;
      out.push({ goal: copy(g), diffs: diffs.map((d) => ({ ...d })), met, firstMet });
    }
    return out;
  }

  /** 局末快照：画面已满足完成条件、模型却仍标 open。代码只数，不动状态。 */
  metNotClosed(): string[] {
    return [...this.map.values()].filter((g) => goalAttention(g) === 'met_not_closed').map((g) => g.id);
  }

  /** 局末快照：模型标 achieved、画面却从未满足过（故障 #13 的目标版：主客观脱钩）。 */
  closedNeverMet(): string[] {
    return [...this.map.values()].filter((g) => goalAttention(g) === 'closed_never_met').map((g) => g.id);
  }

  /** 局末快照：还在追、却没有可核对的完成条件（目标通道空转）。 */
  uncheckable(): string[] {
    return [...this.map.values()].filter((g) => goalAttention(g) === 'uncheckable').map((g) => g.id);
  }

  /** 该出声的目标 id。判据见 goalAttention()，渲染器与循环层共用同一个主人。 */
  nagging(): string[] {
    return [...this.map.values()].filter((g) => goalAttention(g) !== null).map((g) => g.id);
  }
}

/**
 * 该出声的**事实条件**。这函数是唯一主人：渲染器据此写提示行，循环层据此落 nagging 名单，
 * 两处各写一套判据迟早会漂移（故障 #1 的教训：同一份契约不许有两条装配路径）。
 *
 * 三条**互斥**，所以一条目标最多一行提示，名单与行数天然对得上：
 *   met_not_closed  要 met>0 且 open
 *   closed_never_met 要 achieved（与 open 互斥）
 *   uncheckable     要 open 且 met===0（与 met_not_closed 互斥）
 *
 * 都是事实触发，没有任何魔法阈值；代码到此为止，**绝不改 status**。
 * 为什么"正常待达成"不出声：open + 条件可判定 + 还没满足，那正是追目标过程中的正常状态，
 * 出声就是制造噪音（与假设板 proposed 零核对不出声同一条取舍）。
 * 为什么 abandoned 不出声：放弃是模型的判断，代码无权对它说三道四。
 */
export function goalAttention(g: Goal): 'met_not_closed' | 'closed_never_met' | 'uncheckable' | null {
  if (g.met > 0 && g.status === 'open') return 'met_not_closed';
  if (g.status === 'achieved' && g.met === 0) return 'closed_never_met';
  if (g.status === 'open' && (!hasFields(g) || (g.checks > 0 && g.met === 0 && g.unmet === 0))) return 'uncheckable';
  return null;
}

/**
 * 首次达成的时候才往观察里回填一句话。
 * 返回 null 表示这一步没什么可说的——**每步都播报"还没达成"是噪音**，
 * 而且会挤爆上下文预算（M4-b1 第二局第 26 步已经超预算）。
 * 常驻事实（累计判定几次、首次在哪一步）由目标板承载，不靠每步重复。
 * 措辞纪律同假设板：只陈述代码算出的事实，显式把判断权交回模型，绝不写"你应该收手了"。
 */
export function describeGoalCheck(checks: readonly GoalCheck[]): string | null {
  const firsts = checks.filter((c) => c.firstMet);
  if (!firsts.length) return null;
  return firsts.map((c) => {
    const g = c.goal;
    const fields = c.diffs.map((d) => `${d.field} 画面实际 ${JSON.stringify(d.actual)}`).join('；');
    return `目标判定：${g.id} 的完成条件 ${JSON.stringify(g.doneWhen)} 在这一步**首次**被画面满足（${fields}）。` +
      `它当前的状态是 ${g.status}，由你声明；要不要标 achieved、要不要据此收手，由你判断，代码不会替你改。`;
  }).join('\n');
}