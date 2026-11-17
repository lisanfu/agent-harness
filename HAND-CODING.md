# 手敲路线图：把这套 harness 从头敲一遍

> 这份文档不是第二份 README。README §3（Step 0–10）给的是**可以复制的代码**；
> 这份给的是**自己敲的顺序、每一站的过关判据、以及你一定会撞上的坑**。
> 每一站都对应这套工程里一次真实的"跑→坏→查→修→归纳"，坑号与 README §8 故障台账一致（共 19 条）。

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

**手敲的纪律**：另开目录，不要动参考仓库（它现在 396 测试全绿 + M4-e 十局真证据 + M4-f 上限表(4800 例)/缺陷臂真跑证据，改坏了你就失去对照物了）。

```bash
mkdir -p ~/practice/agent-harness && cd ~/practice/agent-harness && git init
export PATH=/home/fuyuan/.local/node-22/bin:$PATH
```

每一站过关就打一个 tag（`git tag s3`）。**读参考实现的方式是"读 20 行 → 关掉 → 自己写"**；
直接选中复制粘贴，这一趟就只剩下打字练习，学不到东西。

---

## 1. 总进度表（15 站，测试数只增不减）

参考仓库的真实数字：`src/` 34 个文件 **6803 行**，`test/` 25 个文件 **6225 行 / 396 测试**，`verify/` 13 个文件 **4048 行**。

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
- 故意破坏：把 `header.judgement` 删掉 / 版本戳改 `m4f-0` / sha 归零 → `[口径落盘]` 三处必有一处硬失败（**局末补写不算**）。
- 坑：**#16 免检通道**（缺戳必须硬失败，不能"缺了当通过"）、**#20 引用了没 import 的 `lexiconSha`**（`node --check` 抓不到，只有真跑才崩）。
- ⚠️ **诚实边界**：真模型臂受免费账号 429 截断，本轮**不出模型臂检出率**——只有上限表与参考版误报率可引用。别把"`detectable=true detected=false`"读成"模型笨"，那是额度没让它开口。

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
- `README.md` / `KNOWLEDGE.md` / 七份 `*-FINDINGS.md` 全部是文档，读。

粗估：**手敲约 4900 行 src + 3700 行 test**，其余是读。按每天有效 4 小时算，15 站 ≈ **13～17 天**；
周末冲刺（每天 8 小时）≈ **7～8 个周末**。中间任何一站连续卡超过 1 小时，就去看那一份 FINDINGS 报告里对应的故障条目——
**这些坑都已经踩过并写下来了，不必再花一遍学费。**

---

## 5. 终局验收（全部要真跑，不接受"应该没问题"）

```bash
export PATH=/home/fuyuan/.local/node-22/bin:$PATH
cd ~/practice/agent-harness

npm test                        # 期望：# pass 396 / # fail 0
npm run smoke                   # mock 大脑 6 步走通（只验接线）
npm run verify:board            # 夹具 → 审计：总计不一致 0 处
npm run verify:goal             # 同上，目标通道
npm run verify:board:selftest   # 注入 15 处漏抓 0 + 反向对照 2 组
npm run verify:goal:selftest    # 注入 24 处漏抓 0 + 反向对照 4 组
npm run verify:random           # 随机臂 8 格表（4 世界 × 2 预算）
npm run verify:detect           # M4-f 检出判决：夹具 6/6 判决路径 + 上限表抽 40/4800 逐行重算，0 处不符
npm run verify:detect:reference # M4-f 参考版误报率 0/4=0.0% [0.0, 49.0]（分母只收真大脑的参考版局，剔除逐条出声）
npm run verify:detect:selftest  # M4-f 判决器：注入 16 处漏抓 0 + 反向对照 5 组（含口径落盘三种篡改、夹具冒充真证据）
```

**还有一条第 16 站的验收，是这一轮才加上的**：`git clone` 一份**别人的视角**的仓库，在上面重跑上面全部命令。
`runs/` 已随仓库发布，所以那一次 clone 必须能重算出**同一个** `0/4` 与同一张上限表——
在自己的工作目录里跑绿，只证明你的机器；在干净克隆上跑绿，才证明交付物。
本轮就是在这一步翻出故障 #21（`误报率 1/2 = 50.0%` 当众印出来），CI 也已把这套矩阵挂成每次 push 都跑。

**这一站已经真跑过（`1b1b225`，从 GitHub 匿名 clone 到空目录）**：零依赖 → `npm test` 396/396；
上面每条 `verify:*` 全部 rc=0，`verify:detect:reference` 重算出同一个 `0/4 = 0.0% [0.0, 49.0]`；
上限表不是"抽样相符"而是**逐字节一致**（4800 行，`md5 79631681c80a5c45d6dfad5c22679020`，22.8s 重算）；
把 run 目录名写错时三个审计脚本各自给 `[证据缺失]` 与人话原因后非零退出，没有一处假装绿。
CI 侧 `verify` 工作流同一 commit 全绿（11 步全 success，含"依赖已发布证据那批"）。

全绿之后，最后一步才是真本事：把 `.env` 里的远端端点接上（**只用远端，不用本地模型**），
自己跑一局，然后**用 `verify/` 下的脚本独立复核你自己这一局**——
那一刻你才会明白为什么这套工程里"审计有牙"排在"agent 会玩"前面。
