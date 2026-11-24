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

async function handleMcpMethod(
  method: string,
  params: Record<string, unknown>,
  manager: McpSessionManager,
): Promise<Record<string, unknown>> {
  switch (method) {
    case 'tools/list':
      return { tools: [...TOOLS] };
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
    case 'resources/templates/list':
      return { resourceTemplates: [...RESOURCE_TEMPLATES] };
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
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }],
      };
    }
    case 'prompts/list':
      return { prompts: [...PROMPTS] };
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
    async handle(method: string, params: Record<string, unknown>, _ctx: RpcContext) {
      return handleMcpMethod(method, params, manager);
    },
  });
}
