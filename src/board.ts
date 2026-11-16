/**
 * 假设板（M4-b1）：长期记忆器官。
 *
 * 它治的病是真跑两局独立复现的：对照组与 M08-B 都发明了"敌人每帧会新生成"
 * 这条假规则（世界里 ENEMY_COUNT=3，从不生成），其中一局还写成"规则已确认"
 * 存进板子。旧板子是 append-only 的 string[]，于是假规则每一步原样回喂、永久驻留。
 * **记忆只进不出 = 错误单调累积。**
 *
 * 分工铁律（与 M4-a 的"模型预测 → 代码算 diff → 模型判断"同一条）：
 *   - 假设的**正文与状态**归模型。代码绝不改 status，绝不判定假设真假。
 *   - 假设的**核对计数**归代码。模型无权写，只能声明"这一步在检验哪条"。
 *   - 代码发现"已被反对却仍未淘汰"时**只出声**，把判断权显式交回模型。
 *
 * 契约层纪律：本文件不认识"屏幕""敌人""分数"。它只认识 PredictionDiff 的三态，
 * 那是 types.ts 里的通用契约。换个游戏，这个器官一行不改。
 */
import type {
  BoardWrite, BoardWriteInput, Hypothesis, HypothesisBoard, HypothesisStatus,
  PredictionDiff, PredictionTest,
} from './types.ts';

const STATUSES: readonly HypothesisStatus[] = ['proposed', 'confirmed', 'retired'];

const isStatus = (s: string): s is HypothesisStatus => (STATUSES as readonly string[]).includes(s);

/** 一次归因的客观增量。三个计数之和恒等于 fields.length。 */
export interface Attribution {
  /** 归因后的假设快照（副本，不是活引用） */
  hypothesis: Hypothesis;
  fields: string[];
  supported: number;
  contradicted: number;
  unverifiable: number;
  /** 指定了 field，但那一步根本没预测它 */
  fieldAbsent: boolean;
}

export type AttributionProblem = 'malformed' | 'unknown_target' | 'not_checked' | 'field_absent';

/** 归因这一步发生了什么。problem=null 才是真的记上了账。 */
export interface AttributionOutcome {
  problem: AttributionProblem | null;
  test: PredictionTest;
  knownIds: string[];
  result: Attribution | null;
  predictedFields?: string[];
}

export interface BoardOptions {
  /**
   * 当前步号，由循环层注入。
   * 刻意用 getter 而不是让工具传步号：ToolContext 不该为了记忆器官变胖，
   * 步号的主人始终是循环层（和 brain.onRetry 同一个套路）。
   */
  step: () => number;
  /** 每次写入（含被拒）的出声口。循环层用它落盘 + 计数，板子自己不写文件。 */
  onWrite?: (w: BoardWrite) => void;
}

export class Board implements HypothesisBoard {
  private readonly plainNotes: string[] = [];
  private readonly map = new Map<string, Hypothesis>();
  private readonly opt: BoardOptions;

  constructor(opt: BoardOptions) { this.opt = opt; }

  // ── 纯文本通道：M1 语义，一字不改 ──────────────────────
  addPlain(text: string): void { this.plainNotes.push(text); }
  plain(): readonly string[] { return this.plainNotes; }

  // ── 结构化通道 ────────────────────────────────────────
  /** 交出去的一律是副本：板子外的代码不该能改到板上那条假设。 */
  get(id: string): Hypothesis | undefined {
    const h = this.map.get(id);
    return h ? { ...h } : undefined;
  }
  ids(): string[] { return [...this.map.keys()]; }
  /** 按创建顺序返回**副本**。请求与证据都必须是快照，否则后续写入会篡改历史。 */
  all(): Hypothesis[] { return [...this.map.values()].map((h) => ({ ...h })); }

  /**
   * 立一条 / 改一条假设。所有校验都在这里，工具层只负责把 args 变成字符串——
   * 一个类别一个主人，拒绝理由才不会两处各说一套。
   *
   * 三条不静默纪律：
   *  - 未知 id 只给 status → 拒绝，绝不悄悄新建（那会伪造"模型立过这条假设"）
   *  - 已存在 id 什么都不给 → 拒绝，绝不把空操作记成一次学习
   *  - 非法 status → 拒绝并列出合法值（ACI 那一课：拒绝理由必须可行动）
   */
  write(input: BoardWriteInput): BoardWrite {
    const step = this.opt.step();
    const id = String(input.id ?? '').trim();
    const before = this.map.has(id) ? { ...this.map.get(id)! } : null;
    const reject = (message: string): BoardWrite => {
      const w: BoardWrite = {
        step, id, ok: false, created: false, textChanged: false, statusChanged: false,
        message, before, after: null, input,
      };
      this.opt.onWrite?.(w);
      return w;
    };

    if (!id) return reject('id 不能为空。要写不带 id 的纯笔记，请只给 text。');

    const rawStatus = input.status === undefined ? undefined : String(input.status).trim();
    if (rawStatus !== undefined && !isStatus(rawStatus)) {
      return reject(`status "${rawStatus}" 不认识。只能用 ${STATUSES.join(' / ')}：proposed=待检验，confirmed=你认为已成立，retired=你决定不再用它作依据。`);
    }
    const rawText = input.text === undefined ? undefined : String(input.text).trim();
    if (rawText !== undefined && !rawText) return reject(`假设 ${id} 的正文不能是空白。`);
    // 板面按行认条目（一条假设 = 一个条目头 + 代码的计数行）。text 里带换行会把一条假设
    // 拆成几条，读板面的大脑和审计脚本都无从判断条目边界——所以在这里拒绝，而不是渲染时悄悄改写。
    if (rawText !== undefined && rawText.includes('\n')) {
      return reject(`假设 ${id} 的正文必须写在一行里（现在跨了 ${rawText.split('\n').length} 行）。板面按行认条目，跨行会把一条假设拆成几条。观察记录请用不带 id 的 note 逐条记，或拆成几条假设各写一行；这里只留一句可检验的猜想。`);
    }
    const why = input.why === undefined ? undefined : String(input.why).trim();

    const existing = this.map.get(id);
    if (!existing) {
      if (rawText === undefined) {
        return reject(`假设 ${id} 不存在。新建必须给 text；要改状态请先立一条。现有 id：${this.ids().join(', ') || '（还没有）'}。`);
      }
      const status: HypothesisStatus = rawStatus ?? 'proposed';
      const h: Hypothesis = {
        id, text: rawText, status,
        createdAtStep: step, statusAtStep: step, statusWhy: why ?? '',
        checks: 0, supported: 0, contradicted: 0, unverifiable: 0,
      };
      this.map.set(id, h);
      const w: BoardWrite = {
        step, id, ok: true, created: true, textChanged: true, statusChanged: true,
        message: `已立假设 ${id} [${status}]。之后用 testing:"${id}" 指出哪一步的预测在检验它，代码会把核对结果客观累加到它名下。`,
        before: null, after: { ...h }, input,
      };
      this.opt.onWrite?.(w);
      return w;
    }

    if (rawText === undefined && rawStatus === undefined) {
      return reject(`假设 ${id} 已存在。要改它请给 text（改写正文）或 status（改状态：${STATUSES.join(' / ')}）。`);
    }
    const textChanged = rawText !== undefined && rawText !== existing.text;
    const statusChanged = rawStatus !== undefined && rawStatus !== existing.status;
    if (textChanged) existing.text = rawText!;
    if (statusChanged) { existing.status = rawStatus as HypothesisStatus; existing.statusAtStep = step; }
    if (why !== undefined && why) existing.statusWhy = why;

    const w: BoardWrite = {
      step, id, ok: true, created: false, textChanged, statusChanged,
      message: `已更新 ${id} [${existing.status}]${textChanged ? '（正文已改写）' : ''}。` +
        `代码客观核对 ${existing.checks} 次：支持 ${existing.supported} / 反对 ${existing.contradicted} / 无法核对 ${existing.unverifiable}。`,
      before, after: { ...existing }, input,
    };
    this.opt.onWrite?.(w);
    return w;
  }

  /**
   * 把一次客观核对归因到某条假设。**只有代码能调它**，工具接口里没有这个方法。
   *
   * 粒度：给了 field 就只算那一个字段；不给则整份核对都算。
   * 局限（必须写进文档）：一条预测同时检验多条假设时，不带 field 的归因会互相污染。
   * 代码不替它拆——拆错就是伪造归因，宁可把粒度局限如实记下来。
   */
  attribute(id: string, diffs: readonly PredictionDiff[], field?: string): Attribution | null {
    const h = this.map.get(id);
    if (!h) return null;
    const use = field === undefined ? [...diffs] : diffs.filter((d) => d.field === field);
    const supported = use.filter((d) => d.status === 'ok').length;
    const contradicted = use.filter((d) => d.status === 'violated').length;
    const unverifiable = use.filter((d) => d.status === 'unverifiable').length;
    h.checks += use.length;
    h.supported += supported;
    h.contradicted += contradicted;
    h.unverifiable += unverifiable;
    return {
      hypothesis: { ...h },
      fields: use.map((d) => d.field),
      supported, contradicted, unverifiable,
      fieldAbsent: field !== undefined && use.length === 0,
    };
  }

  /** 局末快照：哪些假设已被客观反对、模型却仍未淘汰。代码只数，不动状态。 */
  contradictedNotRetired(): string[] {
    return [...this.map.values()].filter((h) => attention(h) === 'contradicted').map((h) => h.id);
  }

  /**
   * 局末快照：哪些假设被模型标成 confirmed，归因到它名下的客观核对却是 0 次。
   * 真跑 runs/20261113-215401-s6 实测：模型自称"此步验证了 enemyCount 和 scoreDelta"，
   * 却一次都没声明 testing → 计数恒为 0 → 淘汰机制永不触发（故障 #13）。
   */
  confirmedNoChecks(): string[] {
    return [...this.map.values()].filter((h) => attention(h) === 'no_checks').map((h) => h.id);
  }

  /** 该出声的假设 id。判据见 attention()，渲染器与循环层共用同一个主人。 */
  nagging(): string[] {
    return [...this.map.values()].filter((h) => attention(h) !== null).map((h) => h.id);
  }
}

/**
 * 该出声的**事实条件**。这函数是唯一主人：渲染器据此写提示行，循环层据此落 nagging 名单，
 * 两处各写一套判据迟早会漂移（故障 #1 的教训：同一份契约不许有两条装配路径）。
 *
 * 两条互斥——被反对必然 checks>0——所以一条假设最多一行提示，名单与行数天然对得上。
 * 都是事实触发，没有任何魔法阈值；代码到此为止，**绝不改 status**。
 *
 * 为什么 proposed 零核对不出声：那正是"待检验"的正常状态，出声就是制造噪音。
 * 只有 confirmed（模型自称已成立）与零核对并存，才是主观陈述与客观账本脱钩。
 */
export function attention(h: Hypothesis): 'contradicted' | 'no_checks' | null {
  if (h.contradicted > 0 && h.status !== 'retired') return 'contradicted';
  if (h.status === 'confirmed' && h.checks === 0) return 'no_checks';
  return null;
}

/**
 * 归因结果的事实文本。只陈述事实 + 给出可行动的下一步，绝不替模型判断假设真假。
 * 返回 null 表示这一步没什么可说的（没声明 testing），此时一个字都不该往观察里加。
 */
export function describeAttribution(o: AttributionOutcome): string | null {
  const t = o.test;
  if (o.problem === 'malformed') {
    return `假设归因：你这一步的 testing 形状不可用（原文 ${JSON.stringify(t.raw) ?? String(t.raw)}），` +
      '没有记到任何假设名下。格式："testing":"H1" 或 "testing":{"id":"H1","field":"enemyCount"}。';
  }
  if (o.problem === 'unknown_target') {
    return `假设归因：testing 指向的 "${t.id}" 不在假设板上，没有记到任何假设名下。` +
      `现有 id：${o.knownIds.join(', ') || '（还没有）'}。要立一条新假设，用 note 带 id 与 text。`;
  }
  if (o.problem === 'not_checked') {
    return `假设归因：这一步没有产生可核对的画面事实（工具没改变画面，或工具报错了），` +
      `所以 testing="${t.id}" 没有计数。`;
  }
  if (o.problem === 'field_absent') {
    return `假设归因：你这一步没有预测 ${t.field}，无法把它记到 ${t.id} 名下。` +
      `这一步实际预测的字段：${(o.predictedFields ?? []).join(', ') || '（一个都没给）'}。`;
  }
  const a = o.result;
  if (!a) return null;
  const h = a.hypothesis;
  return `假设归因：这一步的核对已记到 ${h.id} 名下（字段 ${a.fields.join(', ')}）：` +
    `支持 +${a.supported} / 反对 +${a.contradicted} / 无法核对 +${a.unverifiable}；` +
    `累计核对 ${h.checks} 次，支持 ${h.supported} / 反对 ${h.contradicted} / 无法核对 ${h.unverifiable}。` +
    `它当前的状态是 ${h.status}，由你声明，代码不会替你改。`;
}