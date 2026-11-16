#!/usr/bin/env node
/**
 * CLI 入口。零依赖，手撕 argv。
 *
 * 输出纪律：人类日志一律 stderr；stdout 留给 stdio 大脑协议。
 * 退出码：0=finished，2=其他停止原因，1=配置/启动错误。便于将来接 CI。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBrain, loadEnv, type BrainKind } from './brain/index.ts';
import { classify } from './errors.ts';
import { runHarness } from './loop.ts';
import { seedFromString } from './rng.ts';
import { builtinTools } from './tools/builtin.ts';
import { ToolRegistry } from './tools/registry.ts';
import { ARENA_TASK, runArena } from './world/harness.ts';
import { ALL_MUTANTS } from './world/mutants.ts';
import type { Detection } from './world/detect.ts';
import type { GoalStats, HarnessConfig, HypothesisStats } from './types.ts';

const ROOT = resolve(import.meta.dirname, '..');

interface Args { [k: string]: string | boolean }

function parseArgv(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function num(v: string | boolean | undefined, d: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}

function usage(): void {
  process.stderr.write(`
最小 agent harness（零依赖 / 不用本地模型）

用法:
  node src/cli.ts --brain stdio  --task "任务描述" [选项]
  node src/cli.ts --brain openai --task "任务描述" [选项]     # 需 .env 配好远端端点
  node src/cli.ts --brain openai --world arena --seed 7      # M1：玩确定性竞技场，零说明书

选项:
  --brain <stdio|openai|mock>   大脑来源，默认 stdio（宿主提供决策，零 key）
  --task <文本>                 任务；--world arena 时省略则用零说明书默认任务
  --world <files|arena>         世界类型，默认 files（沙箱文件）。arena = M1 感知+执行层
  --mutant <id>                 仅 arena：变异体 id（M01..M09 / D01..D03）。省略 = 参考版对照组
  --no-minimize                 仅 arena：分叉后不做 ddmin 最小化
  --no-predict                  仅 arena：关掉预测-对照（M4），退回 M1 的契约条件做对照
  --no-goal                     仅 arena：关掉目标通道（M4-b2）。goal 工具不注册、契约里不出现、
                                产物里没有 goal_* 事件——M4-e 消融需要一个真对照组
  --dd-max-tests <n>            仅 arena：ddmin 谓词调用预算，默认 400
  --sandbox <目录>              工具可访问的根，默认 ./sandbox（arena 模式不使用）
  --seed <数字|字符串>          随机种子，默认 42；字符串会哈希成整数
  --max-steps <n>               步数预算，默认 20
  --max-wall-ms <n>             时间预算，默认 300000
  --max-context-chars <n>       上下文字符预算，默认 12000
  --keep-recent <n>             保留最近消息条数，默认 8
  --max-parse-retry <n>         解析失败回炉次数，默认 2
  --repeat-limit <n>            连续重复动作判死循环阈值，默认 3
  --out <目录>                  证据输出根，默认 ./runs
  --i-know-mock-is-not-a-brain  允许 mock（仅测试用，不是大脑）

arena 模式产出（除标准三件套外）:
  world.jsonl    逐帧世界哈希 + 现象描述（M3 证明只存终态会漏检掩蔽缺陷）
  coverage.json  状态覆盖账本（只给裁判/日志，绝不给 agent）
  defect.json    agent 主观陈述 + 公证器客观判定 + 最小化可重放序列

stdio 协议:
  harness → stdout 一行 {"type":"decide", task, system, messages, tools, step, notes, hypotheses}
  宿主    → stdin  一行 {"thought":"...","call":{"name":"...","args":{}}}
                   arena 模式可选追加 "predict":{...} 与 "surprise":{"unexpected":bool,"why":"..."}
                   预测若在检验某条假设，可追加 "testing":"H1" 或 {"id":"H1","field":"enemyCount"}
  假设板渲染: notes 是纯笔记，hypotheses 是结构化假设（含代码累加的核对计数）。
              宿主可直接用 notesBlock(notes, hypotheses) 渲染，与远端大脑共用同一个纯函数。
  目标板渲染: goals 是目标数组（正文/完成条件/status 由宿主声明，判定计数由代码累加）。
              宿主可直接用 goalsBlock(goals) 渲染，同样与远端大脑共用一个纯函数。
              宿主要用目标通道，回决策时带 {"call":{"name":"goal","args":{"id":"G1","text":"...","doneWhen":{"hp":0}}}}。
`);
}

/**
 * 假设板账本的人类可读摘要。
 * 与预测账本同一条纪律：把"不好看"的数一起打出来——没声明归因、指向不存在的 id、
 * 形状写歪、**被客观反对却仍未淘汰**、以及**自称成立却零核对**。
 * 只打"立了几条假设"会把假规则驻留藏起来，而那正是 M4-b 要治的病。
 */
function hypothesisLine(hs: HypothesisStats): string {
  const total = hs.proposed + hs.confirmed + hs.retired;
  return `[假设板] 可检验假设 ${total} 条（待检验 ${hs.proposed} / 模型认为成立 ${hs.confirmed} / 已淘汰 ${hs.retired}），改写正文 ${hs.revised} 次\n`
    + `         归因：记上账 ${hs.attributed} 步；没声明 testing ${hs.unattributed} 步；指向不存在的 id ${hs.unknownTarget} 次；形状写歪 ${hs.malformed} 次；那步无可核对事实 ${hs.notChecked} 次；指定字段没预测 ${hs.fieldAbsent} 次\n`
    + `         收手时仍被客观反对却未淘汰：${hs.contradictedNotRetired} 条${hs.contradictedNotRetired > 0 ? '（假规则驻留的客观量，代码不代它淘汰）' : ''}\n`
    + `         收手时自称成立却零客观核对：${hs.confirmedNoChecks} 条${hs.confirmedNoChecks > 0 ? '（自称已验证 ≠ 账本上有核对，淘汰机制因此永不触发）' : ''}\n`;
}

/**
 * 目标板账本（M4-b2）。同一条纪律：**把不好看的数一起打出来**。
 * 只打"立了几条目标"会藏掉三件本轮真正要测的事——
 *   条件写歪判不出（conditionMalformed / uncheckable）、
 *   画面已满足却仍标 open（metNotClosed，收口不干脆）、
 *   自称达成却从未被画面满足过（closedNeverMet，主客观脱钩）。
 * 没有 goalStats 时整段不出现：文件模式没有目标通道，打一份全 0 会被误读成"启用了但没用"。
 */
function goalLine(gs: GoalStats | undefined): string {
  if (!gs) return '';
  const total = gs.open + gs.achieved + gs.abandoned;
  return `[目标板] 目标 ${total} 条（在追 ${gs.open} / 模型认为达成 ${gs.achieved} / 已放弃 ${gs.abandoned}），新建 ${gs.declared} 次、改写正文 ${gs.revised} 次、改写条件 ${gs.conditionRevised} 次、被拒 ${gs.rejected} 次\n`
    + `         带可核对条件的 ${gs.withCondition} 条；条件形状写歪 ${gs.conditionMalformed} 次（原文留档，绝不猜成条件）\n`
    + `         客观判定共 ${gs.checks} 次：满足 ${gs.met} / 不满足 ${gs.unmet} / 无法核对 ${gs.unverifiable}\n`
    + `         收手时画面已满足却仍标 open：${gs.metNotClosed} 条${gs.metNotClosed > 0 ? '（代码只判定，要不要收手归大脑）' : ''}\n`
    + `         收手时自称达成却从未被画面满足过：${gs.closedNeverMet} 条${gs.closedNeverMet > 0 ? '（自述与账本脱钩，这条必须大声报）' : ''}\n`
    + `         收手时仍判不出结果：${gs.uncheckable} 条${gs.uncheckable > 0 ? '（没有可核对条件，目标通道对这几条等于空转）' : ''}\n`;
}

/**
 * M4-f 检出判决漏斗。一层一行，**判决与失败层一起打**。
 *
 * 为什么不能只打"检出/没检出"一个布尔：那等于把本轮真正要量的东西压成一个数。
 * 四层的失败原因互不相同——不可见是世界的天花板、未触达是策略没走到、
 * 未上报是看见了没当回事、归因错误是报了但指错。混成一个 0 就全查不出来了。
 *
 * ⚠️ 这里会打被删能力名，走的是 stderr。**宿主大脑（stdio）模式下操作者就看得见答案**，
 *    所以缺陷版消融一律用远端大脑；拿自己当大脑跑缺陷版＝开卷考试。
 */
function detectionLine(d: Detection): string {
  const vis = d.visible.diverged
    ? `是（第 ${d.visible.firstStep} 帧首见，共 ${d.visible.frames} 帧不同）`
    : '否（这条轨迹上画面从头到尾一样）';
  const pre = d.preconditions.length
    ? d.preconditions.map((p) => `${p.cap}=${p.reached ? '达成' : '未达成'}〔读${p.side}版〕`).join(' ')
    : '（参考版：没有被删能力，这一层不适用）';
  const quotes = d.claim.quotes.map((q) =>
    `           ${q.where}：${q.text.slice(0, 140)}\n             ↳ 异常词=${q.anomalies.join('/')} 指向=${q.caps.join('/')}`,
  ).join('\n');
  return `[检出判决] L1 屏幕可见分叉=${vis}\n`
    + `            L2 玩家侧前提 ${pre}\n`
    + `            L3/L4 上报=${d.claim.reported ? '有' : '无'}（喊了异常但没指到观测量的有 ${d.claim.vague ? '1' : '0'} 处）`
    + ` 归因=[${d.claim.caps.join(',') || '—'}] → 判决=${d.verdict} 失败层=${d.whyNot ?? '—（参考版不算漏斗）'}\n`
    + `            判据口径=${d.judgementVersion}（改词表必须升版本、按版本分箱重出表）`
    + `${d.invisibleThoughDiverged ? '\n            🔴 内部状态分叉了、屏幕从没变过：这套视网膜下**原理上不可发现**，别记到 agent 账上' : ''}\n`
    + (quotes ? `${quotes}\n` : '');
}

async function main(): Promise<number> {  loadEnv(join(ROOT, '.env'));
  const args = parseArgv(process.argv.slice(2));
  if (args['help'] || args['h']) { usage(); return 0; }

  const world = typeof args['world'] === 'string' ? args['world'] : 'files';
  if (world !== 'files' && world !== 'arena') {
    process.stderr.write(`错误：--world 只能是 files 或 arena，收到 "${world}"\n`);
    return 1;
  }

  const mutant = typeof args['mutant'] === 'string' ? args['mutant'] : null;
  if (mutant && world !== 'arena') {
    process.stderr.write('错误：--mutant 只在 --world arena 下有意义。\n');
    return 1;
  }
  if (mutant && !ALL_MUTANTS.some((m) => m.id === mutant)) {
    process.stderr.write(`错误：未知变异体 "${mutant}"。可用：${ALL_MUTANTS.map((m) => m.id).join(', ')}\n`);
    return 1;
  }

  // arena 模式的任务是固定的零说明书目标；给了 --task 就用你的（便于做对照实验）
  const task = typeof args['task'] === 'string' ? args['task'] : (world === 'arena' ? ARENA_TASK : '');
  if (!task) { usage(); process.stderr.write('\n错误：必须提供 --task（或用 --world arena 取默认零说明书任务）\n'); return 1; }

  const kind = (typeof args['brain'] === 'string' ? args['brain'] : 'stdio') as BrainKind;
  if (kind === 'mock' && args['i-know-mock-is-not-a-brain'] !== true) {
    process.stderr.write('拒绝：mock 是测试替身，不是大脑。仅在单元测试中使用；如确要跑，加 --i-know-mock-is-not-a-brain\n');
    return 1;
  }

  const sandbox = resolve(typeof args['sandbox'] === 'string' ? args['sandbox'] : join(ROOT, 'sandbox'));
  // arena 模式不用文件沙箱，别往里塞示例文件污染证据
  if (world === 'files' && !existsSync(sandbox)) {
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(join(sandbox, 'hello.txt'), '这是一个沙箱示例文件。\nagent 可以用 list_dir / read_file 观察它。\n');
    process.stderr.write(`[init] 已创建沙箱并放入示例文件：${sandbox}\n`);
  }

  const seedRaw = typeof args['seed'] === 'string' ? args['seed'] : '42';
  const seed = /^\d+$/.test(seedRaw) ? Number(seedRaw) : seedFromString(seedRaw);

  const config: HarnessConfig = {
    task,
    sandbox,
    seed,
    maxSteps: num(args['max-steps'], 20),
    maxWallMs: num(args['max-wall-ms'], 300_000),
    maxContextChars: num(args['max-context-chars'], 12_000),
    keepRecent: num(args['keep-recent'], 8),
    maxParseRetry: num(args['max-parse-retry'], 2),
    repeatLimit: num(args['repeat-limit'], 3),
    outDir: resolve(typeof args['out'] === 'string' ? args['out'] : join(ROOT, 'runs')),
  };

  const brain = createBrain(kind);
  const log = (l: string) => process.stderr.write(`${l}\n`);

  // ── arena 模式：M1 眼睛和手 + M3 公证器 ──
  if (world === 'arena') {
    process.stderr.write(`[run] brain=${brain.id} world=arena seed=${seed} mutant=${mutant ?? '（参考版对照组）'}\n`);
    const r = await runArena({
      brain, seed, mutant, config, log,
      doMinimize: args['no-minimize'] !== true,
      doPredict: args['no-predict'] !== true,
      doGoal: args['no-goal'] !== true,
      ddMaxTests: num(args['dd-max-tests'], 400),
    });
    const n = r.notary;
    const ps = r.run.predictionStats;
    // 预测账本要把"不好看"的数一起打出来：没给预测、无法核对、看见了不当回事。
    // 只打准确率会把这三样藏起来，而它们正是 M4 要度量的东西。
    const predictLine = ps
      ? `[预测对照] 核对 ${ps.checked} 步（其中 look 这类不推进画面的 ${ps.staticChecks} 步；给了预测 ${ps.given}，没给 ${ps.missing}）；${ps.fields} 个字段：相符 ${ps.ok} / 不符 ${ps.violated} / 无法核对 ${ps.unverifiable}\n`
        + `           模型判"意外" ${ps.surpriseUnexpected}/${ps.surpriseGiven} 次（另有 ${ps.surpriseMalformed} 次判断写歪了）；代码判不符、模型却说不意外 ${ps.violatedButNotSurprised} 次\n`
      : '';
    process.stderr.write(`
[done] stop=${r.run.stopReason} steps=${r.run.steps.length} 世界动作=${r.worldActions} 用时=${r.run.durationMs}ms 传输层重试=${r.run.brainRetries ?? 0}
       证据: ${r.run.runDir}
       重放三要素: seed=${seed} + 初始哈希=${r.initialHash}（header.json）+ defect.json(fullWorldActions)
       证据一致性: ${r.evidenceConsistent ? '通过（trace 与 session 逐位相同）' : '**不一致，重放不可信**'}
[agent 主观] 笔记 ${r.agentClaims.notes.length} 条；目标 ${r.agentClaims.goals.length} 条；结论: ${r.agentClaims.finishSummary ?? '（未给结论）'}
${hypothesisLine(r.run.hypothesisStats)}${goalLine(r.run.goalStats)}[公证器客观] 分叉=${n.diverged}${n.firstStep !== null ? ` 首分叉第 ${n.firstStep} 步` : ''}${n.masked ? '（掩蔽：终态又相同）' : ''}
${n.firstFields.length ? `       首分叉字段: ${n.firstFields.join(', ')}\n` : ''}${n.minimized ? `       最小化: ${n.minimized.originalLength}→${n.minimized.actions.length} 步，1-minimal=${n.minimized.oneMinimal}，独立复核=${n.minimized.reverified}\n` : ''}       覆盖: 走过 ${r.coverage.cellsVisited}/${r.coverage.cellsTotal} 格，血量见过 [${r.coverage.hpSeen.join(',')}]，hp归零=${r.coverage.hpZeroReached}，死亡=${r.coverage.died}，击杀=${r.coverage.kills}
${predictLine}${detectionLine(r.detection)}`);
    return r.run.stopReason === 'finished' ? 0 : 2;
  }

  // ── files 模式：M0 原行为，一字未改 ──
  const registry = new ToolRegistry();
  for (const t of builtinTools()) registry.register(t);
  process.stderr.write(`[run] brain=${brain.id} seed=${seed} sandbox=${sandbox}\n`);

  const result = await runHarness({ brain, registry, config, log });

  process.stderr.write(`
[done] stop=${result.stopReason} steps=${result.steps.length} 用时=${result.durationMs}ms 传输层重试=${result.brainRetries ?? 0}
       笔记 ${result.notes.length} 条
       证据: ${result.runDir}
       重放三要素: seed=${seed} + header.json(initialState) + result.json(actionSequence)
${hypothesisLine(result.hypothesisStats)}`);
  if (result.finishSummary) process.stderr.write(`       结论: ${result.finishSummary}\n`);
  return result.stopReason === 'finished' ? 0 : 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    const he = classify(e, 'E_CONFIG');
    process.stderr.write(`\n[fatal] ${he.code}: ${he.message}\n`);
    if (he.detail) process.stderr.write(`${JSON.stringify(he.detail)}\n`);
    process.exit(1);
  });