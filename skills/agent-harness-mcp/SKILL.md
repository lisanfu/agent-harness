---
name: agent-harness-mcp
description: 通过 agent-harness MCP server 分步试玩并收集可重放证据。适用于用户要求接入 harness_start / harness_step / harness_status、让当前宿主直接充当游戏 agent 大脑、配置 Qoder MCP、或排查 MCP 步号/恢复/输出根/预算问题。server 不调用模型，也不接受 mock 代替宿主决策。
---

# 用宿主大脑驱动 agent-harness

## 职责边界

宿主负责观察、决策、留痕和收手；server 负责执行、客观核对、停止条件与局末证据。不要把整串动作提前交给 server，也不要用脚本、mock 或预置策略替代当前宿主的真实决策。

`request` 是玩家侧契约。进行中只依据 `request.system`、`request.tools`、`request.messages`、屏幕、笔记、假设、目标和上一步 `observation` 决策。不要读取、推断或索要 mutant、内部状态、coverage、detection；这些只在停止后交给人复盘。

## 接入前检查

1. 确认 MCP 目录包含 `harness_start`、`harness_step`、`harness_status`。若宿主支持 prompt，可读取 `arena-play`。
2. 确认 Node 版本满足 `>=22.18`。不要安装依赖；仓库保持零依赖。
3. 将 `AGENT_HARNESS_MCP_OUT` 指向专用临时目录。禁止仓库根、`runs/`、`src/`、`test/`、`verify/` 或文件系统根。
4. 需要冒烟时使用 `AGENT_HARNESS_MCP_PROVENANCE=fixture`；fixture 只证明接线，不是模型能力证据。真实宿主试玩保持默认 `real`。
5.  mutant 与 soundMutant 只能由 server 启动环境配置，不由模型工具参数指定。

通用 MCP 配置形状：

```json
{
  "mcpServers": {
    "agent-harness": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/agent-harness/src/mcp.ts"],
      "env": {
        "AGENT_HARNESS_MCP_OUT": "/absolute/dedicated/mcp-output",
        "AGENT_HARNESS_MCP_MAX_ACTIVE": "8",
        "AGENT_HARNESS_MCP_MAX_STEPS": "40",
        "AGENT_HARNESS_MCP_MAX_WALL_MS": "300000"
      }
    }
  }
}
```

## 分步协议

1. 调 `harness_start`，可给 `seed`、`max_steps`、`max_wall_ms`。保存返回的 `run_id`；完整阅读 `request`。
2. 根据当前 `request` 产生一个 `Decision`，以 `request.step` 作为 `expected_step` 调 `harness_step`。
3. 阅读 `observation.output`、`observation.prediction` 和下一步 `request`，再产生下一条决策。
4. 需要留痕时使用 `request.tools` 中的 `note`；需要目标时使用 `goal`。是否验证、如何验证由宿主判断。
5. 证据足够、任务完成或无法推进时，提交 `call.name="finish"` 的 Decision。停止后读取完整结果与证据路径。

Decision 形状：

```json
{
  "thought": "宿主对当前画面的判断与行动理由",
  "call": { "name": "move", "args": { "dir": "right" } },
  "predict": { "playerAt": [1, 0], "hpDelta": 0 },
  "surprise": { "unexpected": false, "why": "与当前预期一致" },
  "testing": { "id": "H1", "field": "playerAt" }
}
```

`predict`、`surprise`、`testing` 按当前请求契约选用；工具名和参数必须来自 `request.tools`。不要自创世界工具。

## 异常处理

- `repair_required`：当前步未消耗。按 `repair` 修正 Decision，保持同一个 `expected_step` 重试。
- `-32602` 且提示步号过期：调 `harness_status` 获取当前 `next_step`，不要盲目重放旧决策。
- 进行中局数达上限：先收手已有局，或等其预算停止。
- `wall_clock` / `max_steps` / `loop_detected`：server 已完成局末收尾；把结果作为该次运行的真实结局，不改写停止原因。
- 重启后找不到 run：确认新旧 server 使用同一个 `AGENT_HARNESS_MCP_OUT`。run id 是显式 handle，不依赖旧连接。
- `checkpoint` / `replayed state hash mismatch`：停止使用该局，保留现场；不要手改 checkpoint 或证据来“修好”它。
- `interrupted`：动作执行前已预写，但进程中断，无法证明是否执行完。不要重试该动作；`evidence_consistent=false`，裁判侧会写 `certified:false`，这些数值不能作为认证结果引用。
- 文件锁 `-32000`：先用 `ps` 核对锁内 pid 是否仍存活。死者锁不会自动删除；确认没有活动 server 后，由操作者显式删除对应 `.mcp-lock.json` 或 `.mcp-start.lock`，不要正在运行时清理。
- 现代宿主工具目录为空：检查 connector 日志中的 `resources/list` / `subscriptions/listen` 是否为 -32601，或目录结果是否因缺 `ttlMs` / `cacheScope` 被 schema 拒绝。确认加载的是更新后的 server，再重启 connector；不要用脚本代替宿主决策。
- 三工具都返回 -32603：检查启动 stderr 与完整业务路由，不要只验证 JSON-RPC ping；真实 start/step/status 都必须走通。
- server 无响应：检查启动 stderr 与 Node 路径。stdout 只能出现 MCP JSON-RPC，日志不应混入。

## 验证

在仓库根运行：

```bash
npm run verify:mcp
```

该命令运行真实 stdio 协议/会话测试和 Skill 自带的 fixture 冒烟。临时证据写入系统临时目录并自动清理，不污染 `runs/`。若 Skill 被复制到仓库外，先设置 `AGENT_HARNESS_ROOT=/absolute/path/to/agent-harness`。

需要完整字段、协议版本或环境变量表时读取 [references/protocol.md](references/protocol.md)。
