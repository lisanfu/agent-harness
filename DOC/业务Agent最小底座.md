# 业务 Agent 最小底座：客服工单示例与扩展指南

更新日期：2026-11-25

这是一套不绑定游戏、不绑定模型供应商的最小业务 Agent 底座。它把“宿主大脑做决策”与“业务系统安全执行决策”分开：MCP server 不启动模型，也不用启发式脚本代替模型；宿主每步读取当前 `request`，只提交一个 `Decision`，runtime 负责参数校验、权限、审批、预算、并发控制、版本冲突和审计。

示例业务是客服工单：查询工单、检索知识、保存回复草稿、添加内部备注，最后结束处理。默认不会发送客户消息，也不会改变工单状态。

## 1. 先看边界

这个底座已经提供：

- 模型可替换：Qoder、其他 MCP 宿主或自建模型循环都可以提供 Decision。
- 工具契约：名称、说明、`inputSchema`、效果等级、参数解析和执行函数。
- 参数校验：拒绝未知参数、未知工具、错误类型和越界值。
- 权限分级：`read`、`draft`、`external` 三种效果。
- 外部写入审批：`ApprovalGateway.authorizeAndConsume()` 原子校验并消费一次性 token。
- 业务并发控制：每个 run 串行，`expectedStep` 防止重复提交。
- 数据并发控制：`expectedRevision` 防止覆盖他人的工单修改。
- 预算：步数、整局墙钟、单工具超时、活跃会话上限。
- 审计：动作前先落审计；动作后失败不能伪装成“没有发生”。
- 可替换存储：`TicketStore`、`KnowledgeStore`、`RunJournal` 都是端口。
- 安全业务视图：模型默认看不到 `internalNotes` 等内部字段。

它目前**不是**生产平台，有意保持小：

- run 只存在当前 server 进程的内存中，重启后不能恢复。
- 没有跨进程文件锁、持久 checkpoint 或外部幂等键。
- 示例工单与知识库都是内存数据，重启后丢失。
- 知识检索是确定性关键词匹配，不是生产搜索引擎，也不是模型。
- 只实现 MCP stdio，没有 HTTP/SSE transport、用户鉴权、租户隔离或 RBAC。
- 没有生产审批网关实现；没有网关时外部工具默认关闭。
- 工具超时只能发出 `AbortSignal`，不能强制终止不合作的外部适配器。
- fixture 冒烟只证明接线，不证明真实模型的业务能力。

## 2. 目录与职责

```text
business/
├── main.ts             进程入口、环境变量、示例存储装配
├── server.ts           MCP 目录、JSON-RPC 路由、错误映射
├── runtime.ts          会话状态机、预算、串行执行、停止与收尾
├── types.ts            宿主请求、Decision、Observation、局末结果契约
├── tools.ts            工具注册、参数 helper、审批闸门
├── support-tools.ts    客服工单示例工具
├── store.ts            工单/知识存储端口与内存实现
├── audit.ts            审计端口、JSONL 账本、哈希摘要、原子结果文件
├── smoke.ts            真实 stdio fixture 冒烟
└── test/
    ├── runtime.test.ts 运行时关键闸门
    └── server.test.ts  真实 MCP 入口集成测试
```

架构：

```text
Qoder / 其他宿主 LLM / 自建模型循环
              │
              │ 产生一个 Decision
              ▼
case_start / case_step / case_status
              │
              ▼
        BusinessRuntime
          ├─ ToolRegistry：工具目录与参数校验
          ├─ ApprovalGateway：外部写入审批与 token 消费
          ├─ expectedStep：防重复提交
          ├─ expectedRevision：防覆盖修改
          ├─ maxSteps / wallClock / toolTimeout
          └─ RunJournal：动作前后审计与局末结果
              │
              ▼
   TicketStore / KnowledgeStore
```

`src/mcp/protocol.ts` 只负责现代与 legacy stdio 传输。业务会话没有复用游戏世界的 checkpoint 机制；两者不要混为一谈。

## 3. 快速开始

要求 Node.js `>=22.18`，使用原生 TypeScript 类型擦除。仓库保持零依赖，不需要 `npm install`。

本机 Node 位于 `/home/fuyuan/.local/node-22/bin`，实测版本 `v22.23.4`。

```bash
cd /home/fuyuan/Documents/workspace/agent-harness
export PATH="/home/fuyuan/.local/node-22/bin:$PATH"

npm run verify:business
```

这条命令依次运行：

```bash
npm run test:business
npm run business:smoke
```

本机已验证：业务测试 **12/12 通过**，fixture 冒烟完成 2 个完整动作（知识检索、保存草稿），并确认审计与 `result.json` 存在、临时目录清理。

启动 MCP server：

```bash
npm run business
```

这个命令会占用当前 stdio 通道等待 JSON-RPC，不是在终端里直接聊天。通常由 Qoder 或其他 MCP 宿主启动它。

所有业务输出默认写入：

```text
sandbox/business/<runId>/
```

该目录由 `assertDedicatedOutputRoot()` 保护，不能指向仓库根、`runs/`、`src/`、`test/`、`verify/` 或文件系统根。

## 4. 接入 Qoder 或其他 MCP 宿主

通用配置形状：

```json
{
  "mcpServers": {
    "business-agent": {
      "command": "/home/fuyuan/.local/node-22/bin/node",
      "args": [
        "/home/fuyuan/Documents/workspace/agent-harness/business/main.ts"
      ],
      "env": {
        "BUSINESS_AGENT_OUT": "/home/fuyuan/Documents/workspace/agent-harness/sandbox/business-qoder",
        "BUSINESS_AGENT_MAX_ACTIVE": "8",
        "BUSINESS_AGENT_MAX_STEPS": "12",
        "BUSINESS_AGENT_MAX_WALL_MS": "300000",
        "BUSINESS_AGENT_TOOL_TIMEOUT_MS": "10000"
      }
    }
  }
}
```

路径要换成部署环境中的绝对路径。配置里不需要模型 API key：模型由宿主提供。不要把凭据写进仓库、示例配置或提交内容。

连接后，宿主应看到三个 MCP 工具：

| MCP 工具 | 用途 |
|---|---|
| `case_start` | 创建会话，返回 `runId` 和第一步 `request` |
| `case_step` | 提交一条 Decision，执行后返回 observation 与下一步 request |
| `case_status` | 读取当前安全 request 或已停止结果 |

`request.tools` 才是当前模型可以选择的业务工具。不要把 `ticket.get` 等业务工具误当成顶层 MCP 工具直接调用；它们由 `case_step.decision.call` 承载。

现代 MCP 目录结果带 `ttlMs:0` 与 `cacheScope:"private"`，避免把业务请求误当公共缓存。没有固定资源时，`resources/list`、`resources/templates/list`、`prompts/list` 返回标准空目录。

## 5. 一局客服工单怎么跑

示例工单：

- `T-1001`：退货后的退款多久到账。
- `T-1002`：优惠券能否叠加使用。

### 5.1 开始

```json
{
  "ticketId": "T-1001",
  "maxSteps": 12,
  "maxWallMs": 300000
}
```

`case_start` 返回：

```json
{
  "kind": "started",
  "runId": "biz-......",
  "request": {
    "kind": "business_request",
    "step": 1,
    "maxSteps": 12,
    "remainingMs": 300000,
    "system": "宿主负责业务决策……",
    "messages": [
      {
        "role": "user",
        "content": "请处理工单 T-1001……"
      }
    ],
    "ticket": {
      "id": "T-1001",
      "subject": "退货后的退款多久到账",
      "customerMessage": "我已经把商品寄回去了……",
      "status": "open",
      "revision": 1,
      "tags": ["退款", "物流"],
      "draftReply": null
    },
    "tools": [],
    "recentObservations": []
  }
}
```

上面省略了 `runId` 的具体值和提示词/工具目录细节；真实返回包含完整内容。宿主必须根据实际 `request.tools` 决策，不要照抄示例工具名。

### 5.2 检索知识

用当前 `request.step` 作为 `expectedStep`：

```json
{
  "runId": "biz-......",
  "expectedStep": 1,
  "decision": {
    "thought": "客户询问退款时效，需要先查退货退款规则。",
    "call": {
      "name": "knowledge.search",
      "args": {
        "query": "退款 到账",
        "limit": 3
      }
    }
  }
}
```

返回 `kind="stepped"`，包含：

- `observation`：本次工具是否成功、输出、错误、结果是否确定。
- `request`：下一步请求，当前 `step` 增加到 2。
- `ticket`：动作后刷新的工单视图。

### 5.3 保存草稿

假设上一步返回的工单仍是 `revision=1`：

```json
{
  "runId": "biz-......",
  "expectedStep": 2,
  "decision": {
    "thought": "知识条目说明验收后 1 至 3 个工作日原路退回；保存草稿，不直接发送。",
    "call": {
      "name": "ticket.draftReply",
      "args": {
        "expectedRevision": 1,
        "text": "您好，仓库签收并验收后，退款会在 1 至 3 个工作日内原路退回。若超过 3 个工作日，请提供退货物流单号。"
      }
    }
  }
}
```

草稿写入成功后 revision 通常变为 2。后续写入必须使用新 revision。

### 5.4 结束

```json
{
  "runId": "biz-......",
  "expectedStep": 3,
  "decision": {
    "thought": "已依据知识条目保存回复草稿，未发送、未改状态，可以结束并交人工确认。",
    "call": {
      "name": "finish",
      "args": {
        "summary": "已保存退款时效回复草稿；未发送给客户，未修改工单状态，等待人工确认。"
      }
    }
  }
}
```

`finish` 只结束业务处理，不发送消息，不改变工单状态。

## 6. 工具权限矩阵

| 工具 | 效果 | 默认可见 | 默认行为 |
|---|---|---|---|
| `ticket.get` | `read` | 是 | 读取最新安全工单视图 |
| `knowledge.search` | `read` | 是 | 检索知识条目 |
| `ticket.draftReply` | `draft` | 是 | 保存回复草稿，不发送；revision +1 |
| `ticket.addNote` | `draft` | 是 | 添加内部备注，不发送；revision +1 |
| `ticket.setStatus` | `external` | 否 | 改工单状态；必须配置审批网关且 token 有效 |
| `finish` | `draft` | 是 | 结束会话，不做外部副作用 |

效果等级的业务含义：

- `read`：只读，可以自动执行。
- `draft`：可逆的业务内写入，例如草稿、内部备注；默认允许，但仍是审计对象。
- `external`：跨系统副作用，例如改状态、发消息、退款、下单；默认隐藏，必须审批。

这里把 `finish` 标为 `draft`，是因为它只结束本地会话，不会触发业务外部写入。

即使外部工具可见，模型在 `thought` 里写“用户已经同意”也不构成授权。唯一授权入口是审批服务签发并原子消费的 token。

## 7. Decision 与异常返回

Decision 固定形状：

```ts
interface Decision {
  thought: string;
  call: {
    name: string;
    args: Record<string, unknown>;
  };
}
```

`thought` 为 1..2000 字符，`call.name` 必须来自当前 `request.tools`，`call.args` 必须是对象。

`case_step` 有四种返回：

| `kind` | 含义 | 下一步 |
|---|---|---|
| `stepped` | 工具执行并完成审计 | 根据 observation 产生下一步 Decision |
| `repair_required` | Decision 或工具参数不合法，当前步未消耗 | 修正后使用同一个 `expectedStep` 重试 |
| `finished` | 已结束 | 读取 `result`，不要再提交动作 |
| JSON-RPC 错误 | 过期步号、拒绝、找不到 run 等 | 按错误码处理，必要时 `case_status` |

常见错误：

- `invalid_args`：未知工具、参数错误、未知字段，返回 `repair_required`，不烧步。
- `stale_step` / `-32602`：`expectedStep` 已过期；先用 `case_status` 看当前 request，不要盲目重放。
- `conflict`：工单 revision 已被别人修改；先 `ticket.get`，基于最新 revision 重做决定。该次冲突消耗一步。
- `denied`：审批不通过或审批服务不可用；发生在 `case_step` 内时返回 `observation.ok=false` 并消耗一步。
- `-32000`：顶层拒绝，例如 `case_start` 时活跃会话已达上限。
- `not_found` / `-32002`：工单或 run 不存在。
- 其他 runtime 错误通常映射为 `-32603`。

## 8. 安全执行语义

### 8.1 动作前审计是闸门

普通业务工具执行前先写 `decision_received`，只记录：

- 工具名。
- 参数规范化后的 SHA-256。
- thought 的 SHA-256。
- run、step、时间等元数据。

这次写入失败时，工具不会执行，调用返回 `audit_unavailable`，当前步不消耗。

### 8.2 动作后审计失败不能装作没发生

工具已经返回、工单已经刷新后，还要写 `action_completed`。如果这次审计失败：

- 停止原因改为 `audit_failed`。
- 状态为 `interrupted`。
- `outcomeCertain=false`。
- 不自动重试该动作。

这个区分很重要：“审计写不进去”不等于“业务写入没有发生”。

### 8.3 工具超时结果未知

runtime 向工具传递 `AbortSignal`。超过 `BUSINESS_AGENT_TOOL_TIMEOUT_MS` 后：

- 会话以 `tool_outcome_unknown` 停止。
- `outcomeCertain=false`。
- 不自动重试。

`AbortSignal` 是协作式取消。外部 SDK 如果不检查 signal，超时后仍可能继续完成退款、发消息等副作用。生产适配器必须支持取消或幂等，且对结果未知的动作先查业务系统，不能直接再执行一次。

### 8.4 并发与版本

- 同一个 run 的 `step` 与 `status` 进入 per-run Promise 队列，按序执行。
- 两个相同 `expectedStep` 的并发请求，只可能有一个成功执行，另一个得到过期错误。
- `expectedRevision` 由存储适配器在事务中检查，不能只在内存里先查后写。
- run 是内存状态；server 重启后 `case_status` 会找不到旧 run。已落盘证据仍在，但会话不可恢复。

## 9. 审计与数据保留

每个 run 默认产生：

```text
sandbox/business/<runId>/
├── audit.jsonl
└── result.json
```

`audit.jsonl` 记录 `run_started`、`decision_received`、`repair_required`、`action_completed`、`run_finished`。默认不记录原始 thought、原始参数或原始工具输出，只记录规范化哈希、UTF-8 字节数、耗时、错误码、revision、预算和停止原因。

`result.json` 保存局末结果，包含 `finishSummary` 与安全工单视图；工单视图可能包含客户消息、主题和回复草稿。它不等于“完全脱敏审计”，必须按业务数据设置保留期限、目录权限、加密和访问控制。

`result.json` 通过临时文件加 rename 原子替换。即使局末结果写入失败，返回中的 `resultWritten=false`、`status="interrupted"`、`stopReason="audit_failed"`，不会声称结果已安全落盘。

## 10. 扩展现有客服工具

编辑 `business/support-tools.ts`，在 `createSupportTools()` 返回数组中增加一个 `BusinessTool`。每个工具都要同时提供：

1. 对模型可见的名称、说明、`effect` 和 JSON Schema。
2. 对运行时执行的 `parse()` 与 `execute()`。
3. 如果可能产生外部副作用，标为 `external` 并提供 `approvalToken()`。

示例：增加一个只读“根据知识文档给出预估退款时效”的工具。

```ts
{
  name: 'refund.estimate',
  description: '从已检索知识中提取退款时效；找不到依据时返回 unavailable。',
  effect: 'read',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['knowledgeIds'],
    properties: {
      knowledgeIds: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: { type: 'string', minLength: 1, maxLength: 80 },
      },
    },
  },
  parse(raw) {
    const args = readObject(raw, ['knowledgeIds'], ['knowledgeIds'], 'refund.estimate');
    const ids = args['knowledgeIds'];
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 ||
        ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 80)) {
      throw new BusinessError('invalid_args', 'refund.estimate.knowledgeIds 必须是 1..5 个合法 id。');
    }
    return { knowledgeIds: [...ids] as string[] };
  },
  async execute(_input, context) {
    context.signal.throwIfAborted();
    return { unavailable: true, reason: '真实业务请接入退款规则服务，不要把示例逻辑当生产结论。' };
  },
}
```

这个示例故意不实现退款规则，因为它需要真实业务规则、数据权限和产品确认。不要用一段启发式文本冒充生产退款判断。

新增工具后补三类测试：

- 正确参数可执行，输出符合契约。
- 未知字段、错误类型、越界值返回 `invalid_args`，当前步不消耗。
- 外部工具在无审批、审批拒绝、token 重放时均 fail-closed。

## 11. 增加新的存储端口

现有端口：

```ts
interface TicketStore {
  get(ticketId: string, signal: AbortSignal): Promise<TicketRecord | undefined>;
  update(
    ticketId: string,
    expectedRevision: number,
    patch: TicketPatch,
    signal: AbortSignal,
  ): Promise<TicketRecord>;
}

interface KnowledgeStore {
  search(query: string, limit: number, signal: AbortSignal): Promise<KnowledgeDocument[]>;
}
```

替换为数据库或业务 API 时，遵守以下约束：

- `update()` 在一个事务中同时完成 revision 检查与写入。
- 受影响行数为 0 时，区分“工单不存在”和“revision 冲突”。
- 每条读写都带 tenant、actor、trace id 和权限过滤；不能只靠模型选择 `ticketId`。
- 凭据留在适配器或平台密钥管理中，runtime 不接触连接串。
- 超时映射为明确的 `BusinessError`；结果未知的外部写必须标为 `outcomeUnknown`。
- `AbortSignal` 应传给 HTTP 客户端、数据库驱动或可取消 SDK。
- `TicketRecord` 可以保留内部字段，但 `toTicketView()` 才是模型视图边界。

概念上的 SQL 约束：

```sql
UPDATE tickets
SET draft_reply = :draftReply, revision = revision + 1
WHERE id = :ticketId
  AND tenant_id = :tenantId
  AND revision = :expectedRevision;
```

生产代码还要处理字段白名单、状态机、审计事务、权限、重试策略与连接池。不能简单把示例 SQL 拼进服务。

装配时替换 `business/main.ts` 中的 `createDemoStores()`：

```ts
const stores = createProductionStoresFromPlatformConfig();
const runtime = new BusinessRuntime({
  ...stores,
  journalFactory: (runId) => new JsonlRunJournal(outDir, runId),
  approval: productionApprovalGateway,
  maxActiveRuns: 8,
  defaultMaxSteps: 12,
  defaultMaxWallMs: 300_000,
  toolTimeoutMs: 10_000,
});
```

## 12. 自定义工具注册表

示例客服工具由 runtime 默认创建。业务复杂后可以显式构造 `ToolRegistry`：

```ts
import { ToolRegistry } from './tools.ts';
import { createSupportTools } from './support-tools.ts';

const tools = new ToolRegistry(createSupportTools(tickets, knowledge));

tools.register({
  name: 'order.get',
  description: '读取当前工单关联的订单，只返回业务允许的字段。',
  effect: 'read',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['orderId'],
    properties: { orderId: { type: 'string', minLength: 1, maxLength: 80 } },
  },
  parse(raw) {
    const args = readObject(raw, ['orderId'], ['orderId'], 'order.get');
    return { orderId: readString(args, 'orderId', 1, 80, 'order.get') };
  },
  async execute(input, context) {
    context.signal.throwIfAborted();
    return orders.getForTicket(context.ticketId, input.orderId, context.signal);
  },
});

const runtime = new BusinessRuntime({
  tickets,
  knowledge,
  tools,
  journalFactory,
});
```

新增外部工具时，除 `effect: 'external'` 与 `approvalToken()` 外，还要保证审批服务校验的 args 与最终执行 args 是同一份已解析对象，避免“审批 A、执行 B”。

## 13. 实现生产审批网关

`ApprovalGateway` 是安全边界，不是模型提示词：

```ts
interface ApprovalGateway {
  authorizeAndConsume(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision>;
}
```

生产实现建议：

1. 审批服务签发随机、不可猜测、短时有效的一次性 token。
2. token 绑定 run、tenant、actor、工具名、规范化 args 哈希、目标资源与过期时间。
3. 在数据库事务或 Redis Lua 中原子消费；重放必须失败。
4. 校验操作者是否仍有权限、业务状态是否仍允许该动作。
5. 记录“谁批准了什么”，但不把 token 明文写入审计。
6. 审批服务不可用时 fail-closed，不能降级成自动允许。
7. 对退款、发消息等不可逆动作增加金额上限、双人审批或人工工作台。
8. 审批后到真正执行之间若业务 revision 变化，仍按 revision 冲突拒绝。

审批 token 不是长期 API key。模型只应获得当前动作所需的一次性 token，不能读取审批服务的管理员凭据。

## 14. 接入自己的模型循环

不经过 MCP 也可以直接使用 runtime：

```ts
const started = await runtime.start({ ticketId: 'T-1001' });
let current = started.request;

while (current.kind === 'business_request') {
  const decision = await hostBrain.decide({
    system: current.system,
    messages: current.messages,
    ticket: current.ticket,
    tools: current.tools,
    recentObservations: current.recentObservations,
  });

  const next = await runtime.step({
    runId: started.runId,
    expectedStep: current.step,
    decision,
  });

  if (next.kind === 'finished') break;
  if (next.kind === 'repair_required') {
    current = next.request;
    continue;
  }
  current = next.request;
}
```

这个循环只是把宿主协议接起来，不包含任何业务策略。`hostBrain.decide()` 必须来自真实模型或明确标识的测试替身；生产不能用 mock 冒充模型。fixture 测试可以注入脚本，但必须放在 `test`/`sandbox`，不能绕过真实运行闸门。

## 15. 环境变量

| 变量 | 默认值 | 范围 | 用途 |
|---|---:|---:|---|
| `BUSINESS_AGENT_OUT` | `sandbox/business` | 专用目录 | 审计与局末结果输出根 |
| `BUSINESS_AGENT_MAX_ACTIVE` | `8` | 1..64 | 活跃会话上限 |
| `BUSINESS_AGENT_MAX_STEPS` | `12` | 1..50 | 默认步数预算 |
| `BUSINESS_AGENT_MAX_WALL_MS` | `300000` | 1000..900000 | 默认整局墙钟预算 |
| `BUSINESS_AGENT_TOOL_TIMEOUT_MS` | `10000` | 50..120000 | 单工具超时 |

`case_start` 可以为单局覆盖 `maxSteps` 与 `maxWallMs`，但不能超过协议上限。停止后 run 从活跃计数中释放。

## 16. 生产化 checklist

在上线真实业务前，至少完成以下事项：

### 身份、权限与审批

- [ ] MCP/服务入口有真实用户鉴权，不允许匿名提交 Decision。
- [ ] tenant/actor 由可信上下文注入，不能由模型参数决定。
- [ ] 每个存储方法都做行级权限过滤。
- [ ] 外部工具默认关闭，按业务逐项开启。
- [ ] 审批 token 原子消费、绑定动作与资源、支持过期和撤销。
- [ ] 退款、发货、发消息等动作有金额/频率上限与人工兜底。

### 会话、幂等与故障

- [ ] 将 run 持久化，或明确接受重启后会话丢失。
- [ ] 多进程部署使用共享会话存储和分布式锁，不能继续依赖单进程 Promise 队列。
- [ ] 外部写入有业务幂等键；结果未知时先查询，不盲目重试。
- [ ] 外部适配器真正响应 `AbortSignal`，或实现可查询的取消协议。
- [ ] 动作前/动作后审计失败都有告警和值守流程。
- [ ] 对“已执行但审计失败”“超时但可能执行”设计人工核对入口。

### 数据与可观测性

- [ ] 工单、知识、审批、审计设置保留期限、加密、备份和访问审计。
- [ ] 对 `result.json` 中的客户数据做权限与 PII 保护。
- [ ] 指标覆盖成功率、repair 率、冲突率、审批拒绝、超时、停止原因和工具耗时。
- [ ] 日志关联 runId/traceId，但不记录 token、密钥或不必要的原始客户内容。
- [ ] 业务知识检索有来源、版本、时效和权限；过期规则不能直接用于客户承诺。

### 部署与验证

- [ ] 固定 Node 版本与制品哈希，部署前跑 `verify:business` 和全量回归。
- [ ] 由平台注入密钥，不提交 `.env`、连接串、token 或凭据文件。
- [ ] 给 server 独立输出卷、磁盘配额、内存/CPU 限额和只读根文件系统。
- [ ] stdio 进程的 stderr 接入集中日志；stdout 只保留 JSON-RPC。
- [ ] 用真实模型做业务评测，记录任务成功率、错误率与人工修正，不把 fixture 当能力证据。
- [ ] 对模型提示注入、越权工具调用、伪造审批和知识库不可信内容做对抗测试。

## 17. 验证记录与尚未验证项

2026-11-25 本机执行：

```text
npm run test:business   12/12 通过
npm run business:smoke  通过，2 个完整动作
```

业务测试覆盖：

- 默认安全视图与外部工具隐藏。
- 未知工具/坏参数 repair，不消耗步数。
- 同一 expectedStep 并发防重。
- 草稿、备注、finish 与审计不落原文。
- revision 冲突。
- max_steps 与 wall_clock 停止。
- 外部写入默认拒绝与 token 一次性消费。
- 工具超时结果未知且不自动重试。
- 动作前审计失败不执行。
- 动作后审计失败标记 interrupted。
- 活跃会话上限与收手释放。
- 真实 MCP stdio 目录、订阅、start/step/status/finish。

当前环境没有 `tsc` 可执行文件，且本仓库保持零依赖、未安装 TypeScript，因此尚未完成独立 `tsc --noEmit` 类型检查。Node 原生运行与测试通过不能替代这项检查。

生产数据库、真实审批网关、鉴权、租户隔离、持久会话恢复和真实模型业务效果均尚未实现或验证。
