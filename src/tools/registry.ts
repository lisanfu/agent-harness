/**
 * 工具注册表：schema 校验 + 执行 + 可读拒绝。
 *
 * ACI（Agent-Computer Interface）设计的关键一课：
 *   拒绝理由写 "invalid" → 大脑无法自我纠正，只会重试同一个错。
 *   拒绝理由写 "门锁了，你还没有钥匙" → 大脑能换策略。
 * 所以这里所有失败都带「怎么办」的提示。
 */
import { resolve, sep } from 'node:path';
import { ErrCode, readable } from '../errors.ts';
import type { Tool, ToolCall, ToolContext, ToolResult, ToolSpec } from '../types.ts';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`工具重复注册：${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map(({ name, description, params }) => ({ name, description, params }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return readable(
        ErrCode.TOOL_UNKNOWN,
        `没有名为 "${call.name}" 的工具。`,
        `可用工具只有：${this.names().join(', ')}。请从中选一个。`,
      );
    }
    const checked = checkArgs(tool, call.args);
    if (checked.error) return checked.error;
    try {
      // ⚠️ 传给工具的是**归一化后的 args**，不是原样 args。
      // 但 call.args 本身一个字都不改（它是 Decision 的一部分，trace 记的是模型原文）——
      // 于是证据里同时留下"它写了什么"和"我们按什么执行"。
      return await tool.run(checked.args, ctx);
    } catch (e) {
      const err = e as Error;
      return readable(
        ErrCode.TOOL_RUNTIME,
        `工具 "${call.name}" 执行时抛错：${err.message}`,
        '请检查参数是否指向真实存在的目标，或换一个动作。',
      );
    }
  }
}

/**
 * 参数校验 + **一层容错归一化**。
 *
 * 容错只有一处、只针对 `object` 型参数：模型常把一个对象参数再套一层 JSON 字符串
 * （predict 的 args 也是同一个毛病，见 parse.ts 里的处理）。
 * 拆不开怎么办？**不报错、不猜**：原样交给工具，由工具的器官按"形状不可用"留档
 * （故障 #9 的纪律：拒绝整条会把"模型确实表达过这个意图"抹掉）。
 *
 * 刻意不做的事：不猜别名、不补默认值、不把 string 猜成 number。
 * 猜错一次的代价是伪造一条证据，比多一次拒绝大得多（§4.4：宽容度按猜错的代价分级）。
 */
function checkArgs(tool: Tool, raw: Record<string, unknown>): { args: Record<string, unknown>; error?: ToolResult } {
  const args: Record<string, unknown> = { ...raw };
  const allowed = Object.keys(tool.params);
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      return {
        args, error: readable(
          ErrCode.TOOL_ARGS,
          `工具 "${tool.name}" 不接受参数 "${key}"。`,
          `它只接受：${allowed.length ? allowed.join(', ') : '（无参数）'}。`,
        ),
      };
    }
  }
  for (const [key, spec] of Object.entries(tool.params)) {
    const v = args[key];
    if (v === undefined || v === null) {
      if (spec.required) {
        return {
          args, error: readable(
            ErrCode.TOOL_ARGS,
            `工具 "${tool.name}" 缺少必填参数 "${key}"（${spec.type}）。`,
            `说明：${spec.description}`,
          ),
        };
      }
      continue;
    }
    if (spec.type === 'object' && typeof v === 'string') {
      // 只接受"看起来是对象"的 JSON 字符串；拆出来不是对象就当没这回事，原样交给工具
      try {
        const parsed: unknown = JSON.parse(v);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args[key] = parsed;
      } catch { /* 拆不开就原样交给工具 */ }
      continue;
    }
    if (typeof v !== spec.type) {
      return {
        args, error: readable(
          ErrCode.TOOL_ARGS,
          `参数 "${key}" 类型应为 ${spec.type}，实际收到 ${typeof v}。`,
          `说明：${spec.description}`,
        ),
      };
    }
  }
  return { args };
}

/** 沙箱路径解析：任何越界都拒绝，并告诉大脑边界在哪 */
export function resolveInSandbox(sandbox: string, p: string): string {
  const root = resolve(sandbox);
  const target = resolve(root, p);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new SandboxEscape(`路径 "${p}" 越出沙箱。你只能访问 ${root} 内的文件。`);
  }
  return target;
}

export class SandboxEscape extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxEscape';
  }
}