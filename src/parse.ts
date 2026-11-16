/**
 * 大脑输出解析容错。
 * 弱模型/远端模型都会干这些事：包一层 ```json、前后加解释文字、少个括号、
 * 把 args 写成字符串、多塞一个字段。harness 必须扛住，并且把失败变成可行动的回炉提示。
 *
 * M4 追加一条纪律：**附加字段坏了，不该让一个合法动作作废**。
 * predict / surprise 是可选的观测字段，解析它们失败时绝不抛 E_BRAIN_PARSE——
 * 否则模型好好走了一步，却因为预测写歪了被判"大脑失败"，整局白跑。
 */
import { ErrCode, HarnessError } from './errors.ts';
import type { Decision, PredictionTest, SurpriseJudgment } from './types.ts';

/** 从可能含 fences / 散文的文本里，扫出第一个「平衡」的 JSON 对象 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // 括号不平衡
}

function stripFence(text: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return m?.[1] ? m[1].trim() : text.trim();
}

/** 解析并校验成 Decision。失败抛 E_BRAIN_PARSE，附带原文片段便于定位。 */
export function parseDecision(raw: string): Decision {
  const text = stripFence(raw ?? '');
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    throw new HarnessError(
      ErrCode.BRAIN_PARSE,
      '输出里找不到完整的 JSON 对象（可能括号不闭合或根本没输出 JSON）',
      { raw: snippet(text) },
    );
  }
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    throw new HarnessError(ErrCode.BRAIN_PARSE, `JSON 语法错误：${(e as Error).message}`, {
      raw: snippet(jsonText),
    });
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new HarnessError(ErrCode.BRAIN_PARSE, '顶层必须是对象', { raw: snippet(jsonText) });
  }
  const o = obj as Record<string, unknown>;
  const call = o['call'] ?? o['tool'] ?? o['action'];
  if (!call || typeof call !== 'object' || Array.isArray(call)) {
    throw new HarnessError(ErrCode.BRAIN_PARSE, '缺少 call 字段（应为 {name, args}）', {
      raw: snippet(jsonText),
    });
  }
  const c = call as Record<string, unknown>;
  const name = c['name'] ?? c['tool'];
  if (typeof name !== 'string' || !name.trim()) {
    throw new HarnessError(ErrCode.BRAIN_PARSE, 'call.name 必须是非空字符串', {
      raw: snippet(jsonText),
    });
  }
  let args = c['args'] ?? c['arguments'] ?? {};
  if (typeof args === 'string') {
    // 有些模型把 args 又套了一层 JSON 字符串
    try {
      args = JSON.parse(args);
    } catch {
      throw new HarnessError(ErrCode.BRAIN_PARSE, 'call.args 是字符串但不是合法 JSON', {
        raw: snippet(jsonText),
      });
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new HarnessError(ErrCode.BRAIN_PARSE, 'call.args 必须是对象', { raw: snippet(jsonText) });
  }
  const thought = typeof o['thought'] === 'string' ? o['thought'] : '';
  const decision: Decision = { thought, call: { name: name.trim(), args: args as Record<string, unknown> } };
  const predict = parsePredict(o['predict'] ?? o['prediction']);
  if (predict) decision.predict = predict;
  const surprise = parseSurprise(o['surprise']);
  if (surprise) decision.surprise = surprise;
  const testing = parseTesting(o['testing']);
  if (testing) decision.testing = testing;
  return decision;
}

/**
 * predict 写歪时的留档键。刻意不在这里"修好"它，也不丢掉它：
 * 原样塞进一个预测字段名里，世界层的核对引擎会把它当成**不认识的字段**判 unverifiable。
 * 这样既没伪造"预测被违反"，也没把"模型确实试着预测了"这条证据抹掉。
 * 不需要跨层约定常量——未知字段那条通用路径天然就接住了它。
 */
export const MALFORMED_PREDICT = '__malformed__';

/** 宽容解析 predict。不是对象就留档原文；根本没给就返回 undefined（记 given=false）。 */
function parsePredict(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  let obj: unknown = v;
  if (typeof obj === 'string') {
    // 有些模型把 predict 又套了一层 JSON 字符串，和 args 一个毛病
    try { obj = JSON.parse(obj); } catch { obj = undefined; }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    // 空对象等于没预测。别让 {} 混进 given=true 把"不预测"这个行为藏起来
    return Object.keys(o).length > 0 ? o : undefined;
  }
  return { [MALFORMED_PREDICT]: v };
}

/**
 * 宽容解析 surprise。两条纪律同时成立：
 *  - **不猜**：形状不可用时 unexpected=null，绝不填 false。
 *    猜 false 会凭空制造"代码判违反、模型说不意外"，那是 M4 要度量的关键行为。
 *  - **不丢**：不可用也要留档（null + 原文），否则分不清"没判断"和"判断写歪了"。
 *    真跑一局 surpriseGiven=0 时，这两者的归因完全不同，而静默丢弃会让它们长得一模一样。
 * 只有字段根本没出现才返回 undefined。
 */
function parseSurprise(v: unknown): SurpriseJudgment | undefined {
  if (v === undefined || v === null) return undefined;
  const raw0 = v as Record<string, unknown>;
  const isObj = typeof v === 'object' && !Array.isArray(v);
  const whyRaw = isObj ? (raw0['why'] ?? raw0['reason']) : undefined;
  // 没给理由就把原文留在 why 里：证据不该因为形状不对而消失
  const fallbackWhy = typeof whyRaw === 'string' && whyRaw ? whyRaw : JSON.stringify(v) ?? String(v);
  if (!isObj) return { unexpected: null, why: typeof v === 'string' ? v : fallbackWhy };

  const raw = raw0['unexpected'] ?? raw0['surprised'];
  let unexpected: boolean | null = null;
  if (typeof raw === 'boolean') unexpected = raw;
  else if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'true') unexpected = true;
    else if (s === 'false') unexpected = false;
  }
  if (unexpected === null) return { unexpected: null, why: fallbackWhy };
  return { unexpected, why: typeof whyRaw === 'string' ? whyRaw : '' };
}

/**
 * 宽容解析 testing（M4-b）。纪律与 surprise 完全一致：**不猜、不丢**。
 *
 * 为什么这里比 predict 更保守（只认 id，不接受别名）：
 * predict 猜错了顶多判一个 unverifiable，而 testing 猜错会把客观核对
 * **记到另一条假设头上**，那是伪造归因，会直接污染"假规则被反对了几次"这个关键量。
 * 所以形状不对就 id=null + 原文留档，绝不从 field / 上下文里推断它想指哪条。
 */
function parseTesting(v: unknown): PredictionTest | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') {
    const id = v.trim();
    return id ? { id } : { id: null, raw: v };
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const id = typeof o['id'] === 'string' ? o['id'].trim() : '';
    if (!id) return { id: null, raw: v };
    const f = o['field'];
    const field = typeof f === 'string' && f.trim() ? f.trim() : undefined;
    return { id, ...(field ? { field } : {}) };
  }
  return { id: null, raw: v };
}

/**
 * 回炉提示：告诉大脑错在哪、正确格式长什么样。可读性直接决定它能否自我纠正。
 * 空回复和解析失败是两种不同的错，提示必须分开说——
 * 对空回复说「无法解析」是撒谎：它根本没输出，不是输出了坏东西。
 */
export function repairHint(err: HarnessError, toolNames: readonly string[]): string {
  const reason = err.code === ErrCode.BRAIN_EMPTY
    ? '你上一次的回复是空的，没有任何内容。'
    : `你上一次的输出无法解析：${err.message}`;
  return [
    reason,
    '请只输出一个 JSON 对象，不要加解释文字、不要加代码围栏。格式：',
    '{"thought":"你的推理","call":{"name":"工具名","args":{}}}',
    `可用工具：${toolNames.join(', ')}`,
  ].join('\n');
}

function snippet(s: string, n = 240): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}