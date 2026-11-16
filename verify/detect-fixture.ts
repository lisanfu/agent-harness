/**
 * M4-f 检出判决夹具：一次生成**覆盖漏斗每条判决路径**的证据局，纯代码、零 key、确定性。
 *
 * 为什么需要它（故障 #8 的判决器版）：审计脚本只在真跑证据上跑过，而真跑恰好没触发某条分支，
 * 那条分支的审计逻辑就是没验过的。检出漏斗有四层、六种判决、两个主观通道，
 * 光靠"跑十局真模型"永远凑不齐这些组合——尤其"报了未指明"和"归因错误"这种反直觉的局。
 *
 * 覆盖的分支（一条都不能少，少了就是零样本审计）：
 *   L1 可见分叉      可见（M01）/ 不可见（M06 一步 wait，屏幕全程相同）
 *   L2 玩家侧前提    达成（自己撞墙）/ 不达成（旁观穿墙，前提没触达但画面分叉）
 *   L3 主观上报      finish 通道 / note 通道 / hypothesis 通道 各命中一次
 *   L4 归因          正确 / 错误（指了没被删的能力）/ 报了未指明 / 未上报
 *   严格档           归因集合是被删集合的真子集 → detected 成立、exactlyAttributed 不成立
 *   参考版对照       无误报（干净文本）/ 误报（喊异常又指到观测量，但根本没有缺陷）
 *
 * ⚠️ 它是**裁判侧夹具**，不是 agent 能力的证据：谁喊了异常、指了哪项，全是人写的剧本。
 *    "模型能不能自己发现缺陷"这个问题只有真模型臂能答，报告里分开写。
 *
 * 用法: node verify/detect-fixture.ts [outDir]
 * 输出: stdout 每行一个 run 目录，可直接喂给 verify/detect-audit.ts（与 goal-fixture 同一约定）
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseDecision } from '../src/parse.ts';
import type { Brain, Decision, DecideRequest, HarnessConfig } from '../src/types.ts';
import { ALL_CAPS, randomActions, type Action, type Capabilities } from '../src/world/arena.ts';
import { findMutant } from '../src/world/mutants.ts';
import { checkPreconditions, diffScreens, playSequence, type Verdict } from '../src/world/detect.ts';
import { runArena } from '../src/world/harness.ts';

const log = (l: string): void => void process.stderr.write(`${l}\n`);

class ScriptBrain implements Brain {
  readonly id = 'script:DETECT-FIXTURE（人写剧本，不是大脑）';
  private readonly script: Decision[];
  private n = 0;
  constructor(script: Decision[]) { this.script = script; }
  decide(_req: DecideRequest): Promise<Decision> {
    const d = this.script[this.n++] ?? { thought: '剧本用完', call: { name: 'finish', args: { summary: 'end' } } };
    return Promise.resolve(parseDecision(JSON.stringify(d)));
  }
}

const d = (name: string, args: Record<string, unknown> = {}): Decision => ({ thought: `夹具：${name}`, call: { name, args } });
const note = (text: string): Decision => d('note', { text });
const hypo = (id: string, text: string): Decision => d('note', { id, text });

/**
 * 世界层的 DirValue 是数字（0=up…3=left），工具层只认 up/right/down/left 四个词。
 * 夹具把搜出来的动作序列变回工具调用，必须走这张表——
 * 直接塞数字会被 parseDir 当场拒掉，那一格动作根本不会进 fullWorldActions，
 * 于是"剧本 25 步、实际跑了 10 步"，L1/L2 落在哪格就不是搜出来的那个了（本夹具首跑就栽在这）。
 */
const DIR_NAME = ['up', 'right', 'down', 'left'] as const;
const toCall = (a: Action): Decision =>
  a.kind === 'move' ? d('move', { dir: DIR_NAME[a.dir] }) : d(a.kind);

/** 剧本里一句"干净"的规则描述：一个异常词都不带，用于未上报 / 无误报两类阴性局 */
const CLEAN = '屏幕 HP 10/10，场上 3 个敌人、3 个物品，移动一次局面就变一格。';

// ─────────────────── 动作序列：按 L1/L2 目标状态搜索，不许"看着差不多" ───────────────────

/**
 * 找一条把 (可见分叉, 玩家侧前提) 打到目标组合上的动作序列。
 *
 * 为什么搜而不写死：这四层判据的组合是真世界性质决定的，人脑算不准（M01 那一格
 * "画面分叉但没自己撞过墙"就是冒烟时才看见的）。写死的序列一旦世界微调就会静默
 * 退化成零样本；搜出来再把结果打印留档，换台机器仍是一模一样的序列。
 */
async function findActions(
  seed: number, mutId: string | null, want: { visible: boolean; premise: boolean }, maxLen: number,
): Promise<{ actions: Action[]; salt: number } | null> {
  const caps: Capabilities = mutId ? findMutant(mutId).caps : ALL_CAPS;
  for (let salt = 0; salt < 200; salt++) {
    const actions = randomActions(seed, salt, maxLen);
    const ref = await playSequence(seed, ALL_CAPS, actions);
    const played = mutId ? await playSequence(seed, caps, actions) : ref;
    const visible = diffScreens(ref, played).diverged;
    const pre = checkPreconditions(mutId ? findMutant(mutId).removed : [], { ref: ref.coverage, mutant: played.coverage });
    const premise = pre.every((p) => p.reached);
    if (visible === want.visible && premise === want.premise) return { actions, salt };
  }
  return null;
}

interface Case {
  /** 目录名，也是给人看的这一格在测什么 */
  name: string;
  what: string;
  mutant: string | null;
  /** 想要的 (L1 可见, L2 前提) 组合 */
  want: { visible: boolean; premise: boolean };
  /**
   * 这一格**应当**落在哪个判决上。
   * 首跑就靠它抓到一处静默退化：我写的"报了未指明"文本是「整体感觉不太对」，
   * 而词表里的词是「不对」——「不太对」里根本没有这两个字，异常门没开，
   * 这一格悄悄变成了"未上报"：覆盖分支看着够，实际少一条。
   * 剧本自述的意图必须由判决确认，不然夹具只是在证明我会打字。
   */
  expectVerdict: Verdict;
  /** 严格档预期（只有双缺陷那一格用得上） */
  expectExact?: boolean;
  maxLen: number;
  /** 主观文本走哪个通道：finish 总结 / 纯笔记 / 结构化假设 */
  claims: Decision[];
}

const CASES: Case[] = [
  {
    name: 'M01_visible_premise_hit',
    what: 'L1✓ L2✓ 归因正确（笔记通道，指到被删能力）',
    mutant: 'M01', want: { visible: true, premise: true }, expectVerdict: '归因正确', maxLen: 25,
    claims: [note(CLEAN), note('第 4 帧我朝右走，画面没变化——墙没生效，这一条不正常。')],
  },
  {
    name: 'M01_visible_no_premise',
    what: 'L1✓ L2✗ 未触达：敌人替我演示了穿墙，我自己从没试过往墙上走',
    mutant: 'M01', want: { visible: true, premise: false }, expectVerdict: '未上报', maxLen: 25,
    claims: [note(CLEAN)],
  },
  {
    name: 'M06_invisible',
    what: 'L1✗ 不可见：拾取物全程没被踩过，屏幕一帧不差——这局不进分母',
    mutant: 'M06', want: { visible: false, premise: false }, expectVerdict: '报了未指明', maxLen: 3,
    claims: [note('这里好像有点不对劲，但说不出到底是哪一项。')],
  },
  {
    name: 'M05_wrong_attribution',
    what: 'L1✓ 归因错误：喊了异常，指的却是没被删的能力',
    mutant: 'M05', want: { visible: true, premise: true }, expectVerdict: '归因错误', maxLen: 25,
    claims: [hypo('H1', '敌人不动很异常：整局里 E 的位置一直没变化，我怀疑巡逻根本没生效。')],
  },
  {
    name: 'M03_vague_only',
    what: 'L1✓ 报了未指明：有异常断言，一个观测量都没落到',
    mutant: 'M03', want: { visible: true, premise: true }, expectVerdict: '报了未指明', maxLen: 25,
    claims: [note('整体感觉哪里不对，说不上来具体是哪一项。')],
  },
  {
    name: 'M07_not_reported',
    what: 'L1✓ 未上报：画面分叉了，agent 一个字没说不对劲',
    mutant: 'M07', want: { visible: true, premise: true }, expectVerdict: '未上报', maxLen: 40,
    claims: [note(CLEAN)],
  },
  {
    name: 'D02_partial_attribution',
    what: 'L1✓ 归因正确但严格档不成立：双缺陷只指中一个（finish 通道）',
    mutant: 'D02', want: { visible: true, premise: true }, expectVerdict: '归因正确', expectExact: false, maxLen: 40,
    claims: [note(CLEAN), d('finish', { summary: '打不死敌人这一点不合理：贴身出手之后 E 还在场上。' })],
  },
  {
    name: 'control_clean',
    what: '参考版阴性对照：干净文本 → 无误报',
    mutant: null, want: { visible: false, premise: true }, expectVerdict: '无误报', maxLen: 25,
    claims: [note(CLEAN), hypo('H2', '攻击后进入冷却，两帧后恢复就绪；击杀 +1 分。')],
  },
  {
    name: 'control_false_positive',
    what: '参考版误报对照：喊异常 + 指到观测量，可这个世界根本没有缺陷',
    mutant: null, want: { visible: false, premise: true }, expectVerdict: '误报', maxLen: 25,
    claims: [hypo('H1', '第 9 帧朝右走画面没变化，我怀疑墙的阻挡有问题。')],
  },
];

const outRoot = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'detect-fixture-'));
mkdirSync(outRoot, { recursive: true });
const sandbox = mkdtempSync(join(tmpdir(), 'detect-fixture-sbx-'));
writeFileSync(join(sandbox, 'a.txt'), 'hello');
const SEED = 6;

log(`M4-f 判决夹具 → ${outRoot}`);
log('夹具是裁判侧夹具：谁喊异常是人写的剧本，它只证明判据走得通，不证明模型能发现缺陷。');

const dirs: string[] = [];
const missing: string[] = [];
const achieved = new Set<Verdict>();
/** Verdict 是联合类型，运行时枚举不出来，所以六条路径由这里显式列出——少列一条就是假覆盖 */
const ALL_VERDICTS: Verdict[] = ['无误报', '误报', '未上报', '报了未指明', '归因错误', '归因正确'];
for (const c of CASES) {
  const found = await findActions(SEED, c.mutant, c.want, c.maxLen);
  if (!found) { missing.push(`${c.name}：搜不到 (可见=${c.want.visible}, 前提=${c.want.premise}) 的序列`); continue; }
  const script: Decision[] = [
    ...found.actions.map(toCall),
    ...c.claims,
  ];
  const last = c.claims.at(-1);
  const body = last && last.call.name === 'finish' ? script : [...script, d('finish', { summary: '夹具走完' })];
  // ⚠️ 这句 task 会**原样进大脑的提示词**，所以它不能带任何判决术语。
  // 首跑时这里写的是「夹具：M4-f 检出判决路径覆盖」，被本夹具自己的零泄漏审计当场拦下——
  // 拦得对：那类词只有作者知道，念给被测方听等于开卷考试，哪怕这局的剧本是人写的也一样。
  const config: HarnessConfig = {
    task: '夹具：把这套规则的各个侧面都走一遍（人写剧本，不代表模型能力）',
    sandbox, seed: SEED, maxSteps: body.length + 4, maxWallMs: 120_000,
    maxContextChars: 60_000, keepRecent: 20, maxParseRetry: 2,
    // 循环层的"重复动作即停"是防真大脑空转的护栏；这里剧本是随机动作序列，
    // 连走四个同方向很正常。护栏一触发这局就被截短，L1/L2 落到哪一格就不是我搜出来的那个了。
    // 所以夹具把上限抬到剧本长度以上——不是绕过判据，是不让护栏改剧本。
    repeatLimit: body.length + 10,
    outDir: join(outRoot, c.name),
  };
  const r = await runArena({ brain: new ScriptBrain(body), seed: SEED, mutant: c.mutant, config, doMinimize: false, doGoal: false, log: (l) => log(`    ${l}`) });
  const d0 = r.detection;
  dirs.push(r.run.runDir);
  log(`  ${c.name.padEnd(28)} 可见=${d0.visible.diverged} 前提=${d0.playerPremise} 判决=${d0.verdict} 失败层=${d0.whyNot ?? '—'} salt=${found.salt} 步=${found.actions.length}`);
  log(`    ${c.what}`);
  // 夹具自己的判据：走没走进目标格。没走进就是夹具失效，不能拿它去验审计
  if (d0.visible.diverged !== c.want.visible || d0.playerPremise !== c.want.premise) {
    missing.push(`${c.name}：落盘判决 (${d0.visible.diverged},${d0.playerPremise}) 与目标 (${c.want.visible},${c.want.premise}) 不符`);
  }
  // 第二道：剧本没被循环层的护栏截短。截短了的话上面那两个布尔就不是我搜出来的那格了
  if (r.worldActions !== found.actions.length) {
    missing.push(`${c.name}：剧本 ${found.actions.length} 步世界动作，实际只跑了 ${r.worldActions} 步（被护栏截短）`);
  }
  if (r.run.stopReason !== 'finished') {
    missing.push(`${c.name}：停止原因是 ${r.run.stopReason} 而不是 finished`);
  }
  // 第三道才是这一格真正要验的那件事：**判决落点**。
  // 上面两道只看 L1/L2 两个布尔，判决本身没被人看过——判据写了不用，是故障 #15 的同族。
  if (d0.verdict !== c.expectVerdict) {
    missing.push(`${c.name}：判决=${d0.verdict}，剧本要的是 ${c.expectVerdict}（那段文本没命中预期的词表项）`);
  }
  if (c.expectExact !== undefined && d0.exactlyAttributed !== c.expectExact) {
    missing.push(`${c.name}：严格档=${d0.exactlyAttributed}，剧本要的是 ${c.expectExact}`);
  }
  achieved.add(d0.verdict);
}

/**
 * 覆盖率的诚实说法。
 *
 * 原先那行写的是 `CASES.length === dirs.length`，两边都是 9——恒等式，
 * 一条路径没走通也会打勾（故障 #15：判据写成永不失败）。现在换成两问：
 *   1. 剧本**声明**的判决集合，是不是把 Verdict 六个值全覆盖了？没覆盖是我剧本的缺口；
 *   2. 落盘**实际**得到的判决集合，和声明的集合相等吗？不相等就是某一格退化成了别的格。
 * 上面逐格的第三道已经保证"每格都落在自己声明的格上"，这两问是它的汇总自检，
 * 两道都要留：逐格那一道说得出是哪一格坏了，汇总这一道说不出坏在谁身上但拦得住整批。
 */
const declared = new Set<Verdict>(CASES.map((c) => c.expectVerdict));
const uncovered = ALL_VERDICTS.filter((v) => !declared.has(v));
const extra = [...declared].filter((v) => !achieved.has(v));
if (uncovered.length) missing.push(`剧本没有声明这些判决路径：${uncovered.join('、')}`);
if (extra.length) missing.push(`落盘没得到这些判决路径：${extra.join('、')}`);
log(`判决路径覆盖：声明 ${declared.size}/6｜实际 ${achieved.size}/6｜${[...declared].sort().join('、')}`);

if (missing.length) {
  log('\n❌ 夹具没有覆盖全部目标格：');
  for (const m of missing) log(`   ${m}`);
  process.exit(1);
}
log(`\n✅ ${dirs.length} 局夹具生成完毕：判决落点 ${achieved.size}/${ALL_VERDICTS.length} 条全覆盖（外加严格档与三通道各一格）。`);
for (const p of dirs) process.stdout.write(`${p}\n`);
