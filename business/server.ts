import { RpcError, runMcpStdio, type RpcContext } from '../src/mcp/protocol.ts';
import { asBusinessError, BusinessError, isRecord } from './errors.ts';
import { BusinessRuntime, type BusinessRuntimeOptions } from './runtime.ts';
import type { StartInput, StepInput } from './types.ts';

export const SERVER_INFO = { name: 'business-agent-base', version: '0.1.0' } as const;
export const CAPABILITIES = {
  tools: { listChanged: false },
  resources: { subscribe: false, listChanged: false },
  prompts: { listChanged: false },
} as const;

const RUN_ID_SCHEMA = {
  type: 'string',
  pattern: '^biz-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
};

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thought', 'call'],
  properties: {
    thought: { type: 'string', minLength: 1, maxLength: 2000 },
    call: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'args'],
      properties: {
        name: { type: 'string', description: 'request.tools 中的一个业务工具名' },
        args: { type: 'object', additionalProperties: true },
      },
    },
  },
};

export const TOOLS = [
  {
    name: 'case_start',
    description: '创建业务会话并返回第一步 request。宿主大脑读取 request 后自行决策；server 不调用模型。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ticketId'],
      properties: {
        ticketId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' },
        maxSteps: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
        maxWallMs: { type: 'integer', minimum: 1000, maximum: 900000, default: 300000 },
      },
    },
  },
  {
    name: 'case_step',
    description: '提交一条宿主 Decision。runtime 校验参数、权限、审批、预算与版本，执行后返回 observation 和下一步 request。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['runId', 'expectedStep', 'decision'],
      properties: {
        runId: RUN_ID_SCHEMA,
        expectedStep: { type: 'integer', minimum: 1, maximum: 51 },
        decision: DECISION_SCHEMA,
      },
    },
  },
  {
    name: 'case_status',
    description: '读取当前安全 request 或已停止的局末结果。run 只存在于当前 server 进程。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: { runId: RUN_ID_SCHEMA },
    },
  },
] as const;

function cacheableResult(payload: Record<string, unknown>, context: RpcContext): Record<string, unknown> {
  return context.modern ? { ...payload, ttlMs: 0, cacheScope: 'private' } : payload;
}

function textResult(payload: object): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

function rejectUnknown(params: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new RpcError(-32602, `不接受的参数：${key}`);
  }
}

async function handleMcpMethod(
  method: string,
  params: Record<string, unknown>,
  runtime: BusinessRuntime,
  context: RpcContext,
): Promise<Record<string, unknown>> {
  switch (method) {
    case 'tools/list':
      return cacheableResult({ tools: [...TOOLS] }, context);
    case 'tools/call': {
      if (typeof params['name'] !== 'string') throw new RpcError(-32602, 'tools/call 缺少工具名 name');
      const args = params['arguments'] === undefined ? {} : params['arguments'];
      if (!isRecord(args)) throw new RpcError(-32602, 'tools/call.arguments 必须是对象');
      try {
        switch (params['name']) {
          case 'case_start':
            rejectUnknown(args, ['ticketId', 'maxSteps', 'maxWallMs']);
            return textResult(await runtime.start(args as unknown as StartInput));
          case 'case_step': {
            rejectUnknown(args, ['runId', 'expectedStep', 'decision']);
            if (typeof args['runId'] !== 'string') throw new BusinessError('invalid_args', 'case_step.runId 必须是字符串。');
            return textResult(await runtime.step(args as unknown as StepInput));
          }
          case 'case_status':
            rejectUnknown(args, ['runId']);
            if (typeof args['runId'] !== 'string') throw new BusinessError('invalid_args', 'case_status.runId 必须是字符串。');
            return textResult(await runtime.status(args['runId']));
          default:
            throw new BusinessError('invalid_args', `没有名为 ${params['name']} 的工具；可用：${TOOLS.map((tool) => tool.name).join(', ')}。`);
        }
      } catch (error) {
        const businessError = asBusinessError(error);
        if (businessError.code === 'not_found') throw new RpcError(-32002, businessError.message);
        if (businessError.code === 'denied') throw new RpcError(-32000, businessError.message);
        if (businessError.code === 'invalid_args' || businessError.code === 'stale_step') {
          throw new RpcError(-32602, businessError.message);
        }
        throw new RpcError(-32603, businessError.message);
      }
    }
    case 'resources/list':
      return cacheableResult({ resources: [] }, context);
    case 'resources/templates/list':
      return cacheableResult({ resourceTemplates: [] }, context);
    case 'prompts/list':
      return cacheableResult({ prompts: [] }, context);
    default:
      throw new RpcError(-32601, 'Method not found');
  }
}

export async function runBusinessMcpServer(
  options: BusinessRuntimeOptions & { runtime?: BusinessRuntime; log?: (line: string) => void },
): Promise<void> {
  const runtime = options.runtime ?? new BusinessRuntime(options);
  await runMcpStdio({
    serverInfo: SERVER_INFO,
    capabilities: CAPABILITIES,
    instructions: '宿主负责业务决策；先 case_start，完整阅读 request，每一步只提交一个 Decision，完成后 finish。外部写入默认关闭。',
    log: options.log ?? ((line) => process.stderr.write(`${line}\n`)),
    async handle(method, params, context) {
      return handleMcpMethod(method, params, runtime, context);
    },
  });
}
