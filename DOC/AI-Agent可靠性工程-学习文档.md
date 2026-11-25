# AI Agent 可靠性工程学习文档

> 配套书籍：《AI Agent避坑实战：让智能体少犯错、不失控、靠谱干活》<br>
> 作者：吴岸城<br>
> 工程案例：agent-harness<br>
> 整理日期：2026 年 11 月 25 日

## 1. 这份文档怎么用

这份文档把一本书和一个仓库接起来：书负责提出问题，仓库负责给出可运行的工程回答。它不是全书复述，也不是 API 手册，而是一套“概念 → 代码 → 失败 → 修复 → 证据”的学习路径。

配套阅读：[《AI Agent避坑实战》内容总结](./AI-Agent避坑实战-内容总结.md)。内容总结覆盖官方目录中的 54 个小节；本文不再重复目录，而是专注“这些思想怎样落在我们的工程里”。

### 1.1 三种读法

**第一遍：建立地图。** 读第 2—4 节，弄清 Agent 最小闭环、harness 职责、代码入口和信息边界。

**第二遍：按失败学习。** 从第 5 节选择一个单元，先跑测试，再故意制造对应故障，最后阅读回归测试和故障台账。不要从“读完所有理论”开始。

**第三遍：做 capstone。** 按第 9—10 节给一个小工具补上状态、恢复、幂等、trace 和验收，形成自己的可复用资产。

### 1.2 学习单位不是章节，而是可复现失败

每个学习单元都回答五个问题：

1. 书中的问题是什么？
2. 我们的代码怎样处理它？
3. 怎样让这个故障真的发生？
4. 修复后用什么证据证明？
5. 这个方案不适用于什么边界？

一条故障记录推荐格式：

```text
现象 → 最小复现 → 根因 → 修法 → 回归测试 → 归纳 → 仍未证明的边界
```

### 1.3 证据层级

不要把下列证据混为一谈：

| 证据类型 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| 单元测试 | 某个函数在给定输入下满足契约 | 整个系统在生产环境可靠 |
| fixture 冒烟 | 协议、接线和状态机可用 | 模型能力 |
| 确定性重放 | 同一 seed 与动作序列可复现 | 模型每次都会选择同样动作 |
| 真模型运行 | 某一批次模型行为 | 所有模型、所有任务都可靠 |
| 独立审计 | 独立入口重算，不直接信任判决结果 | 判据本身永远正确 |
| 干净克隆验证 | 已提交内容可独立运行 | 未提交工作树已经发布 |

### 1.4 当前工程状态

本文应用篇对应本地 M5 工作树。2026-11-25 收尾时已经实跑：

- `npm test`：591/591。
- `npm run verify:mcp`：33/33，并通过 Skill fixture 真 stdio 冒烟。
- `npm run verify:docs`：68 条故障台账与 68 条自测清单一致。该脚本核的是 README、HAND-CODING、KNOWLEDGE 等既有文档与磁盘事实，不核本文中的 591/33 等数字；本文的命令、路径、链接和结构另行校验。
- 真实 Qoder：一局 11 步 `wall_clock`，一局 3 步主动 `finish`；两局独立 replay 分别为 9/9、2/2 帧一致，预测审计总计 0 处不一致。

M5 主体已经由提交 `34f3e10` 推送；本轮 Qoder 现代订阅/缓存与真实入口接线修复已纳入后续仓库提交。真实证据留在 gitignored `sandbox/mcp-qoder/`，不夹带进入已发布 `runs/`。

## 2. 环境与学习纪律

### 2.1 本机环境

```bash
export PATH="$HOME/.local/node-22/bin:$PATH"
cd /home/fuyuan/Documents/workspace/agent-harness
node --version
npm --version
```

当前实测 Node 为 `v22.23.4`。仓库要求 Node `>=22.18`，使用原生 TypeScript 类型擦除，零依赖，不需要 `npm install`。

### 2.2 四条纪律

1. **大脑必须是真的。** mock 和 fixture 只能验证接线，不能作为模型能力证据。
2. **决策不能写死。** 不用启发式策略替代 LLM；代码负责世界、约束、状态和裁判。
3. **证据不能污染。** 已发布的 `runs/` 不回填、不改写；实验产物放 gitignored `sandbox/` 或 `/tmp`。
4. **未知不能伪装成功。** 无法证明动作是否执行、证据是否完整时，必须停止或标记未认证。

### 2.3 前端工程师的四个类比

| Agent 概念 | 前端类比 | 关键区别 |
| --- | --- | --- |
| 模型输出 | 用户输入或远端 API 响应 | 输入天然不可信，不能直接 `eval` 或执行 |
| 工具调用 | dispatch action / 调后端接口 | 可能有真实副作用，失败不能简单重发 |
| checkpoint | 持久化 store + 操作日志 | 还要恢复外部世界，不只是本地 state |
| trace | Redux DevTools / rrweb | 不只记录 UI，还要记录模型当时看见什么 |
| 权限门 | 服务端鉴权 + 参数校验 | 不能把安全寄托在 Prompt 文案上 |
| 独立裁判 | E2E 断言只读渲染结果 | 不读组件内部 store，也不信组件自报成功 |

## 3. 核心心智模型：大脑、量具、世界、证据

### 3.1 一张架构图

```text
用户目标
   │
   ▼
宿主大脑 / CLI brain
   │  Decision
   ▼
HarnessEngine ───────► 工具执行器 ───────► 世界
   │                      │                  │
   │                      ▼                  ▼
   │                 ToolResult ◄──────── Observation
   │
   ├──► Trace / Checkpoint / Budget / Stop
   │
   ▼
局末 Finalizer
   ├──► 公证 / 最小化 / 检出 / 眼耳对账
   └──► 证据文件 / 公开结果
```

最重要的分工是：

- **大脑决定下一步。**
- **量具决定这一步是否合法、是否执行、是否停止、结果是否可信。**
- **世界提供观察，不提供答案。**
- **证据让第三方能够复核，而不是相信 Agent 的自述。**

### 3.2 为什么 server 里不能再放一个模型

如果 MCP server 自己调用模型，就同时出现两个决策中心：宿主看到一个状态，server 内部另一个模型看到另一个状态，两边可能重复执行、目标漂移，也无法解释“到底谁做的决定”。

我们的 MCP 边界是：server 不声明 sampling，不创建 CLI brain，不调用模型 SDK；宿主提交 `Decision`，server 只负责确定性执行与记账。

### 3.3 玩家视图与裁判视图

| 信息 | 进行中 | 局末 |
| --- | --- | --- |
| 屏幕、声音、工具契约 | 可见 | 可见 |
| 上一步 observation | 可见 | 可见 |
| note、hypothesis、goal | 可见 | 可见 |
| mutant、被删能力 | 不可见 | 可复盘 |
| 内部状态、coverage | 不可见 | 可复盘 |
| notary、detection、ear | 不可见 | 可复盘 |
| `certified:false` | 停止后明确出现 | 必须保留 |

眼睛不准读心。进行中的 Agent 只能根据玩家侧事实决策，不能通过调试接口偷看裁判答案。

## 4. 代码地图

### 4.1 既有核心

| 路径 | 核心符号 | 学习重点 |
| --- | --- | --- |
| `src/types.ts` | `Decision`、`DecideRequest`、`StepRecord`、`RunResult` | 契约是系统边界 |
| `src/errors.ts` | `ErrCode`、`HarnessError`、`classify()`、`httpFailure()` | 错误分类决定重试策略 |
| `src/parse.ts` | `parseDecision()` | 脏输出解析与拒绝理由 |
| `src/context.ts` | `buildContext()` | 上下文预算与显式截断 |
| `src/tools/registry.ts` | `ToolRegistry` | 工具白名单、参数校验、沙箱 |
| `src/brain/` | `Brain`、stdio/openai/mock | 可插拔大脑，不认模型品牌 |
| `src/rng.ts` | PRNG、canonical hash | 确定性地基 |
| `src/world/render.ts` | 世界到文本屏幕 | 有损投影与零泄漏 |
| `src/world/observe.ts` | 屏幕反解观测量 | 只看渲染结果，不读内部状态 |
| `src/world/session.ts` | 世界动作与帧哈希 | 单只手执行与逐帧台账 |
| `src/world/predict.ts` | 预测差异计算 | 期望与实际分离 |
| `src/board.ts` | 假设板 | 主观状态与客观计数分离 |
| `src/goal.ts` | 目标条件与计数 | 完成条件归模型，判定归代码 |
| `src/notary/diff.ts` | 差分与确定性检查 | 同一序列比较两个世界 |
| `src/notary/ddmin.ts` | 最小化 | 非单调谓词下缩小证物 |
| `verify/` | replay/audit/selftest | 独立重算与篡改自检 |

### 4.2 M5 新增或修改（本地工作树，含 Qoder 兼容补丁）

| 路径 | 核心符号 | 学习重点 |
| --- | --- | --- |
| `src/engine.ts` | `HarnessEngine` | 新增：可暂停、可恢复的共享状态机 |
| `src/loop.ts` | `runHarness()` | 修改：CLI 薄门面，只负责向 brain 要决策 |
| `src/trace.ts` | `TraceWriter.resume()`、`event()` | 修改：追加恢复、保留失败原文 |
| `src/mcp.ts` | server 入口 | 新增：stdout 只走 JSON-RPC |
| `src/mcp/protocol.ts` | JSON-RPC、版本协商、订阅生命周期 | 新增：modern acknowledged/取消/EOF + legacy initialize |
| `src/mcp/catalog.ts` | tools/resources/prompts | 新增：能力目录与 schema |
| `src/mcp/server.ts` | 路由、标准目录、缓存元数据 | 新增：resources/list；modern 可缓存结果用 `ttlMs:0` + `cacheScope:"private"` |
| `src/mcp/session.ts` | `McpSessionManager` | 新增：handle、队列、文件锁、checkpoint、恢复 |
| `src/world/harness.ts` | `createArenaWorld()`、`finalizeArenaWorld()` | 修改：CLI 与 MCP 共用世界和局末收尾 |
| `test/mcp-*.test.ts` | 协议、会话、双进程测试 | 新增：不是只测 happy path |
| `skills/agent-harness-mcp/` | Skill、协议参考、stdio 冒烟 | 新增：教宿主工作流，不教游戏策略 |

### 4.3 阅读顺序建议

不要从 `session.ts` 第一行硬读到尾。按下面顺序：

1. `types.ts`：先知道数据长什么样。
2. `errors.ts`：知道失败怎样分类。
3. `registry.ts`：知道工具怎样被约束。
4. `engine.ts`：知道一步怎样执行。
5. `trace.ts`：知道证据怎样落盘。
6. `world/harness.ts`：知道局末怎样裁判。
7. `mcp/session.ts`：知道跨进程和崩溃怎样处理。
8. `test/mcp-session.test.ts`：用失败案例反推设计。

### 4.4 四个必须亲手读懂的代码片段

以下片段来自本地 M5 工作树，体现“状态先行、证据随后”。

**第一，过期步号必须拒绝，而不是尽力执行。**

```ts
const actualExpected = entry.engine.stepCount + 1;
if (expected !== actualExpected) {
  throw new RpcError(-32602, `expected_step=${expected} 已过期；当前应提交第 ${actualExpected} 步`);
}
```

学习点：`expected_step` 同时承担版本号和并发防重。客户端拿旧画面提交的决策，即使动作本身合法，也必须拒绝。

**第二，副作用执行前，先把执行意图落盘。**

```ts
entry.pending = null;
const inFlight: InFlight = { step: pending.step, decision };
entry.inFlight = inFlight;
this.save(entry); // 先写意图，再执行

let record: StepRecord;
try {
  record = await entry.engine.execute(decision, 0);
} catch (error) {
  entry.engine.interrupt(inFlight);
  throw error;
}
```

学习点：崩溃恢复时，“没有结果”不等于“没有执行”。一旦 `inFlight` 已经落盘，恢复器必须保守停止。

**第三，解析失败不能只剩一个计数。**

```ts
noteParseFailure(input: unknown, error: ErrorInfo): void {
  this.parseFailures++;
  this.writer.event('parse_failure', {
    step: this.currentStep,
    attempt: this.parseFailures,
    input,
    error,
  });
}
```

学习点：汇总值适合监控，原始输入和错误适合定位。少了后两者，你只知道坏了，不知道为什么坏。

**第四，中断局不能伪装成正常完成。**

```ts
const uncertified = run.stopReason === 'interrupted';
const replayMatchesLiveSession = !uncertified
  && JSON.stringify(detection.coverage.mutant) === JSON.stringify(coverage);
```

学习点：证据一致性不是“把数字算完”，而是先回答“这些数字有没有资格被称为结论”。`certified:false` 必须一直传到公开结果和裁判侧产物。

## 5. 十章工程学习单元

以下每章的“书中问题”是整理者依据公开目录提出的学习问题，不是正文引文。

### 5.1 第 1 章：从失败建立正确认知

#### 书中问题

为什么 Demo 经常成功，生产却经常失败？六类崩溃模式为什么不能靠“ Prompt 写得好”解决？

#### 我们的应用

我们把六类故障拆到不同代码层，而不是放在一个巨大的 `catch` 里：

| 故障 | 工程机制 | 代码/测试 |
| --- | --- | --- |
| 无限循环 | 重复动作 + 局面指纹、最大步数 | `engine.ts`、`loop-world.test.ts` |
| 上下文溢出 | system 常驻、近期保留、显式截断 | `context.ts`、`rng-context.test.ts` |
| 输出格式失控 | 容错解析、有限回炉、原文留痕 | `parse.ts`、`empty-repair.test.ts` |
| 资源耗尽 | 步数、步间墙钟检查、活跃局容量上限 | `mcp/session.ts` |
| 级联失败 | 错误分类、熔断式停止、有限重试 | `errors.ts`、`retry.test.ts` |
| 静默失败 | 独立完成判据、证据一致性、未认证标记 | `world/harness.ts`、MCP 恢复测试 |

#### 动手实验

```bash
node --test test/errors.test.ts
node --test test/retry.test.ts
node --test test/rng-context.test.ts
node --test test/loop-world.test.ts
```

再打开一份真实失败证据：`runs/e2e-real-model-http400/trace.jsonl`。重点不是看模型说了什么，而是看 HTTP 400 的原始错误怎样进入 trace，并帮助定位协议字段缺失。

#### 故意制造失败

- 让工具连续返回同一种非法参数，观察解析和工具拒绝是否分开记录。
- 让上下文预算小于 system 本身，确认 `overBudget` 会出声，而不是假装截断成功。
- 让世界每帧 tick 都变化但玩家毫无进展，确认循环检测不会因为哈希永远变化而失效。

#### 验收证据

必须能指出：故障在哪一层、最早信号是什么、哪个硬边界停止它、trace 里有什么。只会说“模型犯错了”不算完成。

### 5.2 第 2 章：理解 Agent 系统

#### 书中问题

Agent 与聊天模型的差别是什么？为什么必须有运行时？控制流和数据流为什么要分开看？

#### 我们的应用

`Decision` 是模型输出，`DecideRequest` 是模型输入，`ToolResult` 是执行结果，`StepRecord` 是把三者串起来的证据。模型不需要知道 checkpoint 文件长什么样，runtime 也不能替模型决定业务动作。

#### 代码走读

1. 在 `types.ts` 找到 `Decision`、`DecideRequest`、`StepRecord`。
2. 在 `registry.ts` 看工具注册与 schema 校验。
3. 在 `engine.ts` 看 `prepare()`、`execute()`、`checkpoint()` 的边界。
4. 在 `loop.ts` 确认 CLI 只负责 `brain.decide()`，没有第二份执行状态机。

#### 动手实验

```bash
node --test test/registry.test.ts
node --test test/prompt.test.ts
node --test test/loop.test.ts
node --test test/arena-shared.test.ts
```

画两张图：控制流图标状态转换；数据流图标哪些信息能进入模型上下文。用红笔标出禁止流动的裁判信息。

#### 常见误区

- 把多写几个角色 Prompt 当作多 Agent 架构。
- 把工具返回的所有字段都塞给模型。
- 把 debug 信息当成观察信息。
- 把 runtime 当成模型外挂 Prompt，而不是确定性状态机。

### 5.3 第 3 章：执行编排

#### 书中问题

怎样从模糊意图拆到可执行单元？ReAct、Plan-and-Execute、串行、并联、DAG 怎样选择？重试和动态重规划为什么容易失控？

#### 我们的应用与边界

当前仓库实现的是**单 run、串行、可暂停状态机**，没有实现通用 DAG 调度器、多 Agent 投票或完整动态重规划。不要因为书里讨论了这些模式，就声称项目已经具备它们。

我们实际实现的是编排的最小底座：

- 每一步必须等待上一步 observation。
- 每个动作受最大步数和墙钟限制。
- 重复动作且局面无进展时停止。
- 解析失败回炉不烧步。
- 过期步号拒绝执行。

#### 代码走读

重点看 `engine.ts` 的停止条件：`finish`、`max_steps`、`wall_clock`、`loop_detected`、`brain_failed`、`interrupted`。每一种停止都必须进入局末收尾，不能直接 `process.exit()` 跳过证据。

#### 动手实验

```bash
node --test test/loop.test.ts
node --test test/loop-world.test.ts
node --test test/empty-repair.test.ts
node --test test/mcp-integration.test.ts
```

#### 设计练习

给一个“整理目录并生成报告”的任务画出三种拓扑：

- 串行：读取 → 分类 → 汇总 → 写出。
- 并联：多个目录独立扫描，最后汇总。
- DAG：解析依赖索引，只有被引用的文件才进入读取。

然后回答：哪个步骤有副作用？哪个步骤可重试？哪个步骤失败后必须补偿？

### 5.4 第 4 章：执行可靠性

#### 书中问题

检查点、幂等、Saga、超时、中断和长任务为什么必须一起设计？

#### 我们的应用

M5 是本项目与第 4 章重合最深的部分。

| 可靠性问题 | 我们的机制 | 关键位置 |
| --- | --- | --- |
| 待决策请求丢失 | checkpoint 保存 `pending` 与 `currentStep` | `mcp/session.ts`、`engine.ts` |
| 动作执行后崩溃 | 执行前先写 `inFlight` | `McpSessionManager.step()` |
| 恢复后重复执行 | 见到 `inFlight` 就停止为 `interrupted` | `load/refresh/assemble` |
| 两个进程同时执行 | start 锁 + 每 run 文件锁 | `acquireFileLock()` |
| 初始世界被替换 | `initialWorldHash` | v2 checkpoint |
| 中间帧被篡改 | 每个 `StepRecord.stateHash` 逐步核对 | `assemble()` |
| 容量统计失真 | 只数磁盘未 finalized checkpoint | `activeCount()` |
| 中断结果被误用 | 公开 result 与 notary/detection/ear/defect 写 `certified:false` | finalizer 与 public result |
| 解析失败无原文 | `parse_failure` 事件 | `noteParseFailure()` |

#### 崩溃窗口

| 崩溃位置 | 恢复时应怎样做 |
| --- | --- |
| 动作意图写入前 | 没有执行，可重新请求决策 |
| `inFlight` 已写、动作未发 | 仍无法百分百证明，保守停止 |
| 动作已发、结果未保存 | 结果未知，绝不自动重放 |
| 结果已保存、下一步 pending 未写 | 从已保存状态重新构造 pending |
| finalizer 未完成 | 使用持久化状态重新收尾，不重复动作 |

#### 动手实验

```bash
node --test test/mcp-session.test.ts
node --test test/mcp-integration.test.ts
```

重点阅读这些测试名：

- “预写动作后崩溃的局 fail-closed，恢复后不重复执行”。
- “恢复逐帧核对，末态没变也拒绝中间帧被篡改的局”。
- “两个 server 进程同 run 并发步骤只执行一次”。
- “死者留下的 run 文件锁 fail-closed”。
- “重启后恢复解析回炉请求，合法决策仍记在原来的下一步”。

#### 幂等练习

给 `move`、`note`、`send_message`、`charge` 四类动作分别回答：是否可重试？是否需要幂等键？超时后能否查询结果？失败是否可补偿？不要把游戏内移动的幂等策略直接套到支付工具。

### 5.5 第 5 章：调试与排查

#### 书中问题

怎样从“看日志”升级到“重建决策过程”？Trace、Metrics、Logs、GenAI 事件各自回答什么？

#### 我们的应用

一次运行的最低证据包括：

```text
header.json      初始 seed、任务、配置、大脑身份
trace.jsonl      每步决策、结果、状态哈希与失败事件
result.json      停止原因、动作序列、notes、hypotheses、goals
```

MCP 还增加 `mcp-checkpoint.json` 和局末裁判文件。恢复时 trace 只能 append，不能清空前半局。

#### 动手实验

```bash
npm run verify:replay
npm run verify:m4
npm run verify:board:selftest
npm run verify:goal:selftest
npm run verify:detect:selftest
npm run verify:ear:selftest
```

这些命令的重点不是“打印全绿”，而是理解审计脚本为什么敢独立下结论。以 replay 为例，它不调用被测判决入口，而是复用 `runSequence`、`findMutant`、`diffFields` 等确定性底层纯函数，自行解析输入、重算和比较；其他审计脚本各有自己的独立入口与反向对照。

#### 故障复盘模板

```text
run_id：
任务目标：
首个偏离预期的 step：
模型当时看见：
模型当时决定：
工具实际结果：
状态哈希是否变化：
停止原因：
证据是否完整：
根因层级：
修复：
回归测试：
```

#### 回放的三个层次

1. 固定输入重跑：模型行为可能变化。
2. 固定状态重放：工具与外部服务仍可能变化。
3. 逐事件确定性重放：要求状态哈希逐步一致。

写测试前先声明你要复现哪一层，否则“重放失败”可能只是模型这次说了不同的话。

### 5.6 第 6 章：生产级部署

#### 书中问题

性能、成本、安全、合规和灰度发布为什么不能等到上线前再补？

#### 我们的应用与边界

本项目不是完整生产部署系统，但已经实现了几项关键边界：

- 输出根只能由 server 环境配置指定。
- 工具参数不能覆盖输出根或选择 mutant。
- 活跃局容量与最大步数有硬上限；墙钟在每次准备或提交下一步前检查，不中断正在执行的单个工具动作。
- stdio 的 stdout 只走协议，日志走 stderr。
- 临时证据不进入已发布 `runs/`。
- 文件锁只保护同一本地文件系统，不是跨主机分布式锁。
- 没有磁盘配额；单个工具动作执行期间没有强制中断超时。

#### 安全练习

把下面每条要求映射到代码或明确标记“未实现”：

| 要求 | 当前状态 |
| --- | --- |
| 最小工具权限 | 工具白名单与 schema 校验 |
| 沙箱路径约束 | registry 与输出根守卫 |
| 高危动作人工审批 | 本仓库未实现通用审批系统 |
| 网络出站限制 | 本仓库未实现 OS 级网络隔离 |
| 多租户隔离 | stdio 单进程不等于多租户服务 |
| 成本预算 | 有步数/墙钟/容量，未实现按金额计费 |
| 灰度发布 | 未实现 |
| 合规审计 | 有证据留痕，不等于法律合规认证 |

#### 动手实验

```bash
node --test test/mcp-integration.test.ts
node --test test/mcp-protocol.test.ts
```

找到“输出根守卫”测试，确认 `runs/` 与仓库根会被拒绝。再检查协议测试，确认内部错误不会把 stack 泄露给客户端。

### 5.7 第 7 章：VLM 闭环视频生产

#### 书中问题

怎样把评审从生成末端提前到生成过程中？自反思为什么会越反思越糟？

#### 我们的应用与边界

本项目没有实现 VLM 视频 Agent，不能把屏幕观察和声音对账包装成 VLM-as-a-Judge。可迁移的是方法论：

- 评审标准要先固定。
- 生成、评审、修订要有状态。
- 每轮修订绑定上一版本和具体差异。
- 连续无改善必须停止。
- 预算耗尽时保留最佳版本，而不是只剩最后一次失败输出。

#### 设计练习

给“生成一张活动海报”写一个最小评审 rubric：

| 维度 | 必须修复 | 可接受 | 证据 |
| --- | --- | --- | --- |
| 主标题 | 缺失或错字 | 字体不同但可读 | OCR 文本 |
| 品牌色 | 明显偏离 | 近似色 | 颜色采样 |
| 留白 | 元素遮挡 | 轻微不对称 | 版面区域检查 |
| 禁用元素 | 出现未授权 logo | 无 | 图像分类或人工 |

然后定义停止条件：最多三轮、同一问题连续两轮无改善、预算耗尽、风险升级。

### 5.8 第 8 章：农业机器人决策图谱

#### 书中问题

真实世界的传感器不可靠、动作不可逆时，Agent 怎样安全降级？

#### 我们的应用与边界

本项目没有硬件机器人，但 `interrupted` 状态体现了同一条原则：**无法证明动作是否完成时，保守停止，而不是猜测后继续。**

可迁移的设计：

- 关键传感器失效时收缩动作集合。
- 多传感器冲突时进入保守模式。
- 危险动作有独立于模型的中断机制。
- 恢复前重新确认环境。
- 降级状态对操作者可见。

#### 状态机练习

```text
RUNNING
  ├─ 非关键传感器离线 → DEGRADED
  ├─ 关键传感器离线 → SAFE_STOP
  ├─ 人工急停 → STOPPING → STOPPED
  └─ 任务完成 → FINISHED

SAFE_STOP
  └─ 传感器恢复 + 环境复核 → READY → RUNNING
```

指出哪些转换可以由模型建议，哪些必须由确定性安全逻辑执行。

### 5.9 第 9 章：Coding Agent 与自治环境

#### 书中问题

Agent 与计算机的接口怎样设计？部署者与监控者怎样协作？自我进化怎样不绕过审批？

#### 我们的应用与边界

本项目不是完整 Coding Agent，但工具错误信息体现了 ACI 思想：错误必须可读、可行动，成功、失败和结果未知要能区分。

`src/errors.ts` 的 `readable()` 返回统一 `ToolResultLike`，让模型知道为什么被拒绝、下一步能做什么。工具设计不应只返回 `Error: something went wrong`。

#### Coding Agent 工具契约练习

| 工具 | 应返回 |
| --- | --- |
| `read_file` | 内容、范围、是否存在、是否截断 |
| `search` | 命中、上下文、总数是否截断 |
| `apply_patch` | diff、写入结果、文件版本 |
| `run_tests` | 退出码、摘要、日志引用 |
| `deploy` | 部署 ID、状态、可回退版本 |

#### 自我进化四道闸门

候选生成 → 沙箱实验 → 独立评估 → 审批部署。当前仓库只覆盖“确定性世界中的实验与独立复核”，没有自动修改自身代码并部署的能力。

### 5.10 第 10 章：框架选择与未来

#### 书中问题

怎样比较框架？三条设计哲学怎样落到选型？A2A、持续学习和自治边界带来什么新风险？

#### 我们的选择

| 选择 | 原因 | 代价 |
| --- | --- | --- |
| 零依赖 TypeScript | 运行和审计成本低 | 很多能力要手写 |
| Node 22 原生跑 TS | 不装编译链 | 受可擦除语法限制 |
| stdio 宿主大脑 | 不要求 API key | 依赖宿主客户端 |
| MCP 分发 | 对接工具生态 | 需要处理协议与恢复 |
| 单 Agent 串行 | 状态和证据最简单 | 没有并行与角色分工 |
| 确定性世界 | 可重放、可做差分 | 不代表真实业务环境 |

#### 三条哲学的工程检查

- **简单胜于复杂**：每个抽象能否说明它减少了哪类错误？
- **状态机优于无限循环**：所有状态和非法转换能否列出来？
- **接口即性能**：工具是否用更少 token 返回更完整、可判定的信息？

#### A2A 信任检查

Agent 间通信至少要考虑身份、能力声明、任务授权、消息完整性、超时、争议处理与审计。协议标准化不等于信任自动化。

## 6. M5 分步协议实验

### 6.1 启动配置

```json
{
  "mcpServers": {
    "agent-harness": {
      "command": "/home/fuyuan/.local/node-22/bin/node",
      "args": ["/home/fuyuan/Documents/workspace/agent-harness/src/mcp.ts"],
      "env": {
        "AGENT_HARNESS_MCP_OUT": "/tmp/agent-harness-learning-mcp",
        "AGENT_HARNESS_MCP_MAX_ACTIVE": "2",
        "AGENT_HARNESS_MCP_MAX_STEPS": "20",
        "AGENT_HARNESS_MCP_MAX_WALL_MS": "120000"
      }
    }
  }
}
```

真实宿主试玩保持默认 `provenance=real`。只有明确要做接线冒烟时才设为 `fixture`。

### 6.2 一次 start → step → status → finish

1. 调 `harness_start`，保存 `run_id`，完整阅读 `request`。
2. 根据当前 `request` 生成一条 `Decision`。
3. 用 `request.step` 作为 `expected_step` 调 `harness_step`。
4. 读取 `observation` 和下一步 `request`，重新决策。
5. 需要收手时提交 `call.name="finish"`。
6. 停止后才读取 notary、detection、ear 与证据路径。

Decision 示例：

```json
{
  "thought": "先观察当前局面，再决定下一步；不预提交整串动作。",
  "call": { "name": "look", "args": {} },
  "predict": { "playerAt": [1, 0], "hpDelta": 0 },
  "surprise": { "unexpected": false, "why": "当前没有发现与预期不一致的现象" },
  "testing": { "id": "H1", "field": "playerAt" }
}
```

字段是否可用必须服从当前 `request` 契约，不能照抄示例硬发。

### 6.3 返回类型

| 返回 | 含义 | 下一步 |
| --- | --- | --- |
| `started` | 已建局并给出请求 | 产生第一条 Decision |
| `stepped` | 动作完成并给出 observation | 根据新请求继续 |
| `repair_required` | 当前步未消耗 | 修正后保持同一步号 |
| `finished` | 正常或预算停止，已收尾 | 阅读局末证据 |
| `brain_failed` | 回炉耗尽，已收尾 | 检查 `parse_failure` |
| `-32602` | 参数错误或步号过期 | 调 status，不盲重放 |
| `-32000` | 活跃局达到上限 | 收手已有局 |
| `-32002` | 输出根下找不到 run | 检查新旧 server 输出根 |
| `interrupted` | 执行窗口中断 | 不重试，保留未认证证据 |

### 6.4 恢复原则

- run id 是显式 handle，不依赖旧连接。
- 新旧 server 必须使用同一输出根。
- checkpoint 不能手改。
- `inFlight` 存在时不许续跑。
- 初始哈希或任一帧哈希不符时停止使用该局。
- 死者锁先核对 pid，确认无活动进程后才由操作者清理。

### 6.5 冒烟命令

```bash
npm run verify:mcp
```

该命令运行真实 stdio 协议、会话、双进程与恢复测试，再跑 Skill fixture。它证明接线和状态机，不证明真实宿主模型一定会玩得好。

### 6.6 真实 Qoder：从“工具能调”到“宿主真的会用”

2026-11-25，用户级 Qoder connector 加载修复后的 server，协商 modern `2026-07-28`，真实会话显示三工具已连接。随后由当前 Qoder LLM 逐帧读取 request、自主产生 Decision；没有 fixture、剧本、mock 或启发式兜底。两局均为 seed=6、参考版、`provenance=real`、`brainId=mcp-host`，只写 gitignored `sandbox/mcp-qoder/`。

| run | 预算 | 停止 | 步数 | 世界动作 | 证据结论 |
|---|---|---|---:|---:|---|
| `mcp-47cecfc5-070b-4cc1-bab6-0c533ea063d4` | 12 步 / 300 秒 | `wall_clock` | 11 | 8 | 第 12 步 finish 在执行前被拒，summary 为空；证据完整 |
| `mcp-37e15572-e3c6-4bc1-aab0-7686353f01d5` | 4 步 / 900 秒 | `finished` | 3 | 1 | 宿主主动 finish；7/7 预测字段相符 |

两局 `evidenceConsistent=true`、`brainRetries=0`、`parseFailures=0`。独立 replay 分别核 **9/9** 与 **2/2** 帧；独立预测审计重算 29 + 7 个字段，与引擎 actual/status **0 处不一致**。准确结论是：当前 Qoder 能完成发现、分步决策、观察和收手；不能扩张成“长局能力强”“所有宿主兼容”或“能发现未知缺陷”。

### 6.7 真实入口补上的四课

**第一，现代协议是一组行为，不是一个版本字符串。** 真实 Qoder 依次暴露了 `resources/list` 缺失、`subscriptions/listen` 缺失、modern 可缓存结果缺 `ttlMs/cacheScope`，以及回调 `_ctx`/`ctx` 接错导致三工具全变 -32603（#62–#65）。修复分别对应标准空目录、acknowledged 订阅握手、私有不缓存元数据和完整上下文传递。

**第二，停止原因不能美化。** 第一局 finish 到达时墙钟已尽，所以只能写 `wall_clock / 11`，不能写成主动完成。`brainMs=0` 也不表示模型没有思考，只表示 server 无法精确计量宿主思考与请求间隔。

**第三，有损投影会制造“看起来像缺陷”的现象。** 玩家最后画，`@` 会遮住脚下 `+`；`pickupCount` 数可见符号，不是内部未拾取对象数。第一局可见物品 3→2 曾被误读为移动自动拾取，回读代码后纠正：只有 `pickup` 才把内部物品标为 taken。先问“这个量从哪里投影出来”，再问“世界是否出错”。

**第四，仪器自己也会误判。** 第二局 finish 明说“不据此声称已发现游戏缺陷”，m4f-1 仍因子串命中判 `reported=true` / `误报`。这说明关键词命中不等于主张成立。按冻结纪律，本轮保留反例、不偷偷改词表，也不混入旧“参考版误报 0/4”的统计。

## 7. M5 故障台账：22 次真实失败

| 编号 | 失败 | 根因 | 工程归纳 |
| --- | --- | --- | --- |
| #47 | start 后 trace ENOENT | run handle 与目录 id 两套 | 身份只能有一个生产者 |
| #48 | 恢复哈希不匹配 | 重放动作形状与真实执行不同 | 重放输入必须同形 |
| #49 | 恢复后重复板面事件 | pending 没持久化 | 待决策请求也是状态 |
| #50 | `brain_failed` 被覆盖成 `finished` | 对象展开顺序错误 | 判别联合标签不能被通用字段覆盖 |
| #51 | 墙钟到点仍报进行中 | 已有 pending 绕过预算检查 | 长寿命 pending 也要过停止条件 |
| #52 | Skill 冒烟找不到入口 | 路径层级假设错误 | 脚本必须真跑 |
| #53 | 并发恢复出现两个 entry | 加载中的对象没有共享身份 | 加载中也要合并并发 |
| #54 | 执行后崩溃导致重复动作 | 没有持久化执行意图 | 先写 inFlight，再执行 |
| #55 | 两个进程都成功提交同一步 | Promise 队列只保护单进程 | 跨进程要用磁盘锁 |
| #56 | 末态相同仍能藏住中间篡改 | 只核末态 | 初始与逐帧都核 |
| #57 | 活跃局上限统计错误 | 信任进程内存 | 跨进程事实源在磁盘 |
| #58 | 只剩解析失败次数 | 汇总替代原文 | 计数不能替代证据 |
| #59 | 删死锁可能误删新锁 | unlink 与新建之间无 CAS | 宁可 fail-closed |
| #60 | repair pending 重启后退步 | currentStep 未保存 | 待决策步号也是状态 |
| #61 | interrupted 仍像已认证 | 只降级总闸门 | 未认证必须传到公开 result 与裁判产物 |
| #62 | `resources/list` 返回 -32601 | 声明能力却漏标准目录 | 声明与标准发现接口必须成对 |
| #63 | 现代订阅返回 -32601 | 只实现 legacy 初始化 | acknowledged、订阅 id、取消/EOF 都要实现 |
| #64 | modern 目录被 schema 拒绝 | 缺 `ttlMs/cacheScope` | 版本升级要逐类结果满足新 schema |
| #65 | 真实入口三工具全 -32603 | `_ctx`/`ctx` 接线错误 | 上下文必须沿完整调用链真跑 |
| #66 | finish 到达前墙钟已尽 | 宿主思考不计入 `brainMs` | 预算停止不能写成主动收手 |
| #67 | 可见 `+` 减少被误读为自动拾取 | 玩家图层遮挡、投影计数 | 有损投影不能当内部账本 |
| #68 | “没有发现缺陷”仍被判误报 | 子串词表不处理否定 | 冻结判据保留反例，升级前不混统计 |

学习这 22 条时，不要只背结论。对每一条找到对应测试或原始证据，问：如果把修复删掉，哪条测试会红？尚未修复的 #68 要能说清“已有反例、暂无修复回归”，不能把记录当完成。

## 8. 实验目录

以下实验按“便宜、可重复、无外部额度”排序。除特别说明外，测试产物都在临时目录。

| 编号 | 主题 | 命令 | 通过证据 |
| --- | --- | --- | --- |
| E0 | 全量基线 | `npm test` | 全部测试通过 |
| E1 | 错误分类与重试 | `node --test test/errors.test.ts test/retry.test.ts` | 429 与 400 走不同路径 |
| E2 | 上下文预算 | `node --test test/rng-context.test.ts` | 截断可见、system 不丢 |
| E3 | 死循环 | `node --test test/loop-world.test.ts` | 走图不误判、真卡住会停 |
| E4 | 差分与最小化 | `node --test test/notary.test.ts` | 确定性、分叉、1-minimal |
| E5 | 预测闭环 | `node --test test/predict-loop.test.ts` | 差异真进入下一次 payload |
| E6 | 假设与目标 | `node --test test/board.test.ts test/goal.test.ts` | 主客观分离、计数闭合 |
| E7 | 检出判据自检 | `npm run verify:detect:selftest` | 注入错误会被抓 |
| E8 | 眼耳判据自检 | `npm run verify:ear:selftest` | 独立重算与反向对照 |
| E9 | MCP 全链路 | `npm run verify:mcp` | 协议、恢复、并发、冒烟 |
| E10 | 既有文档数字守卫 | `npm run verify:docs` | README/HAND-CODING/KNOWLEDGE 与磁盘实测一致；本文另做结构校验 |
| E11 | 机械接线冒烟 | `npm run smoke` | 只证明接线，不是模型证据 |
| E12 | 真实证据重放 | `npm run verify:replay` | 逐帧一致 |

`npm run smoke` 写入 gitignored `sandbox/smoke/`。需要清理时只清理自己生成的 sandbox 子目录，不碰已发布 `runs/`。

## 9. 四周学习计划

### 第 1 周：可运行与可解释

目标：能讲清一次 Agent 运行从输入到证据的全过程。

任务：

- 读第 2—4 节。
- 跑 E0—E3。
- 打开一份成功 trace 和一份失败 trace。
- 写一张控制流图和数据流图。

交付：一页架构说明 + 两份 trace 对照 + 三条故障记录。

### 第 2 周：可恢复与防重复

目标：理解为什么“存 JSON”不等于“能恢复”。

任务：

- 读第 5.4 节与 M5 协议参考。
- 跑 E9。
- 逐步分析 inFlight、pending、文件锁和逐帧哈希。
- 为三个崩溃窗口写恢复预期。

交付：崩溃窗口表 + MCP 分步实验记录 + 至少两条新增故障台账。

### 第 3 周：可观测与可验证

目标：让失败可以被第三方重算。

任务：

- 读第 5.5 节。
- 跑 E4—E8、E10、E12。
- 选一条真实 trace，写独立解析与对账。
- 给审计脚本补一条反向对照。

交付：独立审计脚本或测试 + 篡改自检 + 一条“零样本假通过”防护。

### 第 4 周：可部署与可约束

目标：把一个窄工具包装成可信运行时接口。

任务：

- 读第 5.6、5.9、5.10 节。
- 给工具补 schema、错误分类、幂等键、超时与 trace。
- 用 MCP 暴露 start/step/status 或等价的异步任务协议。
- 写安全边界与未实现清单。

交付：可运行的小型 harness + 测试 + 学习复盘。

## 10. 结课 capstone：给自己的工具加一层可靠性

### 10.1 任务选择

选一个同时满足以下条件的工具：

- 输入输出可以用 JSON 表达。
- 至少有三种失败：参数错误、暂时性失败、结果未知。
- 有或模拟一个外部副作用。
- 失败可以在沙箱中安全注入。

例子：创建待办、发送测试通知、写入测试数据库、修改沙箱文件。不要拿真实支付、真实邮件或生产部署做第一次练习。

### 10.2 必交模块

1. **契约**：请求、决策、结果、错误类型。
2. **状态机**：created、pending、inFlight、done、failed、unknown。
3. **执行意图**：副作用前持久化。
4. **幂等键**：重复请求不重复副作用。
5. **超时与取消**：总时限、取消传播、结果未知出口。
6. **trace**：输入、动作、结果、错误与状态版本。
7. **独立验收**：至少一条不依赖业务自报的检查。
8. **回归测试**：每个 catch 和恢复分支都真跑过。
9. **文档**：使用方式、故障台账、未实现边界。

### 10.3 验收清单

- [ ] 相同请求重复提交不会产生两次副作用。
- [ ] 动作执行后进程崩溃，恢复不会盲目重放。
- [ ] 初始状态与每个动作后的状态都能校验。
- [ ] 参数错误不会被无限重试。
- [ ] 超时能够区分“没发出”和“结果未知”。
- [ ] 总预算耗尽时停止原因真实可见。
- [ ] 解析失败保留原文与错误。
- [ ] 进行中接口不泄露内部裁判字段。
- [ ] 中断结果明确标记未认证。
- [ ] 审计脚本缺证据时非零退出。
- [ ] 至少一条篡改自检和一条反向对照。
- [ ] 文档中的关键数字可由脚本重算。

### 10.4 评分建议

| 维度 | 分值 |
| --- | --- |
| 契约与信息边界 | 15 |
| 状态机与恢复 | 20 |
| 幂等与副作用安全 | 20 |
| 可观测性与证据 | 15 |
| 失败注入与回归 | 15 |
| 文档与诚实边界 | 15 |

得分不是目的。真正重要的是：你能不能让另一个开发者独立复现一次失败，并验证修复。

## 11. 常见误区

### 11.1 “测试全绿，所以系统可靠”

测试只覆盖写过的路径。没有触发的 catch、没有构造的坏输入、没有模拟的崩溃窗口，都不能算已验证。

### 11.2 “模型自己会反思，所以不用状态机”

反思可能重复原意见，也可能改坏原本正确的部分。状态机和停止条件提供模型之外的确定性边界。

### 11.3 “重试越多，成功率越高”

结果未知的副作用不能直接重试。重试还可能放大限流、费用和级联故障。

### 11.4 “有日志就能调试”

只有日志无法稳定重建模型输入、动作顺序和状态版本。Trace 需要统一标识和结构化事件。

### 11.5 “多个 Agent 投票就更可靠”

如果它们共享同一错误上下文，投票只是重复同一错误。独立证据、隔离和裁决规则比角色数量重要。

### 11.6 “Prompt 里写了安全规则，所以安全”

Prompt 不是权限系统。最小权限、白名单、沙箱、审批和审计必须由运行时执行。

### 11.7 “中断后从最后一步继续就行”

如果最后一步有副作用且结果未知，继续就是重复执行。必须先证明它没有执行，或查询真实结果。

### 11.8 “文档写完再补测试”

文档中的数字、命令和边界也是交付物。应像测试代码一样验证它们。

## 12. 当前仍未证明或未实现

- 真实 Qoder 已完成两局（11 步墙钟、3 步主动 finish），但 Claude Code／Codex 尚未验证；两局也不是长局游戏能力或未知缺陷检出率证据。
- m4f-1 在“没有发现缺陷”的否定句上存在真实假阳性（#68），本轮未升级冻结判据。
- fixture 不是模型能力证据；真实宿主试玩同样必须按任务、样本与预算限定结论。
- MCP 的 `brainMs` 无法精确包含宿主模型思考时间，当前如实记录为 0。
- 文件锁只保护同一本地文件系统，不是跨主机分布式锁。
- 没有磁盘配额；单个工具动作执行期间没有强制中断超时。
- stdio 单进程不等于多租户服务。
- 没有通用 DAG 调度器、多 Agent 共识、Saga 框架、按金额计费或完整灰度发布。
- 没有 VLM 视频 Agent、农业机器人或完整 Coding Agent。
- M5 主体与本轮 Qoder 现代订阅/缓存、真实入口接线修复均已纳入仓库版本；Claude Code／Codex 的兼容性仍未验证。
- 正版电子书不提供源文件，本文依据公开目录与简介整理，不包含正文摘录。

把这些边界写清楚，不是削弱项目，而是避免“局部证据被扩大成全面结论”。

## 13. 术语表

| 术语 | 本文中的含义 |
| --- | --- |
| Agent | 能围绕目标感知、决策、行动并观察结果的系统 |
| Harness | 模型之外的运行时骨架与约束层 |
| Brain | 产生 Decision 的模型或宿主 |
| Decision | 一次动作意图，包含 thought 与 call |
| Observation | 动作执行后返回给大脑的玩家侧事实 |
| Checkpoint | 可持久化、可恢复的任务状态 |
| inFlight | 已持久化但尚不能证明完成的执行意图 |
| 幂等键 | 让重复请求指向同一结果的稳定标识 |
| Trace | 按时间追加的运行事件流 |
| Replay | 用初始状态与动作序列重新执行 |
| Differential | 同一动作序列比较两个世界 |
| ddmin | 在谓词非单调时缩小失败用例 |
| Fixture | 已知输入的测试替身，不是模型证据 |
| Provenance | 证据来源，例如 real 或 fixture |
| Certified | 证据是否通过完整性与一致性认证 |
| Fail-closed | 无法确认安全时拒绝继续，而不是猜测恢复 |
| ACI | Agent 与计算机交互的专用接口 |
| A2A | Agent 间通信协议 |
| SLI/SLO | 服务等级指标与目标 |

## 14. Sources 与延伸阅读

### 本书公开来源

- [当当商品页：公开简介、完整目录与作者简介](https://e.dangdang.com/products/1901404305.html)（销售渠道，不是出版社官方页）
- [知阅在线：电子工业出版社电子书平台首页](https://www.zhiyuebook.com/)（用于确认平台存在，不是本书详情页）

### MCP 协议来源

- [MCP 2026-07-28：Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)
- [MCP 2026-07-28：Schema](https://modelcontextprotocol.io/specification/2026-07-28/schema)
- [Python SDK migration guide](https://py.sdk.modelcontextprotocol.io/migration/)

### 仓库内文档

- [内容总结：54 节逐节导读与十章深挖](./AI-Agent避坑实战-内容总结.md)
- [README：搭建步骤、证据格式与测试入口](../README.md)
- [REPRODUCTION：可复现缺陷包](../REPRODUCTION.md)
- M5 工作树说明：`M5-FINDINGS.md`
- MCP 协议参考：`skills/agent-harness-mcp/references/protocol.md`

### 使用边界

本书相关总结依据当当商品页公开的简介、完整目录和作者简介，以及知阅平台可见信息整理；工程应用来自当前仓库实现与实跑记录。两者是“主题映射”，不代表作者本人为本项目背书，也不代表本文已经精读全书正文。
