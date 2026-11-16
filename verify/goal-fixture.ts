/**
 * 生成一份**覆盖目标通道全部判据路径**的确定性证据，供 goal-audit.ts 自检。
 *
 * 为什么需要它（故障 #8 的审计版）：审计脚本如果只在真跑证据上跑过，而真跑恰好没触发某条
 * 分支，那条分支的审计逻辑就是没验过的。b1 那份夹具因此把 13 条归因路径一次走全；
 * 这一份把 b2 的判据路径走全，且完全确定性、可重复生成。
 *
 * ⚠️ 它是**裁判侧夹具**，不是 agent 能力的证据：剧本是人写的，"追 hp=0 并且真追到了"
 * 这件事是人算出来的，不是模型自己决定的。真模型那一局另外跑，报告里分开写。
 *
 * 覆盖的分支（一条都不能少，少了就是零样本审计）：
 *   新建：带条件 / 不带条件 / 条件形状歪（留原文）/ 字段不在词表 / 条件写成 JSON 字符串（宽容度）
 *   改写：正文 / 完成条件（计数不清零）/ 状态 open→achieved / achieved→abandoned→achieved
 *   被拒：空 id / 未知 id 只给状态 / 已存在 id 什么都不给 / 非法状态 / 参数类型不对（连写入事件都没有）
 *   判定三态：满足（首次回填）/ 不满足 / 无法判定（合取里没有 violated 却有 unverifiable）
 *   主客观脱钩：画面满足却仍标 open / 自称 achieved 却从未满足 / 追着一个判不出结果的目标
 *   跨通道：把血量真的打到 0 —— 画面说 hp=0，内部账本说 hpZeroReached，两条独立通道必须同时成立
 *
 * 用法: node verify/goal-fixture.ts [outDir]
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseDecision } from '../src/parse.ts';
import type { Brain, Decision, DecideRequest, HarnessConfig } from '../src/types.ts';
import { createWorld } from '../src/world/arena.ts';
import { runArena } from '../src/world/harness.ts';

class ScriptBrain implements Brain {
  readonly id = 'script:GOAL-FIXTURE（人写剧本，不是大脑）';
  private readonly script: Decision[];
  private n = 0;
  constructor(script: Decision[]) { this.script = script; }
  decide(_req: DecideRequest): Promise<Decision> {
    const d = this.script[this.n++] ?? { thought: '剧本用完', call: { name: 'finish', args: { summary: 'end' } } };
    // 与两个真大脑走同一条解析路径，否则 doneWhen 的 JSON 字符串宽容度不会被触发
    return Promise.resolve(parseDecision(JSON.stringify(d)));
  }
}

const d = (name: string, args: Record<string, unknown> = {}): Decision =>
  ({ thought: `夹具：${name}`, call: { name, args } });

/** 夹具自己算一遍初始画面上的客观量，免得词表数值写死后悄悄失真（画面 3 敌 3 物 10 血） */
const W0 = createWorld(6);
const ENEMIES = W0.enemies.filter((e) => e.alive).length;
const PICKUPS = W0.pickups.filter((p) => !p.taken).length;
const HP0 = W0.player.hp;

/**
 * 32 个世界动作把血量打到 0（每 5 次贴身扣 2 血，参考版第 5 次扣完就倒下）。
 * 序列来自一次性模拟，逐字符照抄，不许"看着差不多"改一格——改了 hp 就到不了 0，
 * 跨通道那一项就退化成零样本。
 */
const CHASE: [string, Record<string, unknown>][] = [
  ['move', { dir: 'right' }],
  ...Array.from({ length: 7 }, () => ['move', { dir: 'down' }] as [string, Record<string, unknown>]),
  ['wait', {}],
  ...Array.from({ length: 7 }, () => ['move', { dir: 'up' }] as [string, Record<string, unknown>]),
  ['wait', {}],
  ...Array.from({ length: 6 }, () => ['move', { dir: 'right' }] as [string, Record<string, unknown>]),
  ['wait', {}],
  ...Array.from({ length: 7 }, () => ['move', { dir: 'down' }] as [string, Record<string, unknown>]),
  ['wait', {}],
];

const script: Decision[] = [
  // ── 记忆通道与目标通道各走各的：纯笔记不进目标板 ──
  d('note', { text: `开局画面：HP ${HP0}/${HP0}，敌人 ${ENEMIES} 个，物品 ${PICKUPS} 个` }),

  // ── 新建：四种"条件"的形状 ──
  d('goal', { id: 'G1', text: '把场上活着的敌人数清零', doneWhen: { enemyCount: 0 } }),          // 带条件，长期不满足
  d('goal', { id: 'G2', text: '开局数清楚场上有多少活敌人', doneWhen: { enemyCount: ENEMIES } }),  // 声明即满足 → 首次回填
  d('goal', { id: 'G3', text: '把血量打到归零', doneWhen: { hp: 0 } }),                            // M07 那道钩子，跨通道主角
  d('goal', { id: 'G4', text: '让局面停在某个状态', doneWhen: 'hp=0' }),                            // 形状歪：收原文，不猜
  d('goal', { id: 'G5', text: '让敌人朝我移动', doneWhen: { enemyDir: 1 } }),                       // 字段不在词表 → 每次无法核对
  d('goal', { id: 'G6', text: '摸清拾取物' }),                                                      // 没给条件 → 判不出
  d('goal', { id: 'G7', text: '让分数变成 100', doneWhen: { score: 100 } }),
  // 合取的第三种结果：hp/敌人数都符，foo 不在词表 → 没有 violated 却有 unverifiable → **无法判定**
  d('goal', { id: 'G9', text: '血量与敌人数同时停在开局值', doneWhen: { hp: HP0, enemyCount: ENEMIES, foo: 1 } }),
  // 宽容度：模型把条件写成 JSON 字符串。归一化只在"能证明是同一意图"时生效
  d('goal', { id: 'G10', text: '再数一遍敌人数', doneWhen: `{"enemyCount": ${ENEMIES}}` }),
  d('goal', { id: 'G8', text: '站到地图右下角', doneWhen: { playerAt: [7, 7] } }),                  // 坐标等值，最后真走到

  // ── 改写：正文 / 条件 / 状态 ──
  d('goal', { id: 'G6', doneWhen: { pickupCount: PICKUPS } }),                                     // 补上条件 → 当场满足，计数不清零
  d('goal', { id: 'G6', status: 'achieved', why: '画面上的未拾取物品数就是它' }),                   // 满足过才收口：不该被出声
  d('goal', { id: 'G3', text: '把血量打到归零（靠敌人贴身一格一格掉血）' }),                         // 改写正文
  d('goal', { id: 'G7', status: 'achieved', why: '我觉得差不多了' }),                               // 从未满足却自称达成 → 出声
  d('goal', { id: 'G8', status: 'abandoned', why: '右下角先不管' }),                                // 放弃≠删除：计数照走

  // ── 五类拒绝：三类归器官（有写入事件），一类归参数类型（连写入事件都没有）──
  d('goal', { id: '', text: '空 id' }),                                                            // 被拒：id 为空
  d('goal', { id: 'G11', status: 'achieved' }),                                                    // 被拒：未知 id 只给状态
  d('goal', { id: 'G2' }),                                                                          // 被拒：什么都不改
  d('goal', { id: 'G2', status: '也许' }),                                                          // 被拒：非法状态
  d('goal', { id: 'G4', doneWhen: 42 }),                                                            // 被拒：类型不对，不产生写入事件

  // ── 32 个世界动作：静态帧也判定 + 把 hp 真的打到 0 ──
  ...CHASE.map(([name, args]) => d(name, args)),

  // ── 局末：模型据代码的事实收口 / 放弃 ──
  d('goal', { id: 'G3', status: 'achieved', why: '代码判定画面 HP 归零过，我据此收口' }),
  d('goal', { id: 'G8', status: 'achieved', why: '到了，之前放弃是我判断错了' }),
  d('goal', { id: 'G1', status: 'abandoned', why: '全程没能把敌人数清零' }),
  d('finish', { summary: '夹具走完目标通道全部判据路径' }),
];

const outDir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'goal-fixture-'));
const sandbox = mkdtempSync(join(tmpdir(), 'goal-fixture-sbx-'));
writeFileSync(join(sandbox, 'a.txt'), 'hello');
const config: HarnessConfig = {
  task: '夹具：覆盖目标通道全部判据路径（人写剧本，不代表模型能力）',
  sandbox, seed: 6, maxSteps: 80, maxWallMs: 120_000,
  maxContextChars: 60_000, keepRecent: 30, maxParseRetry: 2, repeatLimit: 12,
  outDir,
};

const r = await runArena({ brain: new ScriptBrain(script), seed: 6, config, doMinimize: false });
process.stdout.write(`${r.run.runDir}\n`);
process.stderr.write(`stop=${r.run.stopReason} steps=${r.run.steps.length} 目标=${r.run.goals.length} 笔记=${r.run.notes.length}\n`);
process.stderr.write(`hpZeroReached=${r.coverage.hpZeroReached} died=${r.coverage.died} hpSeen=${r.coverage.hpSeen.join(',')}\n`);
process.stderr.write(`${JSON.stringify(r.run.goalStats)}\n`);
