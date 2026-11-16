/**
 * 目标通道接线测试（M4-b2）。
 *
 * 器官单测（goal.test.ts）证明判据对，世界层单测（world-goal.test.ts）证明等值核对对。
 * 这一份证明的是**接线**：声明得进去、判定跑得起、原文上得了线、证据落得下盘、
 * 而文件模式一字不改。M4-b1 换来的教训：
 *   故障 #8「写了但跑了不起作用」——单元测试全绿，真跑时接缝根本没接上。
 *   故障 #11「板子渲染了 ≠ 送达了」——必须存原文，判据才是确定的。
 *
 * 钉住的硬纪律：
 *  1. **代码绝不改 status**，包括画面已经满足的时候。
 *  2. **客观计数不受主观声明影响**：标了 achieved / abandoned 照样每步判定。
 *  3. **静态帧也判定**（故障 #10：闸门按"有没有可核对的事实"划，不按"这步有没有动"划）。
 *  4. **只有首次满足才回填**，否则每步一句话会挤爆上下文预算（M4-b1 第二局第 26 步已超）。
 *  5. **没有画面就没有目标接口**：文件模式不注册 goal 工具，也不写一份全 0 的账本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockBrain } from '../src/brain/mock.ts';
import { GOAL_BOARD_HEADER, GOAL_CLOSED_HEADER, buildSystem, goalsBlock } from '../src/brain/prompt.ts';
import { parseDecision } from '../src/parse.ts';
import { createRng } from '../src/rng.ts';
import { goal as goalTool } from '../src/tools/builtin.ts';
import { builtinTools } from '../src/tools/builtin.ts';
import { gameTools } from '../src/tools/game.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { runHarness } from '../src/loop.ts';
import { Goals } from '../src/goal.ts';
import { runArena } from '../src/world/harness.ts';
import { GOAL_SEAM } from '../src/world/goal.ts';
import { createWorld } from '../src/world/arena.ts';
import { GameSession } from '../src/world/session.ts';
import type { Brain, Decision, DecideRequest, Goal, HarnessConfig, ToolContext } from '../src/types.ts';

class ScriptBrain implements Brain {
  readonly id = 'script:TEST-DOUBLE';
  readonly seen: DecideRequest[] = [];
  private readonly script: Decision[];
  constructor(script: Decision[]) { this.script = script; }
  /** ⚠️ 必须经过 parseDecision：否则测试替身喂给循环层的是真跑永远不会出现的形状（故障 #8 的另一种形态） */
  decide(req: DecideRequest): Promise<Decision> {
    this.seen.push(req);
    const d = this.script[this.seen.length - 1]
      ?? { thought: '剧本用完', call: { name: 'finish', args: { summary: 'end' } } };
    return Promise.resolve(parseDecision(JSON.stringify(d)));
  }
}

const d = (name: string, args: Record<string, unknown> = {}, extra: Partial<Decision> = {}): Decision =>
  ({ thought: 't', call: { name, args }, ...extra });

function cfg(over: Partial<HarnessConfig> = {}): HarnessConfig {
  const sandbox = mkdtempSync(join(tmpdir(), 'goal-sbx-'));
  writeFileSync(join(sandbox, 'a.txt'), 'hello');
  return {
    task: '零说明书试玩', sandbox, seed: 6, maxSteps: 12, maxWallMs: 30_000,
    maxContextChars: 20_000, keepRecent: 12, maxParseRetry: 2, repeatLimit: 9,
    outDir: mkdtempSync(join(tmpdir(), 'goal-out-')),
    ...over,
  };
}

const readJsonl = (p: string): Record<string, unknown>[] =>
  readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const ev = (rows: Record<string, unknown>[], kind: string): Record<string, unknown>[] =>
  rows.filter((r) => r['kind'] === kind).map((r) => r['payload'] as Record<string, unknown>);

/** 从 DecideRequest 还原目标板文本。stdio 宿主与远端大脑共用同一个纯函数。 */
const boardText = (req: DecideRequest): string | null => goalsBlock(req.goals ?? []);

const goal = (r: { goals?: Goal[] }, id: string): Goal => {
  const g = r.goals?.find((x) => x.id === id);
  assert.ok(g, `目标板上没有 ${id}`);
  return g!;
};

const trace = (runDir: string) => readJsonl(join(runDir, 'trace.jsonl'));
const W0 = createWorld(6);
const ENEMIES = W0.enemies.filter((e) => e.alive).length;

/** 第 1 步声明即满足（敌人数就是画面上的数），第 2 条目标永不满足（血量还是 10） */
function declareScript(): Decision[] {
  return [
    d('goal', { id: 'G1', text: '先摸清画面上有多少敌人', doneWhen: { enemyCount: ENEMIES }, why: '开局数一遍' }),
    d('goal', { id: 'G2', text: '把血量打到归零', doneWhen: { hp: 0 } }),
    d('wait'),
    d('finish', { summary: '两条目标：一条已满足、一条还没走到' }),
  ];
}

// ── A. 声明与判定都真的接上了 ────────────────────────────

test('goal 工具在 arena 里注册、进 system 契约；文件模式整个不出现（没有画面就不给装饰接口）', async () => {
  const brain = new ScriptBrain(declareScript());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const names = r.run.steps.map((s) => s.decision.call.name);
  assert.deepEqual(names.slice(0, 2), ['goal', 'goal']);
  assert.ok(brain.seen[0]!.system.includes('goal'), 'system 契约里没有 goal 工具，模型怎么会知道能用它');
  assert.ok(brain.seen[0]!.system.includes('hp'), '完成条件词表没进契约');

  // 文件模式：goal 不是 builtinTools 的一员
  assert.ok(!builtinTools().some((t) => t.name === 'goal'), '文件模式没有画面，goal 不该出现在通用工具里');
  const f = new ScriptBrain([d('goal', { id: 'G1', text: 'x' }), d('finish', { summary: 's' })]);
  const reg = new ToolRegistry();
  for (const t of builtinTools()) reg.register(t);
  const fr = await runHarness({ brain: f, registry: reg, config: cfg() });
  assert.equal(fr.steps[0]!.result.ok, false, '文件模式调用 goal 必须被拒，不能默默收下');
  assert.equal(fr.goals.length, 0);
  assert.equal(fr.goalStats, undefined, '写一份全 0 的账本会被读成"启用了但模型没用"，那是两种结论');
  assert.equal(ev(trace(fr.runDir), 'goal_board').length, 0);
});

test('声明进去、判定跑起来：每步对每条有完成条件的目标都判一次，计数逐条落盘', async () => {
  const brain = new ScriptBrain(declareScript());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });

  const g1 = goal(r.run, 'G1');
  assert.equal(g1.status, 'open', 'status 由模型声明，开局没给就是 open');
  assert.equal(g1.met, 4, 'G1 从第 1 步起每步都被判定且都满足（4 步 = 4 次）');
  assert.equal(g1.firstMetStep, 1);
  // 规则只有一条：**执行过动作的步，判一次**（含 finish 那步）。
  // 没有 applies 闸门，也没有"收手前那步不算"的特例——特例会让计数口径变成猜谜。
  assert.equal(g1.checks, 4);
  assert.equal(g1.met + g1.unmet + g1.unverifiable, g1.checks, '三态必须闭合');

  const g2 = goal(r.run, 'G2');
  assert.equal(g2.checks, 3, 'G2 从第 2 步起才可判定');
  assert.equal(g2.unmet, 3, '血量还是 10，画面明明白白不满足');
  assert.equal(g2.met, 0);
  assert.equal(g2.firstMetStep, null);

  const checks = ev(trace(r.run.runDir), 'goal_check');
  assert.equal(checks.length, 7, '每次判定一条不落：4 + 3');
  assert.ok(checks.every((c) => Array.isArray(c['diffs']) && (c['diffs'] as unknown[]).length > 0),
    'goal_check 必须带逐字段明细，否则审计无法重算合取');
});

test('静态帧照样判定：note 不推进画面，但目标断言的是状态不是变化', async () => {
  // 故障 #10 的目标版。判据在接缝层：目标通道**没有 applies**，循环层每步都调 evaluate。
  // 如果照抄预测通道的旧闸门（"这步没动世界就不核对"），
  // 模型开局声明"我要站在 hp=10 的状态"这种条件就永远得不到判定，那是裁判失职。
  const brain = new ScriptBrain([
    d('goal', { id: 'G1', text: '先数敌人', doneWhen: { enemyCount: ENEMIES } }),
    d('note', { text: '记一笔，不动世界' }),
    d('finish', { summary: 's' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const g = goal(r.run, 'G1');
  assert.equal(g.checks, 3, 'note 与 finish 那两步也要判定：画面静止不等于没有可核对的事实');
  assert.equal(g.met, 3);
  const checks = ev(trace(r.run.runDir), 'goal_check');
  assert.deepEqual(checks.map((c) => c.step), [1, 2, 3], '第 2 步是 note，同样留下一条判定明细');
});

test('客观计数不受主观声明影响：标了 abandoned 的目标后面每步仍在被判定', async () => {
  const brain = new ScriptBrain([
    d('goal', { id: 'G1', text: '把血量打到归零', doneWhen: { hp: 0 } }),
    d('goal', { id: 'G1', status: 'abandoned', why: '我先不管它' }),
    d('wait'),
    d('wait'),
    d('finish', { summary: 's' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const g = goal(r.run, 'G1');
  assert.equal(g.status, 'abandoned', '代码不许把 abandoned 改回 open');
  assert.equal(g.checks, 5, `放弃之后还在判：5 步 = 5 次。否则模型一句话就能关掉指标`);
  assert.equal(g.unmet, g.checks, '血量没归零，每次都是明确不满足');
});

// ── B. 送达：落盘原文 == 线上内容 ────────────────────────

test('目标板原文逐字上线：落盘的 goal_board.text 与大脑那次请求渲染出来的一字不差', async () => {
  const brain = new ScriptBrain(declareScript());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const boards = ev(trace(r.run.runDir), 'goal_board');
  assert.equal(boards.length, 3, '第 2、3、4 步决策前板上已有目标，第 1 步决策前还没有');

  // 第 k 次请求看到的板 = 第 k 步决策前落盘的那份原文（步号从 1 起，请求从 0 起）
  for (const b of boards) {
    const req = brain.seen[(b['step'] as number) - 1]!;
    assert.equal(boardText(req), b['text'], `第 ${b['step']} 步落盘原文与线上下发不一致`);
  }
  assert.ok((boards[0]!['text'] as string).startsWith(GOAL_BOARD_HEADER));
  // 常驻事实由板子承载：判定次数、首次在第几步都在上面
  assert.match(boards[2]!['text'] as string, /客观判定 \d+ 次/);
  assert.match(boards[2]!['text'] as string, /首次满足：第 1 步/);
});

test('只有首次满足才回填一句话；未满足一个字都不播（预算纪律）', async () => {
  const brain = new ScriptBrain(declareScript());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const fb = ev(trace(r.run.runDir), 'goal_feedback');
  assert.equal(fb.length, 1, `回填只该出现在首次满足那一步，实际 ${fb.length} 条`);
  assert.equal(fb[0]!['aboutStep'], 1);
  const text = fb[0]!['text'] as string;
  assert.match(text, /首次/);
  assert.match(text, /由你判断/);
  assert.ok(!text.includes('应该'), '代码不许替模型决定收不收手');
  // 送达的直接证据：那段原文就躺在第 2 步请求的 tool 消息里（history 整份下发）
  const delivered = brain.seen[1]!.messages.some((m) => m.role === 'tool' && m.content.includes(text));
  assert.ok(delivered, '落盘了却没上线 = 故障 #8，判据必须是 payload 里有这段话');
  // 之后不再新增播报。注意 history 会保留第 1 步那条观察（截断才是它消失的唯一途径），
  // 所以判据不是"后面看不到这句话"，而是**它 never 增长到第二条**——增长就等于重复播报。
  for (let i = 1; i < brain.seen.length; i++) {
    const hits = brain.seen[i]!.messages.filter((m) => m.role === 'tool' && m.content.includes('目标判定：')).length;
    assert.ok(hits <= 1, `第 ${i + 1} 次请求里出现 ${hits} 条目标回填，重复播报会挤爆上下文预算`);
  }
  assert.equal(
    brain.seen[3]!.messages.filter((m) => m.role === 'tool' && m.content.includes('目标判定：')).length, 1,
    '第 1 步那条首次满足的回填必须一直在线（它是常驻事实的来源）',
  );
});

test('完成条件写歪了不丢也不猜：原文留档、判成无法核对、并且出声点出缺的是哪个接口', async () => {
  const brain = new ScriptBrain([
    d('goal', { id: 'G1', text: '活得久一点', doneWhen: 'hp>0' }),   // 字符串：形状不可用
    d('wait'),
    d('finish', { summary: 's' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const g = goal(r.run, 'G1');
  assert.equal(g.doneWhen, null, '形状不可用就不许猜成条件');
  assert.equal(JSON.parse(JSON.stringify(g.doneWhenRaw)), 'hp>0', '原文必须留档，否则分不清没给与写歪');
  assert.equal(g.checks, 0, '没有可核对条件就不判定，绝不凭空记一次达成');
  assert.equal(r.run.goalStats!.conditionMalformed, 1);
  assert.equal(r.run.goalStats!.uncheckable, 1);
  const writes = ev(trace(r.run.runDir), 'goal_write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.conditionMalformed, true);
  assert.match(writes[0]!.message as string, /doneWhen|完成条件/, '拒绝/提示理由要可行动（ACI 那一课）');
});

// ── C. 出声判据：三条互斥，只陈述事实 ────────────────────

test('画面已满足却仍标 open：代码只数、只出声，绝不替它标 achieved', async () => {
  const brain = new ScriptBrain(declareScript());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  assert.equal(goal(r.run, 'G1').status, 'open');
  assert.equal(r.run.goalStats!.metNotClosed, 1);
  assert.equal(r.run.goalStats!.closedNeverMet, 0);
  const last = ev(trace(r.run.runDir), 'goal_board').at(-1)!;
  assert.deepEqual(last['nagging'], ['G1'], 'G2 是"正常待达成"，不该出声');
  assert.match(last['text'] as string, /仍是 open/);
  assert.match(last['text'] as string, /由你判断/);
});

test('自称 achieved 却从未被画面满足过：记一笔主客观脱钩，状态照旧不改', async () => {
  const brain = new ScriptBrain([
    d('goal', { id: 'G1', text: '把血量打到归零', doneWhen: { hp: 0 }, status: 'achieved', why: '我觉得差不多了' }),
    d('wait'),
    d('finish', { summary: 's' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const g = goal(r.run, 'G1');
  assert.equal(g.status, 'achieved', '代码擅自改状态 = 抢走模型的判断权');
  assert.equal(g.met, 0);
  assert.equal(r.run.goalStats!.closedNeverMet, 1);
  const last = ev(trace(r.run.runDir), 'goal_board').at(-1)!;
  assert.deepEqual(last['nagging'], ['G1']);
  assert.match(last['text'] as string, /从未/);
});

test('局末账本按状态计数，且与快照同一次求出（不是两次读板子拼出来的）', async () => {
  const brain = new ScriptBrain([
    d('goal', { id: 'G1', text: '摸清敌人', doneWhen: { enemyCount: ENEMIES } }),
    d('goal', { id: 'G2', text: '血量归零', doneWhen: { hp: 0 } }),
    d('goal', { id: 'G3', text: '分数涨一涨', doneWhen: { score: 5 }, status: 'abandoned', why: '不追了' }),
    d('finish', { summary: 's' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const s = r.run.goalStats!;
  assert.equal(s.open, 2);
  assert.equal(s.abandoned, 1);
  assert.equal(s.achieved, 0);
  assert.equal(s.withCondition, 3);
  assert.equal(s.met + s.unmet + s.unverifiable, s.checks, '全局三态闭合');
  assert.deepEqual(r.run.goals.map((g) => g.id), ['G1', 'G2', 'G3'], '快照按创建顺序，落盘才可复核');
});

// ── D. 与假设板/预测通道互不干扰 ─────────────────────────

test('目标通道与假设板是两个器官：互不吞计数，也不共用一套状态', async () => {
  const brain = new ScriptBrain([
    d('goal', { id: 'G1', text: '摸清敌人', doneWhen: { enemyCount: ENEMIES } }),
    d('note', { id: 'H1', text: '敌人不会新生成', status: 'proposed' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES } }),
    d('finish', { summary: 's' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  assert.equal(goal(r.run, 'G1').checks, 4);
  const h = r.run.hypotheses.find((x) => x.id === 'H1')!;
  assert.equal(h.checks, 0, '没声明 testing 就不许把核对记到假设头上（猜目标 = 伪造归因）');
  assert.equal(r.run.goalStats!.declared, 1);
  assert.ok(r.run.predictionStats, '预测通道照常工作');
});

test('doGoal:false 关掉整条链路（M4-e 消融需要一个真对照组）', async () => {
  const brain = new ScriptBrain([d('wait'), d('finish', { summary: 's' })]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false, doGoal: false });
  const rows = trace(r.run.runDir);
  for (const k of ['goal_write', 'goal_board', 'goal_check', 'goal_feedback']) {
    assert.equal(ev(rows, k).length, 0, `${k} 不该出现在关掉目标通道的局里`);
  }
  assert.equal(r.run.goalStats, undefined);
  assert.equal(r.run.goals.length, 0);
  assert.ok(!brain.seen[0]!.system.includes('doneWhen'), '契约里也不该留着用完不上的接口说明');
});

test('header.seams 声明本局开了哪些验证通道：旧版与消融版在证据里不许长得一样', async () => {
  // 动机：审计脚本对"没开通道"的局是不审就放行的。这种放行随时会变成免检通道——
  // 除非证据自己说清楚了"这局开关在哪一档"。三种形状必须彼此可分：
  //   开了且跑了 / 关了（消融对照）/ 那个年代还没有这个开关（旧版，只能靠缺键倒推）
  const hdr = (runDir: string) => JSON.parse(readFileSync(join(runDir, 'header.json'), 'utf8')) as Record<string, any>;

  const on = await runArena({ brain: new ScriptBrain([d('wait'), d('finish', { summary: 's' })]), seed: 6, config: cfg(), doMinimize: false });
  assert.deepEqual(hdr(on.run.runDir).seams, { predict: true, goal: true }, '两条通道都开着就得都声明；声明由循环层写，世界层不需要各报各的');

  const off = await runArena({ brain: new ScriptBrain([d('wait'), d('finish', { summary: 's' })]), seed: 6, config: cfg(), doMinimize: false, doGoal: false });
  assert.deepEqual(hdr(off.run.runDir).seams, { predict: true, goal: false }, '消融版的 goal=false 是**声明**，不是靠"证据里没有"倒推');

  // 关掉通道时 initialState.goals 这个键也不该出现：器官不存在 ≠ 器官存在且板子空着
  assert.ok(!('goals' in hdr(off.run.runDir).initialState), '关着的器官不许在初始状态里留一个空键冒充足迹');
});

// ── F. 渲染纪律（goalsBlock 是纯函数，措辞受同一条界线约束）──

const goalOf = (over: Partial<Goal>): Goal => ({
  id: 'G1', text: '把血量打到归零', doneWhen: { hp: 0 }, status: 'open',
  createdAtStep: 1, statusAtStep: 1, statusWhy: '',
  checks: 4, met: 0, unmet: 4, unverifiable: 0, firstMetStep: null, lastCheckedStep: 4,
  ...over,
});

test('goalsBlock：没有目标就返回 null；正常追目标时不许出现任何一句提示', () => {
  assert.equal(goalsBlock([]), null, '空板返回 null，否则文件模式与没立目标的局会多出一段契约外的文本');
  const text = goalsBlock([goalOf({})])!;
  assert.ok(text.startsWith(GOAL_BOARD_HEADER));
  assert.match(text, /G1 \[open\] 把血量打到归零/);
  assert.match(text, /客观判定 4 次：满足 0 \/ 不满足 4/);
  assert.ok(!text.includes('代码提示'), 'open + 判得出结果 = 正常追目标，出声就是噪音（与假设板 proposed 零核对同一条取舍）');
});

test('goalsBlock：已放弃的离开"在追"区，但 id 与正文留档，防止重复立同一条', () => {
  const text = goalsBlock([
    goalOf({ id: 'G1', status: 'abandoned', statusWhy: '先不管' }),
    goalOf({ id: 'G2', text: '摸清敌人', doneWhen: { enemyCount: 3 }, status: 'open', met: 2, unmet: 2, firstMetStep: 2 }),
  ])!;
  const i = text.indexOf(GOAL_CLOSED_HEADER);
  assert.ok(i > 0, '收口区必须有稳定抬头，否则"板上只剩放弃的"时定位不到起点');
  assert.ok(text.slice(0, i).includes('G2') && !text.slice(0, i).includes('G1'), 'G1 必须离开在追区');
  assert.ok(text.slice(i).includes('G1') && text.slice(i).includes('先不管'), '放弃不是删除：id 与理由都要留档');
});

test('goalsBlock 的措辞只陈述事实、点出缺的接口，绝不替模型做决策', () => {
  for (const g of [
    goalOf({ met: 1, unmet: 3, firstMetStep: 2 }),                                     // 满足却仍 open
    goalOf({ status: 'achieved', met: 0 }),                                            // 自称达成却从未满足
    goalOf({ doneWhen: null, checks: 0, met: 0, unmet: 0, unverifiable: 0 }),          // 判不出
  ]) {
    const t = goalsBlock([g])!;
    assert.match(t, /代码提示：/, `这条该出声：${g.status}/${g.met}`);
    assert.match(t, /由你判断|归大脑|你判断|代码不会/, '必须把判断权显式交回模型');
    for (const banned of ['你应该', '建议', '请标 achieved', '该收手', '优先']) {
      assert.ok(!t.includes(banned), `越界措辞：${banned}`);
    }
  }
});

test('goalsBlock 一条目标最多一行提示：判据互斥，与循环层的 nagging 同一主人', () => {
  for (const g of [
    goalOf({ met: 1, firstMetStep: 2 }),
    goalOf({ status: 'achieved', met: 0 }),
    goalOf({ doneWhen: null, checks: 0, met: 0, unmet: 0, unverifiable: 0 }),
    goalOf({ doneWhen: { ghost: 1 }, checks: 3, met: 0, unmet: 0, unverifiable: 3 }),
    goalOf({}),
  ]) {
    const n = goalsBlock([g])!.split('\n').filter((l) => l.includes('代码提示：')).length;
    assert.ok(n <= 1, `提示行了 ${n} 行，判据不互斥 = 一条目标被念两遍`);
  }
});

test('uncheckable 的出声文案必须与这条目标的形状一致（夹具逼出来的假话）', () => {
  // 形状一：压根没有条件 → 只许说"没有可核对的条件"，不许吹它判过几轮
  const noCond = goalsBlock([goalOf({ doneWhen: null, checks: 0, met: 0, unmet: 0, unverifiable: 0 })])!;
  assert.match(noCond, /还没有可核对的完成条件/);
  assert.ok(!noCond.includes('全是「无法核对」'), '一次都没判过的目标，不能说"判定 N 轮全是无法核对"');

  // 形状二：合取里混一个不认识的字段（夹具里 G9 的真实形状 {hp,enemyCount,foo}）。
  // 三个字段里两个能判，于是每轮都是"无法判定"。旧文案说"字段全不在词表内"是假话，
  // 而模型据假话做的任何修正都建在谎上——这一条就是夹具存在的理由。
  const half = goalsBlock([goalOf({
    doneWhen: { hp: 10, enemyCount: 3, foo: 1 },
    checks: 6, met: 0, unmet: 0, unverifiable: 6,
  })])!;
  assert.match(half, /判定 6 轮的结果全是「无法核对」/);
  assert.ok(!half.includes('还没有可核对的完成条件'), '它明明写了条件，不能说它没写');
  assert.ok(!half.includes('全不在词表内'), '两个字段在词表内，不能说"全不在"');
});

// ── G. 与既有链路的兼容 ────────────────────────────────

test('registry 的 object 容错只拆对象型参数，其他类型一律照旧（不许把 "3" 偷偷当成 3）', async () => {
  const reg = new ToolRegistry();
  for (const t of builtinTools()) reg.register(t);
  const ctx = { sandbox: cfg().sandbox, rng: createRng(1), note: () => {}, notes: () => [] } as unknown as ToolContext;
  const r = await reg.execute({ name: 'note', args: { text: 3 } }, ctx);
  assert.equal(r.ok, false, 'string 型参数给数字仍然要拒：容错只针对 object，猜值的代价是伪造证据');
  assert.match(String(r.output), /类型应为 string/);
});

// ── E. 证据拆主客观两侧 + 文件模式一字不改 ───────────────

test('defect.json 拆两侧：主观声明不带计数，客观计数不带正文，只靠 id 对账', async () => {
  const brain = new ScriptBrain(declareScript());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const defect = JSON.parse(readFileSync(r.files.defect, 'utf8')) as Record<string, unknown>;
  const claims = (defect['agentClaims'] as Record<string, unknown>)['goals'] as Record<string, unknown>[];
  const obj = defect['goalChecks'] as Record<string, unknown>[];
  assert.deepEqual(claims.map((c) => c.id), ['G1', 'G2']);
  for (const c of claims) {
    assert.ok(!('checks' in c) && !('met' in c), '主观侧混进客观计数就没法对账了');
    assert.ok('text' in c && 'status' in c && 'doneWhen' in c);
  }
  for (const o of obj) {
    assert.ok(!('text' in o) && !('status' in o), '客观侧抄进正文与状态就变成主观的复读了');
    assert.ok('checks' in o && 'met' in o && 'firstMetStep' in o);
  }
  assert.deepEqual(obj.map((o) => o.id), claims.map((c) => c.id), '两侧靠 id 对齐');
  assert.ok(defect['goalStats'], '客观账本要能在同一份证据里被读到');
});

test('goal 工具本身：非法 status 列出合法值、未知 id 拒绝、空操作拒绝、坏 doneWhen 仍可留档', async () => {
  const session = new GameSession(6);
  const reg = new ToolRegistry();
  for (const t of gameTools(session)) reg.register(t);
  // 循环层构造 organ 用的 ctx；这里手工搭一个等价物，单独验工具层的 ACI（拒绝理由归一处）
  const goals = new Goals({ step: () => 1, fields: GOAL_SEAM.fields });
  const ctx = { sandbox: cfg().sandbox, rng: createRng(1), goals } as unknown as ToolContext;
  reg.register(goalTool);

  const bad = await reg.execute({ name: 'goal', args: { id: 'G1', text: 'x', status: 'done' } }, ctx);
  assert.equal(bad.ok, false);
  assert.match(String(bad.output), /open/, '拒绝理由要列出合法值');
  assert.match(String(bad.output), /achieved/);

  const ghost = await reg.execute({ name: 'goal', args: { id: 'G7', status: 'achieved' } }, ctx);
  assert.equal(ghost.ok, false);
  assert.match(String(ghost.output), /G7|不存在/, '未知 id 要说清');

  const noop = await reg.execute({ name: 'goal', args: { id: 'G1' } }, ctx);
  assert.equal(noop.ok, false, '什么都没改的写操作要拒绝，否则会冒充"模型动了记忆"');

  const okCreate = await reg.execute({ name: 'goal', args: { id: 'G1', text: '血量归零', doneWhen: '{"hp": 0}' } }, ctx);
  assert.equal(okCreate.ok, true, 'doneWhen 套一层 JSON 字符串要认（和 predict 一个毛病）');
  assert.deepEqual(goal({ goals: goals.all() }, 'G1').doneWhen, { hp: 0 });
});

test('stdio 宿主同样收到目标板：整个 req 上线，接线不需要宿主改协议', () => {
  // 这条不是冗余：用户实际跑的是 stdio 宿主大脑（零 key 那条路）。
  // StdioBrain 序列化 `{type:'decide', ...req}`，所以 goals 自动搭车；
  // 一旦哪天有人改成逐字段挑着发，这条测试会立刻红。
  const wire = JSON.parse(JSON.stringify({
    type: 'decide',
    task: 't', system: 's', messages: [], tools: [], step: 2,
    notes: [], hypotheses: [],
    goals: [{
      id: 'G1', text: '血量归零', doneWhen: { hp: 0 }, status: 'open',
      createdAtStep: 1, statusAtStep: 1, statusWhy: '',
      checks: 3, met: 0, unmet: 3, unverifiable: 0, firstMetStep: null, lastCheckedStep: 2,
    }],
  })) as { goals: { id: string; checks: number }[] };
  assert.equal(wire.goals[0]!.id, 'G1');
  assert.equal(wire.goals[0]!.checks, 3, '客观计数必须一起上线，否则宿主看不到"代码判了几次"');
});

test('文件模式的产物一字未改：没有 goal_* 事件、system 里没有目标契约（跨轮对照口径不变）', async () => {
  const brain = new MockBrain([{ thought: 't', call: { name: 'list_dir', args: {} } }]);
  const reg = new ToolRegistry();
  for (const t of builtinTools()) reg.register(t);
  const r = await runHarness({ brain, registry: reg, config: cfg({ maxSteps: 4 }) });
  assert.equal(r.goals.length, 0);
  assert.equal(r.goalStats, undefined);
  assert.equal(ev(trace(r.runDir), 'goal_board').length + ev(trace(r.runDir), 'goal_check').length, 0);

  const plain = buildSystem({ task: 't', tools: builtinTools().map(({ name, description, params }) => ({ name, description, params })) });
  assert.ok(!plain.includes('目标板') && !plain.includes('doneWhen'), '没给 goalSpec 就不该出现目标契约');
});
