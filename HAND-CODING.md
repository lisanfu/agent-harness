# 手敲路线图：把这套 harness 从头敲一遍

> 这份文档不是第二份 README。README §3（Step 0–10）给的是**可以复制的代码**；
> 这份给的是**自己敲的顺序、每一站的过关判据、以及你一定会撞上的坑**。
> 每一站都对应这套工程里一次真实的"跑→坏→查→修→归纳"，坑号与 README §8 故障台账一致（共 68 条）。

---

## 0. 开工前必须知道的三条机器事实

这三条不写在脑子里，前三站会白掉两天。

1. **node 不在 PATH 上。** 每台新终端先执行
   `export PATH=/home/fuyuan/.local/node-22/bin:$PATH`（Node 22.23.4，原生类型擦除）。
2. **这个工程没有 `tsc`、没有 typecheck 脚本。** `npm test` 就是唯一编译器：
   **类型写歪不会单独报错，只会在运行时炸**。所以"每站先跑 `npm test`"不是仪式，是唯一能发现类型错的手段。
3. **零依赖。** `package.json` 里没有 `dependencies`。凡是"看起来必须装个库才能做"的冲动，都是设计走偏的信号
   （Fisher 精确检验、Wilson 区间、ddmin 收缩全都是手写的，见 S13/S10）。

`tsconfig.json` 四个开关会在你手敲时立刻咬人，先记住：

- `allowImportingTsExtensions` → **import 必须带 `.ts` 后缀**（`from './rng.ts'`，不带就找不到模块）。
- `erasableSyntaxOnly` → **禁用 `enum` / `namespace` / 构造函数参数属性**。类型层的东西必须可擦除。
- `verbatimModuleSyntax` → 纯类型导入必须写 `import type { … }`。
- `noUncheckedIndexedAccess` → `arr[i]` 的类型是 `T | undefined`。**这不是噪声，是判据**：
  它逼你显式处理"这一格根本没有"，而 agent 工程里最贵的错就是把"没数据"读成"数据是 0"。

**手敲的纪律**：另开目录，不要动参考仓库（它现在 591 测试全绿 + M4-e 十局真证据 + M4-f 上限表(4800 例)/缺陷臂真跑证据 + M4-d 30 局主客观对账落盘 + M4-c 双通道上限表(2400 例)与眼耳五桶判据(20 格三方一致) + M5 MCP/Skill 真 stdio 与真实 Qoder 两局，改坏了你就失去对照物了）。

```bash
mkdir -p ~/practice/agent-harness && cd ~/practice/agent-harness && git init
export PATH=/home/fuyuan/.local/node-22/bin:$PATH
```

每一站过关就打一个 tag（`git tag s3`）。**读参考实现的方式是"读 20 行 → 关掉 → 自己写"**；
直接选中复制粘贴，这一趟就只剩下打字练习，学不到东西。

---

## 1. 总进度表（20 站，测试数只增不减）

参考仓库的真实数字：`src/` 44 个文件 **11101 行**，`test/` 37 个文件 **10337 行 / 591 测试**，`verify/` 23 个文件 **7984 行**。
**这三个数不是手抄的**：`npm run verify:docs` 每次重算（8 个句子锚点 + 4 条恒等式 + 五脏清单表逐行），差一位就 rc=1——这条命令本身是台账 #45 的产物。

| 站 | 里程碑 | 这一站新增测试 | 累计 | 行数预算（src / test） | 半天 |
|---|---|---|---|---|---|
| S0 | 空壳能跑 | 0 | 0 | 10 / 0 | ✓ |
| S1 | 契约 + 确定性地基 | 12（`rng-context`） | 12 | 120 / 130 | ✓ |
| S2 | 痛觉（错误分类） | 11（`errors`） | 23 | 150 / 100 | ✓ |
| S3 | 听懂人话（容错解析） | 16（`parse`） | 39 | 200 / 140 | ✓ |
| S4 | 手（工具注册 + 沙箱） | 12（`registry`） | 51 | 135 / 110 | ✓ |
| S5 | 眼与记忆雏形（内置工具 + 上下文） | 0（并到 S1 的 12 里） | 51 | 281 / 0 | ✓ |
| S6 | 嘴 + 三种大脑 | 8（`prompt`） | 59 | 370 / 90 | ✓ |
| **S7** | **心脏：循环 + 证据 + CLI（M0 达成）** | 11（`loop`） | **70** | 855 / 200 | ×2 |
| S8 | 世界：arena / session / render / 游戏动作（M1） | 75（`world`22 `render`20 `session`13 `game`20） | 145 | 763 / 480 | ×2 |
| S9 | 世界接进循环 + 死循环与重试（M1 收尾） | 31（`loop-world`10 `retry`21） | 176 | 并入 S7/S8 / 260 | ×1.5 |
| S10 | 独立重放（M2） | 0（用 S8/S9 的判据 + `verify/replay`） | 176 | 97 / 0 | ×0.5 |
| S11 | 差分公证器 + 变异靶场（M3） | 20（`notary`） | 196 | 774 / 260 | ×2 |
| S12 | 预测-对照闭环（M4-a） | 38（`observe`14 `predict`24） | 234 | 232 / 300 | ×1.5 |
| S13 | 记忆器官：假设板 / 目标 / 计数（M4-b1/b2） | 79（`board`14 `hypothesis`25 `goal`17 `world-goal`16 `goal-loop`23 + `empty-repair`12 归 S7） | 313+ | 1126 / 900 | ×3 |
| S14 | 度量：审计脚本 + 汇总 + 随机臂（M4-e） | 18（`ablation`13 `random-baseline`5） | **380** | 1056 / 200 | ×2 |
| S15 | 度量：缺陷版靶场 + 检出判决器（M4-f） | 16（`detect`16：词表冻结/版本戳/四层漏斗/六判决/子串陷阱/零泄漏） | **396** | +lexicon+detect+m4f / +detect-fixture+audit+selftest | ×1.5 |
| S16 | 度量：主客观对账（M4-d） | 42（`reconcile`42：四桶恒等式/双读法/图层覆盖/回溯归位/括注/零内部状态） | **438** | 985 / 725 ＋ `verify/recon*` 1394 | ×1.5 |
| S17 | 第二条独立投影：听觉通道（M4-c 上半） | 53（`sound`25 `m4c`18 `ear-guard`5 `mock-gate`5） | **491** | 742 / 1053 | ×1.5 |
| **S18** | **眼耳矛盾判据 + 复核三件套 + `--sound-mutant` 接线（M4-c 下半）** | 49（`ear`35 `ear-wiring`14） | **540** | 944 / 825 ＋ `verify/ear*` 1464 | ×1.5 |
| **S19** | **交付面守卫：文档自己印的数字变成被测对象（#45/#46）** | 16（`doc-numbers`：口径对表 wc -l、4 类注入、结构守卫） | **556** | — / 227 ＋ `verify/doc-numbers.ts` 471 | ×0.5 |
| **S20** | **分发：MCP server + Skill，大脑归宿主、判据归量具** | 35（`mcp-protocol` 8 `mcp-integration` 8 `mcp-session` 17 `arena-shared` 2） | **591** | 净 +1403（共享引擎重构 + MCP） / +1201（`mcp*` 1067＋`arena-shared` 134） | ×2 |

> **测试数掉了要当故障看，不能当噪声看。** 这条是这套工程的第 #17 号教训的自用版：
> 本项目曾经因为测试文件加载失败，`npm test` 从 359 掉到 338 而没人立刻发现。
> 所以每一站结束时**必须**看到 `# pass` 等于上表的累计值，且 `# fail 0`。

---

## 2. 每一站怎么敲

统一模板：**目标 → 要写的东西（骨架，不含实现） → 过关判据 → 故意破坏实验 → 一定会撞的坑**。
"故意破坏实验"是你自己给自己做的反向对照——不跑它，你只证明了自己会打字。

### S0 空壳

- 写 `package.json`（`"type":"module"`，scripts 先只留 `test`）、`tsconfig.json`（抄 §0 那四个开关）、`.gitignore`（`runs/ sandbox/ .env node_modules/`）。
- 写一个 `test/smoke.test.ts`：

  ```ts
  import { test } from 'node:test';
  import assert from 'node:assert/strict';

  test('脚手架能跑', () => assert.ok(true));
  ```

  两行 import 不能省：`node:test` / `node:assert` 是 Node **内置**模块，不用装任何包，
  但它们不会自动进作用域——少了 import 就是 `ReferenceError: test is not defined`。
  （这是 S0 最常见的第一摔，写在这里就是为了让你少摔一次。）
- 判据：`npm test` → 1 pass。**然后删掉这个占位测试**，S1 起计数从零开始。
- 坑：`"type": "module"` 忘了写 → 后面每一站都在 CJS/ESM 边界上摔。

### S1 契约 + 确定性与记忆雏形（`src/types.ts`、`src/rng.ts`、`src/context.ts`）

- 要立的接口（**只写类型，不写实现**）：`Decision`、`Action`、`Tool`、`Brain`、`RunHeader`、`TraceEvent`、
  以及**可选字段三件套** `predict` / `testing` / `surprise`（它们必须是 optional，这是 M4-a 的前提）。
  契约层还要预留 `seams`（消融开关，见 S13）与 `brainRetries`。
- `createRng(seed)`：**mulberry32，注入式**。返回值是 `() => number`。
- `context`：`trim(messages, budget)`，**必须保留 system 段**，预算不足时显式标记而不是静默截。
- 判据：`rng-context.test.ts` 12 绿。钉死的三件事——同种子 50 个数逐位相同；`canonical()` **键序无关、数组顺序敏感**；
  截断保 system 且地板不越界。
- 故意破坏：把 `Math.random()` 直接写进 `rng.ts` 的兜底分支。测试应立刻红；**如果没红，说明你的测试根本没测到东西**。
- 一定会撞的坑：**#2 上下文预算沉默超支**（软约束违反不出声）。

### S2 痛觉（`src/errors.ts`）

- 一张错误分类表：`retryable / fatal / needs_repair`，加 `HTTP 400/401/429/500/503`、空返回、真超时、连接被拒、stdin EOF。
- 关键：**分类按"恢复手段"分，不按"异常类型"分**；`Retry-After` 要同时认秒数和 HTTP 日期两种写法。
- 判据：`errors.test.ts` 11 绿，且每个 `catch` 分支都有测试真的触发它。
- 故意破坏：把 429 和 400 归成同一类 → 必须至少两条测试红（400 不许多撞一次）。
- 坑：**#5 限流当致命**、**#7 瞬时失败当永久失败**。

### S3 听懂人话（`src/parse.ts`）

- 括号配平扫描器：正确处理**字符串内大括号**、转义引号、围栏 ```json、不闭合。
- 写歪的形状**留原文 + 单独计数**，不许猜意图（这是后面 S12/S13 归因诚实的前提）。
- 判据：`parse.test.ts` 16 绿。至少要有一条"数组 args"和一条"空名"的拒绝用例。
- 故意破坏：删掉字符串内 `{` 的跳过逻辑 → 两条测试红。
- 坑：**#3 `npm run demo` 写了跑不起来**（脚本也是代码，也要跑一遍）。

### S4 手（`src/tools/registry.ts`）

- 白名单注册表：`register(def)`、`call(name, args)`、参数类型校验、**沙箱越界拒绝**、未知工具拒绝。
- 判据：`registry.test.ts` 12 绿（未知工具 / 缺参 / 类型错 / 多参 / 越界 / ENOENT / 目录当文件 / 重复注册 / 内部抛错）。
- 故意破坏：把"未知工具"改成返回空结果而不是报错 → 必须红。**只会拒绝的判据要配反向对照，只会放过的判据同样要配。**
- 坑：**#16 免检通道**（任何一种能靠"什么都不返回"到达的分类，都是免检通道）。

### S5 眼与记忆雏形（`src/tools/builtin.ts`）

- `list_dir / read_file / write_file / note`。眼睛**只看输出**，不读内部状态；`note` 是记忆雏形（S13 才升级）。
- 判据：内置工具的失败形态（ENOENT、目录当文件）在 S4 的测试里已覆盖，这一站不涨计数——**这是设计，不是遗漏**。
- 故意破坏：让 `read_file` 在文件不存在时返回 `''`。
- 坑：**#11 回填原文没落盘 → 真跑无法证送达**（从这站起就要养成"送达要可追溯"的习惯）。

### S6 嘴 + 三种大脑（`src/brain/prompt.ts`、`mock.ts`、`stdio.ts`、`openai.ts`、`index.ts`）

- 契约渲染：**静态帧只渲染一次**（否则每步重发一份契约，成本与注意力全乱）。
- 三种大脑：`mock`（机械剧本，验接线）、`stdio`（宿主大脑，零 key）、`openai`（远端，只走远端，不用本地模型）。
- 判据：`prompt.test.ts` 8 绿（含"静态帧只渲染一次"与 `--no-goal` 时契约块整段消失）。
- 故意破坏：把契约块改成每步都发 → 计数翻倍必须被抓住。
- 坑：**#15 文案说谎**（渲染文案与真实内容不一致，单元测试照样全绿）。

### S7 心脏：循环 + 证据 + CLI（`src/loop.ts`、`src/trace.ts`、`src/cli.ts`）—— M0 达成

- 循环：`decide → execute → record → 停止判定`。五种停止条件：`finish` / `max_steps` / `brain_failed` / `stuck` / `budget`。
- 退出码语义（**评审会逐条验**）：arena 模式只有 `stopReason==='finished'` 才 0，`max_steps` 是 **2**，
  审计类脚本是 0/1。所以**真跑命令永远不许用 `&&` 串起来**（前面断了后面就不跑了）。
- 证据六件套：`header.json / trace.jsonl / result.json / defect.json / coverage.json`（+ 世界局加 `coverage` 字段）。
- 判据：`loop.test.ts` 11 绿；`npm test` 累计 **70**；
  `npm run smoke` 用 mock 大脑走通一次 6 步。**这一步第一次"活"**。
- 故意破坏：把某条停止分支的计数改成 `continue` → 必须红；改成 `finish` → 必须红。
- 坑：**#9 静默丢弃＝归因作废**、**#17 零样本假通过**（没有 run 目录时打印"总计 0 处不一致"却 exit 0）。

### S8 世界（`src/world/arena.ts`、`session.ts`、`render.ts`、`src/tools/game.ts`、`src/world/value.ts`）—— M1

- 8×8 网格、血量、敌人、拾取物；结算**全走整数**（浮点是确定性重放的头号杀手）。
- 四条能力语义要分清：`wallBlocks` / `attackCooldown` / `pickupHeals` / `hpClamp`——**规则 vs 能力**是这个世界的设计核心。
- `render()` 把内部状态投影成文本画面；`session.coverage()` 返回状态覆盖（**不只记步数**）。
- 判据：75 绿（`world`22 / `render`20 / `session`13 / `game`20），累计 **145**。
- 故意破坏：把一次结算改成浮点除法 → 同种子两局哈希必须分叉；不红说明你没测确定性。
- 坑：**#6 死循环检测把"走图"误判成死循环**（含 tick 的帧哈希不能当循环判据）。

### S9 世界接进循环 + 重试（`src/world/harness.ts`、`mutants.ts`、`src/brain/retry` 路径）—— M1 收尾

- `harness` 把世界 + 动作 + 大脑拼成一局；重试主人只有一个（循环层）。
- 判据：31 绿（`loop-world`10 / `retry`21），累计 **176**。
- 故意破坏：给 `DecideRequest` 加一个函数字段 → **stdio 会把它 JSON 掉**，必须当场炸出来。
- 坑：**#8 回炉提示从来没进 payload**（"回炉"从 M0 起空转）。

### S10 独立重放（`verify/replay.ts`）—— M2

- **这一站开始，判据必须不 import 被测代码**。重放器只读证据文件，独立重建局面并逐帧比哈希。
- 判据：拿 S8/S9 跑出的一局做输入；同种子逐帧哈希相同；**篡改一帧必须出声**。
- 故意破坏：改 `result.json` 里一个 `stateHash` → replay 必须报错；不报错说明你的重放器其实在信证据而不是在算。
- 坑：**#14 两个通道时序不同，判据不能照抄**（决策前下发 vs 决策后回填）。
- 为什么单独设这一站：6-C 硬要求"输出初始状态 + 随机种子 + 完整动作序列"，靠的就是这一站的独立可重放性。

### S11 差分公证器 + 变异靶场（`src/notary/diff.ts`、`ddmin.ts`、`src/m3.ts`）—— M3

- `diffFields` 做**结构化逐字段差分**（不是比最终状态）；`ddmin` 把证物收缩到 **1-minimal**。
- 三态诚实：`相符 / 不符 / 无法核对`——**"无法核对"不是"符合"**，这是全项目复用最多的一个设计。
- 判据：`notary.test.ts` 20 绿（含 144 案例结构不变性、掩蔽夹具、ddmin 非单调 + 预算诚实），累计 **196**。
- 故意破坏：把 `unverifiable` 并进 `ok` → 必须有多条红；没有红说明三态其实没起作用。
- 坑：**#10 我为防灌水设的核对闸门，把最值钱的信号关在了门外**。

### S12 预测-对照闭环（`src/world/observe.ts`、`predict.ts`）—— M4-a

- `observe()` 是 `render()` 的**逆运算**（从画面文本反推字段），**绝不读内部状态**。
- `predict` 通道：模型写预测 → **代码算 diff** → 代码只数只出声，**绝不代判**。
- 判据：38 绿（`observe`14 / `predict`24），累计 **234**。
- 故意破坏：让 `observe` 偷偷读一眼 `session.hp` → 屏幕与内部状态不一致时必须有测试红。
- 坑：**#12 假规则永久驻留**（记忆的入口与出口都要有）。

### S13 记忆器官：假设板 / 目标 / 客观计数（`src/board.ts`、`goal.ts`、`src/world/goal.ts`）—— M4-b1 / b2

- 分工是这一站的全部：**正文 / 状态 / 完成条件归模型，每步判定与计数归代码**。
- 假设板：状态机 `proposed → confirmed/retired`，**淘汰不是删除**，`testing` 归因失败要**分桶**
  （`attributed / unknownTarget / malformed / notChecked / fieldAbsent`）——桶之和必须等于写了的步数。
- 目标：`doneWhen` 只认**画面等值**；`met + unmet + unverifiable === checks` 是闭合恒等式。
- 消融开关：`seams:{predict,goal}` 由**循环层声明**，不许从"证据里缺键"倒推。
- 判据：79 绿（`board`14 / `hypothesis`25 / `goal`17 / `world-goal`16 / `goal-loop`23），累计 **313**（+ S14 到 380，+ S15 到 396）。
- 故意破坏：把计数改成模型自报 → 三条恒等式测试必须全红。
- 坑：**#13 自称已验证而账本 `checks=0`**、**#16 免检通道**、**#18 口径混用**、**#19 跨行正文打穿按行解析**、**#20 版本戳工厂引用了没 import 的 `lexiconSha`**。

### S14 度量：审计 + 汇总 + 随机臂（`verify/*-audit.ts`、`*-selftest.ts`、`ablation.ts`、`random-baseline.ts`）—— M4-e

- 独立审计三套：夹具 → 审计 → **篡改自检**（注入错误 + 反向对照）。
- 统计：手写两尾 Fisher 精确检验（超几何 + log-choose）、Wilson 95%、**主判据以局为单位**。
- 随机臂：**零 key、纯代码、大 n**；与真模型臂**同字段同定义**（别自己造第二套口径）。
- 判据：18 绿（`ablation`13 / `random-baseline`5），`npm test` **380 全绿**；
  `npm run verify:m4e` 在十局真证据上 **0 处不一致**、`verify:board:selftest` 注入 15 处漏抓 0 + 反向对照 2 组、
  `verify:goal:selftest` 注入 24 处 + 4 组、`verify:random` 出 8 格表。
- 故意破坏：删掉 `defect.json` 里一个桶的计数 → 汇总必须拒绝出表（**不许悄悄跳过那一局**）。
- 坑：**#17 零样本假通过的三种形态**（没证据 / 没跑 / 跑完发现"没差异"）。

### S15 度量：缺陷版靶场 + 检出判决器（`src/world/lexicon.ts`、`detect.ts`、`src/m4f.ts`、`verify/detect-*.ts`）—— M4-f

- 判据**跑前冻结**：异常断言词表 + 观测量→能力归因表（`lexicon.ts`），sha 随 `header.judgement` 在第一步之前落盘——
  **在看到任何模型输出之前**定死尺子。换一张表 sha 就变，审计 `[口径落盘]` 三方交叉核对（header / detection / 实时词表）。
- 四层漏斗判决器（`detect.ts`）：L1 可见分叉（唯一分母）→ L2 玩家侧前提（**降级为分层器**）→ L3 主观上报 → L4 归因，
  六选一互斥判决；同一条动作序列在参考版与缺陷版各重放一遍逐帧比屏幕。
- 上限表（`m4f.ts --policy random`）：零 key 大 n（4800 例），先量"这台仪器能看到多少分叉"，与模型无关。
- 判据：16 绿（`detect`），`npm test` **396 全绿**；
  `verify:detect`（夹具 6/6 判决路径、上限表抽 40/4800 逐行重算 0 处不符）、
  `verify:detect:reference`（参考版误报 **0/4=0.0% [0.0, 49.0]**，分母只收真大脑的参考版局）、`verify:detect:selftest`（注入 16 + 反向对照 5 = **21 例漏抓 0**）。
- **S15 之后追加的 A1/A2（发布复核翻出来的，故障 #21）**：`header.provenance` 落盘 + 审计按 `brainId`/`task`
  两条独立信号交叉核对来源；误报分母只收 `src==='model' && mutant===null`；夹具表**取消百分比与置信区间**
  （标题管不住截图）。`verify/replay.ts`、`verify/predict-audit.ts` 改成按仓库根解析路径、证据缺失说人话并计入不一致；
  `verify/detect-selftest.ts` 在上限表缺失时自己现生成一小份而不是崩 ENOENT。
  **这一批的学费**：以读者身份 clone 自己的仓库跑一遍，比再写十个用例更值钱。
- **S15 之后追加的 D1/D2（6-C 复现包，故障 #22）**：`verify/reproduction.ts` 不抄任何数字，它自己重放世界
  重算 `[初始] [重放] [分叉] [口径] [最小化] [接口]` 六组，再把复现包**生成**成 `REPRODUCTION.md`；
  `--check` 让"文档与证据漂移"变成 CI 失败。最小证物除"仍分叉 + 逐删不复现"外，多加一条别处不验的：
  **它必须是完整轨迹保序删除所得**——否则"最小证物"可以是另外编的一条路。
  **这一批的学费**：写完审计立刻写它的篡改自检，19 例里有 2 例（改屏幕首分叉步、改口径戳）当场退 0——
  根因正是 A1/A2 那次"按仓库根解析路径"留下的 `join(ROOT, 绝对路径)`，条件为假让两条核对静默跳过。见台账 #22。
- 故意破坏：把 `header.judgement` 删掉 / 版本戳改 `m4f-0` / sha 归零 → `[口径落盘]` 三处必有一处硬失败（**局末补写不算**）。
- 坑：**#16 免检通道**（缺戳必须硬失败，不能"缺了当通过"）、**#20 引用了没 import 的 `lexiconSha`**（`node --check` 抓不到，只有真跑才崩）。
- ⚠️ **诚实边界**：真模型臂受免费账号 429 截断，本轮**不出模型臂检出率**——只有上限表与参考版误报率可引用。别把"`detectable=true detected=false`"读成"模型笨"，那是额度没让它开口。

---

### S16 主客观对账（`src/world/reconcile.ts`、`verify/recon.ts`、`verify/recon-*.ts`）—— M4-d

- **零新调用**：不跑任何一局，只对**已发布**的 30 局真证据重算。客观侧一律 `observe()`（`render()` 的逆投影），
  **一次都不许读 `WorldState`**——读了内部坐标就是拿答案对答案，agent 数错格子这类最真实的感知误差会被当场"纠正"掉。
- 四桶 + 恒等式（`reconcile.ts`）：每条抽出来的主张必须落进且只落进一个桶，`主张总数 = 相符+矛盾+约定存疑+无法核对`。
  **抽不出主语的数字对不许丢**（丢了＝免检），全部进「无法核对·主语不明」。
- 「约定存疑」这一格是本轮最贵的设计：屏幕上没有坐标轴也没有刻度，所以 `(2,1)` 读作 (x,y) 还是 (row,col)
  **不是 agent 查得到的信息**——那是仪器的洞，算进矛盾率就是冤枉被试。**屏幕没规定的东西，不许替屏幕规定。**
- 判据**先冻结后计数**：`reconCanonical()`→`reconSha()`→`FROZEN_SHA256`，改一次作废整张表。
  顺序必须是 `verify:recon:dry`（试算，不落盘）→ 单测与夹具全绿 → 才允许 `verify:recon` 落盘。
- 独立复核三件套：`recon-fixture.ts`（**44 格手写期望**，判据不许自己解释自己）→
  `recon-audit.ts`（**不 import 判据本体**，自己重写一遍抽取与判决；两边代码不同、结论必须相同）→
  `recon-selftest.ts`（往真落盘证据里注入 10 种造假，逐条要求变红；**含"审计自己 import 了判据"这一条**——复核不是复印）。
- 判据：42 绿（`reconcile`），`npm test` **438 全绿**；`verify:recon:audit` 夹具 55 条 + 语料 1171 条 = **1226/1226 一致**；
  `verify:recon:selftest` 注入 10 + 反向对照 3 + 冻结守卫 5，**漏抓 0**。
- 故意破坏：把某条 `相符` 手改成 `矛盾`、抹掉一条明细但 `claims` 不改、把锚点 `screenSha` 换成别的帧
  → 三个都必须让审计变红（**聚合数字看不出这些假**，这就是为什么要第三只脚）。
- 坑（本轮一口气写了 7 条台账）：**#23** 交替组没包组、**#24** 两张平行表各说各话 + `String.raw` 丢转义、
  **#25** 排前的规则吞掉后面更合适的主张、**#26** 修饰语只许挂一个词 → 整条规则**静默失效**（最贵：不是判错，是根本没核）、
  **#27** ±18 字符"回溯窗口"连自己都不自洽、**#28** 复核侧抹平整段括号造出**假**分歧、**#29** 假设/等待从句里的状态词被抽成现状主张。
- ⚠️ **诚实边界**：模式表是**读过 637 句自述之后**设计的，只描述这批语料里 agent 会怎么说话，换模型必须重跑盘点；
  `alive` n=0、1 局真大脑整局 0 条 thought（有效样本 29 局）、类别分母绝不相乘；
  矛盾率对外只给**区间 31.3%–32.2%**——141 条里逐条读出的 **6 条判据假阳性**必须一起说，且 `attack`/`hpValue` 两行本轮**不可引用**。

---

### S17 第二条独立投影：听觉通道（`src/world/sound.ts`、`src/m4c.ts`、`listen` 工具、`sound.jsonl`）—— M4-c 上半

- **这一站唯一的设计约束：耳朵必须是第二条独立投影，不是屏幕的复读机。**
  `soundFrame(prev, action, next, caps)` 只吃**前后两个内部状态 + 动作**，**一次都不读 `describe()` 的返回值**。
  共用一份文案＝两只器官其实是一只；那样的"眼耳矛盾"永远是噪声，量不出任何东西。
  所以 `session.applyNow()` 里推声音账本那一行旁边写着注释：**不许读 `events`**。
- 声音只给**次序与次数**，不给布局、不给数字（`一声脚步。/一下破风声。/一声闷哼。/一声咔哒…`，
  敌人挪动统一成一句`远处有 N 处窸窣。`）。这条限制是**故意的**：它造出一族屏幕上**逐字节看不出来**的缺陷。
- 三种发声层故障形状必须**各自成桶**：漏报（S01–S08 关掉某个 `SoundCaps`）、误报（S09 `bumpOnMove`，
  单臂跑、不需要参考版，是"眼耳矛盾"这个独立异常源的种子）、时钟错位（S10 `shiftTicks:1`）。
  S10 最容易被测错：只看"内容集合"或"句子总数"两项指标它**完全隐形**——内容一字不差、句数也不少，只是每句晚了 1 帧。
- **给 agent 的新器官只有一个 `listen`**，参数只有可选的 `from`（起始帧）。
  它和 `look` 一样只给现象，不给函数名、不给能力表。工具注册表里有没有 `listen`，就是 `header.seams.ear` 的取值来源
  ——**由代码反查，绝不让跑的人自述**（这是 #16 免检通道那课的延续）。
- **接线的第一课：装耳朵不许动已经发布的东西。** 新增证据只落 `sound.jsonl`，`world.jsonl` / `defect.json` 的形状一字不改，
  否则 M4-d / M4-f / REPRODUCTION.md 里引用的数字全部作废。这条由 `test/ear-guard.test.ts` 钉住：
  33 局已发布证据、**604 帧**逐字节（状态哈希 + `events`）相同 + 首屏原文相同 + `soundEvents()` 与纯 `soundStream()` 深相等 +
  **反向对照有牙**（变异局拿参考版能力重放，≥60% 必须对不上——不红的守卫等于没有守卫）。
- **上限表（`src/m4c.ts`，零 key、本机实测 37 秒）是这一站的产出**：160 条轨迹 × 15 个版本 = 2400 例，四格表。
  可直接引用的结论：**十个发声层变异体的"两者都可见"= 0**（屏幕确实逐字节没变）、
  在**前提达成**的那些例上耳分叉率 **100.0%**（合计 1219/1600）、参考版 R0 160/160 零分叉；
  反向也成立：**仅眼可见合计 126**（M08 120）——两只眼睛各有各的瞎法，没有谁包含谁。
- **上限表必须能被别人重算成同一份字节**：`npm run verify:ear:check`（同一批 2400 例，重算、**不落盘**、与已发布产物比对）
  报 `✅ 833586 字节 / 6951 字节`，exit=0，已挂进 CI 的"依赖已发布证据那批"。这条才是 README 那句"你能自己重算"的可执行形式。
  ⚠️ 实现它的时候翻了一次车（**#35**）：比对最初写在字符串层，`.length` 数的是 JS 码元，中文键名让它报出"682198 字节"，
  而 `wc -c` 是 833586——差 2×汉字数；而且"解码相同、字节不同"（非法 UTF-8）会被判通过。
  改成 Buffer 比对后，配套两条回归测试刻意**带中文键名**、**带非法 UTF-8 序列**：ASCII 夹具永远测不出这一类差，
  我最初那 4 条就是全 ASCII，全绿却什么都没测住。
- **分母纪律在通道侧复发（#33）**：`cueFired` 是从状态侧**另写一套**算出来的"这一族缺陷的前提触发过没有"，
  单独一列。`S06 在这批轨迹里一次都没触发`＝**未测**，写成 0% 是假话。表守卫四道闸门之一就是"某格前提达成=0 必须点名"。
- 判据：53 绿（`sound`25 `m4c`18 `ear-guard`5 `mock-gate`5），`npm test` **491 全绿**；`npm run verify:ear:ceiling` exit=0 且守卫全过；
  `npm run verify:ear:check` exit=0 且两份产物字节数与 `wc -c` 逐位相同——**它有没有牙是注入验过的**：
  把已发布 `ear_ceiling_summary.json` 里一个 `159` 改成 `160`（一位之差），核对立刻 exit=1 并报出"第 123 行起分叉"+两侧原文。
- 坑：**#30** 抄字段名抄出恒为 `undefined` 的一列（`eye.first` 不存在，`diffScreens` 给的是 `firstStep`）——
  只有**逐字段对账**那一例抓得到；**#31** `sound.test.ts` 首跑 9 绿 14 红，成片同因的失败先怀疑夹具（默认夹具带敌人背景音），
  加 `solo()` 而不是放宽判据；**#32** 守卫里差点留下一条 `x === y || true` 的**永真断言**——它不红、不报错，只让那一格永远绿；
  **#33**（上面"分母纪律"那条单列）；
  **#34** 想用 `--brain mock` 跑一局"agent 会不会用耳朵"，被自家门禁当场拒绝——**闸门该拦的时候就让它拦**，
  缺证据就写"缺"，别用替身产出一条之后没法解释它凭什么算证据的数字；
  **#35** "逐字节一致"那个数不是字节——**中文仓库里"字节"有两个含义**，口径必须落到 Buffer 那一层、报的数必须能被 `wc -c` 复核；
  **#36** `npm run smoke` 每跑一次就往 `runs/` 塞一局替身（默认 `--out ./runs` + 证据目录全量入库），修法是把 `--out` 指到 gitignore 的 `sandbox/`，并让测试静态检查"凡 `--brain mock` 的脚本都不许写进 `runs/`"；
  **#37** 干净克隆**空载连跑 4 轮 491/491**、加压第 3 轮才红一条（`实际 3982`）——`test/retry.test.ts` 把**世界定的漂移量**（`toUTCString()` 的整秒粒度 + 请求往返）抄成了 `[4000, 5000]`。
  第一版修法（`±5ms` 松弛量）加压第 6 轮差 6ms 又红——**松弛量也是手挑的负载常数，同一个错误掉到下一层**。
  终版换成两条结构上负载免疫的界：下界 `deadline - Date.now()`（只随机器变忙而变松）、上界 5000。**产品代码全程是对的**，这是 #31 的镜像形态：零星红先怀疑的应该是判据自己。
- ⚠️ **诚实边界（这一站最容易被读歪的地方）**：上面所有数字都是**仪器上限**，不是模型表现。
  **上半那一轮没有任何一条关于"模型会不会用耳朵"的结论**——那需要 `src/world/ear.ts`（眼耳矛盾判据，先冻结词表+sha）
  和 `verify/ear-{fixture,audit,selftest}.ts`，当时都还没建（**下半已经建好，见 S18**）。
  另外真跑那一格现在是**空**的：`--brain mock` 被仓库自己的门禁拒绝（mock 是测试替身不是大脑），
  绕过它等于伪造证据，所以宁可留着，等 `verify/ear-fixture.ts` 以 `provenance='fixture'` 标签补上。

### S18 眼耳矛盾判据 + 复核三件套 + `--sound-mutant` 接线（M4-c 下半）

- **目标**：把"耳朵听到的"和"眼睛看到的"在同一帧上逐族配对，落成**可反驳的判决**——而不是再写一份文案。
  判据单位是**一帧 × 一族**（主张单位是**两行**：眼侧一行、耳侧一行），这一步定下来，后面所有计数才不会串台。
- **要写的东西**：`src/world/ear.ts`（八族 `EAR_CUES` 先注册再计数 → 五桶判决 `EAR_VERDICTS` → 整族位移闸门 → 六条容量差词条 → `earCanonical()` + `earSha()` 冻结指纹）；
  `verify/ear-fixture.ts`（20 格已知判决，`want` 由人**读屏幕手推**）→ `verify/ear-audit.ts`（**不 import 判据**，自己重放重判）→ `verify/ear-selftest.ts`（19 处注入 + 3 条反向对照）；
  接线三处：`ArenaRunOptions.soundMutant`（**收 id 不收对象**）→ `runArena` 从**已落盘的 `sound.jsonl` 读回**声流做判决 → 每局 `ear.json`；CLI `--sound-mutant` + `m4f --sound-mutants`。
- **过关判据（每一条都真跑过）**：
  1. 五桶齐：`相符 / 矛盾 / 时钟错位 / 无法核对 / 容量差`，`bucketizeEar` 对**表外判决**与**账目断裂**直接抛——不许有"其他"这一栏。
  2. 三方一致：`npm run verify:ear` 退出码 0，20 格逐格 `want`＝`mine`＝`got`，且覆盖闸门点名（族 8/8、桶 5/5、容量差 6/6、**阴性 8 格在列**）。
  3. 审计有牙：`npm run verify:ear:selftest` ⇒ 19 处注入 + 3 条反向对照，失败 0 处。
  4. 接线正证/反证：同一剧本换装置 ⇒ `sound.jsonl` 变、**`world.jsonl`/`coverage.json`/`defect.json` 逐字节不变**（实测五局逐字节相同，磁盘 703 字节，`wc -c` 可复核）；R0 ⇒ 矛盾 0 且相符 >0；S01 漏报>0／S09 误报>0／S10 时钟错位>0 且矛盾 0、相符 0。
  5. 门面层真命令行：未知装置 id、`--sound-mutant` 撞 `--no-ear`、arena 之外用这一维、`m4f --sound-mutants` 非法取值——**四条都必须在任何模型调用之前退出码 1**，且拒绝文案点名合法清单。
  6. CI 两枚指纹：`lexiconSha()` 与 `earSha()` 都等于各自的 `FROZEN_SHA256`——**改了判据不升版本 = 新旧数字混进同一格**，而 `ear.json` 里那个 sha 是唯一能事后分辨的东西。
- **故意破坏实验（跑过，不是设想）**：把 `verify/ear-fixture.ts` E18 的 `f.obs[4].hp === 10` 注入成 `=== 11` ⇒ `verify:ear` 退出码 2 并印 `E18：模具自检没过——第 4 帧做了拾取动作且血条涨回 10 不成立`，复原后 20 格重新三方一致；
  把 S01 的 rig 标签改成 R0 而运行时装置不动（D2 那处注入）⇒ `verify:ear:selftest` 当场点名"rig 标签与证据不符"。**这两处红本轮真跑过。**
  另外 **#40 那条"审计认不出中文现象"不是补做的破坏实验，是审计首跑真踩到的 20 格全红**——踩在最前头的错最值钱，因为它说明这类错只有第二只脚能发现。
- 坑：**#38** 给守卫把关的那段自检里藏着 `|| true`（#32 复发，因为它没有下游）；**#39** 两处 `want` 自己写错（E18「E 集合没变」、E15 把 shuffle 相符数成 12，真值 6）——**只能回读屏幕改 `want`，严禁拿 `got` 回填**；
  **#40** 用英文族 id 去 `includes` 中文现象 ⇒ 20 格全红，对照表**必须在审计侧独立重写**；
  **#41** `execFileSync` 只收 stdout、实话全在 stderr ⇒ 两条**假红**（假红和假绿一样危险）；
  **#42** `node --check` 三个新文件全绿灯而它们真有错——**语法门不是质量门**（#20 明知故犯版）；
  **#43** 入参收 `SoundRig` 对象 ⇒ "装置标签同源"这条断言根本无从下手，**能收成同源的就别收两份**；
  **#44** 更狠：接线测试的例 3 标题写着"逐字节相同"，断言比的却是 `readFileSync(p,'utf8')` 两个字符串，探针把这个口径的数（**603**）印出来，我又照抄进文档写成"603 字节"——**磁盘上是 703**。
  #35 讲的同一条纪律，**一次中了三层**（实现／测试／文档）。修法：`play()` 返回 Buffer、比对改 `buf.equals`，并加一条"字节数 ≠ 字符数"的**夹具前提断言**（注入成相等当场红）；文档里的数一律写明口径与复核命令（`wc -c` / `md5sum`）。
- ⚠️ **诚实边界**：20 格三方一致与每局 `ear.json` 证明的是**判据与接线成立**。
  **"agent 会不会用耳朵"至今没有一条模型侧证据**——`--sound-mutants` 那一维的真模型局还等额度（`#34`：缺就写缺）。
  已发布的 45 项 `runs/` 里**一份 `ear.json` 都没有**：它们跑在判据之前，不回填。

### S19 交付面守卫：把文档自己印的数字变成被测对象（`verify/doc-numbers.ts`）

- **目标**：S18 收尾时第五次终局验收抓到一件事——**代码改了、数字没跟着改**（文档印「测试 8828 行」，磁盘 8840，#45）。
  这一站不修那一个数，修**"抄数字"这个动作**：让"说明书里的数字与磁盘相符"变成一条命令，而不是收尾时的一次记忆测试。
- **要写的东西**：`verify/doc-numbers.ts` 三段射程——
  ① **句子锚点**（8 条）：README 合计句、HAND-CODING §1 真实数字句、三个大文件行数、其余文件区间与中位数、`runs/` 项数、
  KNOWLEDGE 标题的中文数词、清单结尾的阿拉伯数、上限表两份产物字节数；
  ② **恒等式**（4 条）：台账条数 == 自测清单条数、`test/` 的 `*.ts` 与 `*.test.ts` 两个口径不许分家、
  文档若声称"一份 `ear.json` 都没有"则磁盘必须为零、每个 `src/*.ts` 必须被 `test/` 或 `verify/` 点到名；
  ③ **五脏清单表逐行**：从"文件"格解析真实路径（`{a,b}` 展开、裸文件名沿用上一个目录），与"行数"格逐行对表。
  外加 `--print`（把可抄的实测值一次打全）与 `--json`（给测试与 CI）。
- **过关判据（每一条都真跑过）**：
  1. `npm run verify:docs` 退出码 0，输出里"不符 0 处"，且 `表格合计 33 行：相符 33`。
  2. **口径对表真命令**：`lineCount` 在 src/test/verify 三个目录上的合计 == `find … | xargs wc -l | tail -1` 的结果（逐目录跑 shell 比）。
  3. 注入必须当场红：改一位 / 删整句 / 复制成两份不同数 / 表格某行 +1 / 中文数词改大 / 文件格指向不存在的文件——**六种各有归属**（bad／missing／ambiguous／bad／bad／当众不核）。
  4. 不核的格**只许出声不许偷偷通过**："591（现为 591）例"这一格由 `npm test` 自己证，脚本必须打印"⚪ 不核 + 理由"。
  5. `main()` 只在直接运行时执行：`node --test test/doc-numbers.test.ts` 必须报出 16 个测试，而不是"一张 doc-numbers 报表 + 1 个失败"。
- **故意破坏实验（跑过，不是设想）**：本轮最先被破坏的是**守卫自己**——首跑 31 处不符里 29 处来自我用 `split('\n')` 冒充 `wc -l`
  （仓库里 29/38 个 src 文件不以换行符结尾，于是每个文件恰好多 1 行），1 处来自锚点凭记忆写句式（真实文本是 `（不落盘）：… 字节`），
  1 处来自 import 即执行 CLI（测试进程被 `process.exit(1)` 劫走）。修完 30 处假红归零，剩下 2 处正是 #45 的真故障。**详见 #46。**
- 坑：**#45**（数字坏在抄写之后，不坏在代码里）与 **#46**（新审计首跑的"不符"，默认嫌疑人是审计自己；审计脚本被 import 时只许交出函数）。
- ⚠️ **诚实边界**：这条守卫只保证**文档与磁盘相符**，不保证文档里的**结论**对。
  它管不到"591 例"这类只有跑起来才知道的数（已按纪律写明不核），也管不到措辞与判断——那是 README §8 与 FINDINGS 报告自己的责任。

### S20 分发：MCP server + Skill，大脑归宿主、判据归量具（`src/engine.ts`、`src/mcp*.ts`）

- **目标**：让 Qoder / Claude Code / Codex 等宿主现成的大脑直接驱动这套量具，同时**不在 server 内复制循环、不偷偷启动模型、不把裁判答案发给玩家**。
- **要写的东西（按依赖顺序）**：
  1. 把 `loop.ts` 的执行、回填、预算与停止抽成可暂停的 `engine.ts`；CLI 只保留 `brain.decide()` 与解析回炉，成为薄门面。
  2. 把 `world/harness.ts` 拆成 `createArenaWorld()` 与 `finalizeArenaWorld()`；连续跑和分步跑共用同一套世界、预测、目标、假设与局末证据。
  3. 写 stdio JSON-RPC：现代 `2026-07-28` 的 `_meta` 校验、`server/discover`、completion envelope，同时兼容 legacy `initialize`。
  4. 只暴露三个工具：`harness_start` / `harness_step` / `harness_status`；一个安全 player resource 与一个不泄策略的 `arena-play` prompt。
  5. 显式 run handle + `expected_step`；进程内串行队列、跨进程文件锁、原子 v2 checkpoint；执行前预写 `inFlight`，重启逐帧重放核哈希；中断局 fail-closed。
  6. 输出根只由启动环境决定；工具不能传 `outDir` / `mutant`。Skill 只教宿主工作流，fixture 冒烟不算模型证据。
- **过关判据（实现前先注册，见 `M5-FINDINGS.md` A1–A12）**：
  1. `npm test` 累计 **591**、失败 0；其中 MCP/Skill 相关 **35**（协议 8 / 集成 8 / 会话 17 / 共享装配 2）。
  2. `npm run verify:mcp` 退出码 0：现代与 legacy 都走**真子进程**发现并调用；宿主 start→step→finish 后六份证据齐全。
  3. 共享 finalizer 与 `runArena()` 同 seed 短局的返回值、六份证据**逐字节相同**——不是只比"都有文件"。
  4. 进行中的 start/step/status/resource 全查 `mutant`、内部字段、`coverage`、`detection`，零命中；server 目录无 sampling，源码无 `.decide()` / brain 工厂 / 模型 SDK。
  5. 同 `expected_step` 并发两请求只执行一次；坏决策回炉不烧步、三次耗尽返回 `brain_failed`；max steps / wall clock / active runs 都真触发。
  6. 篡改初始或中间帧哈希必须拒绝；执行前磁盘上已有 `inFlight`；崩溃恢复不重复动作且裁判结果 `certified:false`。
  7. 双 server 进程同 expected_step 只执行一次；跨进程 start 共享容量；旧 manager 看到另一进程收手后能释放名额。
  8. 恢复后 trace 前缀与 header 不变；仓库根、`runs/`、源码目录、文件系统根都由**真实入口**拒绝。
  9. Skill fixture 从仓库内与仓库外各真跑一次；临时证据自动清理，不进入 `runs/`，header 明标 `provenance=fixture`。
- **故意破坏实验（本轮真红过）**：恢复时把 `StepRecord[]` 直接塞给动作翻译器 ⇒ 重放为空、哈希不符（#48）；checkpoint 不保存 pending ⇒ 重启后板面事件重复（#49）；把 `{kind:'brain_failed', ...publicResult}` 反过来展开 ⇒ 失败标签被 `finished` 覆盖（#50）。这些证明恢复不是"JSON 一存一读"，而是**对象 + 待处理消息 + 外部世界 + 时间预算**四个一致性面。
  终验前又补了八条：并发恢复各自造 entry（#53）；执行后 checkpoint 前崩溃会重复动作（#54）；双进程队列互不共享（#55）；只核末态漏掉初始/中间帧篡改（#56）；容量信内存而不信磁盘（#57）；解析失败原文丢失（#58）；多个等待者删死锁会误删新锁（#59）；repair pending 重启后退步（#60）；中断局仍像已认证（#61）。
- 坑：**#47–#65** 有代码回归；**#66–#68** 是真实宿主暴露的运行/认知/判据边界，按证据分别记录。核心归纳是**执行意图必须先于副作用落盘、跨进程状态必须以磁盘为准、无法证明执行完成的局不许续跑或冒充认证**；真实入口还必须补齐现代订阅、目录与缓存 schema。
- **真实宿主补验（2026-11-25）**：当前 Qoder LLM 完成两局——11 步 `wall_clock`（finish 未执行）与 3 步主动 `finished`；独立 replay 9/9、2/2 帧一致，预测审计 0 处不一致。试玩同时纠正“玩家遮住脚下物品”的投影误判（#67），并保留 m4f-1 把“没有发现缺陷”判成误报的冻结判据反例（#68）。
- ⚠️ **诚实边界**：真实 Qoder 证明当前配置与宿主可发现、分步调用并主动收手；**Claude Code / Codex 尚未验证，两局也不是长局游戏能力或缺陷检出率证据**。
  fixture 由测试客户端供决策，不是模型证据；MCP trace 的 `brainMs` 无法精确含宿主模型思考时间，如实为 0；文件锁只保护共享本地输出根的进程，不是跨主机分布式锁，也不是多租户隔离。

---

## 3. 每一站的收尾三问（不写答案就不算过关）

1. 这一站的**判据单位**是什么——局、步、字段、还是案例？单位和随机性单位不一致时，结论还站得住吗？
2. 这一站最贵的错是哪一类：**漏判**还是**假阳性**？你的测试分别拦住哪一种？
3. 把这一站的证据**删掉一半**，审计会说什么？（答"照样绿"＝你写出了免检通道）

---

## 4. 哪些不必手敲

- `types.ts` 里那 658 行的**注释**（本项目文档密度最高的文件）：读，别抄。
- `m3.ts` 的 452 行**靶场编排**（跑批逻辑，判据在 `notary/diff.ts` 里）。
- `goal-audit-selftest.ts` 的 440 行注入清单：照 S14 的做法**自己写 5 条**就够，剩下的是体力活。
- `README.md` / `KNOWLEDGE.md` / 十份 `*-FINDINGS.md` 全部是文档，读。
- `reconcile.ts` 里那 14 条**抽取正则的源串**（400+ 行）：读懂「每条为什么必须落进且只落进一个桶」，再自己写 3 条（位置 / 数量 / 极性）就够，剩下的是体力活。**必须自己敲的是四桶判决、子句定位、`reconCanonical()` 与恒等式**——那才是这一站的肌肉。

粗估：**手敲约 7100 行 src + 6150 行 test**，其余是读。按每天有效 4 小时算，20 站 ≈ **16～21 天**；
周末冲刺（每天 8 小时）≈ **8 个周末**。中间任何一站连续卡超过 1 小时，就去看那一份 FINDINGS 报告里对应的故障条目——
**这些坑都已经踩过并写下来了，不必再花一遍学费。**

---

## 5. 终局验收（全部要真跑，不接受"应该没问题"）

```bash
export PATH=/home/fuyuan/.local/node-22/bin:$PATH
cd ~/practice/agent-harness

npm test                        # 期望：# pass 591 / # fail 0
npm run verify:mcp             # S20：现代/legacy 真 stdio + 分步会话/恢复/安全视图 + Skill fixture 冒烟
npm run smoke                   # mock 大脑 6 步走通（只验接线）——落 `sandbox/smoke`，不许写进 runs/（台账 #36）
npm run verify:board            # 夹具 → 审计：总计不一致 0 处
npm run verify:goal             # 同上，目标通道
npm run verify:board:selftest   # 注入 15 处漏抓 0 + 反向对照 2 组
npm run verify:goal:selftest    # 注入 24 处漏抓 0 + 反向对照 4 组
npm run verify:random           # 随机臂 8 格表（4 世界 × 2 预算）
npm run verify:detect           # M4-f 检出判决：夹具 6/6 判决路径 + 上限表抽 40/4800 逐行重算，0 处不符
npm run verify:detect:reference # M4-f 参考版误报率 0/4=0.0% [0.0, 49.0]（分母只收真大脑的参考版局，剔除逐条出声）
npm run verify:detect:selftest  # M4-f 判决器：注入 16 处漏抓 0 + 反向对照 5 组（含口径落盘三种篡改、夹具冒充真证据）
npm run verify:recon          # M4-d 对账落盘：30 局 1171 条主张，恒等式 297+141+42+691=1171 ✅
npm run verify:recon:audit    # 夹具 55 + 语料 1171 = 1226 条独立重算，分歧必须 0；审计侧不许 import 判据
npm run verify:recon:selftest # 注入 10 处造假 + 反向对照 3 组 + 冻结守卫 5 条：漏抓 0
npm run docs:reproduction       # 生成 6-C 复现包 REPRODUCTION.md（三要素与最小证物全部重放算得，不许手抄）
npm run verify:reproduction     # 独立重放审计 4 案 + 与入库文档逐字节比对（手改一个字就红）
npm run verify:reproduction:selftest  # 复现包审计自己的篡改自检：注入 13 处漏抓 0 + 反向 2 组 + 边界 4 例
npm run verify:ear:ceiling      # M4-c 双通道上限表：2400 例，四道守卫全过（R0 零漏气、world 行不落"仅耳可见"、每格前提达成 >0）
npm run verify:ear:check        # 同一批 2400 例**重算 + 与已发布产物逐字节比对**（不落盘）：833586 / 6951 字节，一位之差就 exit=1
npm run verify:ear              # M4-c 下半：20 格已知判决 → 审计**不 import 判据**重放重判 → 三方一致 + 覆盖闸门（族 8/8、桶 5/5、容量差 6/6、阴性 8 格）
npm run verify:ear:selftest     # 耳判据篡改自检：注入 19 处漏抓 0 + 反向对照 3 条（含 D2「rig 标签改成 R0」、R3「只留阴性那一批必须红」）
npm run verify:docs             # S19 交付面守卫：文档印的行数/条数/字节数逐格重算（8 锚点 + 4 恒等式 + 五脏清单表逐行，差一位就 rc=1）
```

**还有一条终局验收，是发布前那轮才加上的**：`git clone` 一份**别人的视角**的仓库，在上面重跑上面全部命令。
`runs/` 已随仓库发布，所以那一次 clone 必须能重算出**同一个** `0/4` 与同一张上限表——
在自己的工作目录里跑绿，只证明你的机器；在干净克隆上跑绿，才证明交付物。
本轮就是在这一步翻出故障 #21（`误报率 1/2 = 50.0%` 当众印出来），CI 也已把这套矩阵挂成每次 push 都跑。
**同一条纪律在第三次验收时又翻出一条 #37**（490/491，且只在 clone 里偶发）——所以这一步不是仪式，是这套仓库唯一抓得住"只在我的机器上坏"的关。

**这一站已经真跑过（`1b1b225`，从 GitHub 匿名 clone 到空目录）**：零依赖 → `npm test` 396/396；
上面每条 `verify:*` 全部 rc=0，`verify:detect:reference` 重算出同一个 `0/4 = 0.0% [0.0, 49.0]`；
上限表不是"抽样相符"而是**逐字节一致**（4800 行，`md5 79631681c80a5c45d6dfad5c22679020`，22.8s 重算）；
把 run 目录名写错时三个审计脚本各自给 `[证据缺失]` 与人话原因后非零退出，没有一处假装绿。
CI 侧 `verify` 工作流同一 commit 全绿（11 步全 success，含"依赖已发布证据那批"）。

**终局验收第二次（M4-d 之后重跑，`9d84088`，同样从 GitHub 匿名 clone 到空目录）**：`npm test` **438/438**；
`verify:recon` 把 30 份 `reconciliation.json` **在克隆里重新生成**，与仓库里已发布的那一份**逐字节同一**
（30 份 + `summary.json` 的 md5 聚合 `e2d3e4a6df8b64846d395e6dd96070f9`，克隆前后各算一次，中间删掉重生成）——
这才是"你能自己重算"的硬样子：**对账不靠我跑过，靠任何人在没有 key、没有原始会话的情况下再跑一遍得到同一张表**。
`verify:recon:audit` 1226/1226、`verify:recon:selftest` 漏抓 0；`verify:detect:reference` 重算出同一个 `0/4 = 0.0% [0.0, 49.0]`；
上限表再逐字节一致（4800 行，`md5 79631681c80a5c45d6dfad5c22679020`，57s 重算）；`verify:reproduction` 与入库文档逐字节相符；`verify:m4` 总计不一致 0 处。

**终局验收第三次（M4-c 上半收尾，`df9774d`，同样从 GitHub 匿名 clone 到空目录；日志全留盘）**：
`npm test` 空载 3 轮 **491/491 / 491/491 / 491/491**（24.2–26.5s），**8 路 `yes` 满载再 3 轮 491/491**（31.6–40.9s，是空载的 1.25–1.7 倍——
这正是台账 #37 那条偶发唯一的显形条件）；`test/retry.test.ts` 单独复跑 3 轮 21/21（另起 6 路 `yes`，机器仍忙）。
18 条 `verify:*` 加 `npm run smoke`、`verify:ear:ceiling` 共 20 条命令**全部 rc=0**（每条一份留盘日志）。`verify:ear:check` 在克隆里重算 2400 例，
报出 `ear_ceiling.jsonl 逐字节一致（833586 字节）`、`ear_ceiling_summary.json 逐字节一致（6951 字节）`——
**这两个数与克隆里的 `wc -c` 逐位相同**（#35 的修法在陌生人机器上复核过）；写盘版 `verify:ear:ceiling` 重算后
`md5sum -c` 两份产物全过（`a7ee189e…` / `2ea16770…`）。`verify:recon` 在克隆里重新生成 30 份 `reconciliation.json` + `summary.json`，
重跑前后各自算一次聚合 md5（`{find runs -name reconciliation.json; echo runs/m4d-recon/summary.json} | sort | xargs md5sum | md5sum`）
得同一个 `005bf4ac5920edc4c7ec92efa1f2424b`。`smoke` 落在 gitignore 的 `sandbox/smoke/`，
`runs/` 里 `brainId=mock:TEST-DOUBLE` 的局数 **14 → 14 未增**（那 14 局是 M0/M1 时代发布的历史证据，身份写在 header 里），
全套跑完 `git status` **一个字都不脏**（#36 的修法同样在陌生人机器上复核过）。
CI 侧 `verify` 工作流（单 job `measurements`，含 `npm test` + `smoke` + 依赖已发布证据那批 + `verify:ear:check`）同一 commit **success**；
带那条偶发失败的 `942fd35` 在 CI 上也一直是绿的——**"CI 绿"从来不是这条的显形条件**，这就是 #37 的教训本体。

**第四次抽查（`30ea492`，只改文档与注释那一个 commit，仍匿名 clone；HTTPS 第一次因 TLS 抖动失败，重试第 2 次成功）**：
`npm test` 空载 **491/491**、8 路 `yes` 满载 **491/491**（34.8s）；`verify:ear:check` rc=0 且两份产物逐字节一致；
`smoke` 落 `sandbox/smoke/`、`runs/` 替身局 **14 未增**、`git status` 空。
最后一步是把**文档自己印出的数字**当成被测对象在克隆里重算一遍：`src 8698 / test 8003 / verify 6049 行`、
台账 **37** 条、自测清单 **37** 条、`wc -c` **833586 / 6951** ——**全部与 README、HAND-CODING 写的逐位相同**（口径：`find <目录> -name '*.ts' | xargs wc -l`、`grep -c '^### #' README.md`、`grep -c '^- \[ \] ' KNOWLEDGE.md`）。

**终局验收第五次（M4-c 下半收尾，`491dc40`，同样匿名 HTTPS clone 到空目录；日志逐条留盘）**：
`npm test` 空载 3 轮 **540/540 / 540/540 / 540/540**（24.7–29.4s），**8 路 `yes` 满载再 3 轮 540/540**（34.5 / 35.5 / 43.9s，空载的 1.2–1.6 倍——#37 那条偶发的显形条件照跑）。
命令矩阵 25 条（24 条 `verify:*` + `npm run smoke`）**全部 rc=0**：耳三件套、`verify:ear:check` 重算 2400 例得同一份字节
（`wc -c` **833586 / 6951**，`md5sum` `a7ee189e…` / `2ea16770…`，与已发布产物逐字节）、`verify:recon` 30 局、`verify:detect:reference` 同一个 `0/4 = 0.0% [0.0, 49.0]`、
`verify:reproduction` 与入库文档逐字节相符。`smoke` 落 `sandbox/smoke/`、`runs/` 替身局 **14 → 14 未增**、`ear.json` 份数 **0**（判据晚于那 45 项证据，不回填）、
全套跑完 `git status` **0 行**。CI `verify` 工作流同一 commit **success**（run #11）。
**但这一轮的"文档数字重算"抓到一条真故障（#45）**：`find test -name '*.ts' | xargs wc -l | tail -1` 在克隆里给 **8840**，
而 README §1 与 HAND-CODING §1 都印着 **8828**——差 12 行正是本轮按 #44 改 `test/ear-wiring.test.ts`（Buffer 比对 + 夹具前提断言）那一次编辑，
**发生在数字被抄进文档之后**。其余几格（src 9642、`verify:ear` 两份产物字节、台账 44 / 清单 44、`world.jsonl` 3185 字节 vs 2657 字符）当时逐位相符。
修法不是再抄一遍，是落成命令：**`npm run verify:docs`（S19）**——见上面 §5 命令清单最后一条与本站 §「S19」。

**第六次抽查（S19 落地后，`d02c45e`，仍匿名 HTTPS clone 到空目录；日志逐条留盘）**：
`npm test` 空载 **556/556**（27.9s）、8 路 `yes` 满载 **556/556**（40.0s，1.44 倍——#37 那条的显形条件照跑）。
命令矩阵 12 条**全部 rc=0**：`verify:docs`、耳三件套（`verify:ear` / `:selftest` / `:check`）、`verify:detect` 两件、`verify:recon` 两件、
`verify:reproduction`、`verify:m4`、`verify:random`、`smoke`。这一轮跟前面五次多出来的东西只有一件——
**"把文档自己印的数字当被测对象"这一步不再是我手写 shell 命令，而是仓库里的一条 `npm run verify:docs`**，
它在克隆里报 `表格合计 32 行：相符 32｜不符 0｜当众声明不核 0`、`doc-numbers：全部相符 ✅`。
然后仍按 #45 的老办法**换一种工具**再算一遍（守卫和被守卫的文档不能由同一个工具自证）：
`find <目录> -name '*.ts' | xargs wc -l | tail -1` 给 `src 9642 / test 9067（33 个文件）/ verify 7984（23 个文件）`，
`grep -c '^### #' README.md` = 台账 **46**、`grep -c '^- \[ \] ' KNOWLEDGE.md` = 清单 **46**（两者必须相等，I1），
`runs/` **45** 项 / **291** 个文件，单文件 `wc -l`：`ear.ts` 767、`doc-numbers.ts` 471、`doc-numbers.test.ts` 227——
**逐位与 `verify:docs` 的结论相同**，上限表两份产物 `wc -c` 仍是 **833586 / 6951**。
洁净度：全套跑完 `git status` **0 行**、`runs/` 替身局 **14 未增**、`ear.json` 份数 **0**。
CI `verify` 工作流同一 commit **success**（run #12，runs #10–#12 三连绿）。
回写后又拿新 commit 复跑了一次 clone，这次**我自己多跑了一步 `npm install`**（本仓库零依赖，根本不需要装），
于是 `git status` 冒出 `?? package-lock.json` 一行——数字没坏，坏的是"跑完全套仍然干净"这句话的前提被我的脚本悄悄改了。
修法：`.gitignore` 从此忽略 `package-lock.json`，可复核 `git check-ignore -v package-lock.json` 命中第 9 行。
复跑（`4686dd8`）**故意把那步多余的 install 留着**，让"矩阵跑完 `git status` **0 行**"和"连多余的 install 也不脏，
`git status` 仍 **0 行**"两件事在同一次 clone 里各自成立；那一轮的其余数字与上面逐位相同
（`npm test` 556/556、12 条命令矩阵全 rc=0、`verify:docs` 相符 32／不符 0／不核 0、上限表 **833586 / 6951** 字节、替身局 14、`ear.json` 0 份）。
CI `verify` 工作流在只改文档的两个后续 commit（`9ecc494` run #13、`4686dd8` run #14）也都是 **success**。

**同族第二次自污（复跑只改文档的 `59c5f02`）把这条纪律补齐了**：那一次脚本把日志重定向进了**克隆目录里面**
（`> test.out`，而不是 `> $BASE/logs/test.out`），于是 `git status` 报 **3 行**，而三行全是自己写的 `?? test.out / docs.out / repro.out`——
仓库跟踪的东西一个字节没动。**"跑完全套 `git status` 一个字都不脏"从来有两个前提**：① 仓库里的命令不许往 `runs/` 写（#36 管的那层）；
② **验收脚本自己的日志必须落在克隆外面**（这一层今天才补上）。重跑（日志在 `/tmp/clone-check-s19e/logs/`，多余的 `npm install` 照留）：
`npm test` 556/556（24.4s）、`verify:docs` 相符 32／不符 0／不核 0、`verify:reproduction` rc=0、`git status` **0 行**。
这两次都记在**验收流程的操作规程**里、没有另开台账条：脏的是我脚本的 stdout 落点，判据、证据、文档数字三者都没被污染——
而 #36 不一样，那次真往全量入库的 `runs/` 里塞了一局替身。

全绿之后，最后一步才是真本事：把 `.env` 里的远端端点接上（**只用远端，不用本地模型**），
自己跑一局，然后**用 `verify/` 下的脚本独立复核你自己这一局**——
那一刻你才会明白为什么这套工程里"审计有牙"排在"agent 会玩"前面。
