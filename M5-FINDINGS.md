# M5 分发：MCP server + Skill

## 1. 成立性问题与边界

M5 要解决的不是“再做一个会玩游戏的 agent”，而是：**已有量具能不能插进 Qoder、Claude Code、Codex 等宿主，让宿主现成的大脑直接驱动，同时不复制第二套状态机、不泄露裁判信息？**

本轮冻结的职责边界：

- **大脑归宿主**：宿主读取请求、观察屏幕与声音、产生 Decision、决定何时收手。
- **判据归量具**：共享引擎负责执行、预测对照、目标判定、假设归因、停止条件、trace 与局末证据。
- **server 不启动模型**：不创建 CLI brain，不提供 mock 逃生路径，不声明 sampling。
- **进行中只给玩家侧事实**：mutant、内部状态、coverage、detection 只在停止后交给人复盘。
- **不提前提交整串动作**：MCP 的每一步都必须由宿主根据上一帧结果重新决策，否则只是把 CLI 剧本换了个外壳。

## 2. 先注册再计数：验收判据

实现与测试开始前先冻结以下判据；本轮只按这些项目报成立，不临时扩大结论。

| 编号 | 判据 | 验证方式 |
| --- | --- | --- |
| A1 | 一个状态机供 CLI 与 MCP 共用 | 共享装配/finalizer 对账；六份证据逐字节相同 |
| A2 | server 内没有第二个大脑 | 目录不含 sampling；源码禁止 `.decide()`、brain 工厂、模型 SDK；真 stdio Fixture 只由测试客户端提交决策 |
| A3 | 现代与 legacy MCP 都能完成发现与调用 | `server/discover` + `initialize` 真子进程测试 |
| A4 | 宿主能 start → step → finish | 真 stdio 工具调用，完整局末证据存在 |
| A5 | 进行中零裁判泄漏 | 对 start、step、status、resource 的 JSON 文本查 mutant/内部字段/coverage/detection |
| A6 | 过期步与并发重复步不能重复执行 | 同 `expected_step` 并发两请求：一次成功、一次 -32602，trace 只多一步；进程内恢复与双进程文件锁都防重 |
| A7 | 坏决策回炉不烧步；耗尽后失败类型不丢 | `repair_required` 保持步号；三次坏决策后 `kind=brain_failed` 且证据齐全；原文/错误进 trace |
| A8 | 所有停止路径都收尾且认证状态诚实 | finish、max_steps、wall_clock、loop_detected、brain_failed 有结果；inFlight 崩溃为 interrupted，不重试且 `certified:false` |
| A9 | 恢复不重复、不串局 | seed + 成功动作重放；初始与逐帧哈希核对；trace append；header 与旧 trace 前缀不变 |
| A10 | 输出根由操作者控制 | 工具 schema 不含 outDir/mutant；真实入口拒绝仓库根、runs、源码目录与文件系统根 |
| A11 | 并发与预算有上限 | 同 run 串行；maxActiveRuns、maxSteps、maxWallMs 真跑触发 |
| A12 | Skill 是工作流，不是策略手册 | 只教宿主读契约、提交决策、处理回炉与恢复；fixture 冒烟明确不是模型证据 |

## 3. 分步实现

### Step 1：把不可暂停循环抽成共享引擎

新增 `src/engine.ts`。`prepare()` 生成 `DecideRequest`，`execute(decision)` 执行一条宿主决策，`checkpoint()` 交出可持久化状态。CLI 的 `src/loop.ts` 只负责调用 `brain.decide()` 与解析回炉，不再拥有第二份执行/记账逻辑。

`checkBudget()` 与 `prepare()` 分开：MCP 的待决策请求可能已经存在，预算检查不能只发生在“生成请求”时。

### Step 2：共用世界装配与局末收尾

`src/world/harness.ts` 拆成 `createArenaWorld()` 与 `finalizeArenaWorld()`。CLI 连续跑与 MCP 分步跑使用同一套工具、接缝、公证、最小化、detection、coverage、defect、sound 与 ear 逻辑。

### Step 3：MCP 传输与目录

- `src/mcp/protocol.ts`：stdio JSON-RPC、现代 `2026-07-28`、legacy `initialize`、发现、ping、错误信封。
- `src/mcp/catalog.ts`：三个工具、一个 resource template、一个 prompt。
- `src/mcp/server.ts`：tools/resources/prompts 路由。
- `src/mcp.ts`：唯一进程入口；stdout 只走协议，启动错误只走 stderr。

### Step 4：显式 handle 与分步会话

`harness_start` 返回随机 `mcp-<UUIDv4>`。`harness_step` 必须带 `run_id`、`expected_step`、`decision`。`harness_status` 与 `harness://run/{run_id}/agent-view` 返回同一份安全请求。

决策解析复用 CLI 的 `parseDecision()`。解析失败追加修复提示但不推进步数；超过回炉上限后停止并完整收尾。

### Step 5：恢复、并发与安全

- 每个 run 一条 Promise 队列；`expected_step` 拒绝过期与重复提交。加载中的恢复也用 `Map<runId, Promise<SessionEntry>>` 合并。
- 同一本地输出根增加 `.mcp-start.lock` 与每 run 的 `.mcp-lock.json`；每次 step/status/resource 在锁内重读磁盘 checkpoint，跨进程也不能各自执行同一个动作。锁只按 owner 释放。
- 每步原子写 v2 `mcp-checkpoint.json`，同时保存 revision、pending、当前回炉步号与 initialWorldHash。
- **动作执行前先持久化 `inFlight`。** 崩溃后若仍有 `inFlight`，恢复为 `interrupted`，不重复执行，并保留现场。
- 重启后以 seed + 成功世界动作重建会话；初始世界哈希与每一步结束的 stateHash 都逐帧核对，不只核末态。
- 中断局的 evidence/replay/screens 一致性强制为 false，result/notary/detection/ear/defect 明确写 `certified:false`。
- 解析失败把原始 decision 与错误写进 trace 的 `parse_failure` 事件；RunResult 与公开结果给 `parse_failures`。
- 活跃局上限只数磁盘 checkpoint 中未 finalized 的局，不信任旧 manager 的内存。
- trace 使用 append；header 不重写；历史板子恢复不再次触发 `onWrite` 计数。
- 输出根只来自 `AGENT_HARNESS_MCP_OUT` 或 server 默认 sandbox；工具不能覆盖。max steps、wall time、active runs 都有启动/调用边界。
- 文件锁的持有者已死时 **fail-closed**，不自动删锁；操作者确认没有活动进程后才可显式清理。它不是跨主机分布式锁。

### Step 6：Skill 分发

`skills/agent-harness-mcp/` 包含：

- `SKILL.md`：宿主工作流、配置形状、安全边界、异常处理。
- `references/protocol.md`：工具、资源、环境变量与恢复细节。
- `scripts/smoke.mjs`：真 stdio fixture 冒烟，临时目录自动清理。

`npm run verify:mcp` 将 MCP 测试与 Skill 冒烟串成一条命令。

## 4. 本轮真实故障

| 编号 | 现象 | 根因 | 修法与归纳 |
| --- | --- | --- | --- |
| #47 | start 返回随机 handle，随后写 trace 报 ENOENT | handle 与引擎目录用了两套 id | 创建/恢复引擎时显式注入同一个 runId；**身份必须只有一个生产者** |
| #48 | 重启恢复报状态哈希不匹配 | 把 `StepRecord[]` 直接传给需要 `{name,args}[]` 的动作翻译器，重放动作为空 | 先过滤成功世界工具，再 map 出 call；**重放输入必须与真实执行输入同形** |
| #49 | 恢复后 trace 多出重复 hypothesis_board | status 恢复时再次 prepare，pending 未持久化 | checkpoint 保存 pending；恢复直接复用；**待决策请求是状态，不是可随时重算的视图** |
| #50 | 解析回炉耗尽返回 `finished` | `{kind:'brain_failed', ...publicFinalResult}` 被后者 `kind:'finished'` 覆盖 | 调整展开顺序并加断言；** discriminated union 的标签不能被通用对象覆盖** |
| #51 | 墙钟到点后 status 仍报进行中 | status 只在没有 pending 时 prepare，已有 pending 绕过预算检查 | 抽出无副作用的 `checkBudget()`，step/status/resource 都检查；**长寿命 pending 必须重新过停止条件** |
| #52 | Skill 冒烟找不到 server 入口 | 脚本按 skill 目录向上两级，实际仓库根高三级 | 改为相对 skill 脚本定位仓库根，并保留 `AGENT_HARNESS_ROOT` 显式覆盖；**脚本也要真跑，路径假设不是文档** |
| #53 | 重启后同 run 两个并发请求都成功，trace 多出两步 | 恢复重放 await 时 entry 还没进 map，两个请求各自装配世界、各自绕过串行队列 | 用 loading Promise map 合并恢复中的请求；**加载中的对象也必须已有共享身份** |
| #54 | 动作已执行、trace 已追加，但 checkpoint 未保存时崩溃，重试会重复执行 | 崩溃窗口没有持久化的执行意图 | 执行前先写 `inFlight`；恢复见到它就停止为 `interrupted`；**无法证明执行完成的动作不许重放** |
| #55 | 两个 server 进程共享输出根时，同一 expected_step 两条都成功 | Promise 队列只保护单进程 | 根 start 锁 + 每 run 文件锁 + 锁内磁盘刷新；双 stdio 进程真红 2 fulfilled，修后 1 fulfilled + 1 rejected |
| #56 | 只核末态会漏掉零步初始哈希与中间帧篡改 | 恢复校验没有覆盖每个状态边界 | 保存 initialWorldHash，逐步重放并核对每个 stateHash；**重放要证每一步，不只证终点** |
| #57 | 重启释放内存名额；另一进程收手后旧 manager 仍误拒 | 活跃局上限信任进程内 entries | 只数磁盘 checkpoint 中未 finalized 的局；**跨进程容量的事实源是磁盘** |
| #58 | 解析回炉耗尽只剩次数，坏决策原文与错误不在 trace | 计数与无损证据混为一谈 | `noteParseFailure()` 写原始 input/error，RunResult/public result 增加 `parse_failures`；**汇总数不能替代原文** |
| #59 | 多个等待者回收死者锁时，可能删掉刚创建的新锁 | 自动 unlink 与 owner 校验之间仍有竞态 | 取消自动删锁，-32000 fail-closed，操作者确认后手动清理；**宁可拒绝，不可冒险恢复** |
| #60 | repair pending 重启后请求从第 2 步退回第 1 步 | checkpoint 只存已执行步数，未存 currentStep | checkpoint 保存 currentStep，新增 `engine.resume()` 静默重建上下文；**待决策步号也是状态** |
| #61 | interrupted 局 consistency=false，但 notary/detection/ear 的 true 字段仍像已认证 | 只降级总闸门，没有显式标记各裁判输出未认证 | replay/screens 强制 false，result/notary/detection/ear/defect 写 `certified:false`；**未认证必须逐出口出声** |

每条故障均有对应回归；共同归纳是：**会话恢复不是序列化一个对象，而是恢复“对象 + 待处理消息 + 外部世界 + 时间预算”四个一致性面；跨进程与崩溃窗口还必须补上磁盘事实源、先写执行意图和明确的未认证出口。**

## 5. 已验证与未证明

已验证：共享 CLI/MCP 装配及六份证据逐字节一致；现代/legacy 真 stdio；分步调用与局末证据；进行中零泄漏；进程内与双进程并发防重；回炉及失败原文留痕；步数/墙钟/磁盘活跃局上限；初始与逐帧哈希恢复校验；inFlight 预写先于执行；崩溃局不重复动作且 `certified:false`；repair pending 跨重启保持步号；死者锁 fail-closed；输出根真实入口守卫；Skill 结构及仓库内/仓库外 fixture 冒烟。最终 `npm test` 590 例、MCP 三文件 32 例、Skill 冒烟均通过，`npm run verify:docs` 与证据审计通过；`runs/` 保持 45 项 / 291 个文件、无新增 ear.json。

未证明：

- **没有真实 Qoder/Claude Code/Codex 客户端注册与长局试玩记录**。本轮证明的是协议、状态机与宿主工作流可接入，不是这些宿主产品的兼容性认证。
- **没有新的模型能力结论**。Fixture 决策由测试客户端提供，不是模型行为证据，不进入 `runs/`。
- 当前墙钟只约束 server 生命周期，不能精确计算宿主模型思考耗时；MCP trace 的 `brainMs` 如实为 0。
- 文件锁只保护共享同一本地输出根的进程，不是跨主机分布式锁；死锁 fail-closed，需操作者确认后手动清理。
- 单进程 stdio 不是多租户服务；输出根与并发上限是资源保护，不替代 OS 级隔离。

## 6. 复核入口

```bash
npm run verify:mcp
npm run verify:docs
```

M5 不写已发布的 `runs/`。需要真实宿主试玩时，由操作者配置专用输出根与客户端；产物默认落在 gitignored `sandbox/mcp/`。
