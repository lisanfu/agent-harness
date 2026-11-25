/** MCP 方法路由。传输与协议握手在 protocol.ts，业务状态在 session.ts。 */
import {
  ARENA_PLAY_PROMPT, CAPABILITIES, PROMPTS, RESOURCE_TEMPLATES, SERVER_INFO, TOOLS,
} from './catalog.ts';
import { runMcpStdio, RpcError, type RpcContext } from './protocol.ts';
import { McpSessionManager, type McpSessionOptions } from './session.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

/** 2026-07-28 的可缓存目录/读取结果必须显式给出新鲜度与共享范围。 */
function cacheableResult(payload: Record<string, unknown>, context: RpcContext): Record<string, unknown> {
  return context.modern ? { ...payload, ttlMs: 0, cacheScope: 'private' } : payload;
}

async function handleMcpMethod(
  method: string,
  params: Record<string, unknown>,
  manager: McpSessionManager,
  context: RpcContext,
): Promise<Record<string, unknown>> {
  switch (method) {
    case 'tools/list':
      return cacheableResult({ tools: [...TOOLS] }, context);
    case 'tools/call': {
      if (typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call 缺少工具名 name');
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!isRecord(args)) throw new RpcError(-32602, 'tools/call.arguments 必须是对象');
      let payload: Record<string, unknown>;
      switch (params.name) {
        case 'harness_start': payload = await manager.start(args); break;
        case 'harness_step': payload = await manager.step(args); break;
        case 'harness_status': payload = await manager.status(args); break;
        default: throw new RpcError(-32602, `没有名为 "${params.name}" 的工具；可用：${TOOLS.map((t) => t.name).join(', ')}`);
      }
      return textResult(payload);
    }
    case 'resources/list':
      // 本 server 只暴露需要 run_id 的模板，不注册固定 URI 资源。
      // 标准客户端会在能力发现时请求此接口；声明 resources 就不能返回 -32601。
      return cacheableResult({ resources: [] }, context);
    case 'resources/templates/list':
      return cacheableResult({ resourceTemplates: [...RESOURCE_TEMPLATES] }, context);
    case 'resources/read': {
      const uri = params.uri;
      const prefix = 'harness://run/';
      const suffix = '/agent-view';
      if (typeof uri !== 'string' || !uri.startsWith(prefix) || !uri.endsWith(suffix)) {
        throw new RpcError(-32602, '只支持读取 harness://run/{run_id}/agent-view');
      }
      const runId = uri.slice(prefix.length, -suffix.length);
      if (runId.includes('/')) throw new RpcError(-32602, 'resource uri 形状不正确');
      const view = await manager.agentView({ run_id: runId });
      return cacheableResult({
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }],
      }, context);
    }
    case 'prompts/list':
      return cacheableResult({ prompts: [...PROMPTS] }, context);
    case 'prompts/get':
      if (params.name !== 'arena-play') throw new RpcError(-32602, '没有这个 prompt；可用：arena-play');
      if (params.arguments !== undefined && (!isRecord(params.arguments) || Object.keys(params.arguments).length)) {
        throw new RpcError(-32602, 'arena-play 不接受参数');
      }
      return {
        description: PROMPTS[0].description,
        messages: [{ role: 'user', content: { type: 'text', text: ARENA_PLAY_PROMPT } }],
      };
    default:
      throw new RpcError(-32601, 'Method not found');
  }
}

/** 可注入 manager 供集成测试；真实入口只从启动环境构造 manager。 */
export async function runHarnessMcpServer(
  opts: McpSessionOptions & { manager?: McpSessionManager } = {},
): Promise<void> {
  const manager = opts.manager ?? new McpSessionManager(opts);
  await runMcpStdio({
    serverInfo: SERVER_INFO,
    capabilities: CAPABILITIES,
    instructions: '宿主负责决策；本 server 只执行与核对。先读 arena-play，再用 harness_start / harness_step 分步试玩。',
    log: opts.log ?? ((line) => process.stderr.write(`${line}\n`)),
    async handle(method: string, params: Record<string, unknown>, ctx: RpcContext) {
      return handleMcpMethod(method, params, manager, ctx);
    },
  });
}
