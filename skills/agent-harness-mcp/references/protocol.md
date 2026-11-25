# agent-harness MCP 参考

## 能力与传输

Server：`agent-harness`，入口 `src/mcp.ts`，stdio 一行一个 JSON-RPC 消息。现代协议版本为 `2026-07-28`，同时兼容 legacy `initialize` 的 `2025-11-25`、`2025-06-18`、`2024-11-05`。能力只有 tools、resources、prompts；不声明 sampling，也不启动任何模型。

现代 client request 的 `params._meta` 必须含：

- `io.modelcontextprotocol/protocolVersion`
- `io.modelcontextprotocol/clientCapabilities`

`server/discover` 返回 `resultType: "complete"`。legacy 初始化后发 `notifications/initialized`，legacy result 不含 `resultType`。

现代客户端可调用 `subscriptions/listen`。server 先发送 `notifications/subscriptions/acknowledged`，其中 `params._meta["io.modelcontextprotocol/subscriptionId"]` 等于原 JSON-RPC 请求 id；本量具目录静态，接受的过滤器是 `{}`。订阅流保持打开，普通 tools/resources/prompts 请求仍可处理；`notifications/cancelled` 或 stdin EOF 时返回该订阅的完成结果。

modern 的可缓存结果必须带 `ttlMs` 与 `cacheScope`。本量具按 run 隔离，tools/list、prompts/list、resources/list、resources/templates/list、resources/read 均返回 `ttlMs:0`、`cacheScope:"private"`；legacy 结果不添加这两个字段。tools/call 与 prompts/get 不是目录缓存结果，也不添加。

宿主 MCP 客户端通常已封装这些细节；手写客户端或排查“目录为空 / schema 拒绝 / -32601”时才直接处理。

## 工具

### harness_start

入参：`seed`（0..4294967295，默认 6）、`max_steps`（1..200，默认 40）、`max_wall_ms`（1000..900000，默认 300000）。

成功返回：

- `kind: "started"`
- `run_id`：`mcp-<UUIDv4>`
- `step`：当前待决策步号
- `max_steps`、`stopped`
- `request`：宿主决策所需的完整契约

### harness_step

入参：`run_id`、`expected_step`、`decision`。

`decision` 必填 `thought` 与 `call`；`call` 必填 `name`、`args`。可选 `predict`、`surprise`、`testing`。所有工具调用必须来自 `request.tools`，参数遵守该工具 schema。

返回：

- `kind: "stepped"`：`observation` 含 `step`、`tool`、`ok`、`output`，可有 `error`、`prediction`；`request` 是下一步请求。
- `kind: "repair_required"`：决策解析失败，当前步未消耗；用同一个 `expected_step` 重试。
- `kind: "finished"`：正常收手或预算/循环停止；带完整局末结果。
- `kind: "brain_failed"`：解析回炉耗尽；仍带完整局末结果。
- `-32602`：参数或 `expected_step` 过期；先读状态。
- `-32000`：进行中的局数达到启动上限。
- `-32002`：当前输出根下找不到 run。

同一 run 的 step/status 串行执行；相同 `expected_step` 的并发提交只有一条可成功。

### harness_status

入参：`run_id`。进行中返回 `step`、`next_step`、`max_steps`、`stopped: false`、`request`，不返回裁判侧字段。停止后返回 `stop_reason` 与 `result`。

## 资源与提示

- `resources/list`：固定返回空数组 `resources:[]`；本量具没有无需 run_id 的固定资源。
- `resources/templates/list`：返回 `harness://run/{run_id}/agent-view`。
- `harness://run/{run_id}/agent-view`：玩家侧屏幕与当前 `request`；停止后转为局末结果。
- prompt `arena-play`：宿主 start → 读 request → step 的工作流。

进行中禁止出现 mutant id、被删能力、内部状态、coverage 或 detection。局末结果才包含 notary、detection、ear、证据文件路径等裁判信息。

## 启动环境

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `AGENT_HARNESS_MCP_OUT` | `<repo>/sandbox/mcp` | 唯一输出根，必须专用 |
| `AGENT_HARNESS_MCP_MAX_ACTIVE` | `8` | 进行中的局数上限，1..64 |
| `AGENT_HARNESS_MCP_MAX_STEPS` | `40` | 每局默认步数上限，1..200 |
| `AGENT_HARNESS_MCP_MAX_WALL_MS` | `300000` | 每局默认墙钟上限，1000..900000 |
| `AGENT_HARNESS_MCP_MUTANT` | 参考版 | 操作者设置的世界层变异体 id |
| `AGENT_HARNESS_MCP_SOUND_MUTANT` | `R0` | 操作者设置的声音层变异体 id |
| `AGENT_HARNESS_MCP_PREDICT` | `true` | 是否启用预测接缝 |
| `AGENT_HARNESS_MCP_GOAL` | `true` | 是否启用目标接缝 |
| `AGENT_HARNESS_MCP_EAR` | `true` | 是否注册 listen 工具 |
| `AGENT_HARNESS_MCP_PROVENANCE` | `real` | 仅显式 `fixture` 时标为夹具 |

输出根不能是仓库根、`runs/`、`src/`、`test/`、`verify/` 或文件系统根。工具参数不能覆盖输出根或选择变异体。

## 恢复与证据

每步原子写入 v2 `mcp-checkpoint.json`，保存 revision、pending、`currentStep`、`initialWorldHash` 与引擎状态。执行动作前先写 `inFlight`；重启时仍有 `inFlight` 的局停止为 `interrupted`，不重复执行。恢复用 seed 与成功世界动作重建会话，逐帧核对初始哈希和每个 StepRecord 的 stateHash，不只核末态；trace append，不重写 header，也不重复恢复前的板子事件。解析失败原文与错误进入 trace 的 `parse_failure` 事件，公开结果给 `parse_failures`。

同一输出根用 `.mcp-start.lock` 和每 run 的 `.mcp-lock.json` 做跨进程互斥；step/status/resource 在锁内刷新磁盘状态。锁只按 owner 释放，死者持有的锁 **fail-closed**，不会自动删除。收到锁错误时先核对 pid；确认无活动进程后，操作者可显式删除对应锁文件。该机制只保护共享同一本地文件系统的进程，不是跨主机分布式锁。

局末共用 CLI 的 finalizer，产出 `world.jsonl`、`coverage.json`、`defect.json`、`detection.json`，启用耳朵时另有 `sound.jsonl`、`ear.json`。`evidence_consistent` 与 `replay_matches_live_session` 是证据一致性闸门；`interrupted` 局强制为 false，并在 result/notary/detection/ear/defect 写 `certified:false`，不能把其中的检出或公证数值当成已认证结论。不要手工改写这些文件。
