# 最小 Agent Harness（麻雀虽小，五脏俱全）

[![verify](https://github.com/lisanfu/agent-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/lisanfu/agent-harness/actions/workflows/ci.yml)

零依赖 · Node 22 原生 TypeScript · 大脑可插拔 · **不使用任何本地模型** · 证据无损可重放

**`runs/` 全部证据随仓库发布**：clone 下来 `npm run verify:detect:reference`、`verify:m4`、`verify:random`
就能把我引用的每一个数字自己重算一遍——量具店必须摆尺子，不能只摆照片。

这份文档是「整体搭建步骤 + 每一步怎么做」。代码已经全部写好并通过验证，所以下面每一步既是**从零重建的顺序**，也是**读懂这套东西的顺序**。

配套 [KNOWLEDGE.md](./KNOWLEDGE.md) —— **逐器官知识地图**：每一部分哪些是你已会的前端技能、哪些是真正要新学的、掌握判据是什么、往哪深化。学习看那份，搭建看这份。

---

## 0. 这是什么，不是什么

**是**：一个 agent 的骨架。把「观察 → 决策 → 执行 → 回填 → 判断该不该停」这个循环手写出来，一行都不藏。框架（LangChain / LangGraph）把这层包起来了，所以你永远不知道 agent 到底怎么跑的；这里全部摊开。

**不是**：
- 不是一个能玩游戏的 agent（那是 M1–M3 的事，这里只保证地基）
- 不是又一个「一句话生成游戏」的工具
- **不是脚本**。所有决策来自大脑（模型），代码里没有任何启发式兜底、没有预置策略手册。代码只负责确定性：世界、裁判、证据。

**一句话定位**：别人盖房子，我们生产盖房子的工具。这个 harness 就是那把铲子的柄——发动机（大脑）插别人的。

### 已经验证过的事实（不是设想）

| 验证项 | 结果 |
|---|---|
| 单元 + 集成测试 | **396 个全绿**，`npm test`，约 25 秒，25 个文件 |
| **真实远端模型自主运行** | `agnes-2.5-flash`，**6 步 / 18.6 秒 / exit=0**，自己发现缺陷，零手喂 |
| 真实端到端运行（我当宿主大脑，stdio） | 7 步，`stop=finished`，同一世界同一缺陷（对照组） |
| 远端 HTTP 分支（CLI 级，传输层桩） | 3 步，`exit=0`，契约 599 字符每次只发一份 |
| 五种停止条件 | 全部真跑过，不是"写了分支" |
| 真实错误路径 | HTTP 400/401/429/500/503 / 空返回 / 真超时 / 连接被拒 / stdin EOF，全部真跑过；**429 真退避重试并续跑成功** |
| **M3 差分公证器成立性** | 288 案例：12 变异体全检出、真等价 0 个；确定性基线 24 组 0 不一致 |
| **M3 最小化（ddmin）** | 23/23 仍分叉、23/23 达成 1-minimal、**1840 步 → 185 步（89.9%）** |
| **M3 负面结论（已固化成测试）** | 只比最终状态**漏检 15 例**；首分叉字段 ≠ 缺陷位置；M07 检出率仅 4.2% |
| **M1 感知-执行层成立性** | 真模型四局（参考版 / M02 / M07 + 修复后确认局），**205 测试全绿**；眼睛零泄漏（40/31/120/12 条工具返回全查） |
| **M1 可复现（6-C 硬要求）** | **独立重放逐位相同**：对照组 39/39 帧、M02 29/29 帧、M07 118/118 帧、确认局 12/12 帧；seed + 初始哈希 + 完整动作序列三要素齐备 |
| **M1 缺陷检出** | M02 经公证器检出，首分叉第 1 步，**28 步 → 1 步且 1-minimal**，独立复核通过 |
| **M1 诚实局限** | agent **没看懂**它走过的 M02 缺陷；M07 未检出（已归因到覆盖率，探针证明公证器能检出）；自报坐标越界 19 次 |
| **M4-a 预测闭环真的在用** | 真模型三局，两局逐步给预测（5/5、9/9）；合计 **102 个字段：87 相符 / 15 不符 / 0 无法核对** |
| **M4-a 两个独立异常源对齐** | M08 缺陷被公证器（首分叉 `player.score`）与预测账本（同一步 `scoreDelta` 违反）**同步同量**指向；agent 首次用自己的话引用客观检出的缺陷 |
| **M4-a 预测驱动的学习** | 坐标读法**一次纠正后 8 步全对**；撞墙推断 `(3,3) 是墙` 经墙表 + `coverage.wallAttempts=1` + 预测账本**三方佐证** |
| **M4-a 独立复核** | 重放 6/6、10/10、9/9 帧逐位相同；另写一套解析重算 **102 个字段的 actual 与 status，0 处不一致** |
| **M4-a 诚实局限** | **15 项违反里只有 1 项是种子缺陷**；差异送达但模型不采信（画面死 1 个它写"消灭 4 个"）；`surprise` 三局 **0 次使用**；三局全死在免费额度 429，无一走到 `finish` |
| **M4-b1 记忆器官被真模型自主使用** | 两局真跑，**零说明书**下自己用 `note({id,status})` 立假设、升状态；板面 6 + 28 份快照**全部可证已送达** |
| **M4-b1 独立复核** | 第二局：重放 **27/27 帧逐位相同**、另写一套解析重算 **84 个字段 0 处不一致**、假设板 **13 项聚合逐项对得上、0 处不一致** |
| **M4-b1 审计有牙** | 篡改自检**注入 15 处错误，漏抓 0 处**，外加 2 组反向对照（补上证据就必须放行 / 历史形状不许追判，见故障 #19） |
| **M4-b1 真跑里的自我撤回** | 第 17 步发明"新敌人出现"→ 代码算出 `enemyCount 3≠2` → 第 18 步自己写下"**我之前误以为有新的敌人产生…敌人不会凭空生成**"。因果链原文落盘可证 |
| **M4-b1 诚实局限** | **`testing` 两局 0 次使用** → 归因通道空转，"模型自己淘汰假规则"**只有夹具证据**；两局都没走到 `finish`；7 项违反全是 agent 自己的错（对照组无缺陷） |
| **M4-b2 阴性结果加固** | `goal` 声明在**开着的五局真跑里 0 次使用**（b2 期 0/3 → 本轮 0/5）；`testing` 归因开档 4 写/3 成 vs 关档 41 写/39 成 |
| **M4-e 采纳率差能不能引用** | 以局为单位（前 5 步内起步的局 开 2/5 vs 关 4/5）两尾 Fisher **p=0.5238**，够不着 0.05；**以步为单位的 p=2.14e-8 属伪重复，不许引用**——采纳率是双峰/路径依赖的 |
| **M4-e 随机策略基线** | 25 步随机游走 `hp` 归零 **5.5%**（11/200，Wilson [3.1%, 9.6%]，seed 6）、320 步才 43.5%；平均只走 **5.3/64** 格，而真模型同预算走 **12.4/64** 格 |
| **M4-e 本轮唯一"局"粒度显著的数** | **谁愿意受伤**：同世界同步数预算下"整局一次血都没掉" 真模型 **4/9** vs 随机 **23/200=11.5%**，局级两尾 Fisher **p=0.0179**。单位是局、不是步，所以不是伪重复；但它说的只是**行为倾向**，代价正是同一张表上 `hp=0` 一次没到达 |
| **M4-e 与 M3 硬约束对上号** | 真模型十局 `hp` 归零 **0/9**——"要主动把自己打到濒死"的状态随机能撞上一小部分、模型一次没到，而为此设计的目标通道**没人用** |
| **M4-e 审计有牙（第二轮）** | `board-audit` 注入 15 处 + 反向对照 2 组；`ablation` 十局交叉核对 0 处；故障 **#18 口径混用**、**#19 多行假设打穿按行解析**都由这轮真证据逼出 |
| **M4-f 判决器有牙（第三轮）** | `detect-selftest` 注入 16 处 + 反向对照 5 组 = **21 例漏抓 0 处**（含 `[口径落盘]` 三种篡改：改版本戳 / sha 归零 / 删戳，以及 `[来源]` 夹具冒充真证据）；`detect-audit` 9 局夹具判决路径 **声明 6/6｜实际 6/6**、上限表抽 40/4800 逐行重算 0 处不符；故障 **#20 引用了没接进来的 `lexiconSha`** 由第一次真跑逼出 |
| **M4-f 缺陷版靶场成立** | 变异体第一次当**被试缺陷**跑：L1 可见分叉是唯一分母，4800 例随机上限表 `invisible=0`——**内部一旦分叉屏幕必分叉，分母干净** |
| **M4-f 判据跑前冻结（可机械核对）** | `header.judgement={detector,lexicon,sha}` 第一步之前落盘，审计 `[口径落盘]` 三方交叉核对（header/detection/实时词表 sha）；有 `detection.json` 无戳的局**硬失败**，"局末补写不算" |
| **M4-f 检出率上限表** | 12 变异体可见分叉率从 100%（M02/D03）到 **1%（M06）**——`M06/M07/M09` 随机轨迹几乎不让屏幕分叉，这几格"没检出"不该算漏检（`whyNot=不可见`） |
| **M4-f 参考版误报率** | 分母**只收真大脑跑的参考版局**：4 局旧证据经同一冻结词表独立判 → **0/4 = 0.0% [0.0, 49.0]**。原先那句"0/9"是口径混用（见故障 #21）：9 局里混着 2 局 mock 替身、1 局人写夹具、**2 局根本不是参考版（缺陷局报异常是真检出不是误报）**，四类剔除现在逐条出声。n=4 太小，这个数只能说"没抓到误报"，**不能说"误报率低于 5%"** |
| **M4-f 夹具探针不进任何率** | 夹具那两局 `mutant=null` 是判据通路自检（一局证明仪器不喊、一局故意埋过火证明审计有牙）。现在 `header.provenance` + `brainId`/`task` 两条独立信号交叉核对，夹具表**不印百分比与置信区间**——标题管不住截图，格式才管得住 |
| **M4-f 诚实局限** | 真模型臂每格 1 局、25 步目标全被免费额度 429 截断到 0~18 步，3 局 detectable 全 `未上报`——**本轮不出模型臂检出率**，只有上限表与参考臂误报可引用 |
| CLI 退出码 | 0=finished，1=配置错，2=其他停止原因 |
| 依赖 | **0 个**。不需要 `npm install`，没有 node_modules |
| 本地模型 | **0 个**。全程不使用 |

M3 的完整数据与诚实局限见 [M3-FINDINGS.md](M3-FINDINGS.md)，原始数据 `runs/m3-full/findings.json`。
M1 的完整数据与诚实局限见 [M1-FINDINGS.md](M1-FINDINGS.md)，原始证据 `runs/m1b-{control,M02,M07}/`。
M4-a 的完整数据与诚实局限见 [M4-FINDINGS.md](M4-FINDINGS.md)，原始证据 `runs/20261113-{203623,204204,204625}-s6/`。
M4-b1 的完整数据与诚实局限见 [M4-B-FINDINGS.md](M4-B-FINDINGS.md)，原始证据 `runs/20261113-{215401,220900}-s6/`。
M4-b2 的完整数据与诚实局限见 [M4-B2-FINDINGS.md](M4-B2-FINDINGS.md)，原始证据 `runs/m4b2-goal-{on,off}/`（真模型五局）+ `verify/goal-fixture.ts` 生成的夹具局。
M4-e 的完整数据与诚实局限见 [M4-E-FINDINGS.md](M4-E-FINDINGS.md)，原始证据 `runs/m4e-goal-{on,off}/` + `runs/m4b2-goal-*` + `runs/20261113-234041-s6`（十局），随机臂无证据目录（纯代码可重算）。
M4-f 的完整数据与诚实局限见 [M4-F-FINDINGS.md](M4-F-FINDINGS.md)，原始证据 `runs/m4f-ceiling/`（4800 例上限表，零 key）+ `runs/m4f-model/`（5 局真模型，受额度截断）+ `verify/detect-fixture.ts` 生成的 9 局已知判决夹具。

---

## 1. 五脏清单

| 器官 | 职责 | 文件 | 行数 | 你已有的前端类比 |
|---|---|---|---|---|
| **契约** | 所有接口定义，五脏靠它咬合 | `src/types.ts` | 474 | TypeScript 的 `interface` / Redux 的 action 类型 |
| **心脏** | while 循环，五种停止条件 | `src/loop.ts` | 439 | 事件循环 / `requestAnimationFrame` 主循环 |
| **大脑接口** | 只认接口，不认模型 | `src/brain/*.ts` | 456 | 适配器模式，像换 HTTP client |
| **手** | 工具注册 + schema 校验 + 执行 | `src/tools/registry.ts` | 106 | 表单校验 + dispatch |
| **眼（雏形）** | 观察世界的内置工具 | `src/tools/builtin.ts` | 156 | DOM 查询 / a11y tree |
| **记忆（M4-b）** | 假设板：可淘汰、可改写、核对计数由代码累加 | `src/board.ts` + `builtin.ts` 的 `note` | 243 | Redux store：`status` 是用户声明的 state，计数是 selector 算出来的派生值，两者不许互相覆盖 |
| **海马体** | 上下文预算与截断 | `src/context.ts` | 70 | 虚拟列表：只渲染可见区，但告诉用户"上面还有" |
| **痛觉** | 错误分类 + 可读拒绝 + 可重试判定 | `src/errors.ts` | 150 | Sentry 的错误归类 |
| **公证处** | 无损证据日志 | `src/trace.ts` | 60 | rrweb / Redux DevTools 的 action 录制 |
| **确定性地基** | 注入式 PRNG + 规范化哈希 | `src/rng.ts` | 52 | Redux `action → reducer → state` 的可重放性 |
| **听懂人话** | 容错解析模型输出 | `src/parse.ts` | 200 | 处理后端返回的脏 JSON |
| **嘴** | 提示词装配（只给接口，不给策略） | `src/brain/prompt.ts` | 121 | 写 API 文档，不写业务教程 |
| **门面** | CLI | `src/cli.ts` | 209 | Vite 的 argv 解析 |
| **视网膜（M1）** | 世界 → 文本屏幕，有损投影 | `src/world/render.ts` | 139 | 只把 DOM 渲染结果给 agent，不给它读 store |
| **一只手（M1）** | 串行动作队列 + 逐帧台账 + 覆盖账本 | `src/world/session.ts` | 218 | 单线程事件循环：并发 dispatch 也要排队 reducer |
| **游戏工具（M1）** | look/move/attack/pickup/wait，闭包绑定 | `src/tools/game.ts` | 107 | 每个组件实例绑自己的 props，不用全局单例 |
| **arena 运行器（M1）** | 自主玩 → 抽动作 → 公证 → 最小化 → 落盘 | `src/world/harness.ts` | 221 | CI 流水线：跑测试 → 收证据 → 出报告 |
| **逆投影（M4）** | 屏幕文本 → 观测量，**绝不读内部状态** | `src/world/observe.ts` | 97 | 从渲染后的 DOM 反推可见信息，不去读 store |
| **预测对照（M4）** | 模型预测 → **代码算 diff** → 模型判断是否意外 | `src/world/predict.ts` | 172 | 快照测试：期望值由人写，差异由 Jest 算，不让人自己说"过了" |
| **靶场（M3）** | 确定性世界 + 语义变异体 | `src/world/arena.ts`、`mutants.ts` | 310 + 55 | 一个可重放的 reducer + 关掉某个 middleware |
| **差分公证器（M3）** | 参考版 vs 变异版 → 首个分叉点 | `src/notary/diff.ts` | 164 | Redux DevTools 两条 state 树逐帧 diff |
| **最小化（M3）** | ddmin 把 80 步砍到 3 步仍可复现 | `src/notary/ddmin.ts` | 103 | git bisect，但谓词非单调 |
| **实验台（M3）** | 7 组实验 + 成立性判定 | `src/m3.ts` | 452 | 基准测试脚本 |

源码合计 4657 行，测试 4576 行，独立复核脚本 990 行。**这个体量你可以一个周末读完并改掉任何一处。**

---

## 2. 环境前提

你的机器上 Node 不在默认 PATH，在这里：

```bash
export PATH="$HOME/.local/node-22/bin:$PATH"
node --version    # v22.23.4
npm --version     # 10.9.9
```

建议写进 `~/.bashrc`，省得每次 export。

**为什么是 Node 22**：22.18+ 原生支持直接跑 `.ts`（类型擦除），不需要 ts-node、不需要编译、不需要任何依赖。这对 8GB 内存 + 机械硬盘的机器很关键——没有 node_modules 那个黑洞。

**代价（必须记住的三条语法纪律）**：
1. 禁止 `enum`、`namespace`、构造函数参数属性（`constructor(private x: T)`）——这些不是"可擦除语法"。用 `const` 对象 + 联合类型代替，见 `errors.ts` 的 `ErrCode`。
2. 类型导入必须写 `import type`。写成普通 `import` 会在运行时残留一条真实 import，然后炸。
3. 导入本地文件必须带 `.ts` 后缀（`tsconfig.json` 里 `allowImportingTsExtensions: true`）。

`tsconfig.json` 里 `erasableSyntaxOnly: true` 就是让编辑器帮你守住第 1 条。

**不需要做的事**：`npm install`（零依赖）、装 Ollama（不用本地模型）、申请 API key（默认走 stdio 宿主大脑）。

---

## 3. 搭建步骤

每一步的格式：**做什么 → 怎么做 → 验证 → 知识点 → 会撞的故障**。

### Step 0：立契约（`src/types.ts`）

**做什么**：先把所有接口写死，再写实现。agent 项目最容易失控的地方是"大脑返回什么"和"工具接受什么"没有契约，写到第三层就开始互相猜。

**怎么做**：定义这几个核心类型，其余都是它们的组合。

```ts
export interface Decision { thought: string; call: ToolCall; }   // 大脑一次输出 = 想法 + 一个动作
export interface Brain { readonly id: string; decide(req: DecideRequest): Promise<Decision>; }
export interface Tool extends ToolSpec { run(args, ctx: ToolContext): Promise<ToolResult> | ToolResult; }
export type StopReason = 'finished' | 'max_steps' | 'wall_clock' | 'loop_detected' | 'brain_failed';
```

**关键设计**：
- `thought` 是必填的。它是"有大脑"的证据——脚本不需要解释自己为什么这么做。
- `Brain` 是接口不是类。harness 不认识模型，只认识这个接口。这就是为什么能零 key 跑。
- `ToolResult.output` 是**给大脑看的文本**，失败时必须是可读理由，不能是 `"invalid"`。

**验证**：`node --check` 不适用 TS，直接进 Step 1 一起验。

**知识点**：接口先行 / 依赖倒置。ACI（Agent-Computer Interface）设计——SWE-agent 论文的核心贡献不是模型，是"给模型用的界面怎么设计"。

**前端映射**：和你写 Redux 先定义 action type 再写 reducer 一模一样。

**会撞的故障**：用了 `enum StopReason` → Node 直接报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。改成 `const` 对象 + `as const` + 索引取值类型。

---

### Step 1：确定性地基（`src/rng.ts`）

**做什么**：让"同样输入 → 同样结果"成为可能。这是后面差分公证器的地基，**必须第一天就做对**，后补等于重写。

**怎么做**：
- `createRng(seed)`：mulberry32，30 行，返回 `() => number`。**注入式**——工具通过 `ctx.rng` 拿随机数，禁止任何地方直接写 `Math.random()`。
- `seedFromString(s)`：FNV-1a，让 `--seed run-42` 这种人类可读种子也能用。
- `canonical(obj)`：递归按键名排序后序列化。`{a,b}` 和 `{b,a}` 必须得到同一个字符串。
- `hashState(obj)`：sha256 取前 16 位十六进制。

**验证**：
```bash
node --test test/rng-context.test.ts
```
预期：同种子 50 个随机数完全一致；键序无关、**数组顺序敏感**。

**知识点**：确定性重放三要素 = **seed + initialState + actionSequence**。少了任何一个，"我复现了 bug"这句话就不成立。

**前端映射**：Redux DevTools 的时间旅行就是这个原理。你早就懂了，只是没意识到它能用来抓游戏 bug。

**会撞的故障**：
- 在 sim 层偷偷读了 `Date.now()` → 重放时对不上，而且**偶尔**对得上，最难查。纪律：世界层不许读时钟，时间由外部按固定步长注入。
- 用 `JSON.stringify` 直接哈希 → 键序一变哈希就变，误报"状态分叉"。必须先 `canonical`。
- 浮点累加 → 跨平台末位差。M2 做游戏世界时要用整数或定点数。

---

### Step 2：痛觉（`src/errors.ts`）

**做什么**：把任意异常归一成带错误码的 `HarnessError`，并且**认得真实的错误形状**。

**怎么做**：这一步是被真实 bug 教出来的。你之前那个 Python `llm_client.py`：

```python
except TimeoutError as e:      # 内建 TimeoutError，httpx 抛的根本不是它 → 分支从没执行过
except ConnectionError as e:   # 同上
    raise LLMRequestError(...) # 导入的名字叫 LLMRequestionError → 真进来就 NameError
```

分支写了，但从没跑过。所以这里每一条分类都必须有测试真的触发它。

真实形状是：
```ts
if (e.name === 'TimeoutError' || e.name === 'AbortError')  // AbortSignal.timeout 抛的是 DOMException
const causeCode = e.cause?.code;                            // fetch 连不上是 TypeError('fetch failed')，真因在 cause 里
if (e.message.includes('fetch failed') || causeCode) → BRAIN_CONNECTION
// HTTP 4xx/5xx 根本不是异常！是 response.ok === false，必须单独判
```

还有 `readable(code, message, hint)`：所有给大脑的拒绝理由都带「怎么办」。

**验证**：
```bash
node --test test/errors.test.ts
```
11 个测试，其中 5 个打真实网络：4 个起本地 `node:http` 服务器（500 / 空返回 / 正常 / 真延迟超时），1 个打真实被拒端口。

**知识点**：错误分类学。`E_BRAIN_*` 是大脑的错（该重试/换大脑），`E_TOOL_*` 是动作的错（该换动作，循环继续）。**这个区分决定了循环要不要中断**——分不清就会一遇错就整个 agent 死掉。

**前端映射**：Sentry 的 error grouping；以及你熟悉的"网络错误 vs 业务错误"分开处理。

**会撞的故障**：把 HTTP 500 当异常 catch → 永远捕不到，agent 拿到一坨 HTML 当模型输出去解析。

---

### Step 3：听懂人话（`src/parse.ts`）

**做什么**：模型不会永远乖乖返回纯 JSON。它会加代码围栏、加"好的，我的决策如下"、把 `args` 写成字符串、把 `call` 写成 `action`。

**怎么做**：
- `stripFence()`：剥 ```json 围栏。
- `extractJsonObject()`：**平衡括号扫描器**，且必须尊重字符串与转义。不能用正则——`{"thought":"我用了 { 和 }"}` 会让正则当场翻车。
- `parseDecision()`：容忍围栏/散文/`args` 是 JSON 字符串/别名（`tool`、`action`、`arguments`）。
- `repairHint(err, toolNames)`：解析失败时生成**回炉提示**，告诉大脑错在哪、可用工具有哪些。

**验证**：
```bash
node --test test/parse.test.ts   # 13 个
```
含"字符串里有大括号"、"括号不闭合"、"缺 call"、"空工具名"、"args 是数组"。

**知识点**：容错解析 + 修复式重试（repair loop）。**回炉不是重试**：重试是原样再问一遍，回炉是把错误原因喂回去让它改。前者浪费钱，后者真能修好。

**前端映射**：处理第三方接口返回的脏数据。你干过。

**会撞的故障**：用 `JSON.parse(content)` 裸解析 → 模型一加围栏就 `brain_failed`，你会误以为"模型不行"，其实是你的解析器不行。

---

### Step 4：手（`src/tools/registry.ts`）

**做什么**：工具注册、参数校验、执行、沙箱边界。

**怎么做**：
- `register/names/specs/has/execute`。`specs()` 只导出 `{name, description, params}`，**不把 run 函数暴露给大脑**。
- `validateArgs`：未知参数 / 缺必填 / 类型错，三种都返回**可行动**的拒绝：
  ```
  没有名为 "read" 的工具。可用工具只有：list_dir, read_file, note, finish。请从中选一个。
  工具 "read_file" 缺少必填参数 "path"（string）。说明：相对沙箱根的文件路径
  ```
- `resolveInSandbox(sandbox, p)`：`resolve` 后检查是否仍在根内，越界抛 `SandboxEscape`，理由里写明边界在哪。
- 工具内部抛错 → 捕获成 `E_TOOL_RUNTIME`，**循环继续**。

**验证**：
```bash
node --test test/registry.test.ts   # 12 个
```
含 `../` 越界、`/etc/passwd`、ENOENT、把目录当文件读、重复注册、内部抛错。

**知识点**：ACI 的核心一课——拒绝理由写 `"invalid"`，大脑无法自我纠正，只会重试同一个错；写 `"门锁了，你还没有钥匙"`，大脑能换策略。**你给模型的不是错误码，是下一步的线索。**

**前端映射**：表单校验的错误文案设计。以及 `elementFromPoint` 的命中判定思路。

**会撞的故障**：沙箱只判 `startsWith(root)` → `/root-evil` 能骗过 `/root`。必须判 `root + sep`。这个测试里有。

**安全边界**：内置工具**不提供 shell 执行**。最小 harness 不该自带任意命令执行能力。M1 加"手"时也要走白名单动作，不是 `exec(模型给的字符串)`。

---

### Step 5：眼与记忆雏形（`src/tools/builtin.ts`）

**做什么**：四个工具，覆盖 harness 需要验证的全部路径。

| 工具 | 作用 | 为什么必须有 |
|---|---|---|
| `list_dir` | 列目录（path 可选） | 观察入口 |
| `read_file` | 读文本，上限 8000 字符 | 观察细节；上限防止一次撑爆上下文 |
| `note` | 写假设板 | **长期记忆雏形**，不随上下文截断丢失 |
| `finish` | 显式收手，必须给结论 | 让大脑**自己决定**何时停，而不是只能被预算掐死 |

`snapshotSandbox()` 产出可序列化的初始状态快照 → 重放三要素之一。

**验证**：Step 4 的测试已覆盖 happy path 与失败 path。

**知识点**：`finish` 是五种停止条件里**唯一由大脑主动触发**的。没有它，agent 只会撞到预算墙，你永远不知道它"觉得自己做完了没有"。

**前端映射**：`list_dir`/`read_file` 就是 DOM 查询。M1 会把它们换成"看渲染结果"，但**接口形状不变**——这就是为什么现在做对。

**会撞的故障（重要）**：M1 做眼睛时，**绝不能让眼睛读内部状态 JSON**。那是读心，不是看。零说明书原则要求 agent 只能看到玩家能看到的东西。内部状态只给裁判和日志用。

---

### Step 6：海马体（`src/context.ts`）

**做什么**：上下文预算管理。这是最容易被忽略、却最决定成败的一脏。

**怎么做**：四条原则，代码 70 行。
1. **system 永不截断**（它是任务与契约）。
2. **假设板单独常驻**，不随消息被截掉——否则"我为什么在撞这扇门"会丢。
3. 保留最近 `keepRecent` 条，旧的从新到旧回填，塞不下就停。
4. 省略时**显式标注省略了多少条**：
   ```
   [上下文已截断：省略了中间 12 条较早的消息。如需早期信息，请用工具重新读取，不要凭记忆猜测。]
   ```

第 4 条是灵魂：**让大脑知道自己失忆了**，而不是以为世界本来就这样。没有这句，模型会开始编造早期观察。

预算按字符估算（`content.length + 16`），**诚实标注为估算，不是精确 token**。

**验证**：
```bash
node --test test/rng-context.test.ts
```

**知识点**：上下文窗口是 agent 的工作记忆。截断策略 = 记忆策略。

**前端映射**：虚拟列表。只渲染可见区，但要告诉用户"上面还有 1200 条"。

**会撞的故障（今天真撞到了）**：预算小于「地板」（system + 最近 N 条）时，硬截断会把契约砍掉。正确行为是**保住地板并显式报告超预算**：
```ts
overBudget: chars > budget.maxContextChars   // BuiltContext 新增字段
```
循环层第一次遇到就 `log` + 写一条 `context_over_budget` 证据事件。**沉默的失效最难查**——使用者以为截断在生效，实际上下文一路膨胀。

---

### Step 7：嘴（`src/brain/prompt.ts`）

**做什么**：装配 system 提示词。**这一步有一条不可越过的界线。**

**怎么做**：只给**接口说明**，不给**策略手册**。

- 给：任务、工具清单（名字/描述/参数/必填性）、输出契约、一次一个工具、失败要调整、重要发现写 note、完事调 finish。
- **绝不给**："优先探索未访问区域"、"注意边界值"、"用二分法缩小范围"、"检查覆盖率"。

工具描述相当于键盘上印的字母——那是接口，人也需要知道键盘长什么样。但测试策略是**答案**。给了就等于开卷考试，你测出来的"发现缺陷能力"是假的。

`test/prompt.test.ts` 里有一条测试专门守这条界线：
```ts
for (const banned of ['优先探索', '边界值', '未访问区域', '二分', '覆盖率', '变异']) {
  assert.ok(!s.includes(banned), `system 不该出现策略提示：${banned}`);
}
```

**知识点**：零说明书自主学习。预测-对照曲线（M4）之所以能证明"它自己学会了规则"，前提就是没人提前告诉它规则。

**会撞的故障（今天真撞到了，见 §8 故障台账 #1）**：`system` 字段一度被填成光秃秃的任务文本，契约根本没送出去。

---

### Step 8：大脑三选一（`src/brain/`）

**做什么**：实现 `Brain` 接口的三个版本。**不使用任何本地模型。**

| 模式 | id | 用途 | 需要什么 |
|---|---|---|---|
| `stdio` | `stdio:host` | **默认**。宿主（Qoder / Claude Code / Codex / 你本人）提供决策 | 零 key，零安装 |
| `openai` | `openai:<model>` | 任意 OpenAI 兼容**远端**端点 | `.env` 里填 base_url / key / model |
| `mock` | `mock:TEST-DOUBLE` | **仅单元测试**。按脚本吐决策，无任何智能 | 必须显式加旗标才允许在 CLI 跑 |

**`openai.ts`（81 行）刻意不依赖 function-calling**：把工具契约写进 system、要求返回 JSON。理由是兼容性——不是所有兼容端点都支持 `tools` 字段，但都支持聊天。换供应商只改环境变量。

**`mock.ts` 的门禁**是设计的一部分，不是摆设：
```bash
node src/cli.ts --brain mock --task "x"
# 拒绝：mock 是测试替身，不是大脑。仅在单元测试中使用；
#      如确要跑，加 --i-know-mock-is-not-a-brain
# exit=1
```
为什么这么严？因为"离线兜底大脑"正是被明确否决的**启发式冒充模型决策**。一旦允许 mock 悄悄顶上，你演示的就不是 agent，是脚本。这个旗标名字故意写得很难看，就是要让你每次用都想起这件事。

**`index.ts` 还藏了个零依赖 `.env` 解析器**：支持引号、行内注释、等号两侧空格，**不覆盖已存在的环境变量**（所以命令行临时 export 优先）。

**验证**：
```bash
node --test test/errors.test.ts    # 真实 HTTP 服务器打远端分支
npm run smoke                      # 机械冒烟，只验接线
```

**知识点**：宿主大脑模式（host-brain）。铲子不自带发动机，插上别人的发动机就能用。M5 会把它包成 MCP server，那时"别人的发动机"就是标准接口而不是手打 JSON。

**前端映射**：适配器模式 + 依赖注入。像你换 axios/fetch，业务代码不动。

---

### Step 9：心脏（`src/loop.ts`）

**做什么**：把前面八层串起来。183 行，agent 的全部秘密。

**怎么做**：一个带标签的 `outer:` 循环。

```ts
outer: for (let step = 1; step <= config.maxSteps; step++) {
  if (Date.now() - startedAt >= config.maxWallMs) { stopReason = 'wall_clock'; break; }

  const built = buildContext(system, history, { maxContextChars, keepRecent });

  // ── 决策（含解析回炉）──
  let decision: Decision | undefined;
  for (;;) {
    try { decision = await brain.decide({ task, system, messages: built.messages, tools, step, notes }); break; }
    catch (e) {
      const he = classify(e);
      writer.event('brain_error', { step, attempt, error: he.toInfo() });   // 失败也留档
      if (he.code === ErrCode.BRAIN_PARSE && attempt < config.maxParseRetry) {
        attempt++;
        history.push({ role: 'user', content: repairHint(he, registry.names()) });  // 回炉，不是重试
        continue;
      }
      stopReason = 'brain_failed'; break outer;
    }
  }
  if (!decision) { stopReason = 'brain_failed'; break outer; }

  // ── 执行 ──
  const result = await registry.execute(decision.call, ctx);
  const stateHash = hashState({ notes, entries: snapshotSandbox(sandbox), lastTool, lastOk });
  writer.step({ index: step, decision, result, stateHash, contextChars, brainMs, toolMs });

  history.push({ role: 'assistant', content: JSON.stringify(decision) });
  history.push({ role: 'tool', toolName: decision.call.name, content: result.output });

  if (decision.call.name === 'finish') { stopReason = 'finished'; break; }

  // ── 死循环检测：规范化后的动作签名连续相同 ──
  const sig = canonical(decision.call);
  if (sig === lastSig) repeatCount++; else { lastSig = sig; repeatCount = 1; }
  if (repeatCount >= config.repeatLimit) { stopReason = 'loop_detected'; break; }
}
```

**五种停止条件，缺一不可**：

| stopReason | 触发 | 为什么需要 |
|---|---|---|
| `finished` | 大脑自己调 `finish` | 唯一由大脑主动触发，证明它有判断力 |
| `max_steps` | 步数预算耗尽 | 防无限烧钱 |
| `wall_clock` | 时间预算耗尽 | 防单步卡死 |
| `loop_detected` | 连续 N 次完全相同动作 | 模型卡住时最常见的形态 |
| `brain_failed` | 大脑连续失败且回炉无效 | 区分"世界的问题"和"大脑的问题" |

**注意 `stateHash` 的语义**：它哈希的是**世界状态**（假设板 + 沙箱条目 + 最后一个动作及其成败），不是观察内容。所以连续两次 `read_file` 不同文件会得到**同一个哈希**——这是对的，只读动作不改变世界。今天那次真实运行里第 2、3 步哈希都是 `e665d86f6246bd18`，正好印证。

**验证**：
```bash
node --test test/loop.test.ts   # 11 个，五种停止条件全跑
```

**知识点**：这就是 agent。没有别的魔法。剩下所有工作都是把"眼"和"手"做得更真、把"记忆"做得更长、把"证据"做得更硬。

**前端映射**：游戏主循环 / Redux 的 dispatch 循环。`history.push` 就是 action log。

**会撞的故障**：
- 工具失败就 `break` → agent 一遇到"文件不存在"就整个死掉。正确做法：失败理由进上下文，循环继续，让大脑自己换策略。
- 死循环检测用 `JSON.stringify(call)` 而不是 `canonical(call)` → 键序一变就检测不到。
- 忘记 `if (!decision)` 兜底 → TypeScript 严格模式下 `decision` 可能是 `undefined`，编译期就该拦住。

---

### Step 10：公证处 + 门面（`src/trace.ts`、`src/cli.ts`）

**公证处铁律**：**证据由代码写，绝不交给模型总结。** 模型一压缩，seed / 初始状态 / 动作序列就可能失真，可复现性当场作废。所以逐条 append 原始 JSON，不做任何"摘要"。

**CLI 输出纪律**：人类日志一律 **stderr**，stdout 留给 stdio 大脑协议。否则协议会被日志污染。（MCP 的 stdio transport 也是这条规矩。）

**退出码**：`0`=finished，`2`=其他停止原因，`1`=配置/启动错误。便于将来接 CI。

**验证**：见 §5 的完整实操。

---

## 4. 三种大脑怎么选

```bash
# 默认：宿主大脑，零 key，零本地模型（推荐先用这个）
node src/cli.ts --brain stdio --task "你的任务"

# 有云端 key 时：任意 OpenAI 兼容远端端点
cp .env.example .env      # 填 BRAIN_BASE_URL / BRAIN_API_KEY / BRAIN_MODEL
node src/cli.ts --brain openai --task "你的任务"

# 仅机械冒烟（不是大脑，别拿它演示）
npm run smoke
```

`.env` 注意：`BRAIN_BASE_URL` 要带 `/v1` 这一层，代码自动补 `/chat/completions`。

**全部 CLI 选项**：

| 选项 | 默认 | 说明 |
|---|---|---|
| `--brain` | `stdio` | `stdio` / `openai` / `mock` |
| `--task` | 必填 | 任务描述。**只写目标，不写方法** |
| `--sandbox` | `./sandbox` | 工具可访问的根，不存在会自动创建并放入示例文件 |
| `--seed` | `42` | 数字或字符串（字符串会哈希成整数） |
| `--max-steps` | `20` | 步数预算 |
| `--max-wall-ms` | `300000` | 时间预算 |
| `--max-context-chars` | `12000` | 上下文字符预算（估算） |
| `--keep-recent` | `8` | 保留最近消息条数 |
| `--max-parse-retry` | `2` | 解析失败回炉次数 |
| `--repeat-limit` | `3` | 连续重复动作判死循环阈值 |
| `--out` | `./runs` | 证据输出根 |
| `--i-know-mock-is-not-a-brain` | — | 允许 mock |

---

## 5. 亲手当大脑：完整可复制流程

这是**已经真跑过一遍**的流程。我用它在 7 步内自主发现了一处缺陷，全程零 key、零本地模型。

### 5.1 stdio 协议

```
harness → stdout  一行  {"type":"decide", task, system, messages, tools, step, notes}
宿主    → stdin   一行  {"thought":"...", "call":{"name":"...", "args":{}}}
```

也接受包一层 `{"type":"decision","decision":{...}}`，或直接给一段能解析出 Decision 的字符串。
等待超时（默认 600 秒）或 stdin EOF → `E_BRAIN_PROTOCOL` → `brain_failed`，**并留档**。

### 5.2 用 FIFO 驱动（复制即用）

```bash
export PATH="$HOME/.local/node-22/bin:$PATH"
cd ~/Documents/workspace/agent-harness

mkdir -p /tmp/h-e2e
mkfifo /tmp/h-e2e/in

# 持有写端，否则 node 一读就 EOF
nohup sleep 900 > /tmp/h-e2e/in 2>/dev/null & disown

# 启动 harness，stdout 收请求，stderr 收人类日志
nohup node src/cli.ts --brain stdio \
  --task "这是一个小游戏服务端的配置目录。请自己观察，判断线上实际行为是否与设计意图一致；若发现不一致，指出具体证据。没有说明书，规则要你自己从文件里读出来。" \
  --sandbox /tmp/h-e2e/sandbox --seed 2026 --max-steps 12 --out /tmp/h-e2e/runs \
  < /tmp/h-e2e/in > /tmp/h-e2e/out.jsonl 2> /tmp/h-e2e/log.txt & disown

# 看当前请求（你作为大脑，只能看这里，不许去偷看沙箱）
node -e 'const L=require("fs").readFileSync("/tmp/h-e2e/out.jsonl","utf8").trim().split("\n");
const r=JSON.parse(L[L.length-1]);console.log("step",r.step);
for(const m of r.messages.slice(-2))console.log(`[${m.role}]`,m.content)'

# 给出你的决策
printf '%s\n' '{"thought":"先看看有什么","call":{"name":"list_dir","args":{}}}' > /tmp/h-e2e/in
```

重复「看请求 → 写决策」直到 `finish`。然后 `cat /tmp/h-e2e/log.txt` 看全程。

**纪律**：当大脑时，**只根据工具返回的观察做决策**。世界作者知道答案，大脑不许知道。否则你验证的是自己的记忆力，不是 agent 的能力。

### 5.3 那次真实运行的结果

沙箱里三个文件（`rules.json` / `changelog.md` / `server.log`），大脑事先不知道内容。

```
[1] list_dir({})                    → ok   拿到三个文件名
[2] read_file({"path":"rules.json"}) → ok   max_players=4, version=1.2.0
[3] read_file({"path":"changelog.md"})→ ok  v1.2.0 要求上限提到 6 ← 矛盾出现
[4] note({"text":"候选缺陷…"})        → ok   写进假设板，防截断丢失
[5] read_file({"path":"server.log"}) → ok   p=5/p=6 被拒 lobby full (4/4) ← 证实
[6] note({"text":"已证实…"})          → ok
[7] finish({"summary":"…"})          → ok   stop=finished

[done] stop=finished steps=7 假设板 2 条
```

结论（大脑自己写的）：v1.2.0 的人数上限变更未落到 `rules.json`，属配置漏改；并主动划清边界——`turn_seconds=30` 与日志一致无问题，`respawn=true` 因日志无死亡事件**无法验证，不下结论**。

**这一步证明了什么**：harness 的 plumbing 全通，大脑能自主观察→形成假设→记忆→验证→收手。
**这一步没证明什么**：不是"agent 发现了未知缺陷"的能力评测——世界是我造的，我知道答案。真正的能力评测要靠 M3 的变异靶场（缺陷位置与类型对 agent 隐藏）。

### 5.4 真模型自主运行（已配置并跑通）

`.env` 已填好远端端点（`agnes-2.5-flash`）。**注意接线细节**：原始配置的 URL 带了 `/chat/completions`，而代码会自己补这一层，所以 `BRAIN_BASE_URL` 只能写到 `/v1`，否则拼成双重路径。

```bash
node src/cli.ts --brain openai --task "…" --sandbox /tmp/h-e2e/sandbox --seed 2026 --max-steps 12
```

同一个世界、同一个任务，真模型自己跑：

```
[1] list_dir            → ok   2756ms
[2] read_file changelog → ok   5221ms   先读意图（和我先读配置的顺序相反）
[3] read_file rules     → ok   1843ms
[4] read_file server.log→ ok   2049ms
[5] note                → ok   3989ms   主动把发现存进假设板
[6] finish              → ok   2760ms   stop=finished，总 18.6 秒，exit=0
```

它自己找到同一处缺陷，还多引用了一条我没用过的证据（`match started id=A7 players=4`）。

**两次运行的对照价值**：第 1 步 `stateHash` 完全相同（`ff2572ab9c2be6bd`）——同种子、同初始世界、同第一个动作 → 同世界状态。后面分叉，因为动作序列不同。**这正是差分公证器的工作原理**，在真实运行里已经看到雏形。

**这一步证明了什么**：真 LLM 能自主驱动整个循环，零手喂、零本地模型、零说明书。
**这一步没证明什么**：世界是我造的，我知道答案。能力评测仍要靠 M3 变异靶场。

证据：`runs/e2e-real-model-6steps/`，以及失败那次 `runs/e2e-real-model-http400/`（见 §8 故障 #4）。

---

## 6. 证据格式：重放三要素

每次运行产出 `runs/<时间戳>-s<seed>/`：

```
header.json    seed + initialState + task + config + brainId     ← 三要素之二
trace.jsonl    每步完整记录，逐条 append，含失败事件            ← 无损过程
result.json    stopReason + steps + notes + actionSequence      ← 三要素之三
```

`trace.jsonl` 每行一个 `StepRecord`：
```json
{"index":1,"at":"...","decision":{"thought":"...","call":{...}},
 "result":{"ok":true,"output":"..."},"stateHash":"ff2572ab9c2be6bd",
 "contextChars":775,"brainMs":97860,"toolMs":1}
```

失败路径也留档（**没走到工具的事件同样可审计**）：
```json
{"kind":"brain_error","at":"...","payload":{"step":1,"attempt":0,
 "error":{"code":"E_BRAIN_PROTOCOL","message":"宿主输入已关闭（stdin EOF），无法继续决策"}}}
{"kind":"context_over_budget","payload":{"maxContextChars":400,"actualChars":811,"keepRecent":2}}
{"kind":"loop_detected","payload":{"step":3,"sig":"...","repeatCount":3}}
```

**为什么这份证据能独立重放**：`result.json` 里的 `actionSequence` 是纯动作数组，脱离 harness 也能喂给任何实现同样工具接口的世界。加上 `header.json` 的 seed 与 initialState，第三方可以逐位复现，不需要相信你的叙述。

**这是整个项目的硬通货**。M3 的差分公证器就靠它：参考版 vs 变异版 + 同一动作序列 → 第一个分叉点 + 最小化复现。

**已保留两份真实运行的证据，可以直接打开看**：

- `runs/e2e-real-model-6steps/` —— **真远端模型自主运行**，6 步 finished，18.6 秒
- `runs/e2e-real-model-http400/` —— 真模型第一次跑，第 2 步 HTTP 400（故障 #4 的原始证据）
- `runs/e2e-stdio-7steps/` —— 我当宿主大脑那次，7 步 finished，含 2 条假设板与完整结论
- `runs/e2e-stdio-eof-brain_failed/` —— 宿主立刻掉线那次，0 步，但 `trace.jsonl` 里仍有 `brain_error` 事件

第二份和第四份尤其值得看：**失败也必须可审计**。1 步就失败的运行照样产出完整三件套，我就是靠 `e2e-real-model-http400` 里的原始 400 body，30 秒定位到 `tool_call_id` 缺失的。

---

## 7. 测试

```bash
npm test                              # 377 个，约 25 秒
node --test test/loop.test.ts         # 单跑一层
node --test --test-name-pattern="回炉" test/loop.test.ts
node --test test/notary.test.ts       # M3 公证器 + ddmin
node --test test/retry.test.ts        # 429/5xx 重试分支（真发 HTTP、真数请求次数）
node --test test/loop-world.test.ts   # 死循环判据（走图 vs 真卡住）
node --test test/predict-loop.test.ts # M4-a 预测闭环（断言差异真进了下一次的 payload）
node --test test/board.test.ts        # M4-b1 记忆器官自身的不变量
node --test test/hypothesis.test.ts   # M4-b1 接线（含本地 HTTP 抓真实请求体）
node --test test/goal.test.ts         # M4-b2 目标器官自身的不变量（三态合取、计数闭合）
node --test test/world-goal.test.ts   # M4-b2 世界层等值核对（只认画面，绝不读内部状态）
node --test test/goal-loop.test.ts    # M4-b2 接线：声明→判定→原文上线→证据落盘 + seams 三档形状
npm run verify:m4                     # 独立复核三局真跑证据（不复用被测的核对代码）
npm run verify:board -- runs/<runDir> # 独立复核假设板（另写一套状态机与文本解析）
npm run verify:board:selftest         # 审计脚本自身的回归：注入 15 处错误 + 2 组反向对照（放宽必须配一条仍会失败）
npm run verify:goal                   # 独立复核目标通道（自带夹具：先生成证据再审它）
npm run verify:goal:selftest          # 目标审计的回归：注入 24 处错误 + 4 组反向对照
npm run verify:ablation               # M4-e 十局逐局汇总：只读证据 + 以局为单位的 Fisher 精确检验
npm run verify:random                 # M4-e 随机策略臂：4 个世界 seed × 2 个步预算 × 200 次，零 key
npm run verify:m4e                    # 一条命令：三套独立审计跑满十局 + 十局汇总（全绿 exit=0）
npm run verify:detect:ceiling         # M4-f 缺陷版靶场的预登记上限表：零 key 大 n（4800 例），先量"仪器能看到多少"
npm run verify:detect                 # M4-f 检出判决独立复核（9 局夹具 + 抽 40 行上限表逐行重算，含 [口径落盘]）
npm run verify:detect:reference       # M4-f 参考版误报率 0/4=0.0%（分母只收真大脑的参考版局；替身/夹具/缺陷局逐条剔除并出声）
npm run verify:detect:selftest        # M4-f 判决器篡改自检：注入 15 处 + 反向对照 4 组 = 19 例（含口径落盘三种篡改）
npm run verify:detect:model           # M4-f 真模型缺陷臂（受免费账号 429 额度限制，每局独立捕获、截断不带走整批）
node --test test/ablation.test.ts     # 汇总器自身：Fisher 手算可对 + 交叉核对两侧 + 缺证据守卫
node --test test/random-baseline.test.ts  # 随机臂自身：确定性、seed 敏感性、血量夹逼判据、Wilson 边界
```

⚠️ **四个 `verify:*` 脚本现在缺 run 目录就直接非零退出**（故障 #17）：三个审计（board/goal/predict）退 1，`replay.ts` 退 2 并打印用法。
不带目录时旧形状是"循环不执行 → 打印总计不一致 0 处 → 退出 0"，那是最危险的一种绿：**判据没跑，报表却全过**。

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `parse.test.ts` | 16 | 围栏/散文/字符串内大括号/args 是字符串/别名/不闭合/缺 call/空名/数组 args/回炉提示/**testing 简写与全写归一化**/**六种写歪的形状都留原文不猜目标** |
| `errors.test.ts` | 11 | DOMException 超时、fetch failed + cause、**真实 HTTP 500/空/正常/真超时/连接被拒** |
| `registry.test.ts` | 12 | 未知工具/缺参/类型错/多参/沙箱越界/ENOENT/目录当文件/重复注册/内部抛错 |
| `rng-context.test.ts` | 12 | 同种子一致/canonical 键序无关/数组顺序敏感/截断保 system/显式标记/超预算地板 |
| `loop.test.ts` | 11 | 五种停止条件/回炉成功/回炉耗尽留档/工具失败不中断/假设板抗截断/同种子同哈希 |
| `prompt.test.ts` | 8 | 契约含工具名与输出格式/**不含策略手册**/必填可选标注/假设板/**线上不得出现 tool 角色**/真实 HTTP 验证契约只发一份 |
| `world.test.ts` | 22 | **给 Date.now/Math.random 装炸弹**/step 纯函数/计数式随机 vs 有状态流对照/9 项能力语义/边界与死亡是规则不是能力 |
| `notary.test.ts` | 20 | diffFields 路径/**前置检查真抛 E_CONFIG**/**掩蔽夹具**/**首分叉≠缺陷位置夹具**/结构不变性 144 案例/ddmin 非单调+1-minimal+预算诚实 |
| `render.test.ts` | 20 | **泄漏检测**（只改敌人 dir/id/hp 或冷却 2↔3，屏幕文本必须逐字不变）/能力无关措辞/图例与血条/方向白名单拒绝理由可行动 |
| `session.test.ts` | 13 | **并发 apply 与串行逐帧哈希相同**（一只手）/覆盖账本夹具/内部状态不出现在任何工具输出/动作序列可独立重放 |
| `game.test.ts` | 20 | 工具白名单/**零说明书禁词**/撞墙是游戏语义不是工具错误/**两个 session不串台**/toWorldActions 滤掉 look/note/finish 与非法方向 |
| `retry.test.ts` | 21 | **429 两次后成功且三次 payload 逐位相同**/400 与 401 一次都不多撞/Retry-After 秒数与 HTTP 日期/超上限夹取/耗尽诚实放弃/**重试进 trace 与 result**/DecideRequest 不许有函数字段 |
| `loop-world.test.ts` | 10 | **故障 #6 复现：走图不算死循环**/真卡住仍拦下/**卡住时帧哈希仍每步不同**/文件模式原判据不被改坏/全链路能跑到 finish |
| `empty-repair.test.ts` | 12 | **故障 #7：空回复可回炉不掐断整局**/三种空形态/**故障 #8：回炉提示必须真进 payload**/提示对空回复不说"无法解析"/预算共用与耗尽诚实/连续两次回炉按序追加 |
| `observe.test.ts` | 14 | **伪造屏幕照实解析（证明它没在咨询世界）**/图例里的符号不算网格内容/缺行给 null 不猜/行长不齐与两个 @ 都不猜/负血量照实读/**内部字段不同而画面相同 → 观察必须相同** |
| `predict.test.ts` | 24 | **差异由代码算，自述改不了结论**/差值算术/**无法核对 ≠ 被违反**（未知字段、非法值、缺网格都不许判违反）/不给预测也留档/坐标三种写法与顺序歧义/**故障 #9：surprise 写歪既不猜 false 也不静默丢弃**/接口说明不泄露坐标原点/`advanced` 由画面帧号算，解析不到保守判 false |
| `predict-loop.test.ts` | 21 | **差异真出现在大脑下一次收到的消息里**（#8 的教训）/**回填原文逐字落盘，真跑也能证送达**/最后一步留档但不冒充已送达/note 与非法方向与 finish 都不核对/look 也核对但 `advanced=false` 分开计数/given=false 留档/账本逐项对账/**一份差异只被判断一次**/判断可追溯到具体哪一步/主观客观分开存/**加了预测闭环逐帧哈希仍与纯世界重放相同**/`--no-predict` 退回 M1 条件 |

| `board.test.ts` | 14 | **计数闭合恒等式**/**归因绝不改 status**/**交出去的一律是副本（否则后续写入篡改历史证据）**/被拒写入也落盘/改写正文 ≠ 改状态/纯笔记与结构化两条通道互不干扰/**出声名单两条互斥且都由事实推出**/四种归因失败文本都可行动 |
| `hypothesis.test.ts` | 25 | **假规则退役后真的离开活跃区**/**代码绝不自己淘汰**/**退役后的假设从线上 payload 的活跃区消失（本地 HTTP 抓真实请求体）**/落盘原文与请求渲染逐字相同/field 限定归因/无法核对单独累加/未知 id 不静默新建/形状写歪留原文/无 id 的 note 与 M1 逐字相同/**自称 confirmed 却零核对必须出声（故障 #13）**/加了记忆器官逐帧哈希仍与纯世界重放相同 |
| `goal.test.ts` | 17 | **计数闭合恒等式 met+unmet+unverifiable===checks**/**三态合取：一个 violated 压倒 unverifiable，判不出既不算达成也不算不达成**/**判定绝不改 status**/标 achieved·abandoned 之后照样判定/**出声判据三条互斥（一条目标最多一行提示）**/全字段无法核对要点出缺的接口/空条件不判定但要出声/形状写歪留原文单独计数/未知 id 与空操作与非法 status 一律拒绝/改条件要留 before 快照/交出去的一律是副本/只有首次达成才出声 |
| `world-goal.test.ts` | 16 | **词表只有绝对状态量，一个差值字段都不许有**/GOAL_SPEC 不泄题（不泄露坐标原点约定）/spec·fields·evaluate 三件套指向同一份词表/血量归零画面 → `hp:0` 判 ok（M07 的可核对起点）/一 ok 一 violated 一 unverifiable 时**合取不在这里做**/坐标顺序反了判违反/不认识的值不合法一律 unverifiable 不猜/缺 HUD 时血量分数判不出而网格照数/屏幕没网格就不许把空数组读成"0 个敌人"/纯函数不读时钟/**跨通道一致：同一写法在预测与目标两侧不许判成两样** |
| `goal-loop.test.ts` | 23 | goal 工具在 arena 注册并进契约、**文件模式整个不出现**/声明进去且每步对每条有条件目标判一次/**静态帧照样判定**（故障 #10 纪律搬过来）/标 abandoned 后面每步仍被判/**板面原文逐字上线**（落盘 text 与那次请求渲染一字不差）/只有首次满足才回填一句/条件写歪不丢不猜且出声/画面满足却仍 open：代码只数只出声/**自称 achieved 却从未满足：记一笔脱钩、状态照旧**/局末账本与快照同一次求出/目标与假设是两个器官互不吞计数/**doGoal:false 整条链路消失**/**header.seams 三档形状：全开/消融/文件模式（故障 #16）**/**uncheckable 文案必须与目标形状一致（故障 #15）**/registry 的 object 容错只拆对象型参数/defect.json 主客观分侧只靠 id 对账/stdio 宿主照样收到目标板 |
| `ablation.test.ts` | 13 | **Fisher 四例全部手算可对**（1/21；观测表就是最可能表时 p=1——"不显著"不许读成"没差异"；一方全中另一方全不中才给最小概率；某档没有局 → NaN，绝不能印成 0 或 1）/起步取"最早那次**可核对**的给出"，工具步写了却没得核对单独算 `emitted` 不混进 `given`/逐帧与账本对不上必须出声、goal 声明数对不上同样出声/被 429 打断的局标 `complete=false`，可核对不足 3 步时"起步"判为量不出（不进主判据分母）/**写了 testing 但归因没成立（fieldAbsent）必须放行**（#18 放行侧）与**五个桶合计对不上必须出声**（#18 拒绝侧）/缺一个证据文件要说清缺哪个、`main` 带着半截证据拒绝出表/不带任何 run 目录 → 退出码 1/**"与敌相邻过"与"整局没掉血"是两个独立口径**：同一局可以贴过身却一次血没掉（`hpSeen=[10]`），缺 `hpSeen` 字段的旧证据一律如实留 0 种、不猜成"没掉血" |
| `random-baseline.test.ts` | 5 | **同参数两次调用逐字相同**（随机臂必须确定性，否则大 n 的数字没有意义）/换一个世界 seed 数字必须变（否则动作生成器根本没用到 seed）/**hp 归零与"被打死"是否同一事件**靠 `hpBelowZeroCount` 恒 0 这条判据撑着，写死并给出血量夹逼的出处/Wilson 区间：全 0 的样本给出的是上界不是 0%，全中的样本下界不许谎报成 100%，n=0 → NaN/**贴身是掉血的前提不是结果**：`adjacencyRate=100%` 与 `neverHurtCount>0` 必须能同时成立，且步预算越长没掉血率越低（这条敢写死只因该臂确定性） |

**测试哲学**：每个 `catch` 分支都必须有测试真的触发它。这是从你那个 Python 文件的三个真 bug 换来的教训——**分支写了不等于分支跑过**。M3 又踩了一次：确定性前置检查的抛错分支原本无法触发，补了 `determinismProbe` 注入接缝才真跑了一遍。

**M4-b1 把这条纪律又推高一级**：测试替身 `ScriptBrain` **刻意经过 `parseDecision` 再返回**。两个真大脑都走解析器，替身若绕过它，喂给循环层的就是真跑永远不会出现的形状——那测的是一条不存在的路径，绿了也不算数。这个坑真踩了：21/23 红，根因不在产品代码，在替身。

**M3 的负面结论也写成了断言**（掩蔽会漏检、首分叉字段跨子系统传播）。用的种子/长度是实验探针实测后硬编码的夹具，不在测试里现场搜索——否则回归会随实现漂移，把"结论"变成"每次重新发现"。

---

## 8. 故障台账

学习单位不是"一章书"，是**一个可复现的失败**。格式固定：现象 → 根因 → 修法 → 归纳 → 回归测试。

### #1 契约根本没送出去（今天抓到）

- **现象**：65 个测试全绿，但 stdio 宿主收到的 `system` 只有任务文本，没有工具清单和输出格式。
- **根因**：`loop.ts` 写了 `system: config.task`。远端分支因为自己又拼了一遍 `buildSystem(req)` 才侥幸没坏——**两条路径看到两份不同的契约**。
- **修法**：契约在循环层装配一次（`buildSystem({task, tools})`），同时传给 `buildContext` 和 `DecideRequest.system`；`openai.ts` 改为直接搬 `req.system`，不再二次拼装。`buildSystem` 的入参收窄成 `SystemPromptInput`，循环层不必为了拼提示词去伪造消息历史。
- **归纳**：**契约类字段必须有内容断言，不能只断言"跑通了"。** 全绿的测试 suite 可以完全没检查过最重要的那个字段。
- **回归**：`test/prompt.test.ts` 新增 6 个，其中一个起真实 HTTP 服务器，断言 `system` 含工具名、含输出契约、**且只发一份**、假设板在场、失忆标记没被吞。

### #2 上下文预算沉默失效（今天抓到，由 #1 引出）

- **现象**：修好 #1 后，`maxContextChars: 400` 的测试红了——实际 `contextChars` 900+。
- **根因**：system 从 20 字符变成 599 字符，「system + 最近 N 条」这个**地板**本身就超预算。旧代码默默超支，使用者以为截断在生效。
- **修法**：不硬截断砍契约（那会更糟），而是保住地板 + 显式报告：`BuiltContext.overBudget`，循环层首次遇到就 log 并写 `context_over_budget` 证据事件。
- **归纳**：**软约束可以违反，但违反必须出声。** 沉默的失效比报错难查十倍。
- **回归**：`overBudget` 真假两例 + 循环层留档断言 + 预算充足时不误报。

### #3 `npm run demo` 写了但跑不起来（今天抓到）

- **现象**：`package.json` 的 `demo` 脚本用 `--brain mock` 却没加门禁旗标 → 必然 `exit=1`。
- **根因**：加门禁时忘了同步脚本。**脚本也是代码，也要跑一遍。**
- **修法**：改名 `smoke`（诚实：它只是机械冒烟，不是 agent 演示），补上旗标，任务文本写明"mock 不是大脑"。
- **回归**：`npm run smoke` 实跑 `exit=0`。

### #4 半套 function-calling 协议 → 真模型第 2 步 HTTP 400（今天抓到，最值钱的一条）

- **现象**：接上真远端模型，第 1 步 `list_dir` 成功，第 2 步直接 `E_BRAIN_HTTP: HTTP 400`，`stop=brain_failed`。
- **定位**：`trace.jsonl` 的 `brain_error` 事件里存着原始 body：
  ```
  messages[3]: missing field `tool_call_id`
  ```
- **根因**：`role:'tool'` 是 **function-calling 协议的一部分**，必须配 `tool_call_id`，且前一条 assistant 必须带 `tool_calls`。我们刻意不用 function-calling（兼容性优先），却发了 `role:'tool'` —— **半套协议 = 400**。
- **修法**：新增 `toWireMessages()`，工具结果在线上一律降级成 `user` 消息并标注来源 `[工具返回 list_dir]\n…`。内部契约（`Message.role='tool'`）不动，trace 与上下文仍需区分"谁说的"。**内部语义 ≠ 线上格式，这就是适配器的职责。**
- **顺手修**：`E_BRAIN_HTTP` 的 message 原来只写"HTTP 400"，理由藏在 detail 里，人得翻 trace 才知道为什么。改成把 body 前 220 字符直接放进 message —— **ACI 对人类同样适用，日志也是界面**。
- **归纳**：**桩验证接线，真模型验证协议语义，两者不能互相替代。** 这个缺陷穿过了三道关：67 个单元测试全绿、宿主大脑跑通、传输层桩跑通——因为桩不会校验 `tool_call_id`。只有真端点才拦得住。
- **回归**：`test/prompt.test.ts` 新增 2 个（线上不得出现 tool 角色、缺 toolName 也要标注来源），并在真实 HTTP 测试里加了同一断言。修完真模型 6 步跑通。

### #5 限流被当成致命错误 → 真模型对照组第 11 步被掐断（M1 抓到）

- **现象**：接真模型跑 arena 参考版对照组，前 10 步完全正常（自主 `look → move → attack → wait → note`，还自己写出了战斗规则假设），第 11 步 `E_BRAIN_HTTP: HTTP 429`，body 是 `You've reached the API rate limit for free users`，`stop=brain_failed`，整局作废。
- **定位**：`trace.jsonl` 的 `brain_error` 事件里存着原始 429 body——和 #4 一样，**失败可审计**这件事第二次救了场。
- **根因**：`openai.ts` 把所有 `!res.ok` 一律抛成同一个 `E_BRAIN_HTTP`，而 `loop.ts` 只给 `E_BRAIN_PARSE` 回炉机会。于是**可重试的限流被当成致命协议错误**。
  429 和 400 是两类东西：400 是"你话说错了"（重说一万遍也错），429 是"你说得对，但现在轮不到你"（等一会儿就好）。**分类错了，重试策略就全错。**
- **修法**（六处，缺一不可）：
  1. 让错误**自己携带** `retryable` 事实，而不是让上层拿状态码去猜。上层一旦开始 `if (status === 429 || status >= 500)`，分类知识就散落到每个调用点，换个供应商（有的把限流写成 503）就要改一圈。
  2. 429 单独一个码 `E_BRAIN_RATE_LIMIT`；`httpFailure()` 统一分类：429/408/5xx 可重试，其余 4xx 不可。
  3. 传输层指数退避 + 抖动，并**听服务端 `Retry-After`**。两种合法写法都认：延迟秒数与 HTTP 日期。只认前一种是常见半成品——碰到日期算出 `NaN`，`setTimeout(NaN)` 立刻触发，"退避重试"退化成"贴着限流墙连撞"。
  4. **重试必须重发逐位相同的 payload**，所以 payload 在重试循环外只装配一次。重试的定义是"同一句话再说一遍"，不是"换句话再说"。
  5. 每次重试写 `brain_retry` 证据事件，`result.json` 记 `brainRetries`。不记下来，trace 里第 11 步就只有一次请求，事后看 `brainMs` 会以为"模型慢"，**归因直接错**。
  6. 重试耗尽后诚实放弃：message 写明"已原地重试 N 次仍失败"，并**摘掉 `retryable`**，否则上层若再套一层重试就变成 4×4 次撞墙。`Retry-After` 远超上限时夹到上限后失败，不挂死一小时把 wall 预算烧光。
- **差点犯的错（自己拦住）**：把 `onRetry` 塞进 `DecideRequest`。`StdioBrain` 是把整个 req `JSON.stringify` 发到 stdout 的，**函数字段会被 JSON 静默丢掉**——远端能重试、宿主模式悄悄不能，且不报任何错。出声口只能挂在 brain 实例上。已加断言钉住这个坑。
- **归纳**：**错误分类的粒度决定容错策略的粒度。** 一个码装两类语义，就等于把"可恢复"和"不可恢复"混成一谈。#4 教的是"内部语义 ≠ 线上格式"，#5 教的是"线上状态码 ≠ 一种失败"。
- **回归**：`test/retry.test.ts` 新增 21 条，**真发 HTTP、真数请求次数**——只断言"抛了什么错"分不清"重试了"和"直接放弃了"。睡眠用注入点记录，不真等（否则一个测试睡 7 秒，还测不到退避数值）。全套 **183 测试全绿**。

### #6 死循环检测把"直线走图"误判成死循环（M1 真跑三局抓到，最隐蔽的一条）

- **现象**：接真模型跑 arena 三局（参考版对照组 / M02 / M07），**全部 `stop=loop_detected`**，被砍在 7~12 步。但逐帧看证据，玩家每步都在前进：
  - 对照组第 10/11/12 步都是 `move right`，玩家 `(4,2)→(5,2)→(6,2)→(7,2)`
  - M02 第 5/6/7 步都是 `move down`，玩家 `(0,1)→(1,1)→(2,1)`
  - M07 第 6/7/8 步都是 `move down`，正朝物品靠近
- **根因**：判据只比 `canonical(decision.call)`（动作签名），不问状态有没有变。**在网格世界里连续同向移动是合法导航，不是循环。动作相同 ≠ 局面相同。**
- **后果比"步数少"严重得多**：
  1. agent 从没机会调 `finish` → 三局都没有主观结论，6-C 要求的"给出结论和依据"无从谈起；
  2. M07（血量归零不死亡）永远走不到 hp=0 → 公证器报"未分叉"；
  3. 于是这个 **harness 自己造成的假阴性**，会被误读成"公证器检不出 M07"。M3 报告里 M07 检出率仅 4.2% 是**随机动作的覆盖率问题**，这次是**判据问题**——两种原因必须分开，否则归因全错。
- **修法中的陷阱（差点修错）**：最直觉的修法是"动作相同且 `stateHash` 相同才算循环"。但 `worldHash = hashState(s)`，而 `WorldState.tick` 每帧自增 → **帧哈希永远不同** → 检测彻底失效、永不触发。**这是把一个误报 bug 修成一个漏报 bug。**
- **正确修法**：两个哈希各司其职，不能互相替代。
  - `worldHash`：帧身份，**含 tick**，用于重放逐位比对（M3 公证器）
  - `situationHash`：局势身份，**不含 tick**，用于"这一步有没有进展"
  循环层新增可注入 `loopFingerprint`；世界模式传局势指纹，文件模式不传、保持原判据（重复写同一条 note 确实是卡住了，已有测试依赖它）。
- **归纳**：**"重复"不等于"卡住"。判停条件必须问效果，不能只问形式。**
  前端类比：Redux 里同一个 action type 连续 dispatch 不是死循环，只要 state 在变就是正常推进；死循环是 `state → 同一个 state`。`tick` 相当于 `Date.now()`，不该参与"局面是否相同"的判断。
- **回归**：`test/loop-world.test.ts` 新增 10 条，**两边都钉住**——走图不算循环（复现原故障形状）、真卡住仍算循环（M02 关巡逻后 `wait` / 撞墙）、卡住时帧哈希仍每步不同（证明 `worldHash` 不能当判据）、文件模式原判据不被改坏、全链路能跑到 `finish`。全套 **193 测试全绿**。

### #7 HTTP 200 但内容空串，被当成致命错误掐断整局（M1 第二批真跑抓到）

- **现象**：`runs/m1b-M02/20261113-084119-s6`，本来要跑 40 步：
  ```
  [32] 第1次失败 E_BRAIN_EMPTY: 大脑返回空内容
  [done] stop=brain_failed steps=31 世界动作=28
  ```
  模型这一步没说活，整局就死了。前面 28 个世界动作、12 次限流重试全都白熬。
- **根因**：`E_BRAIN_EMPTY` 是"200 但内容空"的业务错误，被归成**不可恢复**；而循环层当时只给 `E_BRAIN_PARSE` 回炉机会。
- **和 #5 是同一类病**：**瞬时失败被归成永久失败。** #5 是服务端拒绝（429），#7 是模型没说话。两者都"再问一遍就可能好"，却都被判了死刑。
- **修法归属（关键判断）**：空回复归**循环层**，传输层一行不动。
  - 判断依据不是"错在哪一层代码"，而是"**怎么修**"：修法是把提示塞进 `history` 再问一遍，传输层看不到 `history`，重发同一份 payload 治不了"模型没说话"。
  - 已有测试 `空内容不在传输层重试`（`retry.test.ts`）正好钉住了这条归属，改完继续绿。**一个失败类别只有一个重试主人**，这条纪律这次是反过来用的：它告诉我该修哪儿。
  - `repairHint` 按错误码分支：空回复说"你上一次的回复是空的"，解析失败才说"无法解析"。**对空回复说"无法解析"是撒谎**，会把模型引向错误的自我纠正（去修一个根本不存在的格式问题）。
- **归纳**：**错误分类要按"恢复手段"分，不是按"异常类型"分。** 前端类比：`fetch` 的 429 和表单校验失败都该重试/重填，但一个是等一会儿原样重发，一个是必须改内容再发——归成一类就必然有一边治错。
- **回归**：`test/empty-repair.test.ts`，真发 HTTP、真数请求次数、真读提示原话。覆盖三种空形态（空串 / 纯空白 / 没有 `content` 字段）、预算共用、耗尽诚实放弃、`maxParseRetry=0` 尊重用户配置。

### #8 回炉提示从来没进过 payload——"回炉"从 M0 起就是空转（写 #7 测试时挖出来，最值钱的一条）

- **现象**：为 #7 写的测试断言"重发的 payload 里必须含回炉提示"，**失败**。取到的最后一条 user 消息是任务原文 `'测试任务'`，提示压根不在请求里。
- **根因**：`buildContext` 在回炉内循环**外面**装配一次；`history.push(repairHint(...))` 之后 `continue`，重发的仍是那份**旧 `built.messages`**。提示只进了内存里的 history，没进线上 payload。
- **后果**：从 M0 起，"解析失败回炉"一直退化成"**原样再问一遍**"。之前真跑里第 27 步 `E_BRAIN_PARSE` 被"修好"，其实是 `temperature=0.7` 的运气碰对的，不是提示起了作用。**容错机制一直在，但一直没用。**
- **为什么 193 个测试都没抓到**：旧测试用 `MockBrain` 按脚本吐下一条决策，**压根不看输入**；断言只有 `stopReason === 'finished'` 和 trace 里有 `brain_error`。这两条在"提示没送到"的情况下照样成立。
- **差点犯的错（必须记下来）**：第一反应是"我的测试前提错了"，准备放松断言去迁就代码。**先去读了装配代码，才发现是代码错。** 判据是读代码，不是改断言——把真缺陷改成"测试写错了"，是这套工程里最危险的一种自我欺骗。
- **修法**：`const built` → `let built`，回炉分支里 push 完提示**重新装配**；超预算告警抽成可重入的 `warnBudget()`，避免重复代码。`built.chars` 仍记录"实际用于成功那次尝试"的上下文大小，语义不变。
- **归纳**：**"分支写了 ≠ 分支跑过"要再升一级："分支跑了 ≠ 分支起作用"。** 测容错必须测**线上 payload**，不能只测结局。前端类比：测一个"报错后重试并带上修正参数"的函数，只断言最终成功是不够的——得断言第二次请求的 body 里真的带了修正参数，否则它可能只是碰巧重试成功了。
- **回归**：3 条 payload 级判据——重发 payload 必须与上次不同、提示必须在里面、原有上下文不能被替换掉、连续两次回炉的两条提示按顺序都在。全套 **205 测试全绿**。

### #9 附加字段静默丢弃——"模型从不判断意外"这个结论无法归因（M4 真跑逼出来的）

- **现象**：M4 第一局真跑，`predictionStats.surpriseGiven = 0`。模型一次都没判断"是否意外"。但我**无法回答一个更基本的问题**：它是压根没写 `surprise`，还是写了但形状不对被我的解析器丢了？
- **根因**：`parseSurprise` 对不可用的形状直接 `return undefined`。于是"没判断"和"判断写歪了"在证据里长得一模一样——`decision.surprise` 都是 `undefined`，`Object.keys(decision)` 也都不含它。
- **为什么这是缺陷而不是小事**：两者的归因完全不同。前者是**契约没被遵守**（要改接口说明），后者是**容错没接住**（要改解析器）。M07 那一课已经付过学费：`未分叉` 必须能分清"没走到"还是"公证器不行"，否则会把 harness 的问题读成被测对象的问题。
- **修法**：`SurpriseJudgment.unexpected` 改成 `boolean | null`。`null` = 给了但形状不可用，原文留在 `why` 里，账本单独计 `surpriseMalformed`。**不猜**（绝不填 `false`，那会凭空制造"代码判违反、模型说不意外"）、**不丢**（证据不能因为形状不对而消失）。`predict` 那边同招：坏字符串塞进 `__malformed__` 字段，让"未知字段 → unverifiable"这条通用路径天然接住，既不伪造违反也不抹掉"它确实试着预测了"。
- **归纳**：**容错的两条底线是"不猜"和"不丢"，只守一条都会出错。** 我第一版只守了"不猜"，代价是归因能力。前端类比：表单校验失败时把整个字段丢掉，你就再也分不清"用户没填"和"填了但格式错"——埋点里这是两种完全不同的转化率问题。
- **回归**：`predict.test.ts` 断言五种坏形状都留档且 `unexpected === null`、原文可复核、字段真缺失时才是 `undefined`；`predict-loop.test.ts` 断言 `surpriseMalformed` 单独计数、不混进 `surpriseGiven`、不算成"说不意外"。

### #10 我为防灌水设的核对闸门，把最值钱的信号关在了门外（M4 真跑第 1 步就打脸）

- **现象**：M08-A 局（`runs/20261113-204204-s6`）第 1 步 `look`，agent 预测 `playerAt:[1,1]`、`enemyCount:2`、`pickupCount:1`；画面真值是 `[0,0]`、3、3。**三项全错，却一项都没被核对**——因为我的闸门规定"只有推进画面的步才核对"。
- **根因**：`applies` 写成 `isWorldTool(call.name) && result.ok`，把 `look` 整个排除。理由是"前后同一帧，核对它等于白送相符，准确率灌水"。
- **为什么理由只对了一半**：灌水担心是对的，但 `look` 不推进世界 ≠ 它没有可核对的事实。"我在哪、有几个敌人"是**对当前画面的断言**，照样能核对。而真跑证明：**整局最大的一次感知错误恰恰发生在这一步**（M1 §7 那 19 次越界自报也是同一类病）。
- **修法**：闸门改按"有没有可核对的事实"划——`look` 也核对；同时 `PredictionRecord.advanced` 由**屏幕上印着的帧号**算出（不读内部状态），`predictionStats.staticChecks` 单独计数。两类核对分开算准确率，灌水担心用"分开记"解决，而不是用"不做"解决。
- **归纳**：**闸门的判据要贴着"事实是否存在"，不要贴着"操作是否高级"。** 前端类比：快照测试里"首次渲染就断言"和"交互后断言"难度不同，你不会因此不测首次渲染，你会把它们分成两组用例。
- **回归**：`predict-loop.test.ts` 新增 look 局（`advanced=false`、两项违反被抓出、`staticChecks=1`、`worldActions=0`）与动作步 `advanced=true` 的对照；`predict.test.ts` 钉住帧号解析不到时保守判 `false`，不猜它推进了。

### #11 差异进了 history ≠ 能从证据里证明它进了 payload（写独立审计脚本时挖出来）

- **现象**：为 M4-a 写独立审计脚本，想验"真跑里差异确实送到了模型"，**验不了**。trace 只存了 `prediction`（判定结果），没存**实际回填给模型的那段原文**，也不存 outgoing payload。
- **根因**：#8 的教训只落实到了测试层（接线处断言 payload），没落实到**证据层**。真跑不留 payload，只留 trace——于是真跑的"送达"只能靠"模型引用了差异里的数字配对"去反推，那是**间接证据**。
- **为什么这算缺陷而不是不便**：这套工程的卖点是客观证据。一个只能靠被测对象自述来佐证的关键环节，等于把 #8 那种自说自话又请回来了。
- **修法**：新增 `prediction_feedback` 事件，落盘回填原文 + `aboutStep`。判据是确定的：**history 整份下发，所以只要存在第 N+1 步决策，第 N 步的回填原文就一定在那次请求里**。事件里**刻意不放 `delivered` 字段**——送达与否由审计从证据推出，不由引擎自述。
- **归纳**：**"分支跑了 ≠ 分支起作用"要再升一级："起作用了 ≠ 证据能证明它起作用"。** 前端类比：你在代码里 `console.log` 了请求体，不等于线上日志里查得到它；可观测性要按"事后能不能独立复核"来设计，不是按"我当时看没看见"。
- **回归**：两条新测试。一条断言落盘原文与下一次请求的 tool 消息**逐字相同**（`endsWith('\n\n' + text)`）；一条用 `maxSteps=1` 造出"核对了但整局随即结束"的情形，断言原文仍留档、且没有 `delivered` 字段冒充已送达。全套 **264 测试全绿**。
- **诚实局限**：三局真跑跑在这个事件落地之前，证据里没有它。审计脚本对此**单独报"已知证据缺口"，不假装通过**。下一次真跑（M4-e）才会带上它。

### #12 假规则永久驻留：记忆只进不出 = 错误单调累积（M4-a 两局独立复现，M4-b1 的目标故障）

- **现象**：对照组（`runs/20261113-203623-s6`）假设板第 2 条写着"**规则已确认**：每击杀相邻敌人+1分；攻击有冷却时间；**敌人数随帧变化（可能移动/新生成）**"。M08-B 局独立发明了同一条。而世界里 `ENEMY_COUNT=3`，**从不生成新敌人**，敌人数只减不增。
- **根因**：旧假设板是 append-only 的 `string[]`——没有 id、没有状态、没有淘汰、与客观核对结果毫无关联。于是这条假规则**每一步原样回喂**，永久驻留，成为后续所有决策的依据。
- **为什么这不是"模型笨"**：模型数错了敌人数（感知错误），然后**发明了一个机制来解释自己的错误**，而不是承认自己数错了。这是 M4-a 最重要的发现。harness 的责任是：它给这个发明提供了一个**只进不出的容器**。
- **修法**：新增记忆器官 `src/board.ts`。假设变成 `{id, text, status, checks/supported/contradicted/unverifiable}`；`note` 带 id 走结构化通道；模型可以 `status:"retired"` 淘汰它；核对计数由**代码**客观累加（模型声明 `testing:"H1"` 指出哪一步在检验哪条）；被反对却未淘汰时**只出声**，判断权显式交回模型。**淘汰不是删除**：id 与正文留档，模型才不会把同一条假规则再立一遍。
- **归纳**：**记忆器官必须有出口。** 前端类比：Redux store 里只 push 不清理的数组就是内存泄漏；缓存必须有失效策略，否则错误数据永久命中。"常驻不截断"是优点，"常驻且不可撤销"是缺陷。
- **回归**：`test/hypothesis.test.ts` 24 条 + `test/board.test.ts` 13 条；13 条路径的确定性夹具经独立审计 **0 处不一致**；审计自身再做篡改自检，**注入 14 处错误全抓**。
- **诚实局限**：真跑第一局模型立的 H1 是**真规则**（敌人确实朝玩家移动），所以"模型自己淘汰假规则"目前**只有夹具证据**（人写剧本），不能声称真跑已复现。夹具 runDir 绝不拿来当模型能力的证据。

### #13 自称已验证，客观账本零核对 → 淘汰机制永不触发（本轮真跑抓到）

- **现象**：`runs/20261113-215401-s6` 第 6 步，模型自己用了新假设板：
  ```
  note({"id":"H1","status":"confirmed",
        "why":"…此步验证了enemyCount和scoreDelta的预测与画面完全一致"})
  ```
  但局末 `H1.checks = 0`，账本 `attributed=0 / unattributed=7`。它**一次都没声明 `testing`**。
- **根因**：归因刻意不猜目标（猜错就是伪造归因），所以没声明就绝不记账。而出声条件当时只有"被客观反对"——计数恒为 0 → 反对恒为 0 → **永不出声 → 淘汰机制永不触发**。
- **为什么比"少记一笔账"严重得多**：#12 的整个修法依赖客观计数到达板子。计数永远是 0，机制就是空转。**这是故障 #8 的同一形态：写了、跑了、不起作用。** 而且它骗过了夹具——夹具里人写的剧本每一步都老老实实声明 `testing`。
- **修法**：把出声判据收进**唯一主人** `attention(h)`（渲染器与循环层共用，避免两处各写一套）；新增第二条事实条件 `status==='confirmed' && checks===0`；提示文案点出缺的那个接口（`testing`），否则模型无从行动；账本新增 `confirmedNoChecks`。两条**互斥**（被反对必然 checks>0），所以一条假设最多一行提示，名单与行数天然对得上。**代码仍然不改 status。**
- **刻意不做**：`proposed` 零核对不出声——那正是"待检验"的正常状态，出声就是制造噪音。只有"自称已成立"与"零核对"并存才是主客观脱钩。
- **归纳**：**接口给了 ≠ 模型会用；机制的触发条件必须覆盖"机制没被启用"这种状态。** 前端类比：你写了缓存失效逻辑，失效条件是"命中次数 > 0"，而调用方从来没传 `cacheKey` → 失效逻辑永远不跑，且一切看起来正常。
- **回归**：新测试先红后绿；夹具补第 13 条路径，让**局末** `confirmedNoChecks=1`（否则这项聚合是零样本审计＝假通过）；审计自检新增 3 例：删提示行、账本报 0、**删掉字段想把审计降级成旧版**（必须既大声报版本差异、又照样被抓）。全套 **304 测试全绿**。

### #14 审计把"请求撞墙"误判成"没送达"（真跑证据逼出来的审计缺陷）

- **现象**：第一局真跑过审计，报 1 处不一致：`1 份板面快照找不到对应的步记录`。
- **根因**：送达判据照抄了兄弟脚本的形状——"存在第 N 步的步记录"。但板子是**决策前**渲染的：第 10 步请求撞 429、整局终止，于是**有快照、无步记录**。判据把"请求发出但没拿到决策"与"根本没发请求"混成了一类。
- **修法**：三分类，缺一不可地分开记——① 有步记录（决策成功，最强证据）② 无步记录但有该步 `brain_error`/`brain_retry`（请求确实发出过）③ 两者都无（**这才是缺陷**）。并加**反向对照**：给同一步补上 `brain_error` 就必须放行，证明新判据不是"一律放过"。
- **归纳**：**两个通道的时序不同，判据必须不同。** `prediction_feedback` 是决策**后**回填，整局结束就真的没送到；板子是决策**前**下发，撞墙时它已经在 payload 里了。照抄兄弟脚本的判据 = 把时序差异抹掉。前端类比：请求拦截器里打的日志和响应拦截器里打的日志，不能拿同一个"有没有响应"去判送达。
- **回归**：自检第 11 例（渲染了却连请求都没发出）+ 反向对照 1 组。旧那局真跑按**版本纪律**处理：大声报"跑在 #13 修正之前"，按旧判据核对，不混进错误数也不假装通过。

### #15 代码的出声文案对目标形状说了谎（独立夹具第一次跑审计就抓到）

- **现象**：`verify/goal-fixture.ts` 第一次生成证据，`verify/goal-audit.ts` 报 **199 处不一致**。
  其中一条最能说明问题：G9 的完成条件是 `{"hp":10,"enemyCount":3,"foo":1}`——两个字段能核对、一个字段不在词表内，
  判定 6 轮全部落在"无法核对"（因为合取里有一个 violated/unverifiable 就整条判不出），
  而板子上印的却是"**没有可核对的完成条件**，或条件里的字段全不在词表内"。这句话对这条目标是假的。
- **根因**：`renderGoal` 的 `uncheckable` 分支用**一个模板覆盖三种不同形状**：
  ① 真的没给 `doneWhen`；② 给了但形状代码读不懂（`'hp=0'` 这种字符串）；③ 给了、字段也认识，只是这些轮的结果全落在无法核对。
  文案写的时候只有 ①② 在脑子里，夹具把 ③ 造出来之后它就开始说谎。
- **修法**：按 `goalCheckable(g)` 分成两套**只由数字支撑**的文案，并把实际计数写进句子（"判定 6 轮的结果全是「无法核对」"）。
  判断权仍交回模型，一个字都不越界。**代码说不出真相时宁可少说，不能说假话。**
- **归纳**：**出声文案是"代码说出口的话"，它和账本一样受事实约束，不是免费的修辞。** 模板复用 = 形状一变就撒谎；
  而且这种谎只出现在文案里，计数与判定全对，**单元测试永远不会红**——它是靠"独立重算 + 文案与形状互校"才暴露的。
  🟢 前端类比：一个 `errorMessage` 写死了"该字段未填写"，而真实情况是"填了但格式不对"——校验逻辑没错，用户照着提示补填空，永远补不好。
- **回归**：`test/goal-loop.test.ts` 新增"uncheckable 的文案必须与这条目标的形状一致"；
  审计里 `文案谎称` / `明明写了条件，文案却说它没有` / `文案没如实报出 N 轮全无法核对` 三条硬判据；
  自检注入第 17 例把旧说谎文案回注，必须被抓。

### #16 "旧版"与"消融版"在证据里长得一模一样——免检通道（写反向对照时自己撞出来的）

- **现象**：给目标审计写反向对照 2（"抹干净 goal 痕迹 → 应认成版本差异并放行"）时，改完三源判别它**失败**了：
  `initialState.goals` 这个键还在，于是审计正确地判成"通道开着却没跑"。往上追才发现真正的问题不在测试前提，
  而在证据本身——**审计对"这一局没开目标通道"是不审就放行的**，而"没开"这件事只能靠**证据里缺键**倒推。
  任何一种能靠删证据到达的分类，都是免检通道。
- **根因**：证据里没有"这一局开了哪些验证通道"的**声明**。于是三种情况在文件层是同一个形状：
  ① 该局跑在 M4-b2 之前（本来没这器官）；② 消融对照组 `--no-goal`（M4-e 要靠它做真对照）；③ 有人删了 goal 痕迹。
  ①② 都该放行，③ 必须抓——不放行就审不出 ③，放行就审不出 ①。
- **修法**：`RunHeader.seams = {predict, goal}`，由**循环层**写（它才是知道 `opts.prediction/opts.goal` 的主人，世界层不必各报一遍）。
  审计按可信度分三源用：声明（`seams`）→ 旁证（`initialState.goals` 键在不在）→ 产物（`goal_*` 事件、`goalStats`）。
  于是 ①无 seams 且三源皆空 → `[版本]` 放行但大声报；② `seams.goal=false` 且无产物 → `[消融]` 放行，它是**真对照组**；
  ③ `seams.goal=false` 却留着 goal 产物 → **硬故障**（开关与产物互相矛盾）。
- **⚠️ 残余局限（写清楚，不许假装已解决）**：把 `seams` 整块删掉仍能冒充 ①。证据层防得住部分删改，防不住全删——
  后者只能靠运行记录与 outDir 命名区分。**报告里必须把这条界线说出来**，否则就是把"防不住"说成"防住了"。
- **归纳**：**审计里每一次 `continue`（跳过不审）都必须配一条反向对照 + 一条"声明与产物必须一致"的硬判据。**
  🟢 前端类比：feature flag 的状态要写在响应头里，不能靠"这个字段没出现"倒推——那等于把灰度状态交给删除操作决定。
- **回归**：自检新增注入 5（声明 false 却留产物，必须抓）与对照 4（如实消融，必须放行）；
  `loop.test.ts` / `goal-loop.test.ts` 钉住三档形状：全开 `{true,true}`、消融 `{true,false}`、文件模式 `{false,false}`，
  外加"关掉通道时 `initialState.goals` 这个键也不许出现"（器官不存在 ≠ 器官存在且板子空着）。

### #17 不带目录的审计打出"总计不一致 0 处"（零样本假通过的第三种形态）

- **现象**：`npm run verify:board` 只输出一行 `===== 总计不一致 0 处 =====`，退出码 0。它一行都没审。
- **根因**：三个审计脚本的主循环都是 `for (const dir of process.argv.slice(2))`——没参数就不进循环，
  而 `grandBad` 初值是 0，收尾照常打印"0 处不一致"。和"零样本审计＝假通过"同源，只是这次发生在**参数层**而不是证据层。
- **修法**：三个审计脚本（`goal` / `board` / `predict`）入口统一加"没有目录 → 报错退出 1"；
  `replay.ts` 同病不同形——它缺参数时抛的是 `TypeError: Cannot read properties of undefined`，看着像程序坏了，其实也是"一行没审"，
  现改成打印用法并退出 2。npm scripts 改成自带目标（`verify:board`/`verify:goal` 先生成夹具再审它，`verify:predict`/`verify:replay` 写死要审的 run）。
- **归纳**：**"判据没跑出问题"必须与"判据没跑"可区分。** 空表 + 绿色是最危险的一种绿。
  这条不是新纪律，是把已有纪律应用到新位置——它同样是故障 #8/#13 的家族：**写了、跑了、不起作用**。
- **回归**：`node verify/goal-audit.ts`（无参数）退出码 1；夹具→审计这条链由 `npm run verify:board` / `verify:goal` 自带，
  两个 selftest 的干净基线也依赖它（基线不成立时自检直接中止，不会把"没审"读成"全过"）。

### #18 汇总脚本把"写了 testing 的步数"当成"归因成功数"（新脚本第一次跑真证据就抓出口径混用）

- **现象**：`verify/ablation.ts` 对两局报"不一致"——`testing 归因 逐帧=1 账本=0`（083043）、`逐帧=6 账本=4`（084406）。
  台账没坏，逐帧重算也没坏，**是脚本把两个不同的量当成了同一个**。
- **根因**：`src/loop.ts` 的归因把每一次 `decision.testing` 恰好投进 5 个桶之一
  （`attributed / unknownTarget / malformed / notChecked / fieldAbsent`），并恰好发一条 `hypothesis_check` 事件；
  逐帧数"写了 testing 的步"对应的是**总量**，账本里的 `attributed` 只是其中一个桶。
  旧代码写成 `hs.attributed !== testing`，等于要求"写了就必须归因成功"——那是模型行为的断言，不是数据一致性的断言。
- **修法**：拆成两条各自独立的恒等式，两条都必须成立：
  ① `hypothesis_check` 事件数 === 逐帧"写了 testing"的步数（一事件一归因，`fieldAbsent` 也发事件）；
  ② 五个桶之和 === 同一个数（桶是穷尽划分）；另加 ③ `attributed` 事件侧 === 账本 `attributed`。
- **归纳**：**交叉核对的两侧必须是同一个量的两种算法，不能是两个量。** 口径混用的危险在于它会"抓到 bug"——
  一个假阳性比一个假阴性更难察觉，因为它让脚本看起来在工作。
  这仍是 #8/#13/#17 的家族：**写了、跑了、不起作用**，只是这次"不起作用"的表现是**起了反作用**。
- **回归**：`test/ablation.test.ts` 两个用例钉住两侧——
  放行侧：`problem:"field_absent"` 的合成局必须**零出声**（旧代码会在这里误报）；
  拒绝侧：把桶之和改小必须出声。两例同时过，才证明改的是口径而不是把判据调松。

### #19 模型把观察记录写成多行假设，审计的按行解析当场误判（真证据逼出合约漏洞）

- **现象**：审 084406 时 `board-audit.ts` 报 `❌ 第5步板面解析失败：假设 H1 后面没有计数行，渲染形状不对`，退出码 1。
  逐帧看板面：H1 的正文是模型自己写的 5 行观察清单，计数行被顶到了第 6 行——**渲染器和账本都没错，是审计假设了"一条假设一行"**。
- **根因**：两层。表层：`parseBoard` 用 `seg[i + 1]` 取计数行，正文跨行就必然失败。
  深层：`src/board.ts` 的写入路径**从来没拦过换行**，而 `renderHypothesis` 把 `text` 原样拼进 `- id [status] ` 之后——
  板面是文本带内协议（in-band），正文里的换行会造出假的条目边界，读板面的大脑和审计脚本都无从判断哪几行属于同一条假设。
  该局 3 条假设**全部**是跨行写的：这不是偶发，是这类模型的自然写法。
- **修法（两侧都要，缺一侧就是半个修复）**：
  ① 合约侧：`board.write` 拒绝含 `\n` 的正文，理由可行动（"观察记录走不带 id 的 note，或拆成几条假设各一行"）——
    拒在主人这里，而不是渲染时悄悄改写（悄悄改写＝证据与自述分家，#13 同族）。
  ② 审计侧：`parseBoard` 改成"下一个条目头之前都算本条目正文"，计数行仍在条目内强制要求，缺了就照旧大声失败；
    同时把这类写入计入 `[形状] 跨行正文的写入 = N 次`，**明确标成版本差异**：既不追判成不一致（拿今天的尺子量昨天的证据＝伪不一致，#16 同族），
    也不一声不响（不报数就等于把放宽改成了免检通道）。
- **归纳**：**放宽解析和收紧合约必须各自带一条"仍然会失败"的回归。** 只放宽不守，判据就退化成橡皮图章；
  只收紧不放宽，历史证据就全成了冤案。
- **回归**：`test/board.test.ts` 新增跨行拒绝（新建与改写两侧，且拒了不许动板上正文）＋`test/hypothesis.test.ts` 一条**接线侧**判据
  （跨行走工具层照样被拒、理由点出替代通道、改成一行立刻通过——拒绝必须可修复，不是死路）；
  `board-audit-selftest.ts` 注入 15（删掉计数行 → 必须仍抓，关键词「没有计数行」）＋反向对照 2
  （把夹具改成忠实的多行历史形状：写入 input/after、每份板面快照、账本 `hypotheses[].text` 四处同步改 → 必须放行，且必须打出「跨行正文的写入 = 1 次」）。
  自检现在是**注入 15 处、漏抓 0 处；反向对照 2 组**。

### #20 版本戳工厂引用了没接进来的函数，每个真跑/夹具当场崩（M4-f 接线第一次跑就抓）

- **现象**：`judgeStamp()` 组装 `{detector, lexicon, sha}` 时调 `lexiconSha()`，但 `src/world/detect.ts` 的
  import 只带了 `LEXICON_VERSION, matchClaim, type Cap`——**没有 `lexiconSha`**。`ReferenceError: lexiconSha is not defined`
  直接崩掉每个 fixture 生成和每个真模型臂（`runs/m4f-model/*` 全部落不出 `header.judgement`）。
- **根因**：口径戳是新加的证据链头，函数与调用同文件同 PR 写出，却忘了 import——
  `node --check x.ts` 不做类型/引用解析，抓不到"引用了没接进来的东西"，只有真跑才崩。
- **修法**：补齐 `lexiconSha` import，重生成 9 夹具、审计与自检全绿（`396 pass / 0 fail`）。
  **这是 #8/#13/#15/#17/#18 的同族：写了、跑了、不起作用**——只是这次"不起作用"表现为崩而不是静默，反而最好抓。
- **回归**：`test/detect.test.ts` 一条三方版本一致判据钉死——`judgeStamp()` 必须等于 `DETECTOR_VERSION+lexicon`、
  且 `sha` 等于 `lexiconSha()` 实时值；`detect-audit.ts` `[口径落盘]` 在有 `detection.json` 缺戳时硬失败。
  两处合起来证明戳确实早于第一步存在、且不是拼出来的假串。

### #21 分母里混进了三种不同来源的证据，"误报率"这个名字同时装着自检项和仪器精度（发布复核时抓到）

- **现象**（两层，第二层更狠）：
  1. `npm run verify:detect` 当众打出 **`误报率 1/2 = 50.0%`**。本地和干净克隆上都一样。
     那两局 `mutant=null` 是夹具造的——一局证明"仪器不喊"，一局**故意埋了"仪器过火"**证明审计有牙。
     一个判据通路自检项，长在了仪器精度指标的名字上。
  2. 为了堵第 1 层而新加的"来源交叉核对"，第一次跑就把**已发布的旧证据**判出不一致：
     `verify:detect:reference` 那 9 局"参考版"里其实是 **4 局真大脑 + 2 局 `mock:TEST-DOUBLE` 替身 +
     1 局 `script:FIXTURE` 人写夹具 + 2 局 `mutant=M08` 的缺陷局**。最后那两局连"参考版"都不是——
     **缺陷世界里报异常是真检出，把它放进"误报"分母是类别错误**。
- **根因**：`fp`/`refs` 只按 `mutant===null` 一个条件收样本，而这个条件**跨来源、跨世界类型都不唯一**。
  #18 是"同一个量的两种算法被当成两个量"，这条是它的对偶：**两个不同的量共用一个名字**。
  两者都不是算错，是**分母没有身份**。
- **修法**：`header.provenance` 落盘（夹具声明 `fixture`）＋审计用两条与本字段无关的独立信号交叉核对
  （`brainId` 含 `FIXTURE`、`task` 前缀「夹具」、`mock:`/`script:` 前缀）。
  误报分母改为**只收 `src==='model' && mutant===null`**，四类剔除逐条出声，参考版误报率
  从 `0/9` 改口为 **`0/4 = 0.0% [0.0, 49.0]`**——分母变小、置信上界 49%，
  所以这个数只能说"没抓到误报"，**不能说"误报率低于 5%"**。
  夹具那张表同时**取消百分比与 Wilson 区间**：首版只在标题写"不许引用"，结果表里照样印出
  `M01/n/a 1/2 50.0% [9.5, 90.5]`——**标题管不住截图，格式本身才管得住**。
- **回归**：`detect-selftest` 注入 14（把夹具局 `provenance` 改成 `'real'` 冒充真证据 → 必须当场抓住，
  那是分母上唯一可行的造假路子）＋反向对照 R6（旧证据没有 `provenance` 键 → **事后规则不追判**（#19），
  但必须按 `brainId` 如实归类为夹具并出声）。自检 **21 例、漏抓 0**。
- **一句话教训**：**任何"率"都要在打印时说出分母是谁**。`n/总数` 不够，必须带上来源类别；
  做不到就先把那批证据分张表打——混在一张表里的两个数，迟早被人截成同一个。

### 历史台账（从你的 Python 项目带来的）

| 现象 | 根因 | 归纳 |
|---|---|---|
| `except TimeoutError` 从不触发 | 捕的是内建异常，httpx 抛的是别的类型 | 认错误**形状**，不认名字 |
| 真进异常分支就 `NameError` | `LLMRequestError` vs 导入的 `LLMRequestionError`；`AgentBaseException` 压根没导入 | 错误路径没跑过 = 错误路径不存在 |
| `invoke()` 声明返回 `str` 实际返回 `AIMessage` | 类型注解没人验 | 契约要测，不要信 |

**节奏建议**：每积累 5–10 条故障做一次归纳，把它们变成测试或纪律。**不要按章节线性学习**——按"跑 → 坏 → 查 → 修 → 归纳 → 再跑"的螺旋走。

---

## 9. M1–M5 怎么接进来

地基已经打好，后面每一步都是**替换某个器官，接口不变**。

| 里程碑 | 换什么 | 接在哪 | 关键约束 |
|---|---|---|---|
| **M1 眼睛和手** ✅ **已完成成立性验证** | `list_dir/read_file` → 渲染结果感知 + 白名单动作 | `src/world/render.ts`、`session.ts`、`src/tools/game.ts`、`harness.ts`，`Tool` 接口不变 | 眼睛**只看渲染输出**，不读内部状态；耳朵只拿现象描述，不拿函数名；**只有一只手**（串行执行） |
| **M2 确定性重放** ✅ **已落地并逐位验证** | 加固定步长世界 + 注入式时钟 | `src/rng.ts` 已就位；`src/world/arena.ts` 已落地一个切片 | sim 层禁读时钟；整数/定点数；固定系统执行顺序；`canonical` + `stateHash` 逐位比对 |
| **M3 差分公证器 + 变异靶场** ✅ **已完成成立性验证** | 参考版 vs 变异版 + 同一动作序列 | `src/notary/diff.ts`、`ddmin.ts`、`src/world/`、`src/m3.ts` | **不需要手写不变量，不需要预知 bug 位置**；语义变异体（删掉一个必需能力）；缺陷位置与类型对 agent 隐藏 |
| **M4-a 预测-对照闭环** ✅ **已完成成立性验证** | 每步先预测再对照 | `src/world/observe.ts`、`predict.ts`；`loop.ts` 经 `PredictionSeam` 注入，`types.ts` 不依赖世界层 | 模型预测 → **代码算 diff** → 模型判断是否意外；三态诚实（相符/不符/**无法核对**）；逆投影**绝不读内部状态** |
| **M4-b1 假设可淘汰** ✅ **已落地并独立复核** | append-only 笔记 → 结构化假设板（id/status/客观核对计数） | 新增 `src/board.ts`；`note` 带 id 走结构化通道；`Decision.testing` 声明归因；`types.ts` 仍不依赖世界层 | 正文与状态归模型，**计数归代码**；代码只出声绝不代判；淘汰不是删除；**不猜归因目标**（猜错=伪造归因）；无 id 的 note 与 M1 逐字相同 |
| **M4-b2 目标导向意图** ✅ **已落地并独立复核（真跑：接口 0 次使用，见 M4-B2-FINDINGS.md）** | 假设板旁边长出第二个器官：`goal` 声明"要把局面制造成哪个状态"+ `doneWhen` 画面等值条件 | 新增 `src/goal.ts`、`src/world/goal.ts`（词表+等值核对）、`goal_*` 四类证据事件、`RunHeader.seams` | 正文/状态/**完成条件**归模型，**每步客观判定与计数归代码**；三态诚实（满足/不满足/**判不出**）且 `met+unmet+unverifiable===checks`；代码只出声绝不代标 achieved；判不出结果的文案必须与这条目标的形状一致（#15）；通道开关由循环层声明，不留"删证据即免检"的通道（#16） |
| **M4-c/d 听觉 + 对账** | 听觉通道；主客观对账 | 新增听觉器官、`harness.ts` 对账层 | 三条独立异常源（预测被违反 / 眼耳矛盾 / 裁判客观违规）；**该预测而未预测要出声**；M3 硬约束：探索必须能表达"我要制造 hp=0 的局面" |
| **M4-e 多局消融 + 随机基线** ✅ **已建成并真跑（结论：采纳率两档差够不着显著，目标通道真跑 0 次使用，见 M4-E-FINDINGS.md）** | 单局数字 → **逐局汇总表 + 以局为单位的 Fisher 精确检验 + 大 n 随机策略臂** | 新增 `verify/ablation.ts`（只读证据，不 import 被测代码）、`verify/random-baseline.ts`（零 key、纯代码、可大 n）、`npm run verify:ablation` / `verify:random` / `verify:m4e` | 逐帧与账本**必须交叉核对，不许静默取一**；口径混用要各自独立核对（#18）；**采纳率是双峰/路径依赖的，步级检验是伪重复**，主判据只能以局为单位；样本不够就出"够不着显著"而不是 p 值；随机臂**一句都不许写成"目标导向比随机强多少"** |
| **M4-f 缺陷版靶场** ✅ **已建成并独立复核（结论：上限表与参考版误报可引用，模型臂受额度截断暂不出检出率，见 M4-F-FINDINGS.md）** | "能不能发现未知缺陷" → **四层漏斗（L1 可见分叉为唯一分母）+ 跑前冻结的判据/词表 + 大 n 随机上限表 + 参考版阴性对照** | 新增 `src/world/lexicon.ts`、`src/world/detect.ts`、`src/m4f.ts`（`--policy random`/`model`）、`verify/detect-{fixture,audit,selftest}.ts`、`header.judgement` 口径戳、`npm run verify:detect*` | 判据/词表**在看到任何模型输出之前**落盘加版本戳，`[口径落盘]` 三方交叉核对、缺戳硬失败（局末补写不算）；L2 前提**降级为分层器**不做分母（D01 可见 65% 但前提仅 8%）；`invisible=0` 证分母干净；检出率与误报率**成对出现**，模型臂额度截断**一句都不许写成检出率** |
| **M5 分发** | stdio → MCP server + Skill | `src/brain/stdio.ts` 换成 MCP transport | 协议纪律不变：stdout 只走 JSON |

**M1 已完成成立性验证**（真模型四局：主实验三局 + 修复后确认局），结论见 [M1-FINDINGS.md](M1-FINDINGS.md)。
机制成立：眼睛零泄漏、一只手串行、**独立重放 39/39 + 29/29 + 118/118 帧逐位相同**、M02 缺陷检出并最小化到 1 步。
但它同时给出三条必须说清的局限：**agent 没看懂它走过的缺陷**（假设板从未提到"敌人不动"）、
**M07 未检出**（120 步一次没掉血，探针证明公证器能检出，是覆盖率问题）、
**感知保真 ≠ 大脑理解正确**（自报坐标越界 19 次、7 次拾取失败自述与客观账本矛盾）。
🔴 最后一条是本轮最重要的新发现：**评测必须把客观账本与主观自述分开记，否则会把模型的错算到工具头上。**

**M4-a 已完成成立性验证**（真模型三局：对照组 + M08 两局），结论见 [M4-FINDINGS.md](M4-FINDINGS.md)。
机制成立：模型真的在逐步预测（5/5、9/9），代码算出的差异真的改变了它的下一步推理——
**坐标读法一次纠正后 8 步全对**，**撞墙推断 `(3,3) 是墙` 经墙表 + 覆盖账本 + 预测账本三方佐证**。
M08 缺陷被**两个互不相干的通道同步同量指向**（公证器首分叉 `player.score` / 预测账本同一步 `scoreDelta` 违反），
agent 第一次用自己的话引用了客观检出的缺陷。独立复核：重放 6/6 + 10/10 + 9/9 帧逐位相同，
另写一套解析重算 102 个字段的 `actual` 与 `status`，**0 处不一致**。

**但它同时给出四条必须说清的局限**：
**15 项预测违反里只有 1 项是种子缺陷**（其余是 agent 自己数错/猜错，对照组没缺陷也照样报违反）；
**差异送达 ≠ 差异被采信**（画面 3→2 死 1 个，它写"消灭了 4 个"，4 = 它自己的幻觉预测 6 − 真值 2）；
**`surprise` 通道三局 0 次使用**（闭环后半段在真跑里仍是空转）；
**预测覆盖率决定对照覆盖率**（B 局没预测 `scoreDelta`，差异通道就漏掉了缺陷）。
🔴 第三条与第四条合起来是本轮最重要的新发现：**模型倾向于发明机制来解释自己的感知错误，而不是承认自己数错了**——
两局都独立发明了"敌人会新生成"这条假规则，其中一局还把它写成"规则已确认"存进假设板。
**假设板只进不出，假规则就会永久驻留。** 这是 M4-b"假设可淘汰"最硬的立论依据。

**M4-b1 已落地并独立复核**（真模型两局，参考版对照组 seed=6），结论见 [M4-B-FINDINGS.md](M4-B-FINDINGS.md)。
记忆器官 `src/board.ts` 上线：假设有 id、有状态、可淘汰，核对计数由**代码**客观累加，
代码发现"被反对却未淘汰"或"自称成立却零核对"时**只出声，绝不代判**。
真模型在零说明书下**自主用了这套接口**（自己立假设、自己升状态），板面 6 + 28 份快照全部可证已送达；
第二局重放 27/27 帧逐位相同、84 个字段另写一套解析重算 0 处不一致、13 项账本聚合逐项对得上。
审计脚本自身也过了篡改自检：**注入 14 处错误漏抓 0 处**，外加 1 组反向对照。（M4-e 之后是 15 处 + 2 组——多出的那一对正是故障 #19：放宽解析与收紧合约各钉一条。）

**本轮最值钱的一幕**：第二局第 17 步它又发明了"新敌人出现"这条假规则，
代码算出 `enemyCount 预测3 / 画面2` 并回填，第 18 步它自己写下
"**我之前误以为有新的敌人产生…这说明敌人不会凭空生成**"。
这是 M4-a 那条"模型宁可发明机制也不承认数错"的**首个真跑反例**，因果链原文落盘可证。
但必须说清：它没把假规则写进板子，所以**淘汰机制没参与这次纠正**，起作用的是 M4-a 的预测通道；n=1，不是曲线。

**三条必须说清的局限**：
**`testing` 两局 0 次使用**——归因通道空转，计数恒为 0，于是"模型自己淘汰假规则"**只有夹具证据**（人写剧本，不算模型能力）；
**自称已验证 ≠ 账本上有核对**（第一局 `status:"confirmed"` 而 `checks=0`，故障 #13，已修但真跑未再触发）；
**7 项违反全是 agent 自己的错**（对照组无种子缺陷），"违反数 ≠ 缺陷数"再次成立。
🔴 第一条是本轮最重要的新发现：**接口给了 ≠ 模型会用**。
`testing` 是记忆器官与客观账本之间唯一的桥，桥没通车，整个淘汰机制就只在夹具里成立。
不写策略提示去催它用（那会污染零说明书前提），也不做"只有一条假设就自动归因"的兜底（**猜目标就是伪造归因**）。
把这条脱钩作为客观事实报给模型，归 M4-d。

**M3 已提前做完成立性验证**（纯代码、零模型），结论见 [M3-FINDINGS.md](M3-FINDINGS.md)。机制成立：288 案例 12 变异体全检出、ddmin 23/23 仍分叉且 1-minimal、压缩 89.9%。

**但它给 M1/M4 下了五条硬约束**，这比"验证通过"更值钱：

1. **探索必须目标导向，不能随机游走。** M07（血量归零不死亡）80 步检出率 4.2%，320 步仍只有 16.7%——它要求"把自己打到濒死"，随机动作撞不上。M4 假设板必须能表达"我要制造 hp=0 的局面"这类意图。
2. **必须记录状态覆盖，而不只是步数。** M04/M08/D02 在 91.7% 出现平台期，160 步与 320 步完全一样。跑更久没用，得知道"哪些状态从没到达过"。
3. **逐帧哈希必须落盘。** 15 例掩蔽是硬证据：中途分叉、最终状态又相同，只比最终状态全部漏检。
4. **报告必须区分"症状起点"与"根因位置"。** M01 删的是墙，首分叉却落在 `enemies[1].dir`——真实因果传播。宣称定位到根因就是造假。
5. **动作分布本身要可变。** 平台期意味着要主动切换策略（多攻击/多拾取/主动送死），这正是"大脑做决策"该干的事，不是写死的探索脚本。

**预测-对照曲线为什么能证明"不是脚本"**：
- 准确率随步数上升 = 它自己学会了规则（零说明书）
- 突然下探 = 遇到异常
- 随机策略消融 = 一条平线（对照组）

三条曲线摆在一起，比任何演示视频都有说服力。

**M4-a 实测到哪一步了（不夸大）**：第一条曲线已有**单点证据**——M08-A 的 `playerAt`
第 2 步 violated、第 3~10 步连续 8 次 ok，且第 3 步 thought 明确写出自我纠正。
但这是**一局之内的一个字段**，还不是"曲线"：样本量 n=1，且三局都死在第 9~10 步（免费额度 429），
横轴太短画不出趋势。第二条（突然下探 = 异常）目前**不成立**：15 项违反里 12 项是 agent 自己的错，
下探更多反映它数错了，而不是世界坏了——**必须先把主客观对账（M4-d）做出来，这条曲线才有意义**。
第三条（随机策略消融）**还没做**，只有 `--no-predict` 开关和一条"退回 M1 条件"的测试。归 M4-e。

**M4-e 把这三条曲线的账结掉了一部分（不夸大）**：第三条**做了**，而且是全项目唯一大 n 的一臂
（`verify/random-baseline.ts`，零 key、纯代码、4 世界 × 2 预算 × 200 局）。结果并不给模型脸上贴金：
同世界同步数预算下，随机游走 `hp` 归零 **5.5%**、平均只走 **5.3/64** 格，而真模型走 **12.4/64** 格却
**9 个跑满局里没有一局**把血量打到过 0——差距出在"愿意受伤"这一维（整局一次血没掉：模型 4/9 vs 随机 11.5%，局级 Fisher **p=0.0179**）。
第一条（学习曲线）现在有了多局数据，但结论是**它还不成立**：采纳率是双峰/路径依赖的，
两档差以局为单位 p=0.5238 够不着显著，步级那个 2.14e-8 属伪重复**不许引用**（§10.10）。
第二条（异常下探）仍卡在 M4-d：本轮十局跑的是**参考版**，没有一个数字算"缺陷检出率"。
🔴 所以 M4-e 最该被引用的一句不是"模型比随机强"，而是**"要主动把自己打到濒死"这条 M3 硬约束，两臂都没执行**：
随机撞不全，模型不撞，而为此设计好的 `goal` 通道**开着 5 局、0 次使用**。

---

## 10. 明确不做

- **不做启发式兜底大脑**。所有决策来自模型。代码只做确定性的事：世界、裁判、证据。
- **不做策略手册提示词**。零说明书是能力评测的前提。
- **不用本地模型**。1.5B 本地模型质量不够，别早赌。走远端或宿主。
- **不让模型写证据**。证据由代码无损记录。
- **不让模型宣布违规**。裁判是代码。
- **不做任意 shell 执行**。动作走白名单。
- **不堆 agent 数量当卖点**。GitHub 上 49 个 agent / 72 个 skill 的项目已经存在，角色分工不是差异化。差异化是**可独立重放的缺陷证据**。
- **不引入依赖**。零依赖是这台机器的生存条件，也是"一个周末读完"的前提。

---

## 附：目录树

```
agent-harness/
├── package.json          零依赖，scripts: start / test / smoke
├── tsconfig.json         erasableSyntaxOnly + verbatimModuleSyntax + strict
├── .env.example          远端大脑配置模板（只走远端）
├── .env                  已填好并验证（gitignore，不要提交）
├── .gitignore            node_modules/ sandbox/ .env *.log（**runs/ 故意不忽略——证据随仓库发布**）
├── LICENSE               MIT
├── .github/workflows/ci.yml  每次 push 重算：npm test + 复核矩阵 + 零依赖守卫 + 词表冻结指纹
├── README.md             本文件：搭建步骤
├── KNOWLEDGE.md          逐器官知识地图：已会 vs 真新学 + 掌握判据 + 深化路线
├── M3-FINDINGS.md        M3 成立性验证报告：实测数据 + 负面结论 + 对 M1/M4 的硬约束
├── M1-FINDINGS.md        M1 成立性验证报告：四局实测 + 独立重放 + 缺陷检出 + 感知保真≠理解正确
├── M4-FINDINGS.md        M4-a 成立性验证报告：三局实测 + 两套独立复核 + 15 项违反只有 1 项是缺陷
├── M4-B-FINDINGS.md      M4-b1 成立性验证报告：记忆器官 + 真跑两局 + 审计篡改自检 + 自称已验证却零核对
├── M4-B2-FINDINGS.md     M4-b2 成立性验证报告：目标器官 + 真跑五局（接口 0 次使用）+ 三源四档审计 + 免检通道
├── M4-E-FINDINGS.md      M4-e 成立性验证报告：十局逐局表 + 以局为单位的 Fisher（p=0.5238）+ 大 n 随机臂 + 伪重复纪律
├── M4-F-FINDINGS.md      M4-f 成立性验证报告：缺陷版靶场四层漏斗 + 4800 例上限表 + 参考版误报 0/4 + 模型臂额度诚实局限
├── runs/                 **已发布的证据**：上限表 4800 案例、逐局 detection.json、真模型臂原始 trace、各批消融
├── src/
│   ├── types.ts          全部契约
│   ├── loop.ts           心脏：五种停止条件
│   ├── board.ts          记忆（M4-b1）：假设可淘汰，计数归代码，出声判据的唯一主人
│   ├── goal.ts           目标器官（M4-b2）：doneWhen 归模型、逐步客观判定与计数归代码，三态诚实 + 闭合恒等式
│   ├── errors.ts         痛觉：错误分类 + 可读拒绝
│   ├── parse.ts          容错解析 + 回炉提示
│   ├── context.ts        海马体：预算与截断
│   ├── rng.ts            确定性地基
│   ├── trace.ts          公证处：无损证据
│   ├── cli.ts            门面
│   ├── m3.ts             M3 实验台：7 组实验 + 成立性判定（零模型）
│   ├── brain/
│   │   ├── index.ts      工厂 + 零依赖 .env
│   │   ├── prompt.ts     嘴：只给接口不给策略
│   │   ├── openai.ts     远端大脑
│   │   ├── stdio.ts      宿主大脑（默认，零 key）
│   │   └── mock.ts       测试替身（门禁）
│   ├── world/            M1 感知执行 + M3 靶场 + M4 预测对照
│   │   ├── arena.ts      确定性世界：7 个固定顺序系统 + 计数式随机 + 两种哈希
│   │   ├── render.ts     视网膜：世界 → 文本屏幕（有损投影，只给可见几何）
│   │   ├── observe.ts    逆投影（M4）：屏幕文本 → 观测量，绝不读内部状态
│   │   ├── predict.ts    预测对照（M4）：代码算 diff，三态诚实，接口说明不泄题
│   │   ├── goal.ts       目标词表与等值核对（M4-b2）：只认画面绝对量，判不出 ≠ 不满足
│   │   ├── lexicon.ts    判决词表（M4-f）：异常断言词 + 观测量→能力归因表，跑前冻结、sha 落盘
│   │   ├── detect.ts     检出判决器（M4-f）：四层漏斗 L1 可见分叉→L2 前提→L3 上报→L4 归因，六选一判决
│   │   ├── session.ts    一只手：串行动作队列 + 逐帧台账 + 覆盖账本
│   │   ├── harness.ts    M1+M3+M4 合流：自主玩 → 抽动作 → 公证 → 最小化 → 落盘
│   │   └── mutants.ts    9 单 + 3 双变异体（label 只供度量，不喂公证器）
│   ├── notary/           M3 公证器
│   │   ├── diff.ts       逐帧差分 + 确定性前置检查 + 掩蔽判定
│   │   └── ddmin.ts      动作序列最小化（子集+补集，谓词非单调）
│   └── tools/
│       ├── registry.ts   手：校验 + 执行 + 沙箱
│       ├── builtin.ts    眼与记忆雏形（文件模式）
│       └── game.ts       游戏工具：闭包绑定 session，绝不用模块级单例
├── verify/               独立复核脚本（**刻意不复用被测的核对代码**）
│   ├── replay.ts         从证据重放逐帧哈希 + 自己算首分叉 + 自己判 1-minimal
│   ├── predict-audit.ts  另写一套屏幕解析，重算全部预测差异 + 门认证 + 帧链 + 送达审计
│   ├── board-audit.ts    另写一套状态机与板面解析，重算归因/计数/出声名单/账本/分侧
│   ├── board-fixture.ts  裁判侧夹具：13 条路径一次走全（**人写剧本，不是模型能力的证据**）
│   ├── board-audit-selftest.ts  审计自身的回归：注入 15 处错误逐处要求抓住 + 2 组反向对照
│   ├── goal-fixture.ts   裁判侧夹具：32 步追打让 hp 真归零，10 条目标走完判定的每个分支
│   ├── goal-audit.ts     另写一套屏幕解析与状态机，重算判定/计数/板面文案/送达/跨通道/分侧（589 行，不 import 被测代码）
│   ├── goal-audit-selftest.ts  审计自身的回归：注入 24 处错误逐处要求抓住 + **4 组反向对照**（版本/消融/零使用/撞墙）
│   ├── ablation.ts       M4-e 逐局采纳率汇总：只读证据、逐帧与账本交叉核对、两尾 Fisher 精确检验（手写，零依赖）
│   ├── random-baseline.ts M4-e 随机策略臂：零 key 纯代码、大 n、Wilson 区间，只说"世界的下限难度"
│   ├── detect-fixture.ts M4-f 已知判决夹具：9 局走完六选一判决，**人写剧本，不是模型能力的证据**
│   ├── detect-audit.ts   M4-f 检出判决独立复核：自带一份重放与判决实现，逐帧屏幕重建 + [口径落盘]三方核对 + 上限表抽样重算
│   └── detect-selftest.ts M4-f 判决器篡改自检：注入 15 处 + 反向对照 4 组 = 19 例（含口径落盘三种篡改）
└── test/                 396 个测试，25 个文件
```

运行后生成（已 gitignore）：`runs/<时间戳>-s<seed>/`、`sandbox/`。

M3 实验产物：`runs/m3-full/findings.json`（288 案例逐条记录 + 23 例最小化后的完整动作序列）。
M4-a 原始证据：`runs/20261113-{203623,204204,204625}-s6/`（每局六件套：header / trace / result / world / coverage / defect）。

**复核命令**：`npm run verify:m4` 一条命令跑完三局重放 + 三局预测审计（全绿 exit=0）。
注意 `runs/` 已 gitignore，所以这条命令需要本地保有那三局证据；换机器请先按 §12 的命令重跑或拷入证据目录。