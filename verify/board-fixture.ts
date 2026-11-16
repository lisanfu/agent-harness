/**
 * 生成一份**覆盖全部归因路径**的确定性证据，供 board-audit.ts 自检。
 *
 * 为什么需要它：审计脚本如果只在真跑证据上跑过，而真跑恰好没触发某条分支，
 * 那条分支的审计逻辑就是没验过的（故障 #8：分支写了 ≠ 分支跑了）。
 * 这份夹具用剧本大脑把 13 条路径一次走全，且完全确定性、可重复生成。
 *
 * ⚠️ 它是**裁判侧夹具**，不是 agent 能力的证据：剧本是人写的，
 * 所以这份 runDir 绝不能拿来声称"模型自己学会了淘汰假设"。
 * 真模型的那一局另外跑，报告里分开写。
 *
 * 用法: node verify/board-fixture.ts [outDir]
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseDecision } from '../src/parse.ts';
import type { Brain, Decision, DecideRequest, HarnessConfig } from '../src/types.ts';
import { runArena } from '../src/world/harness.ts';

class ScriptBrain implements Brain {
  readonly id = 'script:FIXTURE（人写剧本，不是大脑）';
  private readonly script: Decision[];
  private n = 0;
  constructor(script: Decision[]) { this.script = script; }
  decide(_req: DecideRequest): Promise<Decision> {
    const d = this.script[this.n++] ?? { thought: '剧本用完', call: { name: 'finish', args: { summary: 'end' } } };
    // 与两个真大脑走同一条解析路径，否则 testing 简写不会被归一化
    return Promise.resolve(parseDecision(JSON.stringify(d)));
  }
}

const d = (name: string, args: Record<string, unknown> = {}, extra: Partial<Decision> = {}): Decision =>
  ({ thought: `夹具第${name}步`, call: { name, args }, ...extra });

/** 13 条路径：新建/改写/淘汰/纯笔记 × 归因成功(带与不带 field)/未知 id/形状歪/无核对/字段缺/无法核对/未声明/自称成立却零核对 */
const script: Decision[] = [
  d('note', { text: '我先看看' }),                                                        // 纯笔记
  d('note', { id: 'H1', text: '敌人每帧会新生成', status: 'confirmed', why: '我数出来变多了' }), // 新建
  d('wait', {}, { predict: { enemyCount: 6 }, testing: 'H1' }),                            // 归因：反对
  d('wait', {}, { predict: { enemyCount: 6, playerAt: [0, 0] }, testing: { id: 'H1' } }),   // 归因：整份，混合
  d('note', { id: 'H1', text: '敌人数只减不增' }),                                          // 改写正文
  d('wait', {}, { predict: { enemyCount: 3 }, testing: { id: 'H1', field: 'enemyCount' } }),// 归因：限定字段
  d('note', { id: 'H2', text: '攻击能一次清掉相邻多个敌人' }),                               // 第二条假设
  d('attack', {}, { predict: { enemyCount: 0, scoreDelta: 5 }, testing: { id: 'H2', field: 'scoreDelta' } }),
  d('wait', {}, { predict: { enemyCount: 3 }, testing: 'H9' }),                            // 未知 id
  d('wait', {}, { predict: { enemyCount: 3 }, testing: { field: 'enemyCount' } as never }), // 形状歪
  d('note', { text: '再记一笔' }, { testing: 'H1' }),                                       // 那步无可核对事实
  d('wait', {}, { predict: { playerAt: [0, 0] }, testing: { id: 'H1', field: 'enemyCount' } }), // 字段没预测
  d('wait', {}, { predict: { enemyDir: 1 }, testing: 'H2' }),                              // 无法核对
  d('note', { id: 'H9', status: 'retired' }),                                              // 被拒：未知 id 只改状态
  d('note', { id: 'H1', status: '也许' }),                                                  // 被拒：非法状态
  d('note', { id: 'H1', status: 'retired', why: '画面里只减不增，我先前数错了' }),            // 淘汰
  d('wait', {}, { predict: { enemyCount: 3 } }),                                           // 核对但未声明归因
  // 故障 #13 的真跑形状（runs/20261113-215401-s6）：自称已验证，却从不声明 testing。
  // 必须让它在**局末**仍然成立，否则 confirmedNoChecks 这项聚合就是零样本审计＝假通过。
  d('note', { id: 'H3', text: '敌人每帧朝我移动一格', status: 'proposed' }),
  d('wait', {}, { predict: { enemyCount: 3 } }),                                           // 给了预测，不声明 testing
  d('note', { id: 'H3', status: 'confirmed', why: '此步验证了 enemyCount 的预测与画面完全一致' }),
  d('finish', { summary: '夹具走完 13 条路径' }),
];

const outDir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'board-fixture-'));
const sandbox = mkdtempSync(join(tmpdir(), 'board-fixture-sbx-'));
writeFileSync(join(sandbox, 'a.txt'), 'hello');
const config: HarnessConfig = {
  task: '夹具：覆盖假设板全部归因路径（人写剧本，不代表模型能力）',
  sandbox, seed: 6, maxSteps: 24, maxWallMs: 60_000,
  maxContextChars: 40_000, keepRecent: 30, maxParseRetry: 2, repeatLimit: 9,
  outDir,
};

const r = await runArena({ brain: new ScriptBrain(script), seed: 6, config, doMinimize: false });
process.stdout.write(`${r.run.runDir}\n`);
process.stderr.write(`stop=${r.run.stopReason} steps=${r.run.steps.length} 假设=${r.run.hypotheses.length} 笔记=${r.run.notes.length}\n`);
process.stderr.write(`${JSON.stringify(r.run.hypothesisStats)}\n`);