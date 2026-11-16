/**
 * 结构化假设板（M4-b1）的接线测试。
 *
 * 目标故障（真跑两局独立复现，见 M4-FINDINGS §7.1）：
 *   对照组与 M08-B 都发明了"敌人每帧会移动或新生成"这条**假规则**——
 *   世界里 ENEMY_COUNT=3，从不生成，敌人数只减不增。
 *   其中一局还把它写成"规则已确认"存进假设板。
 *   而旧假设板是 append-only 的 string[]：没有 id、没有状态、没有淘汰、
 *   与客观核对结果毫无关联。于是这条假规则**每一步原样回喂**，永久驻留，
 *   成为后续所有决策的依据。记忆器官只进不出 = 错误单调累积。
 *
 * 修法必须守住 M4 的分工铁律：
 *   **代码只客观计数 + 出声，绝不替模型判定假设真假。**
 *   所以这里既断言"模型能淘汰"，也断言"代码不会自己淘汰"。
 *
 * 另外沿用故障 #8 / #11 的教训：
 *   分支写了 ≠ 分支跑了 ≠ 分支起作用 ≠ 证据能证明它起作用。
 *   因此本文件不止断言数据结构，还断言**退役后的假设真的从线上 payload 的活跃区消失**
 *   （用本地 HTTP 服务端抓真实请求体），以及**假设板原文落盘且与线上逐字相同**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_ACTIVE_HEADER, BOARD_HEADER, BOARD_RETIRED_HEADER, notesBlock } from '../src/brain/prompt.ts';
import { OpenAIBrain } from '../src/brain/openai.ts';
import { runHarness } from '../src/loop.ts';
import { parseDecision } from '../src/parse.ts';
import { builtinTools } from '../src/tools/builtin.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { toWorldActions } from '../src/tools/game.ts';
import type { Brain, Decision, DecideRequest, HarnessConfig, Hypothesis } from '../src/types.ts';
import { ALL_CAPS, createWorld, runSequence } from '../src/world/arena.ts';
import { runArena } from '../src/world/harness.ts';

/**
 * 剧本大脑：按顺序吐决策，并把每次收到的 DecideRequest 原样抓出来看。
 *
 * ⚠️ 刻意经过 parseDecision 再返回。两个真大脑（OpenAIBrain / StdioBrain）都走它，
 * 测试替身若绕过它，喂给循环层的就是**真跑永远不会出现的形状**——
 * 那测的是一条不存在的路径，绿了也不算数（故障 #8 的另一种形态）。
 * 走一遍解析，"testing":"H1" 这种简写与写歪的形状才与线上完全一致。
 */
class ScriptBrain implements Brain {
  readonly id = 'script:TEST-DOUBLE';
  readonly seen: DecideRequest[] = [];
  private readonly script: Decision[];
  constructor(script: Decision[]) { this.script = script; }
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
  const sandbox = mkdtempSync(join(tmpdir(), 'hyp-sbx-'));
  writeFileSync(join(sandbox, 'a.txt'), 'hello');
  return {
    task: '零说明书试玩', sandbox, seed: 6, maxSteps: 12, maxWallMs: 30_000,
    maxContextChars: 20_000, keepRecent: 12, maxParseRetry: 2, repeatLimit: 9,
    outDir: mkdtempSync(join(tmpdir(), 'hyp-out-')),
    ...over,
  };
}

const readJsonl = (p: string): Record<string, unknown>[] =>
  readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const ev = (rows: Record<string, unknown>[], kind: string): Record<string, unknown>[] =>
  rows.filter((r) => r['kind'] === kind).map((r) => r['payload'] as Record<string, unknown>);

/** 从 DecideRequest 还原假设板文本。stdio 宿主就是这么渲染的，与远端共用同一个纯函数。 */
const boardText = (req: DecideRequest): string | null => notesBlock(req.notes, req.hypotheses);

/** 把假设板切成「活跃区」与「已淘汰区」。退役的判据是**离开活跃区**，不是"从板上消失"。 */
function splitBoard(text: string | null): { active: string; retired: string } {
  const t = text ?? '';
  const i = t.indexOf(BOARD_RETIRED_HEADER);
  return i < 0 ? { active: t, retired: '' } : { active: t.slice(0, i), retired: t.slice(i) };
}

const hyp = (r: { hypotheses?: Hypothesis[] }, id: string): Hypothesis => {
  const h = r.hypotheses?.find((x) => x.id === id);
  assert.ok(h, `假设板上没有 ${id}`);
  return h!;
};

// seed=6：世界里有 3 个敌人，且**从不生成新敌人**。这是"假规则"的客观反证。
const w0 = createWorld(6);
const ENEMIES = w0.enemies.filter((e) => e.alive).length;

/**
 * 目标故障的完整剧本：立一条假规则 → 被客观核对反对 → 模型自己淘汰它。
 * 第 3 步之后，H1 必须离开活跃区。
 */
function retireScript(): Decision[] {
  return [
    d('note', { id: 'H1', text: '敌人每帧会新生成', status: 'confirmed', why: '我数出来变多了' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES + 3 }, testing: 'H1' }),
    d('note', { id: 'H1', status: 'retired', why: '画面里敌人数只减不增，我先前数错了' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES } }),
    d('finish', { summary: '玩完了' }),
  ];
}

// ── A. 目标故障回归：假规则不再永久驻留 ──────────────────────

test('模型能淘汰被客观反对的假设：退役后它离开活跃区，不再作为依据回喂', async () => {
  const brain = new ScriptBrain(retireScript());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });

  // 第 3 次请求（= 第 3 步决策前）：H1 还活着，且带着代码数出来的反对次数
  const before = splitBoard(boardText(brain.seen[2]!));
  assert.ok(before.active.includes('H1'), '退役前 H1 必须在活跃区');
  assert.match(before.active, /反对 1/);
  assert.equal(before.retired, '', '还没退役，不该出现淘汰区');

  // 第 4 次请求：H1 必须已经离开活跃区。这是本故障的核心判据。
  const after = splitBoard(boardText(brain.seen[3]!));
  assert.ok(!after.active.includes('H1'), '退役后 H1 仍在活跃区 → 假规则继续回喂，故障没修掉');
  assert.ok(after.retired.includes('H1'), '淘汰不是删除：id 必须留档，否则模型会重复提出同一条');
  assert.ok(after.retired.includes('我先前数错了'), '淘汰理由必须留档，那是模型自我修正的证据');

  assert.equal(hyp(r.run, 'H1').status, 'retired');
  assert.equal(r.run.hypothesisStats!.retired, 1);
  assert.equal(r.run.hypothesisStats!.contradictedNotRetired, 0);
});

test('代码绝不自己淘汰：反对再多，status 仍是模型声明的那个，只出声不代判', async () => {
  // 与上一个剧本唯一的差别：删掉模型主动退役的那一步。
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人每帧会新生成', status: 'confirmed', why: '我数出来变多了' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES + 3 }, testing: 'H1' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES + 5 }, testing: 'H1' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES + 7 }, testing: 'H1' }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const h = hyp(r.run, 'H1');
  assert.equal(h.status, 'confirmed', '代码擅自改状态 = 抢走模型的判断权，M4 分工铁律不允许');
  assert.equal(h.contradicted, 3);
  assert.equal(h.checks, 3);
  assert.equal(r.run.hypothesisStats!.contradictedNotRetired, 1);
  assert.equal(r.run.hypothesisStats!.retired, 0);

  // 出声：核对发生之后的每一次请求，活跃区都必须带着这条事实，且明确把判断权交回模型。
  // 索引口径：seen[i] 是第 i+1 步的请求，看到的是**上一步结束时**的板子。
  // 第 2 步的请求（seen[1]）发生在第一次核对之前，所以它不该有**反证**提示。
  // （它会有另一条提示：这个剧本一上来就把 H1 标成 confirmed 却零核对，那属故障 #13，
  //   与"凭空制造反证"是两回事，所以这里按提示的具体内容断言，不按"代码提示"四个字。）
  const first = splitBoard(boardText(brain.seen[1]!)).active;
  assert.match(first, /客观核对 0 次/);
  assert.ok(!first.includes('次核对与这条假设相反'), '还没核对就报反证 = 凭空制造反证');
  for (const i of [2, 3, 4]) {
    const active = splitBoard(boardText(brain.seen[i]!)).active;
    assert.match(active, /代码提示：已有 \d+ 次核对与这条假设相反/);
    assert.ok(active.includes('要不要淘汰由你判断'), '只报数不算出声，必须显式说明判断权归它');
    assert.ok(active.includes('代码不会替你改'), '不许暗示代码会代它淘汰');
    assert.ok(!active.includes('客观核对是 0 次'), '有了核对就不该再报零核对，两条提示互斥');
  }
  // 反对次数必须随核对递增，不是写死的一句话
  assert.deepEqual(
    [2, 3, 4].map((i) => /已有 (\d+) 次/.exec(splitBoard(boardText(brain.seen[i]!)).active)![1]),
    ['1', '2', '3'],
  );
});

/**
 * 故障 #13（真跑 runs/20261113-215401-s6 复现）：**自称已验证，客观账本零核对。**
 *
 * 那一局模型自己用了结构化假设板（proposed → confirmed），却在 why 里写
 * "此步验证了 enemyCount 和 scoreDelta 的预测与画面完全一致"——而它**一次都没声明 testing**，
 * 于是 H1 的 checks 恒为 0。后果比"少记一笔账"严重得多：
 * 淘汰机制的触发条件是"被客观反对"，计数永远是 0 就永远不触发，
 * 假规则可以**零反证地永久驻留**。这是故障 #8 的同一形态：机制写了、跑了，但不起作用。
 *
 * 修法仍守分工铁律：代码只把这个脱钩**如实说出来**，绝不代它把 confirmed 降回去。
 */
test('自称 confirmed 却零客观核对：板子必须出声，且绝不代它改状态', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人每帧朝我移动一格', status: 'proposed' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES } }),          // 给了预测，没声明 testing
    d('note', { id: 'H1', status: 'confirmed', why: '此步验证了 enemyCount 的预测与画面完全一致' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES } }),          // 还是没声明
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const h = hyp(r.run, 'H1');
  assert.equal(h.status, 'confirmed', '代码擅自降级 = 抢走模型的判断权');
  assert.equal(h.checks, 0, '没声明 testing 就绝不许猜目标（猜错 = 伪造归因）');
  assert.equal(r.run.hypothesisStats!.unattributed, 2, '给了预测却没归因的步数必须如实记');
  assert.equal(r.run.hypothesisStats!.confirmedNoChecks, 1);
  assert.equal(r.run.hypothesisStats!.contradictedNotRetired, 0, '零核对不等于被反对，两个量不许混');

  // seen[i] 是第 i+1 步的请求。proposed 阶段零核对是正常的，不该出声。
  assert.ok(!splitBoard(boardText(brain.seen[1]!)).active.includes('代码提示'), 'proposed 零核对就出声 = 制造噪音');
  // 第 4 步的请求：confirmed 已写下、核对仍为 0 → 必须出声
  const active = splitBoard(boardText(brain.seen[3]!)).active;
  assert.match(active, /客观核对 0 次/);
  assert.match(active, /代码提示：你把它标为 confirmed，但归因到它名下的客观核对是 0 次/);
  assert.ok(active.includes('testing'), '出声必须指向缺的那个接口，否则模型无从行动');
  assert.ok(active.includes('由你判断'), '判断权必须显式交回模型');
  assert.ok(active.includes('代码不会替你改'));

  // 落盘的出声名单必须与文本一致，且可被独立审计重算
  const boards = ev(readJsonl(join(r.run.runDir, 'trace.jsonl')), 'hypothesis_board') as unknown as
    { step: number; nagging: string[] }[];
  assert.deepEqual(boards.map((b) => b.step), [2, 3, 4, 5]);
  assert.deepEqual(boards.map((b) => b.nagging), [[], [], ['H1'], ['H1']]);
});

test('出声不是只在有核对的那一步：note 步也带着假设板事实', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人会新生成' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES + 3 }, testing: 'H1' }),
    d('note', { text: '我先记一笔别的' }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  // 第 3 步是 note，不产生核对，但第 3 次请求的假设板仍须带着反对事实
  assert.match(splitBoard(boardText(brain.seen[2]!)).active, /反对 1/);
  assert.equal(r.run.steps[2]!.prediction, undefined, '前提：note 步不核对');
});

// ── B. 归因由代码客观累加，粒度可控 ─────────────────────────

test('testing 带 field：只把那一个字段的核对归给假设，其余字段不污染计数', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人数量恒定' }),
    d('wait', {}, {
      predict: { enemyCount: ENEMIES, playerAt: [9, 9] },
      testing: { id: 'H1', field: 'enemyCount' },
    }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const h = hyp(r.run, 'H1');
  assert.deepEqual(
    { checks: h.checks, supported: h.supported, contradicted: h.contradicted, unverifiable: h.unverifiable },
    { checks: 1, supported: 1, contradicted: 0, unverifiable: 0 },
    'playerAt 预测错了，但它不属于这条假设，不许算进来',
  );
  assert.equal(r.run.steps[1]!.prediction!.violated, 1, '前提：整份核对里确实有一项不符');
  assert.equal(r.run.hypothesisStats!.attributed, 1);
});

test('testing 不带 field：整份核对都归它，三个计数之和恒等于 checks', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人数量恒定' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES + 3, playerAt: [0, 0] }, testing: 'H1' }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const h = hyp(r.run, 'H1');
  assert.deepEqual(
    { checks: h.checks, supported: h.supported, contradicted: h.contradicted, unverifiable: h.unverifiable },
    { checks: 2, supported: 1, contradicted: 1, unverifiable: 0 },
  );
  assert.equal(h.supported + h.contradicted + h.unverifiable, h.checks, '计数不闭合就是账本漏项');
});

test('无法核对单独累加：绝不把 unverifiable 算成反对（不凭空制造反证）', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '内部冷却字段决定攻击' }),
    d('wait', {}, { predict: { enemyDir: 1 }, testing: 'H1' }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const h = hyp(r.run, 'H1');
  assert.deepEqual(
    { checks: h.checks, supported: h.supported, contradicted: h.contradicted, unverifiable: h.unverifiable },
    { checks: 1, supported: 0, contradicted: 0, unverifiable: 1 },
  );
  assert.equal(r.run.hypothesisStats!.contradictedNotRetired, 0, '无法核对不该触发淘汰提示');
  assert.ok(!splitBoard(boardText(brain.seen[1]!)).active.includes('代码提示'));
});

test('没声明 testing 的核对不记到任何假设名下，但要单独计数', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人数量恒定' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES + 3 } }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const h = hyp(r.run, 'H1');
  assert.equal(h.checks, 0, '没指定归因对象就不许乱记——猜一个目标等于伪造证据');
  assert.equal(r.run.hypothesisStats!.unattributed, 1);
  assert.equal(r.run.hypothesisStats!.attributed, 0);
});

test('testing 指向不存在的 id：出声 + 单独计数，绝不静默创建一条假设', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人数量恒定' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES }, testing: 'H9' }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  assert.deepEqual(r.run.hypotheses!.map((h) => h.id), ['H1'], '凭空多出 H9 就是静默创建');
  assert.equal(r.run.hypothesisStats!.unknownTarget, 1);
  assert.equal(r.run.hypothesisStats!.attributed, 0);

  const rows = readJsonl(join(r.run.runDir, 'trace.jsonl'));
  const fb = ev(rows, 'hypothesis_feedback');
  assert.equal(fb.length, 1);
  const text = String(fb[0]!['text']);
  assert.ok(text.includes('H9'), '出声必须点名它写错的那个 id');
  assert.ok(text.includes('H1'), '必须告诉它现有 id 有哪些，否则无法行动（ACI 那一课）');
  // 出声原文必须真的进了下一次请求
  const tool = brain.seen[2]!.messages.filter((m) => m.role === 'tool').pop();
  assert.ok(tool!.content.includes(text), '归因出声只落盘没送达 = 故障 #8 重演');
});

test('testing 形状不可用：留档原文 + 单独计数，不猜成某条假设也不丢弃', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人数量恒定' }),
    d('wait', {}, {
      predict: { enemyCount: ENEMIES },
      testing: { field: 'enemyCount' } as unknown as Decision['testing'],
    }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const t = r.run.steps[1]!.decision.testing!;
  assert.equal(t.id, null, '形状不可用必须是 null，绝不猜成 H1');
  assert.deepEqual(t.raw, { field: 'enemyCount' }, '原文必须留档：不丢');
  assert.equal(r.run.hypothesisStats!.malformed, 1);
  assert.equal(hyp(r.run, 'H1').checks, 0);
  const fb = ev(readJsonl(join(r.run.runDir, 'trace.jsonl')), 'hypothesis_feedback');
  assert.match(String(fb[0]!['text']), /形状不可用/);
});

test('这一步没有可核对事实时，testing 不产生计数，但要说明为什么', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人数量恒定' }),
    d('note', { text: '再记一笔' }, { testing: 'H1' }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  assert.equal(hyp(r.run, 'H1').checks, 0);
  assert.equal(r.run.hypothesisStats!.notChecked, 1);
  assert.equal(r.run.hypothesisStats!.attributed, 0);
  const fb = ev(readJsonl(join(r.run.runDir, 'trace.jsonl')), 'hypothesis_feedback');
  assert.match(String(fb[0]!['text']), /没有产生可核对的画面事实/);
});

test('指定了 field 但那一步没预测该字段：出声说明，不拿别的字段顶替', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人数量恒定' }),
    d('wait', {}, { predict: { playerAt: [0, 0] }, testing: { id: 'H1', field: 'enemyCount' } }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  assert.equal(hyp(r.run, 'H1').checks, 0, '拿 playerAt 顶替 enemyCount 就是伪造归因');
  assert.equal(r.run.hypothesisStats!.fieldAbsent, 1);
  const fb = ev(readJsonl(join(r.run.runDir, 'trace.jsonl')), 'hypothesis_feedback');
  assert.match(String(fb[0]!['text']), /没有预测 enemyCount/);
});

// ── C. note 工具的接口与拒绝理由 ────────────────────────────

function fileRun(script: Decision[], over: Partial<HarnessConfig> = {}) {
  const registry = new ToolRegistry();
  for (const t of builtinTools()) registry.register(t);
  const brain = new ScriptBrain(script);
  return { brain, run: runHarness({ brain, registry, config: cfg(over) }) };
}

test('无 id 的 note 与 M1 逐字相同：纯笔记通道一字不改', async () => {
  const { brain, run } = fileRun([d('note', { text: '假设A' }), d('finish', { summary: 's' })]);
  const r = await run;
  assert.deepEqual(r.notes, ['假设A']);
  assert.equal(r.steps[0]!.result.output, '已记录（假设板现有 1 条）');
  assert.deepEqual(r.hypotheses, []);
  // 没有结构化假设时，假设板文本必须与 M1 的 notesBlock 完全一致
  assert.equal(boardText(brain.seen[1]!), notesBlock(['假设A']));
  assert.equal(boardText(brain.seen[1]!), '假设板（你此前记下的，常驻不截断）：\n1. 假设A');
  assert.equal(r.hypothesisStats!.plainNotes, 1);
});

test('纯笔记与结构化假设可以共存，编号笔记不被挤掉', async () => {
  const { brain, run } = fileRun([
    d('note', { text: '门后可能有东西' }),
    d('note', { id: 'H1', text: '钥匙在门后' }),
    d('finish', { summary: 's' }),
  ]);
  const r = await run;
  assert.deepEqual(r.notes, ['门后可能有东西']);
  const text = boardText(brain.seen[2]!)!;
  assert.match(text, /1\. 门后可能有东西/);
  assert.ok(text.includes(BOARD_ACTIVE_HEADER));
  assert.match(text, /- H1 \[proposed\] 钥匙在门后/);
});

test('空手 note / 无 id 却给 status / 未知 id 只改状态：全部可读拒绝，不静默降级', async () => {
  const { run } = fileRun([
    d('note', {}),
    d('note', { text: 'x', status: 'retired' }),
    d('note', { id: 'H9', status: 'retired', why: '不成立' }),
    d('note', { id: 'H1', text: '第一条' }),
    d('note', { id: 'H1' }),
    d('note', { id: 'H1', status: '也许' }),
    d('finish', { summary: 's' }),
  ]);
  const r = await run;
  const outs = r.steps.slice(0, 6).map((s) => s.result);
  for (const [i, o] of outs.entries()) {
    if (i === 3) { assert.equal(o.ok, true, '第 4 步是合法新建，不该被拒'); continue; }
    assert.equal(o.ok, false, `第 ${i + 1} 步应当被拒绝：${o.output}`);
    assert.ok(o.output.length > 8, '拒绝理由必须可行动，不能只说 invalid');
  }
  assert.match(outs[1]!.output, /id/, '无 id 却给 status，必须告诉它 id 是必需的');
  assert.match(outs[2]!.output, /H9/);
  assert.match(outs[2]!.output, /text/, '未知 id 只改状态，必须告诉它新建要给 text');
  assert.match(outs[4]!.output, /H1/);
  assert.match(outs[5]!.output, /proposed/);
  assert.match(outs[5]!.output, /retired/, '非法状态必须列出合法值');
  // 拒绝不许污染板子
  assert.deepEqual(r.hypotheses!.map((h) => h.id), ['H1']);
  assert.deepEqual(r.notes, []);
});

test('跨行正文经工具层照样被拒，且拒绝理由把替代通道说清楚（故障 #19 的接线侧）', async () => {
  const { run } = fileRun([
    d('note', { id: 'H1', text: '敌人朝我移动\n观察：第1帧(7,0)、第2帧(6,0)、第3帧(5,0)' }),
    d('note', { id: 'H1', text: '敌人每帧朝我移动一格' }),
    d('note', { text: '第1帧(7,0)、第2帧(6,0)、第3帧(5,0)' }),
    d('finish', { summary: 's' }),
  ]);
  const r = await run;
  const [first, second] = r.steps;
  assert.equal(first!.result.ok, false, '跨行正文必须被拒（工具层不许吞掉 board.write 的拒绝）');
  assert.match(first!.result.output, /一行/, '理由要点的就是那条被破坏的合约');
  assert.match(first!.result.output, /note/, '还要给出可行动的替代通道：观察记录走不带 id 的笔记');
  assert.equal(second!.result.ok, true, '改成一行就该通过——拒绝必须是可修复的，不是死路');
  assert.equal(hyp(r, 'H1').text, '敌人每帧朝我移动一格');
  // 被拒那次不许留下任何"模型立过这条假设"的痕迹
  const writes = ev(readJsonl(join(r.runDir, 'trace.jsonl')), 'hypothesis_write');
  assert.deepEqual(writes.map((w) => (w as { ok: boolean }).ok), [false, true], '被拒也要落盘，但不许冒充成功');
  assert.equal(r.hypothesisStats!.proposed, 1);
});

test('改写正文算一次 revised，旧正文留在 trace 里可追溯', async () => {
  const { run } = fileRun([
    d('note', { id: 'H1', text: '敌人会新生成' }),
    d('note', { id: 'H1', text: '敌人数只减不增' }),
    d('finish', { summary: 's' }),
  ]);
  const r = await run;
  assert.equal(hyp(r, 'H1').text, '敌人数只减不增');
  assert.equal(r.hypothesisStats!.revised, 1);
  const writes = ev(readJsonl(join(r.runDir, 'trace.jsonl')), 'hypothesis_write');
  assert.equal(writes.length, 2);
  const second = writes[1] as { before: Hypothesis | null; after: Hypothesis | null; textChanged: boolean };
  assert.equal(second.textChanged, true);
  assert.equal(second.before!.text, '敌人会新生成', '旧正文必须留档：那是模型修正自己的证据');
  assert.equal(second.after!.text, '敌人数只减不增');
});

test('拒绝也要落盘：不丢，否则分不清"模型没写"和"写了被拒"', async () => {
  const { run } = fileRun([d('note', { id: 'H9', status: 'retired' }), d('finish', { summary: 's' })]);
  const r = await run;
  const writes = ev(readJsonl(join(r.runDir, 'trace.jsonl')), 'hypothesis_write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!['ok'], false);
  assert.equal(writes[0]!['id'], 'H9');
  assert.deepEqual(writes[0]!['input'], { id: 'H9', status: 'retired' }, '被拒的原始参数必须留档');
});

// ── D. 证据与送达（故障 #11 的纪律）─────────────────────────

test('假设板原文逐步落盘，且与那一次请求的渲染逐字相同', async () => {
  const brain = new ScriptBrain(retireScript());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const boards = ev(readJsonl(join(r.run.runDir, 'trace.jsonl')), 'hypothesis_board') as
    { step: number; text: string; nagging: string[] }[];
  assert.ok(boards.length > 0, '零样本的审计是假通过');
  assert.deepEqual(boards.map((b) => b.step), [2, 3, 4, 5], '第 1 步板子是空的，不该发也不该记');
  for (const b of boards) {
    const req = brain.seen[b.step - 1]!;
    assert.ok(req, `第 ${b.step} 步没有对应的请求`);
    assert.equal(boardText(req), b.text, '落盘原文与那一次请求的假设板不逐字相同 → 证据不可用于审计');
  }
  // nagging 是结构化事实，便于审计聚合；不必去解析文本。
  // 这个剧本一上来就把假规则标成 confirmed，所以第 2 步就该因"零核对"出声（故障 #13），
  // 第 3 步换成因"被反对"出声，退役之后两条都不再触发。
  assert.deepEqual(boards.map((b) => b.nagging), [['H1'], ['H1'], [], []]);
  assert.match(boards[0]!.text, /客观核对是 0 次/);
  assert.match(boards[1]!.text, /次核对与这条假设相反/);
});

test('hypothesis_check 事件记下归因明细，计数可从证据重算', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人数量恒定' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES + 3, playerAt: [0, 0] }, testing: 'H1' }),
    d('wait', {}, { predict: { enemyCount: ENEMIES }, testing: { id: 'H1', field: 'enemyCount' } }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const checks = ev(readJsonl(join(r.run.runDir, 'trace.jsonl')), 'hypothesis_check') as
    { step: number; id: string; fields: string[]; supported: number; contradicted: number; unverifiable: number }[];
  assert.deepEqual(checks.map((c) => c.step), [2, 3]);
  assert.deepEqual(checks.map((c) => c.fields), [['enemyCount', 'playerAt'], ['enemyCount']]);
  // 独立重算：把事件里的增量加起来，必须等于局末快照
  const sum = checks.reduce((a, c) => ({
    supported: a.supported + c.supported,
    contradicted: a.contradicted + c.contradicted,
    unverifiable: a.unverifiable + c.unverifiable,
  }), { supported: 0, contradicted: 0, unverifiable: 0 });
  const h = hyp(r.run, 'H1');
  assert.deepEqual(sum, { supported: h.supported, contradicted: h.contradicted, unverifiable: h.unverifiable });
  assert.equal(h.checks, sum.supported + sum.contradicted + sum.unverifiable);
});

test('defect.json：主观侧只有 id/正文/状态/理由，客观侧只有计数与账本', async () => {
  const brain = new ScriptBrain(retireScript());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const defect = JSON.parse(readFileSync(r.files.defect, 'utf8'));
  const result = JSON.parse(readFileSync(join(r.run.runDir, 'result.json'), 'utf8'));

  assert.deepEqual(result.hypotheses, r.run.hypotheses);
  assert.deepEqual(result.hypothesisStats, r.run.hypothesisStats);
  assert.deepEqual(defect.hypothesisStats, r.run.hypothesisStats);

  const claimed = defect.agentClaims.hypotheses as Record<string, unknown>[];
  assert.equal(claimed.length, 1);
  assert.deepEqual(Object.keys(claimed[0]!).sort(), ['id', 'status', 'statusWhy', 'text']);
  for (const k of ['checks', 'supported', 'contradicted', 'unverifiable']) {
    assert.ok(!(k in claimed[0]!), `客观计数 ${k} 混进主观陈述就没法对账了`);
  }
  const counted = defect.hypothesisChecks as Record<string, unknown>[];
  assert.deepEqual(counted, [{ id: 'H1', checks: 1, supported: 0, contradicted: 1, unverifiable: 0 }]);
  for (const k of ['text', 'status', 'statusWhy']) {
    assert.ok(!(k in counted[0]!), `主观字段 ${k} 混进客观计数侧`);
  }
});

test('契约里真的有 testing 与 note 的 id/status 接口，且仍是零说明书', async () => {
  const brain = new ScriptBrain(retireScript());
  await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  const sys = brain.seen[0]!.system;
  assert.match(sys, /"testing"/);
  assert.match(sys, /id\?: string/);
  assert.match(sys, /status\?: string/);
  assert.match(sys, /retired/);
  // 接口说明不等于策略手册：不许告诉它该立什么假设、该什么时候淘汰
  for (const banned of ['优先探索', '边界值', '未访问区域', '覆盖率', '变异', '二分', '敌人不会新生成']) {
    assert.ok(!sys.includes(banned), `system 不该出现策略或答案：${banned}`);
  }
});

// ── E. 线上 payload：退役必须真的从远端请求体里消失 ──────────────

function withServer(handler: Parameters<typeof createServer>[0]): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv: Server = createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

test('远端线上抓包：退役前活跃区有 H1，退役后活跃区没有、淘汰区有', async () => {
  const script = retireScript();
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  let n = 0;
  const s = await withServer((q, res) => {
    let raw = '';
    q.on('data', (c) => { raw += c; });
    q.on('end', () => {
      bodies.push(JSON.parse(raw));
      const decision = script[n++] ?? { thought: 'end', call: { name: 'finish', args: { summary: 'end' } } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
    });
  });
  try {
    const brain = new OpenAIBrain({ baseUrl: s.url, apiKey: 'k', model: 'm', timeoutMs: 5000 });
    const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
    assert.equal(r.run.stopReason, 'finished');
    assert.equal(bodies.length, 5, '前提：五次请求都真的发出去了');

    const boardMsg = (i: number): string => {
      const m = bodies[i]!.messages.filter((x) => x.role === 'system' && x.content.startsWith(BOARD_HEADER));
      assert.equal(m.length, 1, `第 ${i + 1} 次请求里假设板必须恰好出现一次，不许重复下发`);
      return m[0]!.content;
    };
    // 第 3 次请求（退役前）：活跃区有 H1，且带着代码数出来的反对
    const before = splitBoard(boardMsg(2));
    assert.ok(before.active.includes('H1'));
    assert.match(before.active, /反对 1/);
    // 第 4 次请求（退役后）：这是故障 #8 的真正判据——线上内容变了没有
    const after = splitBoard(boardMsg(3));
    assert.ok(!after.active.includes('H1'), '线上活跃区仍有 H1 → 淘汰只改了数据结构，没改 payload');
    assert.ok(after.retired.includes('H1'));
    assert.notEqual(boardMsg(2), boardMsg(3), '两次请求的假设板一字不差 = 淘汰根本没送达');
    // 契约只发一遍（假设板是另一条 system 消息，不算重复）
    assert.equal(bodies[3]!.messages.filter((x) => x.content.startsWith('你是一个自主 agent')).length, 1);
  } finally { await s.close(); }
});

// ── F. 不扰动 M2/M3 的确定性 ────────────────────────────────

test('结构化假设板不改变世界动作序列与逐帧哈希', async () => {
  const brain = new ScriptBrain(retireScript());
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false });
  assert.equal(r.evidenceConsistent, true);
  const actions = toWorldActions(r.run.actionSequence);
  assert.deepEqual(actions, [{ kind: 'wait' }, { kind: 'wait' }], 'note / finish 不该进动作序列');
  const replay = runSequence(6, actions, ALL_CAPS);
  const frames = readJsonl(r.files.world) as unknown as { hash: string }[];
  assert.deepEqual(frames.map((f) => f.hash), replay.hashes, '假设板污染了世界重放');
});

test('关掉预测接缝后假设板仍可用：记忆与预测是两个器官，不该互相绑死', async () => {
  const brain = new ScriptBrain([
    d('note', { id: 'H1', text: '敌人数量恒定', status: 'confirmed', why: '看起来是这样' }),
    d('wait', {}),
    d('note', { id: 'H1', status: 'retired', why: '我改主意了' }),
    d('finish', { summary: 'x' }),
  ]);
  const r = await runArena({ brain, seed: 6, config: cfg(), doMinimize: false, doPredict: false });
  assert.equal(r.run.predictionStats, undefined);
  assert.equal(hyp(r.run, 'H1').status, 'retired');
  assert.equal(hyp(r.run, 'H1').checks, 0, '没有预测接缝就没有客观核对，计数必须是 0 而不是编一个');
  assert.equal(r.run.hypothesisStats!.retired, 1);
  assert.ok(!splitBoard(boardText(brain.seen[3]!)).active.includes('H1'));
  // 契约里不该出现 testing：没有核对就没有归因，硬塞一个字段等于给它一份不存在的接口
  assert.ok(!brain.seen[0]!.system.includes('"testing"'));
});