/**
 * 复现包生成器（大赛 6-C 硬要求：初始状态 + 随机种子 + 完整动作序列，且可第三方复现）。
 *
 * 为什么它是"生成"而不是"手写"：这份文档里每一个数字、每一条动作序列、每一段屏幕差异，
 * 都是本脚本**自己重放世界**算出来的。手写一份复现包，就等于把"证据"换成"照片"——
 * 那是台账 #15（判据写了不用）与 #21（引用了没接进来的东西）的第三次发作。
 *
 * 独立性：只借世界层纯函数（createWorld / step / describe / render / worldHash）与
 * 变异体表（findMutant）——那是**被测的世界**，不是判决者。公证器（notary）与 M4-f 判决器
 * 的结论在这里全部当作**待核对的主张**，逐条独立重算对照。
 *
 * 用法:
 *   node verify/reproduction.ts                     # 审计 + 把复现包打到 stdout
 *   node verify/reproduction.ts --emit REPRODUCTION.md   # 审计通过后写文件
 *   node verify/reproduction.ts --check REPRODUCTION.md  # 审计 + 比对已入库文档（漂移即红）
 *   node verify/reproduction.ts <runDir> ...        # 只审指定那几局
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createWorld, step, worldHash, ALL_CAPS, type Action, type Capabilities, type WorldState } from '../src/world/arena.ts';
import { findMutant } from '../src/world/mutants.ts';
import { describe, render, renderInitial } from '../src/world/render.ts';
import { diffFields } from '../src/notary/diff.ts';

const ROOT = resolve(join(resolve(new URL('.', import.meta.url).pathname), '..'));

/**
 * 进复现包的局：全是**真大脑**跑出来的缺陷局（不是脚本替身、不是夹具）。
 * 每条都写清"为什么选它"，因为复现包不是样本越多越好，是要覆盖不同的判决形态。
 */
const FEATURED: { dir: string; why: string }[] = [
  {
    dir: 'runs/m1b-M02/20261113-084119-s6',
    why: '最早的一局真大脑缺陷局（M1-b）：28 步轨迹收缩到 **1 步**就是全部证物。它同时是主观侧的反面教材——'
      + '模型 notes 里写的是"右侧可无限行走而不撞墙"，而本案注入的缺陷是**敌人不再巡逻**，两者不是一回事；'
      + '复现包因此只报客观证据，不替模型圆场（吻合判定见 M4-f 的 `归因正确/归因错误`，主客观对账是 M4-d）',
  },
  {
    dir: 'runs/m4f-model/M01-on/20261116-230249-s6',
    why: 'M4-f 模型臂：仪器独立判定可见分叉＋玩家侧前提已触达，但模型没上报——复现包照样成立',
  },
  {
    dir: 'runs/m4f-model/D02-on/20261116-230824-s6',
    why: '双变异体（D02）：最小复现收缩到 1 步，证明"多重缺陷"也能定位到单步证据',
  },
  {
    dir: 'runs/20261113-204204-s6',
    why: 'M3/M4 期的 M08 局：复现包在 M4-f 口径之前就成立，不是新加判据事后包装的',
  },
];

// ─────────────────────────── 参数 ───────────────────────────

const argv = process.argv.slice(2);
let emit: string | null = null;
let check: string | null = null;
let useDefault = true;
const dirs: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--emit') { emit = argv[++i] ?? ''; continue; }
  if (a === '--check') { check = argv[++i] ?? ''; continue; }
  // --no-default：不退回内置清单。这条存在是为了让"零样本"成为一个**可被自检打到**的分支，
  // 而不是一句写在注释里、永远跑不到的愿望。
  if (a === '--no-default') { useDefault = false; continue; }
  dirs.push(a);
}
const targets = dirs.length > 0
  ? dirs.map((d) => ({ dir: d.replace(/\/+$/, ''), why: '（命令行指定）' }))
  : useDefault ? FEATURED : [];

// #17 的老规矩：零样本不许当通过。没有局可审就直接红，不打印"0 处不一致"糊人。
if (targets.length === 0) {
  console.error('❌ 一个 run 目录都没有 → 本脚本一行都没审。零样本＝假通过，拒绝以 0 退出。');
  process.exit(1);
}

/** 证据缺失说人话：缺哪个文件、为什么可能缺、下一步跑什么。 */
function need(runDir: string, f: string): string {
  const p = runDir.startsWith('/') ? runDir : join(ROOT, runDir);
  const fp = join(p, f);
  if (!existsSync(fp)) {
    console.error(`[证据缺失] 读不到 ${fp}\n` +
      `  复现包需要 ${f}。两种可能：① run 目录名写错了（列一下 runs/）；` +
      `② 该局是 M4-f 之前跑的、本来就没有这个文件（那就别把它写进 FEATURED）。`);
    process.exit(2);
  }
  return readFileSync(fp, 'utf8');
}

// ─────────────────────────── 自己的重放（不经 GameSession、不经判决器） ───────────────────────────

interface Replay { states: WorldState[]; screens: string[]; hashes: string[] }

function replay(seed: number, caps: Capabilities, actions: readonly Action[]): Replay {
  let s = createWorld(seed);
  const states = [s];
  const screens = [renderInitial(s)];
  const hashes = [worldHash(s)];
  for (const a of actions) {
    const prev = s;
    s = step(prev, a, caps, seed);
    states.push(s);
    screens.push(render(s, describe(prev, a, s)));
    hashes.push(worldHash(s));
  }
  return { states, screens, hashes };
}

const j = (v: unknown): string => JSON.stringify(v);
const act = (a: Action): string => (a.kind === 'move' ? `move(${['上', '右', '下', '左'][(a as { dir: number }).dir]})` : a.kind);
const actList = (as: Action[]): string => (as.length === 0 ? '（空序列）' : as.map(act).join(' → '));

/** 两条流的第一个/全部差异位置（内部状态用 diffFields，屏幕用字符串等值） */
function divergence(a: unknown[], b: unknown[], eq: (x: unknown, y: unknown) => boolean) {
  const frames: { step: number; detail: string }[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i >= a.length || i >= b.length) { frames.push({ step: i, detail: '一边已终止' }); continue; }
    if (eq(a[i], b[i])) continue;
    const d = diffFields(a[i], b[i]);
    frames.push({ step: i, detail: d.length ? d.map((x) => `${x.path}: ${j(x.ref)}→${j(x.mut)}`).join(', ') : '屏幕文本不同' });
  }
  return { first: frames.length ? frames[0]! : null, frames };
}

// ─────────────────────────── 逐局审计 + 组包 ───────────────────────────

interface Packet {
  dir: string; why: string; mutant: string; label: string; removed: string[]; seed: number;
  initialHash: string; initialScreen: string;
  stateJson: string; actions: Action[]; minActions: Action[]; claims: string[];
  internalFirst: string; visibleFirst: string; visibleFrames: number; refScreen: string; mutScreen: string;
  dropped: string; verdict: string | null;
}

const issues: string[] = [];
const packets: Packet[] = [];
const rejects: string[] = [];

function say(kind: string, ok: boolean, text: string): void {
  console.log(`  ${ok ? '✅' : '❌'} [${kind}] ${text}`);
  if (!ok) issues.push(`[${kind}] ${text}`);
}

for (const t of targets) {
  const header = JSON.parse(need(t.dir, 'header.json'));
  const defect = JSON.parse(need(t.dir, 'defect.json'));
  const logged = need(t.dir, 'world.jsonl').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const actions = defect.fullWorldActions as Action[];
  const n = defect.notary ?? {};
  const brainId = String(header.brainId ?? '');

  console.log(`\n----- ${t.dir} -----`);
  console.log(`  大脑=${brainId}  seed=${defect.seed}  动作=${actions.length} 步`);

  // 复现包只收"真大脑 + 确实分叉 + 有最小证物"的局。凑不齐就**出声拒绝**，不硬凑。
  if (!defect.mutant) { rejects.push(`${t.dir}：对照组，无缺陷可复现`); console.log('  ⏭ 跳过：对照组（没有缺陷，就没有复现包）'); continue; }
  if (brainId.startsWith('mock') || brainId.startsWith('script')) {
    rejects.push(`${t.dir}：${brainId} 是测试替身，不是大脑`);
    console.log('  ⏭ 跳过：测试替身（#21：替身不许进任何对外结论）');
    continue;
  }
  if (!n.diverged || !n.minimized) {
    rejects.push(`${t.dir}：该局从未分叉（${defect.mutant} 没被这条轨迹踩到）`);
    console.log('  ⏭ 跳过：整条轨迹没触到缺陷 —— 没有最小证物，硬写复现包就是编故事');
    continue;
  }

  const mut = findMutant(defect.mutant);
  const ref = replay(defect.seed, ALL_CAPS, actions);
  const m = replay(defect.seed, mut.caps, actions);

  // J1 初始状态三方钉死：我重算的 == header 落的 == defect 落的 == header.world.mutant 说的
  say('初始', ref.hashes[0] === header.initialState?.world?.hash && ref.hashes[0] === defect.initialHash,
    `初始哈希 重算=${ref.hashes[0]} header=${header.initialState?.world?.hash} defect=${defect.initialHash}`);
  say('初始', header.initialState?.world?.mutant === defect.mutant && header.seed === defect.seed,
    `变异体/种子 三方一致（header=${header.initialState?.world?.mutant}/${header.seed}，defect=${defect.mutant}/${defect.seed}）`);

  // J2 落盘的这一局确实是"缺陷版世界"跑出来的
  const badFrames: number[] = [];
  for (let i = 0; i < Math.max(m.hashes.length, logged.length); i++) if (m.hashes[i] !== logged[i]?.hash) badFrames.push(i);
  say('重放', badFrames.length === 0 && m.hashes.length === logged.length,
    `逐帧比对 重算=${m.hashes.length} 落盘=${logged.length} 不符帧=${badFrames.length ? badFrames.join(',') : '0 处'}`);

  // J3 首分叉：内部层独立重算，对照公证器主张；屏幕层自己数，对照 detection.json（若有）
  const internal = divergence(ref.states, m.states, (x, y) => j(x) === j(y));
  const visible = divergence(ref.screens, m.screens, (x, y) => x === y);
  say('分叉', (internal.first?.step ?? null) === (n.firstStep ?? null) && internal.frames.length === (n.divergedFrames ?? -1),
    `内部首分叉 独立=第${internal.first?.step ?? '无'}步(${internal.first?.detail ?? '—'}) 共${internal.frames.length}帧｜公证器称=第${n.firstStep ?? '无'}步 共${n.divergedFrames}帧`);
  // 绝对路径要照原样用：join(ROOT, '/tmp/xxx') 会把 tmp 那截拼到仓库里，
  // 于是 detection.json "不存在"、两条判决层核对**静默跳过**——自检注入 #8/#9 就是这么抓到它的。
  const abs = t.dir.startsWith('/') ? t.dir : join(ROOT, t.dir);
  const det = existsSync(join(abs, 'detection.json')) ? JSON.parse(need(t.dir, 'detection.json')) : null;
  if (det) {
    say('分叉', (visible.first?.step ?? null) === (det.visible?.firstStep ?? null) && visible.frames.length === (det.visible?.frames ?? -1),
      `屏幕首分叉 独立=第${visible.first?.step ?? '无'}步 共${visible.frames.length}帧｜M4-f 判决称=第${det.visible?.firstStep ?? '无'}步 共${det.visible?.frames}帧（判决=${det.verdict}）`);
    const expectStamp = `${header.judgement?.detector}+lex-${header.judgement?.lexicon}`;
    say('口径', det.judgementVersion === expectStamp,
      `口径戳自洽：期望=${expectStamp} 实际=${det.judgementVersion}`);
  }

  // J4 最小证物：仍复现 / J5 删任一步不复现 / J6 它是完整序列保序删出来的（不是手编）
  const min = n.minimized.actions as Action[];
  const minRef = replay(defect.seed, ALL_CAPS, min);
  const minMut = replay(defect.seed, mut.caps, min);
  const minDiv = j(minRef.states) !== j(minMut.states);
  say('最小化', minDiv, `最小序列（${min.length} 步：${actList(min)}）仍复现分叉=${minDiv}`);
  const drops = min.map((_, i) => {
    const cut = min.filter((__, k) => k !== i);
    const a2 = replay(defect.seed, ALL_CAPS, cut), b2 = replay(defect.seed, mut.caps, cut);
    return { i, still: j(a2.states) !== j(b2.states) };
  });
  say('最小化', drops.every((d) => !d.still),
    `逐个删一步后仍分叉的个数=${drops.filter((d) => d.still).length}/${drops.length}（必须全 0 才叫 1-minimal）`);
  let k = 0, subseq = min.length <= actions.length;
  for (const a of actions) if (k < min.length && j(a) === j(min[k])) k++;
  say('最小化', subseq && k === min.length,
    `最小序列是完整序列保序删除所得=${k === min.length}（公证器称 ${n.minimized.originalLength}→${min.length} 步，tests=${n.minimized.tests}，reverified=${n.minimized.reverified}）`);

  // J7 接口是结构化的：动作是带 kind 的对象、状态可哈希、屏幕文本是渲染出来的而非人写的
  const kindsOk = actions.every((a) => ['move', 'attack', 'pickup', 'wait'].includes(a.kind));
  say('接口', kindsOk && actions.length > 0,
    `动作全部是结构化对象（kind∈move/attack/pickup/wait）=${kindsOk}；状态逐帧带 hash=${logged.every((r: any) => typeof r.hash === 'string')}`);

  packets.push({
    dir: t.dir, why: t.why, mutant: String(defect.mutant), label: mut.label, removed: mut.removed.map(String), seed: defect.seed,
    initialHash: ref.hashes[0]!, initialScreen: ref.screens[0]!,
    stateJson: JSON.stringify(ref.states[0], null, 1),
    actions, minActions: min,
    claims: ((defect.agentClaims?.notes ?? []) as string[]).concat(
      det?.claim?.quotes?.length
        ? (det.claim.quotes as string[]).map((q) => `（M4-f 采到的上报原话）${q}`)
        : [],
    ),
    internalFirst: internal.first ? `第 ${internal.first.step} 步｜${internal.first.detail}` : '从未分叉',
    visibleFirst: visible.first ? `第 ${visible.first.step} 步起，共 ${visible.frames.length} 帧屏幕不同` : '屏幕全程相同（这条轨迹上它不可见）',
    visibleFrames: visible.frames.length,
    refScreen: visible.first ? ref.screens[visible.first.step]! : '',
    mutScreen: visible.first ? m.screens[visible.first.step]! : '',
    dropped: `${n.minimized.originalLength} 步 → ${min.length} 步（收缩 ${Math.round((1 - min.length / n.minimized.originalLength) * 100)}%，逐删 ${drops.length} 次全不复现）`,
    verdict: det?.verdict ?? null,
  });
}

console.log(`\n===== 复现包审计：可入库 ${packets.length} 案｜拒绝 ${rejects.length} 案｜不一致 ${issues.length} 处 =====`);
for (const r of rejects) console.log(`   ⏭ ${r}`);

// ─────────────────────────── 组 markdown ───────────────────────────

function markdown(): string {
  const L: string[] = [];
  L.push('# 复现包（REPRODUCTION）——缺陷不是截图，是能在你机器上再跑一遍的东西');
  L.push('');
  L.push('> 本文件由 `node verify/reproduction.ts --emit REPRODUCTION.md` **生成**，不要手改：');
  L.push('> `npm run verify:reproduction:check` 会重放一遍世界、重算每一条主张，与已入库文本逐字节比对，');
  L.push('> 漂了就红。手抄的复现步骤会过期，重放的不会。');
  L.push('');
  L.push('每一案都给齐 6-C 要求的三要素——**随机种子 / 初始状态 / 完整动作序列**——再加两样别处通常没有的：');
  L.push('**最小复现序列**（1-minimal：删掉任一步就不再复现）与**首分叉的机器可读位置**（内部状态层 + 玩家可见的屏幕层各算一遍）。');
  L.push('');
  L.push('复现不需要模型、不需要 API key、不需要网络：动作序列已经录在证据文件里，世界是纯函数，`seed` 决定一切初始状态。');
  L.push('');
  L.push('## 一键自查（先看这个再往下看）');
  L.push('');
  L.push('```bash');
  L.push('git clone https://github.com/lisanfu/agent-harness.git && cd agent-harness');
  L.push('node verify/reproduction.ts          # Node ≥ 22.18，零依赖，无需 npm install');
  L.push('```');
  L.push('');
  L.push('它会逐案打印 `[初始] [重放] [分叉] [口径] [最小化] [接口]` 六组核对，每条都是**本脚本自己重算**的结果与');
  L.push('公证器/判决器主张的对照；任何一条不符即非零退出。最后一行是 `可入库 N 案｜拒绝 M 案｜不一致 0 处`。');
  L.push('');
  if (rejects.length) {
    L.push('**本脚本主动拒绝的局（宁可少给，不给假的）**：');
    L.push('');
    for (const r of rejects) L.push(`- ${r}`);
    L.push('');
  }
  L.push('---');
  const seenState = new Map<string, number>();
  packets.forEach((p, i) => {
    L.push('');
    L.push(`## 案例 ${i + 1}：\`${p.mutant}\`｜\`${p.dir}\``);
    L.push('');
    L.push(`**注入的缺陷（变异体表原文，不是人给的解释）**：\`${p.mutant}\` ${p.label}｜被删掉的能力：${p.removed.map((r) => `\`${r}\``).join('、')}`);
    L.push('');
    L.push(`**为什么选它**：${p.why}`);
    if (p.verdict) L.push(`**M4-f 四层漏斗判决**：\`${p.verdict}\`（判决口径戳见该局 \`header.judgement\`，跑前已冻结）`);
    L.push('');
    L.push('### 三要素');
    L.push('');
    L.push(`- **随机种子**：\`seed=${p.seed}\`（世界全部初始状态由它确定性生成）`);
    L.push(`- **初始状态哈希**：\`${p.initialHash}\`（本脚本重放算得，与 \`header.json\`、\`defect.json\` 三方一致）`);
    L.push(`- **完整动作序列**（${p.actions.length} 步，agent 实际走的）：`);
    L.push('');
    L.push('  ```json');
    L.push(`  ${j(p.actions)}`);
    L.push('  ```');
    L.push('');
    L.push(`  人类可读：\`${actList(p.actions)}\``);
    L.push('');
    L.push('### 初始画面（agent 看到的第一屏，由本脚本渲染）');
    L.push('');
    L.push('```');
    for (const line of p.initialScreen.split('\n')) L.push(line);
    L.push('```');
    L.push('');
    L.push('### 首分叉：内部状态层与玩家可见层各算一遍');
    L.push('');
    L.push(`- 内部状态：${p.internalFirst}`);
    L.push(`- 玩家屏幕：${p.visibleFirst}`);
    L.push('');
    if (p.visibleFrames > 0) {
      L.push('分叉那一帧，两版屏幕并排（左参考版 / 右缺陷版，同一 seed 同一条动作序列）：');
      L.push('');
      L.push('```');
      const r = p.refScreen.split('\n'), s = p.mutScreen.split('\n');
      for (let i = 0; i < Math.max(r.length, s.length); i++) L.push(`${(r[i] ?? '').padEnd(46)} | ${(s[i] ?? '')}`);
      L.push('```');
      L.push('');
    }
    L.push('### 最小复现序列（1-minimal）');
    L.push('');
    L.push(`- ${p.dropped}`);
    L.push(`- 最小序列：\`${j(p.minActions)}\` 即 \`${actList(p.minActions)}\``);
    L.push('');
    L.push('这条序列**只用于复现缺陷**：它是从完整轨迹里保序删除得到的（脚本已核对），且逐删一遍全不复现——');
    L.push('也就是说它不是"另一条也能触发的路"，而是这局证据的**最小充分片段**。');
    L.push('');
    if (p.claims.length) {
      L.push('### 大脑自己在局内说了什么（原文摘自 `defect.json.agentClaims`，一个字没改）');
      L.push('');
      for (const c of p.claims) L.push(`- ${c}`);
      L.push('');
      L.push(p.verdict
        ? `这些话与本案缺陷是否吻合，**不由本文判断**：M4-f 判决器按跑前冻结的口径给的是 \`${p.verdict}\`。`
        : '该局跑在 M4-f 口径落盘之前，判决未落盘，本文**不做吻合判定**（台账 #19：事后规则不追判旧证据）。'
          + '原文照抄只让读者自己看见一件事：模型说的话与注入的缺陷可以完全不相干。');
      L.push('');
    }
    L.push('### 结构化状态与动作接口（6-C 要求"支持结构化状态与动作接口"）');
    L.push('');
    L.push(`\`${p.dir}/\` 下这些文件就是接口本身：`);
    L.push('');
    L.push('| 文件 | 内容 | 谁写的 |');
    L.push('| --- | --- | --- |');
    L.push('| `header.json` | `seed`、`initialState.world={kind,seed,hash,screen,mutant}`、`judgement` 口径戳、`config` | 循环层，第一步之前 |');
    L.push('| `world.jsonl` | 每帧 `{tick, action, hash, events}`：状态用哈希钉住，动作是结构化对象 | 世界层 |');
    L.push('| `trace.jsonl` | 每步的大脑请求/工具调用/返回屏幕文本 | 循环层 |');
    L.push('| `defect.json` | `mutant`、`fullWorldActions`、`notary`（首分叉＋最小化）、`agentClaims` | 公证器 |');
    L.push('| `detection.json` | 四层漏斗判决（可见/前提/上报/归因）与 `whyNot` | M4-f 判决器 |');
    L.push('');
    L.push('动作取值：`{kind:"move",dir:0|1|2|3}`｜`{kind:"attack"}`｜`{kind:"pickup"}`｜`{kind:"wait"}`（0=上 1=右 2=下 3=左）。');
    L.push('初始状态由 `createWorld(seed)` 确定性生成，本脚本重放后打印如下（与上面哈希一一对应）：');
    L.push('');
    const firstSeen = seenState.get(p.stateJson);
    if (firstSeen === undefined) {
      seenState.set(p.stateJson, i + 1);
      L.push('```json');
      L.push(p.stateJson);
      L.push('```');
    } else {
      // 同一个 seed 的局到处都是——重复贴四遍 JSON 不是证据，是凑字数。
      L.push(`与**案例 ${firstSeen}** 的初始状态逐字节相同（同 \`seed=${p.seed}\`、同哈希 \`${p.initialHash}\`），不再重复贴。`);
    }
    L.push('');
    L.push('---');
  });
  L.push('');
  L.push('## 这些复现包**不**声称什么');
  L.push('');
  const verdicts = [...new Set(packets.map((p) => p.verdict).filter((v): v is string => !!v))];
  L.push(`1. 不声称"模型能发现缺陷"。本文件 ${packets.length} 案里，落盘了 M4-f 判决的那些，判决只有：`
    + `**${verdicts.length ? verdicts.join(' / ') : '（一案都没有）'}**——没有一例是"上报且归因正确"。`);
  L.push('   缺陷是**量具**（差分公证器 + 屏幕层独立重放）发现并复现的；大脑那一栏该空就空着。');
  L.push('   把"仪器找到了"写成"模型找到了"，就是台账 #21 的同一种病：分母与来源共用一个名字。');
  L.push('2. 不声称覆盖全部缺陷类型。这批真大脑轨迹里没有出现"内部分叉而屏幕全程相同"的结构性不可见缺陷；');
  L.push('   上限表 `runs/m4f-ceiling/` 4800 例 `invisible=0` 说的是"随机臂不会遇到它"，不是"这种缺陷不存在"。');
  L.push('3. 不声称最小序列唯一。逐删只证明"这 1 步不能少"，不证明"没有别的更短路"。');
  L.push('');
  L.push('## 想自己造新复现包');
  L.push('');
  L.push('```bash');
  L.push('# 用宿主大脑/远端大脑跑一局缺陷世界（不填 key 就走 stdio 宿主大脑，零 key）');
  L.push('node src/cli.ts --world arena --mutant M02 --seed 6 --max-steps 30 --out runs/my-repro');
  L.push('# 独立重放＋出复现包（不 import 判决器，自己走 step/diffFields）');
  L.push('node verify/replay.ts runs/my-repro');
  L.push('node verify/reproduction.ts runs/my-repro');
  L.push('```');
  L.push('');
  L.push(`*生成于本次审计：${packets.length} 案入库｜${rejects.length} 案拒绝｜不一致 ${issues.length} 处。*`);
  L.push('');
  return L.join('\n');
}

const out = markdown();
if (check !== null) {
  const path = check.startsWith('/') ? check : join(ROOT, check);
  if (!existsSync(path)) {
    console.error(`\n❌ 要比对的文档不存在：${path}（先跑 npm run docs:reproduction 生成）`);
    process.exit(1);
  }
  const onDisk = readFileSync(path, 'utf8');
  if (onDisk !== out) {
    const a = onDisk.split('\n'), b = out.split('\n');
    let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    console.error(`\n❌ ${check} 与重放结果漂移：第 ${i + 1} 行起不同`);
    console.error(`   入库：${a[i] ?? '（文件到此结束）'}`);
    console.error(`   重放：${b[i] ?? '（重放到此结束）'}`);
    console.error('   修法：npm run docs:reproduction 重新生成（**不要手改文档**，手改就是把证据换成照片）。');
    process.exit(1);
  }
  console.log(`\n✅ ${check} 与独立重放逐字节一致（文档没被手改，证据没被换）`);
} else if (emit !== null) {
  writeFileSync(emit.startsWith('/') ? emit : join(ROOT, emit), out, 'utf8');
  console.log(`\n已写出 ${emit}：${packets.length} 案｜${rejects.length} 案拒绝`);
} else {
  console.log('\n' + '─'.repeat(70) + '\n（以下是复现包正文；写文件用 --emit REPRODUCTION.md）\n');
  console.log(out);
}

if (issues.length) {
  console.error(`\n❌ 不一致 ${issues.length} 处：复现包不入库，先修上面每一条。`);
  process.exit(1);
}
if (packets.length === 0) {
  console.error('\n❌ 零案入库：没有证据就没有复现包，拒绝以 0 退出。');
  process.exit(1);
}
console.log(`\n===== 结论：${packets.length} 案的三要素与最小证物全部由独立重放复核通过，不一致 0 处 =====`);
process.exit(0);
