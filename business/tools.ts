import { BusinessError, isRecord } from './errors.ts';
import type { KnowledgeStore, TicketStore } from './store.ts';
import type { BusinessToolSpec, ToolEffect } from './types.ts';

export interface ApprovalRequest {
  runId: string;
  toolName: string;
  args: unknown;
  token: string;
}

export interface ApprovalDecision {
  allow: boolean;
  reason: string;
}

/** 生产实现必须原子地校验并消费一次性 token；不能只相信模型说“用户已同意”。 */
export interface ApprovalGateway {
  authorizeAndConsume(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

export interface ToolContext {
  runId: string;
  ticketId: string;
  tickets: TicketStore;
  knowledge: KnowledgeStore;
  approval?: ApprovalGateway;
  signal: AbortSignal;
}

export interface BusinessTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  effect: ToolEffect;
  inputSchema: Record<string, unknown>;
  parse(raw: Record<string, unknown>): Input;
  execute(input: Input, context: ToolContext): Promise<Output>;
  approvalToken?: (input: Input) => string;
}

type RegisteredTool = BusinessTool<any, any>;

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(tools: RegisteredTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: RegisteredTool): this {
    if (this.tools.has(tool.name)) throw new BusinessError('invalid_args', `工具重复注册：${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  specs(includeExternal: boolean): BusinessToolSpec[] {
    return [...this.tools.values()]
      .filter((tool) => includeExternal || tool.effect !== 'external')
      .map(({ name, description, effect, inputSchema }) => ({ name, description, effect, inputSchema }));
  }

  async execute(name: string, rawArgs: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new BusinessError('invalid_args', `未知业务工具：${name}；可用：${this.specs(true).map((item) => item.name).join(', ')}。`);
    }
    context.signal.throwIfAborted();
    const input = tool.parse(rawArgs);
    if (tool.effect === 'external') {
      if (context.approval === undefined) {
        throw new BusinessError('denied', `外部写入工具 ${name} 未配置审批网关，已拒绝执行。`);
      }
      const token = tool.approvalToken?.(input) ?? '';
      if (token === '') throw new BusinessError('invalid_args', `外部写入工具 ${name} 缺少 approvalToken。`);
      let verdict;
      try {
        verdict = await context.approval.authorizeAndConsume({
          runId: context.runId,
          toolName: name,
          args: input,
          token,
        }, context.signal);
      } catch (error) {
        throw new BusinessError('denied', `审批服务不可用，已拒绝执行 ${name}。`, { cause: error });
      }
      if (!verdict.allow) {
        throw new BusinessError('denied', `审批未通过：${verdict.reason}`);
      }
    }
    context.signal.throwIfAborted();
    return tool.execute(input, context);
  }
}

export function readObject(raw: Record<string, unknown>, allowed: readonly string[], required: readonly string[], toolName: string): Record<string, unknown> {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new BusinessError('invalid_args', `${toolName} 不接受参数 ${key}；只接受：${allowed.join(', ') || '（无）'}。`);
    }
  }
  for (const key of required) {
    if (raw[key] === undefined) throw new BusinessError('invalid_args', `${toolName} 缺少必填参数 ${key}。`);
  }
  return raw;
}

export function readString(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  toolName: string,
): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new BusinessError('invalid_args', `${toolName}.${key} 必须是 ${min}..${max} 字符的字符串。`);
  }
  return value.trim();
}

export function readOptionalInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number,
  toolName: string,
): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BusinessError('invalid_args', `${toolName}.${key} 必须是 ${min}..${max} 的整数。`);
  }
  return value;
}

export function readEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
  toolName: string,
): T {
  const value = args[key];
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new BusinessError('invalid_args', `${toolName}.${key} 必须是：${values.join(' / ')}。`);
  }
  return value as T;
}

export function requireArgs(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new BusinessError('invalid_args', '工具参数 args 必须是对象。');
  return value;
}
