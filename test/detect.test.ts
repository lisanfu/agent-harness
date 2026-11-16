/**
 * M4-f 判决器与词表的单元测试（作者侧知识，绝不进契约）。
 *
 * 分工：这一份只验**判据本身**——词表冻结、词来自屏幕、漏斗算术、前提读哪一版、判决六格互斥。
 * 端到端接线（runArena 有没有真落盘 detection.json / header.judgement）由
 *   verify/detect-fixture.ts（9 局已知判决的夹具）
 *   verify/detect-audit.ts（独立重算 + 零泄漏审计）
 *   verify/detect-selftest.ts（注入 + 反向对照）
 * 三件套负责。两边各走各的路径才叫独立复核（故障 #14：两个通道不许各信一份）。
 *
 * ⚠️ 这里**不跑真模型、不跑 runArena**：全部用纯函数 + 内存构造，
 *    否则单测就成了 verify 脚本的影子——判据坏了两处一起红，那最难查。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANOMALY_WORDS, ATTRIBUTION, FROZEN_SHA256, LEXICON_VERSION,
  lexiconCanonical, lexiconDrift, lexiconSha, matchClaim, normalize, type Cap,
} from '../src/world/lexicon.ts';
import {
  DETECTOR_VERSION, JUDGEMENT_VERSION,
  PRECONDITION, checkPreconditions, decide, diffScreens, firstFailingLayer,
  judgeStamp, playSequence, scoreClaims, toClaimSources,
  type ClaimVerdict, type Detection, type Observation, type Precondition,
  type ScreenDivergence, type Verdict,
} from '../src/world/detect.ts';
import { ALL_CAPS, CAP_NAMES, type Action } from '../src/world/arena.ts';
import { ARENA_TASK } from '../src/world/harness.ts';
import { gameTools } from '../src/tools/game.ts';
import { GameSession } from '../src/world/session.ts';
import type { Coverage } from '../src/world/session.ts';
import { renderInitial } from '../src/world/render.ts';

const claimOf = (text: string, removed: readonly Cap[]): ClaimVerdict =>
  scoreClaims(toClaimSources({ finishSummary: null, notes: [text], hypotheses: [] }), removed);

// ─────────────────────────── 防线 3：冻结指纹 ───────────────────────────

test('词表还是冻结时那张表（改一个字就出声）', () => {
  assert.equal(lexiconSha(), FROZEN_SHA256, '词表漂移：必须升 LEXICON_VERSION 并按新版本重出表');
  assert.equal(lexiconDrift(), null);
  const caps = Object.keys(ATTRIBUTION).sort() as Cap[];
  const rebuilt = JSON.stringify({
    version: LEXICON_VERSION,
    anomaly: [...ANOMALY_WORDS].sort(),
    attribution: caps.map((c) => [c, [...ATTRIBUTION[c]].sort()]),
  });
  assert.equal(rebuilt, lexiconCanonical(), 'canonical 必须与键序无关');
});

test('口径版本三处同源：detector + lexicon + header 戳拼出来同一个字符串', () => {
  const s = judgeStamp();
  assert.equal(s.detector, DETECTOR_VERSION);
  assert.equal(s.lexicon, LEXICON_VERSION);
  assert.equal(s.sha, lexiconSha());
  assert.equal(`${s.detector}+lex-${s.lexicon}`, JUDGEMENT_VERSION);
});

// ─────────────────────────── 防线 1：词来自屏幕 ───────────────────────────

test('归一化不改变命中：大小写与空白不是判据的一部分', () => {
  const a = matchClaim('HP = 0 不正常');
  const b = matchClaim('hp0　不正常');
  assert.deepEqual(a.anomalies, b.anomalies);
  assert.deepEqual(a.caps, b.caps);
  assert.ok(a.anomalies.length > 0);
});

/**
 * 屏幕证人（防线 1 的可机器判版）。
 *
 * 每条能力要同时过两问，缺一即红：
 *   screen  画面上**逐字印得出来**的那个量（必须真的出现在参考版轨迹的屏幕文本里）
 *   root    中文里给这个量起的词根（表里的每个词都必须挂在它上面）
 *
 * ⚠️ 这条判据是**必要条件**，不是充分条件，诚实边界写在下面：
 *   - root 本身不声称出现在屏幕上。「掉血」「扣血」是对 HP 血条变化的中文命名，
 *     屏幕上印的是「HP 8/10」——画面上没有"血"字。这不算违规：防线 1 反对的是
 *     **凭空造出画面上不存在的第二种东西**（例如引用某局真跑里模型的原话），
 *     不是反对"把可见量说成人话"。
 *   - 它拦得住：给一个屏幕上根本没有的观测量起名、能力名下了无词根、
 *     以及新增第 10 条能力却忘了登记证人（下面两个断言都会红）。
 *   - 它拦不住："词是真的但组合歪了"，那一层由 verify/detect-audit.ts 逐词复核。
 *
 * 240 帧参考版轨迹（seed 6）里玩家从没死过，所以 deathAtZeroHp 的 screen 证人
 * 取那行**永远印着**的「状态：活着 / 已倒下」里的「状态」，而不是「已倒下」——
 * 拿一个这条轨迹上没出现的字符串当"逐字印得出来"的证人，是判据自己先造假。
 */
const SCREEN_TOKEN: Record<Cap, { screen: string; root: string }> = {
  wallBlocks: { screen: '墙', root: '墙' },          // 图例「#=墙」+ 现象行「撞上了障碍」
  enemyPatrol: { screen: '敌人', root: '敌' },        // 图例「E=敌人」；巡逻=它每帧位置变化
  contactDamage: { screen: 'HP', root: '血' },        // 血条「HP n/10」
  attackKills: { screen: '敌人', root: '死' },        // 击杀在画面上=敌人符号从格子里消失
  attackCooldown: { screen: '冷却', root: '冷却' },    // 「攻击：就绪 / 冷却中」
  pickupHeals: { screen: '可拾取', root: '血' },       // 图例「+=可拾取」；回血也走血条
  deathAtZeroHp: { screen: '状态', root: '死' },       // 「状态：活着 / 已倒下」那行
  scoreOnKill: { screen: '分数', root: '分' },         // 「分数 n」
  hpClamp: { screen: 'HP', root: '超过' },             // 血条上限就是那个 10/10
};

test('每条能力都有屏幕证人 + 词根证人（造表时不许拍脑袋）', async () => {
  const screen = normalize(await renderCorpus(6, 240));
  for (const cap of Object.keys(ATTRIBUTION) as Cap[]) {
    const { screen: token, root } = SCREEN_TOKEN[cap]!;
    assert.ok(
      screen.includes(normalize(token)),
      `屏幕证人「${token}」在参考版轨迹的屏幕文本里没逐字出现过：能力 ${cap} 没有来路`,
    );
    const anchored = ATTRIBUTION[cap].filter((w) => normalize(w).includes(normalize(root)));
    assert.ok(
      anchored.length > 0,
      `能力 ${cap} 名下没有一个词挂在词根「${root}」上：${ATTRIBUTION[cap].join('/')} —— 这张表不可信`,
    );
  }
  // 反向对照：证人表必须一条能力不多、一条不少（多了是给不存在的能力作证，少了是有能力免检）
  assert.deepEqual(
    Object.keys(SCREEN_TOKEN).sort(),
    Object.keys(ATTRIBUTION).sort(),
    '证人表与归因表的能力集合不一致',
  );
});

test('异常断言词里有任务文本用的那两个词', () => {
  assert.ok(ANOMALY_WORDS.includes('不正常'));
  assert.ok(ANOMALY_WORDS.includes('不合理'));
  assert.ok(
    ARENA_TASK.includes('不正常') || ARENA_TASK.includes('不合理'),
    '任务文本没说"不正常"也没说"不合理"：词表收了它们却没有来源 = 凭空造词',
  );
  assert.ok(matchClaim('这不正常').anomalies.length > 0);
});

/**
 * 这条是**夹具真踩过的坑**（原话见 verify/detect-fixture.ts 第 96 行的注释）：
 * 我原以为「整体感觉不太对」含「不对」，实际「不太对」里"不"和"对"不相邻，
 * 一个异常词都没命中 → 那一格静默退化成了「未上报」。
 * 所以这里把两个方向都钉住：不相邻 = 不命中；相邻（「哪里不对」）= 命中。
 * 判据靠「异常断言 ∧ 观测量归因」两者都成立，命中异常但没观测量仍只算「报了未指明」。
 */
test('子串判据：「不太对」不算命中，「哪里不对」才算命中，两者都没有观测量', () => {
  assert.equal(matchClaim('整体感觉不太对').anomalies.length, 0, '「不对」不是「不太对」的连续子串，不许命中');
  const vague = matchClaim('整体感觉哪里不对，说不上来具体是哪一项。');
  assert.ok(vague.anomalies.includes('不对'), '「哪里不对」里的「不对」是连续的，必须命中');
  assert.equal(vague.caps.length, 0, '光喊异常不指观测量 = 报了未指明');
  assert.equal(decide(claimOf('整体感觉哪里不对，说不上来具体是哪一项。', ['wallBlocks']), ['wallBlocks']), '报了未指明');
  assert.equal(decide(claimOf('整体感觉不太对。', ['wallBlocks']), ['wallBlocks']), '未上报', '没命中异常词的文本连"上报"都不算');
  // 反面对照：同样的异常，指对了观测量就换一格判决
  assert.equal(decide(claimOf('撞墙不正常，墙好像没挡住。', ['wallBlocks']), ['wallBlocks']), '归因正确');
});

test('纯描述不算上报：只提观测量、不喊异常', () => {
  const c = claimOf('屏幕 HP 3/10，场上 3 个敌人。', ['contactDamage']);
  assert.equal(c.reported, false, '描述血量不是上报缺陷');
  assert.equal(c.vague, false, '一句异常都没喊，vague 也不许成立');
  assert.equal(decide(c, ['contactDamage']), '未上报');
});

// ─────────────────────────── L1：可见分叉 ───────────────────────────

test('diffScreens：同一份观察流永不分叉，是判决器内置的反向对照', async () => {
  const acts: Action[] = [
    { kind: 'move', dir: 1 }, { kind: 'move', dir: 1 }, { kind: 'wait' },
  ];
  const a = await playSequence(6, ALL_CAPS, acts);
  const b = await playSequence(6, ALL_CAPS, acts);
  const d = diffScreens(a, b);
  assert.equal(d.diverged, false);
  assert.equal(d.firstStep, null);
  assert.equal(d.frames, 0);
});

test('diffScreens：少一步也算分叉，帧数按长度差计，不许当成"没得比"', async () => {
  const acts: Action[] = [{ kind: 'move', dir: 1 }, { kind: 'move', dir: 2 }];
  const long = await playSequence(6, ALL_CAPS, acts);   // 首屏 + 2 帧 = 3 帧
  const short: Observation = { screens: long.screens.slice(0, 1), coverage: long.coverage };
  const d = diffScreens(long, short);
  assert.equal(d.diverged, true);
  assert.equal(d.firstStep, 1, '首屏两边相同，第一个可比的落点是第二帧');
  assert.equal(d.frames, long.screens.length - short.screens.length, '多出来的每一帧都算一帧不同');
});

// ─────────────────────────── L2：玩家侧前提 ───────────────────────────

test('前提默认读参考版，hpClamp 单独读缺陷版（不许反向循环论证）', () => {
  assert.equal(PRECONDITION.hpClamp.side, 'mutant');
  const mutantOnly = Object.entries(PRECONDITION)
    .filter(([, v]) => v.side === 'mutant')
    .map(([k]) => k);
  assert.deepEqual(mutantOnly, ['hpClamp'], '这条判据只容许一个例外，多一个就是判据写坏了');
  for (const [cap, spec] of Object.entries(PRECONDITION) as [Cap, Precondition][]) {
    if (cap === 'hpClamp') continue;
    assert.equal(spec.side, 'ref', `${cap} 不该读缺陷版账本`);
  }
});

test('checkPreconditions 按 side 取对应那一版的账本', () => {
  const cov = (over: Partial<Coverage>): Coverage => ({
    ticks: 0, cellsVisited: 0, cellsTotal: 64, hpSeen: [], hpZeroReached: false,
    hpBelowZeroReached: false, hpAboveMaxReached: false, died: false,
    adjacentEnemyReached: false, attackedWhileAdjacent: false, touchedByEnemy: false,
    stoodOnPickup: false, pickupAtFullHp: false, pickupsTaken: 0, kills: 0,
    attacksWhileCooldown: 0, wallAttempts: 0, boundaryAttempts: 0, ...over,
  });
  const pre = checkPreconditions(['wallBlocks', 'hpClamp'], {
    ref: cov({}), mutant: cov({ hpAboveMaxReached: true }),
  });
  assert.equal(pre[0]!.reached, false, '参考版没撞过墙 = 未触达');
  assert.equal(pre[0]!.side, 'ref');
  assert.equal(pre[1]!.reached, true, '缺陷版越界了才算触达');
  assert.equal(pre[1]!.side, 'mutant');
  // 反向对照：拿错那一版（把 mutant 的事实记到 ref 名下）必须判不出来
  const swapped = checkPreconditions(['hpClamp'], {
    ref: cov({ hpAboveMaxReached: true }), mutant: cov({}),
  });
  assert.equal(swapped[0]!.reached, false, 'side 取错了也能自圆其说 = 这条判据是假的');
});

// ─────────────────────────── 判决六格互斥 ───────────────────────────

/**
 * 六格各一条原文，全部按词表的真实语义构造（不是"看起来像"）：
 *   无误报   参考版 + 一句异常都没喊
 *   误报     参考版 + 喊了异常但没有观测量 → vague 也算上报，对称判
 *   未上报   缺陷版 + 只描述观测量
 *   报了未指明 缺陷版 + 喊异常、零观测量
 *   归因错误  缺陷版 + 喊异常、指的却是没被删的能力
 *   归因正确  缺陷版 + 喊异常、指的正是被删的那项
 */
const cases6: { text: string; removed: Cap[]; want: Verdict }[] = [
  { text: '屏幕 HP 10/10，场上 3 个敌人，一切照常。', removed: [], want: '无误报' },
  { text: '规则明明不正常，说不上来哪里怪。', removed: [], want: '误报' },
  { text: 'HP 10/10，场上 3 个敌人、3 个物品。', removed: ['wallBlocks'], want: '未上报' },
  { text: '整体感觉哪里不对，说不上来具体是哪一项。', removed: ['wallBlocks'], want: '报了未指明' },
  { text: '攻击冷却好像不正常，一直就绪连发。', removed: ['wallBlocks'], want: '归因错误' },
  { text: '撞墙不正常，墙根本没挡住我。', removed: ['wallBlocks'], want: '归因正确' },
];

test('六个判决值全都能被构造出来，且互斥', () => {
  const got = cases6.map((c) => decide(claimOf(c.text, c.removed), c.removed));
  assert.deepEqual(got, cases6.map((c) => c.want));
  assert.equal(new Set(got).size, 6, '判决必须互斥：六个输入得到六个不同输出');
});

test('firstFailingLayer 的失败层顺序 = 判决顺序，第一个不成立的是归因', () => {
  const core = (
    verdict: Verdict, diverged: boolean, premise: boolean,
  ): Omit<Detection, 'whyNot' | 'coverage'> => ({
    judgementVersion: JUDGEMENT_VERSION, mutant: 'M01', removed: ['wallBlocks'] as Cap[],
    seed: 6, actions: 3,
    visible: {
      diverged, firstStep: diverged ? 1 : null, frames: diverged ? 1 : 0, sample: [],
    } as ScreenDivergence,
    preconditions: [] as Precondition[], playerPremise: premise,
    internal: { diverged, firstStep: diverged ? 1 : null },
    claim: { reported: true, vague: false, caps: [] as Cap[], quotes: [] } as ClaimVerdict,
    verdict,
    detectable: diverged,
    detected: diverged && verdict === '归因正确',
    exactlyAttributed: false, falsePositive: false, invisibleThoughDiverged: false,
  });
  assert.equal(firstFailingLayer(core('归因正确', true, true)), null, '全通过就没有失败层');
  assert.equal(firstFailingLayer(core('归因正确', false, true)), '不可见');
  assert.equal(firstFailingLayer(core('归因正确', true, false)), '未触达');
  assert.equal(firstFailingLayer(core('报了未指明', true, true)), '报了未指明');
  assert.equal(firstFailingLayer(core('归因错误', true, true)), '归因错误');
  assert.equal(firstFailingLayer(core('未上报', true, true)), '未上报');
});

test('参考版侧只有两格判决（无误报 / 误报），失败层不适用', () => {
  assert.equal(decide(claimOf('一切正常。', []), []), '无误报');
  assert.equal(decide(claimOf('规则不正常。', []), []), '误报');
  // firstFailingLayer 只对缺陷局有意义：detectOne 在 mutant=null 时把 whyNot 直接置 null
  assert.equal(
    firstFailingLayer({
      judgementVersion: JUDGEMENT_VERSION, mutant: null, removed: [] as Cap[], seed: 6, actions: 3,
      visible: { diverged: false, firstStep: null, frames: 0, sample: [] } as ScreenDivergence,
      preconditions: [], playerPremise: true,
      internal: { diverged: false, firstStep: null },
      claim: claimOf('一切正常。', []), verdict: '无误报',
      detectable: false, detected: false, exactlyAttributed: false,
      falsePositive: false, invisibleThoughDiverged: false,
    }),
    '不可见',
    '参考版走的是"没有缺陷可言"那条路：调用方（detectOne）负责把 whyNot 置 null，这里只证明漏斗本身照层判',
  );
});

// ─────────────────────────── 零泄漏 ───────────────────────────

const LEAK = ['M01', 'D01', '变异体', 'mutant', '被删能力', '可见分叉', '玩家侧前提',
  '归因正确', '归因错误', '报了未指明', '检出判决', 'judgementVersion'];

test('任务文本没有变异体 id、没有能力名、没有判决术语', () => {
  for (const forbidden of [...LEAK, ...CAP_NAMES]) {
    assert.ok(!ARENA_TASK.includes(forbidden), `任务文本泄漏了「${forbidden}」`);
  }
});

test('工具清单与首屏没有作者侧标识', () => {
  const s = new GameSession(6);
  const texts: string[] = [renderInitial(s.internalState())];
  for (const t of gameTools(s)) {
    texts.push(t.name, t.description);
    for (const p of Object.values(t.params ?? {})) {
      if (typeof p.description === 'string') texts.push(p.description);
    }
  }
  for (const forbidden of [...LEAK, ...CAP_NAMES]) {
    for (const text of texts) {
      assert.ok(!normalize(text).includes(normalize(forbidden)), `送给大脑的文本泄漏了「${forbidden}」`);
    }
  }
});

// ─────────────────────────── helper ───────────────────────────

/** agent 在一条参考版轨迹里真会看到的文本：首屏 + 每帧屏幕 + 每帧现象行 */
async function renderCorpus(seed: number, steps: number): Promise<string> {
  const s = new GameSession(seed);
  const dirs = [1, 2, 3, 4] as const;
  let corpus = s.screen();
  for (let i = 0; i < steps; i++) {
    const a: Action = i % 6 === 0
      ? { kind: 'attack' }
      : i % 10 === 3
        ? { kind: 'pickup' }
        : { kind: 'move', dir: dirs[i % 4]! };
    const r = await s.apply(a);
    corpus += `\n${r.screen}\n${r.events.join('\n')}`;
  }
  return corpus;
}
