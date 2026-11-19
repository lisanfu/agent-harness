/**
 * M4-c 眼耳对账夹具：一次生成**覆盖判据每条判决路径**的「已知判决短局」，纯代码、零 key、确定性。
 *
 * 为什么需要它（故障 #8/#22/#34 的听觉版）：`test/ear.test.ts` 那 35 条真值表用的是我手写的帧
 * （`frame(t, prev, action, next, [sound])`），而 `src/m4c.ts` 的上限表跑的是长局真轨迹——
 * 中间那条「屏幕是真的由世界投影出来、声音是真的由发声层放出来」的通道没人管过。
 * 更要命的是台账 #34：想用 `--brain mock` 产一局"agent 真用上耳朵"的证据被 CLI 当场拒绝，
 * 那是对的（mock 是测试替身，不是大脑），但这一格必须由**裁判侧夹具**补上，否则整条判据
 * 只在合成帧上绿过。
 *
 * 三样东西各归各的活，谁也不许替谁背书（台账 #14）：
 *   - `want` 是**人对着屏幕逐帧读出来的期望计数**（八族 × 五桶那张矩阵）；
 *   - `got` 是判据（`src/world/ear.ts`）自己落盘的判决；
 *   - 独立重算在 `verify/ear-audit.ts`，它**不 import 判据**，只吃这个文件里的屏幕与声流。
 * 三方一致才算过。夹具自己不查判据——否则夹具就成了判据的影子，坏了一起红。
 *
 * ⚠️ 它是**裁判侧夹具**：动作序列是人挑的，发声装置是人换的，没有任何一句自述来自模型。
 *    它只证明判据走得通、走得对，不证明 agent 能不能自己发现缺陷——那只有真模型臂能答。
 *
 * 每格都带一道**模具自检**：这一帧到底有没有真的挨打/倒下/叠格/整条声流晚一帧。
 * 自检不过＝这一格根本没摸到它声称摸到的那条分支（#15「判据写成永不失败」的夹具版）。
 * 它分两个阶段各抓到东西：
 *   - 手推期望时（对着 `sandbox/dbg` 的逐帧打印）：E11 的拾取那格当时满血（眼睛说不清，
 *     压根不是"相符"）、E13 倒下之后那两帧我以为耳朵会响、其实发声层按设计一声不响；
 *   - 首跑：E18 我写的「响了一声窸窣而 E 集合没变」不成立——那帧是**多出一格 E**（前帧的
 *     一格格都还在），真空出来的格子数为 0，这才是"无从核对"的真依据，断言按事实改了口径；
 *     E15 我把"同族第二声算耳侧独多"错算成 shuffle 相符 12 条（正确是 3 对 = 6 条 + 3 条矛盾），
 *     即人工期望自己抄错——矩阵比对把它逼了出来。
 * 另有一条自检是**给自检把的门**：期望矩阵不许从判据输出反抄（`want` 是人读屏幕定的，
 * `got` 是判据给的），否则夹具就成了判据的影子，坏了一起绿。
 *
 * 用法: node verify/ear-fixture.ts [outFile]
 * 输出: stdout 一行 = 证据文件路径，可直接喂给 verify/ear-audit.ts（与 recon-fixture 同一约定）
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ALL_CAPS, type Action, type Capabilities } from '../src/world/arena.ts';
import { observe, type Observation } from '../src/world/observe.ts';
import { GameSession } from '../src/world/session.ts';
import { findSoundMutant } from '../src/world/mutants.ts';
import {
  CAPACITY_ITEMS, EAR_CUES, EAR_VERDICTS, earFrames, earStamp,
  type EarClaim, type EarSide, type EarSound, type EarVerdict,
} from '../src/world/ear.ts';

const log = (l: string): void => void process.stderr.write(`${l}\n`);

const MOVE = (dir: 0 | 1 | 2 | 3): Action => ({ kind: 'move', dir });
const ATTACK: Action = { kind: 'attack' };
const TAKE: Action = { kind: 'pickup' };
const WAIT: Action = { kind: 'wait' };
const times = (n: number, a: Action): Action[] => Array.from({ length: n }, () => a);

/**
 * 期望矩阵的写法：`{ shuffle: { 相符: 6 }, 'cap:enemyCells': { 容量差: 3 } }`。
 * 键 = 八族 id 或 `cap:` 开头的容量差词条；缺的桶按 0 算。
 * 为什么是**计数矩阵**而不是逐条判决：一格夹具是一整段短局，几十一条主张，
 * 逐条抄一遍只会让我抄错（#30 那一族"写了、跑了、不起作用"）。
 * 矩阵照样能钉死每一处：族、桶、条数三个轴都得到，只是不钉帧号——
 * 帧号由 `wantAt` 单独点名（只点名这一格真正要验的那几条）。
 */
type WantMatrix = Record<string, Partial<Record<EarVerdict, number>>>;

interface Case {
  id: string;
  /** 这一格在验什么，给人看的 */
  what: string;
  /** 发声装置：`R0` = 参考版（八族全响）；`Sxx` = 换 rig，**世界一个字节都不变** */
  rig: string;
  seed: number;
  actions: Action[];
  /**
   * 模具自检：屏幕侧事实。判据的期望值是照着这些事实定的，
   * 事实不成立＝这一格是空的，拿它去验判据等于什么都没验。
   */
  goal: Array<[string, (f: Facts) => boolean]>;
  want: WantMatrix;
  /** 点名的逐条判决：帧号 + 族 + 哪一侧 + 落哪个桶 */
  wantAt?: Array<{ tick: number; cue: string; side: EarSide; verdict: EarVerdict }>;
  /**
   * 合成耳朵证据（只有两格用得上）：真实 rig 产不出"数字说少了"和"同一帧响两声"这两种形状
   * ——发声层一帧只放一声、数字由真状态算。这两条判决路径**只有靠人给声流**才摸得到。
   * 眼睛那侧仍然是真跑出来的屏幕，一点没改。
   */
  soundsOverride?: (tick: number, real: string[]) => string[];
}

/** 模具自检拿得到的东西：全部是**屏幕上读得出**的，不含任何内部状态。 */
interface Facts {
  obs: Observation[];
  sounds: EarSound[];
  actions: Action[];
  /** 第 t 帧听到某句（子串匹配） */
  heard: (t: number, sub: string) => boolean;
  /** 第 t 帧某句一次都没响 */
  silent: (t: number, sub: string) => boolean;
  /** 第 t 帧某句响了几声 */
  count: (t: number, sub: string) => number;
}

// ─────────────────────────── 20 格已知判决短局 ───────────────────────────

const C = (
  id: string, what: string, rig: string, seed: number, actions: Action[],
  goal: Array<[string, (f: Facts) => boolean]>, want: WantMatrix,
  extra: { wantAt?: Case['wantAt']; soundsOverride?: Case['soundsOverride'] } = {},
): Case => ({ id, what, rig, seed, actions, goal, want, ...extra });

const CASES: Case[] = [
  // ── 一、两个通道都说对的那一批（§10 点名要的阴性对照：审计算有牙，也得证明它认得出"没错"）──
  C('E01', '出手 + 击杀 + 有人挪：三族双向相符，屏幕上多出来的量化事实进容量差',
    'R0', 6, [ATTACK],
    [
      ['第 1 帧分数从 0 涨到 1', (f) => f.obs[0]!.score === 0 && f.obs[1]!.score === 1],
      ['上一帧 HUD 攻击就绪、这一帧灰了', (f) => f.obs[0]!.attackReady === true && f.obs[1]!.attackReady === false],
      ['这一帧听到破风、倒地、两处窸窣', (f) => f.heard(1, '破风') && f.heard(1, '倒地') && f.heard(1, '2 处窸窣')],
      ['玩家一格没动（脚步必须不响）', (f) => JSON.stringify(f.obs[0]!.player) === JSON.stringify(f.obs[1]!.player)],
    ],
    { swing: { 相符: 2 }, killThud: { 相符: 2 }, shuffle: { 相符: 2 },
      'cap:scorePoints': { 容量差: 1 }, 'cap:killCells': { 容量差: 1 }, 'cap:enemyCells': { 容量差: 1 } },
    { wantAt: [{ tick: 1, cue: 'shuffle', side: '眼', verdict: '相符' }] }),

  C('E02', '站着不动三帧：只有敌人挪动这一族，两侧各说三次',
    'R0', 6, times(3, WAIT),
    [
      ['三帧玩家都在 (0,0)', (f) => f.obs.every((o) => JSON.stringify(o.player) === '[0,0]')],
      ['每一帧都是一声「3 处窸窣」', (f) => [1, 2, 3].every((t) => f.count(t, '窸窣') === 1 && f.silent(t, '脚步'))],
    ],
    { shuffle: { 相符: 6 }, 'cap:enemyCells': { 容量差: 3 } }),

  C('E03', '往左走出画面：撞墙闷响相符（目标格压根不在图上）',
    'R0', 6, [MOVE(3)],
    [
      ['一格没动', (f) => JSON.stringify(f.obs[0]!.player) === JSON.stringify(f.obs[1]!.player)],
      ['这一帧响的是闷响而不是脚步', (f) => f.heard(1, '闷响') && f.silent(1, '脚步')],
    ],
    { wallBump: { 相符: 2 }, shuffle: { 相符: 2 }, 'cap:enemyCells': { 容量差: 1 } }),

  C('E04', '连走三格：脚步与窸窣双向相符，且第一帧下界被 @ 盖掉一格（2 而不是 3）',
    'R0', 6, times(3, MOVE(1)),
    [
      ['玩家三帧三格', (f) => f.obs[1]!.player![0] === 1 && f.obs[3]!.player![0] === 3],
      ['第一帧屏幕上有 3 格「E」空出来，其中 (1,0) 被 @ 盖住',
        (f) => f.obs[0]!.enemies.some((c) => c.join() === '1,0') && !f.obs[1]!.enemies.some((c) => c.join() === '1,0')
          && JSON.stringify(f.obs[1]!.player) === '[1,0]'],
      ['每帧一声脚步 + 一声三处窸窣', (f) => [1, 2, 3].every((t) => f.heard(t, '脚步') && f.heard(t, '3 处窸窣'))],
    ],
    { footstep: { 相符: 6 }, shuffle: { 相符: 6 },
      'cap:playerCell': { 容量差: 3 }, 'cap:enemyCells': { 容量差: 3 } }),

  C('E18', '挨打之后才拾取：血条上涨让"拿没拿"变成屏幕说得出的一件事（咔哒相符）',
    'R0', 1, [WAIT, WAIT, MOVE(1), TAKE],
    [
      ['第 3 帧血条从 10 掉到 8', (f) => f.obs[2]!.hp === 10 && f.obs[3]!.hp === 8],
      ['第 4 帧做了拾取动作且血条涨回 10', (f) => f.obs[4]!.hp === 10 && f.actions[3]!.kind === 'pickup'],
      ['第 3→4 帧没有一格可见「+」消失，且玩家脚下那格在屏幕上本来就看不见：咔哒的相符只能来自「做了拾取动作且血条上涨」这一条依据',
        (f) => JSON.stringify(f.obs[3]!.pickups) === JSON.stringify(f.obs[4]!.pickups)
          && !f.obs[3]!.pickups.some((c) => c[0] === f.obs[3]!.player![0] && c[1] === f.obs[3]!.player![1])],
      ['第 4 帧响了一声「1 处窸窣」，而屏幕上没有一格「E」确定空出来（前帧的 E 一格格都还在）⇒ 这一族无从核对',
        (f) => f.heard(4, '咔哒') && f.heard(4, '1 处窸窣')
          && f.obs[3]!.enemies.every((c) => f.obs[4]!.enemies.some((d) => d[0] === c[0] && d[1] === c[1]))],
    ],
    { shuffle: { 相符: 6, 无法核对: 1 }, footstep: { 相符: 2 }, hurtGrunt: { 相符: 2 },
      pickupClick: { 相符: 2 }, 'cap:enemyCells': { 容量差: 4 },
      'cap:playerCell': { 容量差: 1 }, 'cap:hpPoints': { 容量差: 2 } }),

  // ── 二、耳朵出声、屏幕说这一帧不该有：误报（S09 单局成证，§10 第 3 条）──
  C('E05', 'S09 误报型：正常移动也播闷响——单局、无参考版即可成立',
    'S09', 6, times(2, MOVE(1)),
    [
      ['两帧玩家都真的换了格子（眼睛说不算撞）',
        (f) => f.obs[0]!.player![0] === 0 && f.obs[1]!.player![0] === 1 && f.obs[2]!.player![0] === 2],
      ['两帧各多出一声闷响', (f) => [1, 2].every((t) => f.count(t, '闷响') === 1)],
      ['脚步照旧响（只有闷响是多的）', (f) => [1, 2].every((t) => f.heard(t, '脚步'))],
    ],
    { footstep: { 相符: 4 }, shuffle: { 相符: 4 }, wallBump: { 矛盾: 2 },
      'cap:playerCell': { 容量差: 2 }, 'cap:enemyCells': { 容量差: 2 } },
    { wantAt: [
      { tick: 1, cue: 'wallBump', side: '耳', verdict: '矛盾' },
      { tick: 2, cue: 'wallBump', side: '耳', verdict: '矛盾' },
    ] }),

  C('E19', 'S06 拾取咔哒丢失：满血以下才谈得上"这格看得见"，那一格才抓得住漏报',
    'S06', 1, [WAIT, WAIT, MOVE(1), TAKE],
    [
      ['与 E18 同一局，只是第 4 帧那声咔哒没了', (f) => f.silent(4, '咔哒')],
      ['血条照样从 8 涨回 10（眼睛有依据，耳朵一声不响）', (f) => f.obs[3]!.hp === 8 && f.obs[4]!.hp === 10],
    ],
    { shuffle: { 相符: 6, 无法核对: 1 }, footstep: { 相符: 2 }, hurtGrunt: { 相符: 2 },
      pickupClick: { 矛盾: 1 }, 'cap:enemyCells': { 容量差: 4 },
      'cap:playerCell': { 容量差: 1 }, 'cap:hpPoints': { 容量差: 2 } },
    { wantAt: [{ tick: 4, cue: 'pickupClick', side: '眼', verdict: '矛盾' }] }),

  // ── 三、眼睛看见了、耳朵没出声：漏报（S01/S04/S05/S07/S08 各一族）──
  C('E08', 'S01 脚步丢失：三帧三声漏报，全在眼侧',
    'S01', 6, times(3, MOVE(1)),
    [
      ['三帧都真的换了格子', (f) => f.obs[1]!.player![0] === 1 && f.obs[3]!.player![0] === 3],
      ['一声脚步都没有，窸窣照旧', (f) => f.sounds.every((s) => !s.text.includes('脚步')) && f.count(2, '窸窣') === 1],
    ],
    { footstep: { 矛盾: 3 }, shuffle: { 相符: 6 },
      'cap:playerCell': { 容量差: 3 }, 'cap:enemyCells': { 容量差: 3 } }),

  C('E09', 'S08 窸窣丢失：屏幕上确确实实有人空出来了，耳朵一句不说',
    'S08', 6, times(3, MOVE(1)),
    [
      ['三帧各有一批「E」格子空出来', (f) => [1, 2, 3].every((t) => f.obs[t]!.enemies.join() !== f.obs[t - 1]!.enemies.join())],
      ['一声窸窣都没有，脚步照旧', (f) => f.sounds.every((s) => !s.text.includes('窸窣')) && f.heard(1, '脚步')],
    ],
    { footstep: { 相符: 6 }, shuffle: { 矛盾: 3 },
      'cap:playerCell': { 容量差: 3 }, 'cap:enemyCells': { 容量差: 3 } }),

  C('E10', 'S04 敌人倒地声丢失：样本只有一声，闸门不许把它赦成别的东西',
    'S04', 6, [ATTACK],
    [
      ['分数照涨（眼睛记到了这次击杀）', (f) => f.obs[1]!.score === 1],
      ['一声倒地都没有', (f) => f.silent(1, '短促的倒地声') && f.heard(1, '破风')],
    ],
    { swing: { 相符: 2 }, killThud: { 矛盾: 1 }, shuffle: { 相符: 2 },
      'cap:scorePoints': { 容量差: 1 }, 'cap:killCells': { 容量差: 1 }, 'cap:enemyCells': { 容量差: 1 } },
    { wantAt: [{ tick: 1, cue: 'killThud', side: '眼', verdict: '矛盾' }] }),

  C('E16', 'S05 受击闷哼丢失：三帧挨打三声不漏（眼睛看得见血条往下掉）',
    'S05', 13, [MOVE(2), MOVE(2), WAIT, MOVE(0), MOVE(3), MOVE(0), ATTACK],
    [
      ['第 3、4、6 帧血条下降 10→8→6→4', (f) => [3, 4, 6].every((t) => f.obs[t]!.hp! < f.obs[t - 1]!.hp!)],
      ['一声闷哼都没有', (f) => f.sounds.every((s) => !s.text.includes('闷哼'))],
    ],
    { footstep: { 相符: 8 }, shuffle: { 相符: 12 }, hurtGrunt: { 矛盾: 3 },
      wallBump: { 相符: 2 }, swing: { 相符: 2 }, killThud: { 相符: 2 },
      'cap:playerCell': { 容量差: 4 }, 'cap:enemyCells': { 容量差: 7 }, 'cap:hpPoints': { 容量差: 3 },
      'cap:scorePoints': { 容量差: 1 }, 'cap:killCells': { 容量差: 1 }, 'cap:killCollapse': { 容量差: 2 } }),

  C('E17', 'S07 自身倒地声丢失：倒下那一帧 HUD 状态行变了，耳朵却不说',
    'S07', 40, [ATTACK, TAKE, MOVE(0), WAIT, MOVE(0), MOVE(1), MOVE(3), WAIT, MOVE(0), MOVE(2), WAIT, WAIT],
    [
      ['第 10 帧状态行从「活着」变「已倒下」', (f) => f.obs[9]!.alive === true && f.obs[10]!.alive === false],
      ['那一帧没有沉重倒地声，血条与闷哼照旧', (f) => f.silent(10, '沉重的倒地声') && f.heard(10, '闷哼')],
    ],
    { swing: { 相符: 2 }, shuffle: { 相符: 20 }, wallBump: { 相符: 8 }, footstep: { 相符: 4 },
      hurtGrunt: { 相符: 10 }, deathThud: { 矛盾: 1 },
      'cap:enemyCells': { 容量差: 12 }, 'cap:playerCell': { 容量差: 2 }, 'cap:hpPoints': { 容量差: 5 } }),

  // ── 四、时钟错位：单独一桶，不许冒充事实矛盾（§4 的那一格）──
  C('E20', 'S10 整条声流晚一帧（三帧移动）：样本够的两族各自过闸，D 全是 +1',
    'S10', 6, times(3, MOVE(1)),
    [
      ['每一声都比它对的那一帧晚一帧：脚步落在 2、3、4',
        (f) => f.heard(2, '脚步') && f.heard(3, '脚步') && f.heard(4, '脚步') && f.silent(1, '脚步')],
      ['屏幕侧一切正常（第 3 帧玩家确实在 (3,0)）', (f) => f.obs[3]!.player![0] === 3],
    ],
    { footstep: { 时钟错位: 6 }, shuffle: { 时钟错位: 6 },
      'cap:playerCell': { 容量差: 3 }, 'cap:enemyCells': { 容量差: 3 } },
    { wantAt: [
      { tick: 1, cue: 'footstep', side: '眼', verdict: '时钟错位' },
      { tick: 2, cue: 'footstep', side: '耳', verdict: '时钟错位' },
      { tick: 3, cue: 'shuffle', side: '眼', verdict: '时钟错位' },
      { tick: 4, cue: 'shuffle', side: '耳', verdict: '时钟错位' },
    ] }),

  C('E06', 'S10 晚一帧 + 出手击杀：破风与倒地各只响一次，靠继承拿到同一个 D',
    'S10', 6, [ATTACK, ...times(3, WAIT)],
    [
      ['窸窣族过了闸门（四次、同一 D），第 5 帧那声落在屏幕之外',
        (f) => [2, 3, 4, 5].every((t) => f.count(t, '窸窣') === 1)],
      ['破风与倒地都落在第 2 帧，而它们对应的是第 1 帧',
        (f) => f.heard(2, '破风') && f.heard(2, '短促的倒地声') && f.silent(1, '破风')],
    ],
    { shuffle: { 时钟错位: 8 }, swing: { 时钟错位: 2 }, killThud: { 时钟错位: 2 },
      'cap:scorePoints': { 容量差: 1 }, 'cap:killCells': { 容量差: 1 }, 'cap:enemyCells': { 容量差: 4 } },
    { wantAt: [
      { tick: 1, cue: 'swing', side: '眼', verdict: '时钟错位' },
      { tick: 2, cue: 'swing', side: '耳', verdict: '时钟错位' },
      { tick: 1, cue: 'killThud', side: '眼', verdict: '时钟错位' },
      { tick: 2, cue: 'killThud', side: '耳', verdict: '时钟错位' },
    ] }),

  C('E07', 'S10 但只有两帧：谁都没过闸门 ⇒ 同一个时钟 bug 被读成两起事实矛盾（继承的代价，如实登记）',
    'S10', 6, [ATTACK, WAIT],
    [
      ['窸窣只响两次（3 次闸门过不了）', (f) => f.count(2, '窸窣') === 1 && f.count(3, '窸窣') === 1],
      ['第 1 帧眼睛说了三件事，耳朵一声不响',
        (f) => f.silent(1, '破风') && f.silent(1, '倒地') && f.silent(1, '窸窣')],
    ],
    { swing: { 矛盾: 2 }, killThud: { 矛盾: 2 },
      shuffle: { 相符: 2, 矛盾: 1, 无法核对: 1 },
      'cap:scorePoints': { 容量差: 1 }, 'cap:killCells': { 容量差: 1 }, 'cap:enemyCells': { 容量差: 2 } },
    { wantAt: [
      { tick: 1, cue: 'swing', side: '眼', verdict: '矛盾' },
      { tick: 2, cue: 'swing', side: '耳', verdict: '矛盾' },
      { tick: 3, cue: 'shuffle', side: '耳', verdict: '无法核对' },
    ] }),

  // ── 五、屏幕原理上说不出来的东西：无法核对 + 容量差（免检必须计数，#21/#34）──
  C('E11', '走到物品堆再满血拾取：咔哒原理上无法核对，血量与分数之外全是容量差',
    'R0', 6, [...times(5, MOVE(2)), MOVE(1), TAKE],
    [
      ['最后一步确实站上了原本画着「+」的那格',
        (f) => JSON.stringify(f.obs[6]!.player) === '[1,5]' && !f.obs[6]!.pickups.some((c) => c.join() === '1,5')],
      ['满血：第 7 帧前后血条都是 10/10（眼睛说不出拿没拿）', (f) => f.obs[6]!.hp === 10 && f.obs[7]!.hp === 10],
      ['那声咔哒确实响了（只有耳朵说了，眼睛没法接）', (f) => f.heard(7, '咔哒')],
    ],
    { footstep: { 相符: 12 }, shuffle: { 相符: 14 }, pickupClick: { 无法核对: 1 },
      'cap:playerCell': { 容量差: 6 }, 'cap:enemyCells': { 容量差: 7 } },
    { wantAt: [{ tick: 7, cue: 'pickupClick', side: '耳', verdict: '无法核对' }] }),

  C('E12', 'seed13 一路挨打再三连杀：三具尸体挤进一声倒地，第 2、3 具进容量差不算漏报',
    'R0', 13, [MOVE(2), MOVE(2), WAIT, MOVE(0), MOVE(3), MOVE(0), ATTACK],
    [
      ['第 7 帧分数从 0 涨到 3（屏幕上只有这一个地方数得出杀了几个）',
        (f) => f.obs[6]!.score === 0 && f.obs[7]!.score === 3],
      ['第 7 帧场上「E」全没了，而倒地声只有一声',
        (f) => f.obs[7]!.enemies.length === 0 && f.count(7, '短促的倒地声') === 1],
      ['第 5 帧撞的是画面之外的格子（闷响相符）',
        (f) => JSON.stringify(f.obs[4]!.player) === JSON.stringify(f.obs[5]!.player)],
    ],
    { footstep: { 相符: 8 }, shuffle: { 相符: 12 }, hurtGrunt: { 相符: 6 }, wallBump: { 相符: 2 },
      swing: { 相符: 2 }, killThud: { 相符: 2 },
      'cap:playerCell': { 容量差: 4 }, 'cap:enemyCells': { 容量差: 7 }, 'cap:hpPoints': { 容量差: 3 },
      'cap:scorePoints': { 容量差: 1 }, 'cap:killCells': { 容量差: 1 }, 'cap:killCollapse': { 容量差: 2 } },
    { wantAt: [
      { tick: 7, cue: 'killThud', side: '眼', verdict: '相符' },
      { tick: 7, cue: 'cap:killCollapse', side: '屏幕', verdict: '容量差' },
      { tick: 5, cue: 'wallBump', side: '眼', verdict: '相符' },
    ] }),

  C('E13', 'seed40 被打到倒下再走两帧：倒下那帧相符，倒下之后一律不核对',
    'R0', 40, [ATTACK, TAKE, MOVE(0), WAIT, MOVE(0), MOVE(1), MOVE(3), WAIT, MOVE(0), MOVE(2), WAIT, WAIT],
    [
      ['第 10 帧血条见底、状态行改口', (f) => f.obs[10]!.hp === 0 && f.obs[10]!.alive === false],
      ['倒下之后那两帧世界还在走（「E」集合变了）而发声层一声不响',
        (f) => f.obs[12]!.enemies.join() !== f.obs[10]!.enemies.join() && f.silent(11, '窸窣') && f.silent(12, '窸窣')],
      ['倒地声只响在第 10 帧', (f) => f.heard(10, '沉重的倒地声') && f.silent(11, '沉重的倒地声')],
    ],
    { swing: { 相符: 2 }, shuffle: { 相符: 20 }, wallBump: { 相符: 8 }, footstep: { 相符: 4 },
      hurtGrunt: { 相符: 10 }, deathThud: { 相符: 2 },
      'cap:enemyCells': { 容量差: 12 }, 'cap:playerCell': { 容量差: 2 }, 'cap:hpPoints': { 容量差: 5 } },
    { wantAt: [
      { tick: 10, cue: 'deathThud', side: '眼', verdict: '相符' },
      { tick: 10, cue: 'deathThud', side: '耳', verdict: '相符' },
    ] }),

  // ── 六、真 rig 产不出来的两种形状：人给耳朵证据（眼睛那侧仍然是真屏幕）──
  C('E14', '合成耳朵：数字落在屏幕下界之外（画面证明至少 2/3/3 处，耳朵说 1 处）',
    'R0', 6, times(3, MOVE(1)),
    [
      ['人给的声流每帧只剩一声「1 处窸窣」', (f) => [1, 2, 3].every((t) => f.count(t, '1 处窸窣') === 1)],
      ['眼睛那侧与 E04 逐字节同一（只换耳朵，不换世界）',
        (f) => f.obs[1]!.player![0] === 1 && f.obs[3]!.player![0] === 3],
    ],
    { footstep: { 相符: 6 }, shuffle: { 矛盾: 6 },
      'cap:playerCell': { 容量差: 3 }, 'cap:enemyCells': { 容量差: 3 } },
    { wantAt: [{ tick: 1, cue: 'shuffle', side: '眼', verdict: '矛盾' }],
      soundsOverride: () => ['一声脚步。', '远处有 1 处窸窣。'] }),

  C('E15', '合成耳朵：同一帧响两声窸窣——屏幕一帧只支持一次，第二声算耳侧独多',
    'R0', 6, times(3, MOVE(1)),
    [
      ['人给的声流每帧两声「3 处窸窣」', (f) => [1, 2, 3].every((t) => f.count(t, '3 处窸窣') === 2)],
      ['脚步仍然一声（多的只有窸窣那一族）', (f) => [1, 2, 3].every((t) => f.count(t, '脚步') === 1)],
    ],
    { footstep: { 相符: 6 }, shuffle: { 相符: 6, 矛盾: 3 },
      'cap:playerCell': { 容量差: 3 }, 'cap:enemyCells': { 容量差: 3 } },
    { wantAt: [{ tick: 2, cue: 'shuffle', side: '耳', verdict: '矛盾' }],
      soundsOverride: (_t, real) => [...real, real.filter((x) => x.includes('窸窣')).at(-1) ?? '远处有 3 处窸窣。'] }),
];

// ─────────────────────────── 跑局、出证据 ───────────────────────────

const sha12 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

/** 期望矩阵 → 排序后的三元组列表（族｜桶｜条数），落盘与比对都用这个形状。 */
const matrix = (want: WantMatrix): Array<{ key: string; bucket: EarVerdict; n: number }> =>
  Object.entries(want)
    .flatMap(([key, row]) => EAR_VERDICTS
      .filter((b) => (row[b] ?? 0) > 0)
      .map((b) => ({ key, bucket: b, n: row[b]! })))
    .sort((a, b) => a.key.localeCompare(b.key) || a.bucket.localeCompare(b.bucket));

const outArg = process.argv[2];
const outFile = outArg
  ? resolve(outArg)
  : join(mkdtempSync(join(tmpdir(), 'ear-fixture-')), 'ear_cases.json');
mkdirSync(resolve(outFile, '..'), { recursive: true });

const fails: string[] = [];
const rows: Record<string, unknown>[] = [];
const seenCue = new Set<string>();
const seenCap = new Set<string>();
const seenBucket = new Set<EarVerdict>();
const negative: string[] = [];

for (const c of CASES) {
  const mut = findSoundMutant(c.rig);
  const caps: Capabilities = ALL_CAPS;

  // 眼睛那侧：真实 projector 的产物。夹具不手搓屏幕文本（同 recon-fixture 那条理由）。
  const session = new GameSession(c.seed, caps, mut.rig);
  const screens = [session.screen()];
  for (const a of c.actions) screens.push((await session.apply(a)).screen);
  const obs = screens.map((s) => observe(s));
  let sounds: EarSound[] = session.soundEvents();
  if (c.soundsOverride) {
    const out: EarSound[] = [];
    for (let t = 1; t <= c.actions.length; t++) {
      const real = sounds.filter((s) => s.tick === t).sort((x, y) => x.seq - y.seq).map((s) => s.text);
      c.soundsOverride(t, real).forEach((text, i) => out.push({ tick: t, seq: i + 1, text }));
    }
    sounds = out;
  }
  const facts: Facts = {
    obs, sounds, actions: c.actions,
    heard: (t, sub) => sounds.some((s) => s.tick === t && s.text.includes(sub)),
    silent: (t, sub) => !sounds.some((s) => s.tick === t && s.text.includes(sub)),
    count: (t, sub) => sounds.filter((s) => s.tick === t && s.text.includes(sub)).length,
  };

  // ── 第一道：模具自检。这一格到底摸没摸到它声称摸到的那条分支 ──
  for (const [label, ok] of c.goal) if (!ok(facts)) fails.push(`${c.id}：模具自检没过——${label} 不成立`);

  // ── 通道二：判据自己怎么说 ──
  const judged = await earFrames({ seed: c.seed, actions: c.actions, sounds, caps });

  // 第二道：落盘屏幕必须就是判据看见的那些屏幕（否则"人读的屏幕"和"判据读的屏幕"是两份）
  for (const f of judged.frames) {
    if (!f.inRange) continue;
    const mine = obs[f.tick]!;
    if (JSON.stringify(mine) !== JSON.stringify(f.next)) {
      fails.push(`${c.id}：第 ${f.tick} 帧落盘屏幕与判据读到的观测量不一致（证据与世界对不上，判决不可信）`);
      break;
    }
  }

  const got: Array<{ key: string; bucket: EarVerdict; n: number }> = [];
  for (const [key, row] of Object.entries(judged.byKey)) {
    for (const b of EAR_VERDICTS) if (row[b] > 0) got.push({ key, bucket: b, n: row[b] });
  }
  got.sort((a, b) => a.key.localeCompare(b.key) || a.bucket.localeCompare(b.bucket));

  const want = matrix(c.want);
  const key = (xs: Array<{ key: string; bucket: string; n: number }>): string =>
    xs.map((x) => `${x.key}:${x.bucket}×${x.n}`).join('｜');
  if (key(got) !== key(want)) {
    fails.push(`${c.id}：落点不同 —— 判据给 ${key(got) || '（空）'}，人工期望 ${key(want)}（${c.what}）`);
  }

  // 点名的逐条判决：帧号 + 族 + 侧 + 桶，少一条都不算过
  const claims: EarClaim[] = judged.claims;
  for (const w of c.wantAt ?? []) {
    const hit = claims.some((x) => x.tick === w.tick && x.key === w.cue && x.side === w.side && x.verdict === w.verdict);
    if (!hit) {
      fails.push(`${c.id}：点名要第 ${w.tick} 帧 ${w.cue}[${w.side}]=${w.verdict}，判据没给出这一条（${c.what}）`);
    }
  }

  for (const x of want) {
    if (x.key.startsWith('cap:')) seenCap.add(x.key);
    else seenCue.add(x.key);
    seenBucket.add(x.bucket);
  }
  const contradiction = (b: EarVerdict): number =>
    claims.filter((x) => x.verdict === b && !x.key.startsWith('cap:')).length;
  // 阴性对照的准入：声音必须是**发声层真放的**。人给声流那一格哪怕判决全绿也不算——
  // 它绿的是"我写的剧本和我写的判据一致"，不是"这个世界本来没毛病"。
  if (!c.soundsOverride
    && contradiction('矛盾') === 0 && contradiction('时钟错位') === 0 && contradiction('相符') > 0) negative.push(c.id);

  rows.push({
    id: c.id,
    what: c.what,
    provenance: c.soundsOverride
      ? 'fixture（裁判侧夹具：动作是人挑的，**耳朵那侧的声流由人给出**，眼睛那侧仍是真 projector 的屏幕，没有一句来自模型）'
      : 'fixture（裁判侧夹具：动作是人挑的，声音是人换装置放出来的，没有一句来自模型）',
    seed: c.seed,
    rig: {
      id: c.rig,
      label: mut.label,
      note: c.soundsOverride
        ? '⚠️ 这一格的声流不是这个 rig 放的（发声层原理上产不出这种形状，见 `ear_source`）；rig 只保证世界一个字节没改'
        : 'rig 只改"放不放这一声"，不改世界一个字节',
    },
    // 台账 #21 同族：**声音从哪来必须自己说出口**。不声明，别人会把"人给的两声窸窣"
    // 读成"参考版真放出来的"——那连阴性对照都能被伪造出来。
    ear_source: c.soundsOverride
      ? '人给声流（合成耳朵证据）：真实发声层一帧只放一声、数字由真状态算，产不出"数字说少了"和"同一帧响两声"'
      : '发声层真放（GameSession 的 soundEvents，未经任何人工改写）',
    caps: 'ALL_CAPS（世界能力全部开启：眼耳两通道看到的是同一个没有世界缺陷的世界）',
    actions: c.actions,
    sounds,
    frames: screens.map((screen, tick) => ({
      tick, screen, sha: sha12(screen),
      heard: sounds.filter((s) => s.tick === tick).sort((x, y) => x.seq - y.seq)
        .map((s) => ({ seq: s.seq, text: s.text })),
    })),
    goal: c.goal.map(([label]) => label),
    want,
    wantAt: c.wantAt ?? [],
    got: claims.map((x) => ({
      tick: x.tick, key: x.key, cue: x.cue, side: x.side, text: x.text,
      verdict: x.verdict, shift: x.shift, why: x.why,
    })),
    gotCounts: judged.counts,
    consistency: judged.consistency,
  });

  log(`  ${c.id.padEnd(5)} ${(c.soundsOverride ? '（人给声流）' : mut.label).padEnd(24)} 主张 ${String(claims.length).padStart(3)}｜${key(got)}`);
}

// ── 覆盖率：八个族、五个桶一个都不许少；少了就是零样本审计（#17/#22）──
const missingCue = EAR_CUES.filter((x) => !seenCue.has(x));
const missingBucket = EAR_VERDICTS.filter((x) => !seenBucket.has(x));
const missingCap = CAPACITY_ITEMS.map((x) => `cap:${x.id}`).filter((k) => !seenCap.has(k));
if (missingCue.length) fails.push(`夹具没有任何一格摸到这些族：${missingCue.join('、')}`);
if (missingBucket.length) fails.push(`夹具没有任何一格落进这些桶：${missingBucket.join('、')}`);
if (missingCap.length) fails.push(`容量差词条里有 ${missingCap.length} 条从没进过期望：${missingCap.join('、')}`);

log(`\nM4-c 眼耳夹具（判据 ${JSON.stringify(earStamp())}）：${CASES.length} 格｜族覆盖 ${EAR_CUES.length - missingCue.length}/${EAR_CUES.length}｜桶覆盖 ${EAR_VERDICTS.length - missingBucket.length}/${EAR_VERDICTS.length}｜容量差词条覆盖 ${CAPACITY_ITEMS.length - missingCap.length}/${CAPACITY_ITEMS.length}`);
log(`阴性对照（两个通道都说对、零矛盾零错位、且声音由发声层真放）：${negative.length} 格 → ${negative.join('、')}`);
const synthetic = CASES.filter((c) => c.soundsOverride).map((c) => c.id);
log(`合成耳朵（声流人给，不进阴性对照）：${synthetic.join('、')}——这两格摸的是"数字说少了"和"同一帧响两声"，真 rig 原理上产不出来`);

if (fails.length) {
  log('\n❌ 夹具失效（模具自检没过，或判据落点与人工期望不符）：');
  for (const f of fails) log(`   ${f}`);
  process.exit(1);
}

// 名单也落盘：审计会**自己重算一遍**这份阴性对照，两边不一致就是有一方认错了"没错"（#21 同族）。
writeFileSync(outFile, JSON.stringify({ ear: earStamp(), negative, cases: rows }, null, 1) + '\n');
log(`\n✅ ${CASES.length} 格夹具生成完毕，证据 → ${outFile}`);
process.stdout.write(`${outFile}\n`);
