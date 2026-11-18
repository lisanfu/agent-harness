/**
 * 听觉器官（M4-c）：世界每帧发出的**声音现象流**。
 *
 * 为什么必须有第二个投影面：到这里为止，整个靶场其实只有一只眼睛——
 * 屏幕（`render`）和屏幕上的「刚才发生」（`describe`）是同一段代码产出的，
 * 拿它们互查等于用同一把尺子量两次。M4-f 的上限表报 `invisible=0`
 * （内部一旦分叉屏幕必分叉），那条结论的边界必须写清楚：**它只覆盖世界层缺陷**。
 * 真实引擎里"算"和"播"是两条代码路径（结算系统 / 渲染层 / 音频层），
 * 音频层的 bug 一个字节都不会改到画面上——只看屏幕的测试工具对这类缺陷**结构性失明**。
 * 本文件就是为了让这一类缺陷存在得出来、并且能被量出来。
 *
 * 三条纪律：
 *  1. **与 `describe()` 零共享**：这里不 import 它、不复用它的事件字符串、不读它的产物。
 *     两条投影必须各自独立地从 (prev, action, next) 推出来，否则"眼耳一致"是同义反复，
 *     对账退化成自证（台账 #15 的教训在通道侧复发）。
 *  2. **只给现象，不给因果，也不给函数名**：agent 听到的是「一声闷响，像撞上了硬物」，
 *     绝不是 `playSound('wall_bump')` 或"因为 wallBlocks 生效"。后者等于把缺陷答案念给它听（§render 铁律 3）。
 *     同理：声音**没有布局**（不说在第几格）、**没有数字**（不说掉了几点血），只有**次序与次数**——
 *     这正是它和屏幕的**容量差**，也是「无法核对」那一桶存在的理由。
 *  3. **确定性纯函数**：不读时钟、不用随机、不查能力开关的语义。
 *     同一对状态 + 同一动作 + 同一 rig ⇒ 同一条声流（逐字节）。删掉任何能力都不许让声音"移位"，
 *     所以这里一律按**画面可见的变化**分支，绝不按内部结算结果分支（见下面 pickup 那条注释）。
 *
 * ⚠️ 反向泄漏防线：`SoundEvent` 只有 `tick / seq / text` 三个字段，**没有 kind/id/类别**。
 *    落盘与送达 agent 的都是现象文本；把"这条声音属于哪个触发器"的映射放在判据侧（`ear.ts`），
 *    判据可以读文本，仪器不许替 agent 把答案标在证据里。
 */
import { DX, DY, type Action, type WorldState } from './arena.ts';

/** 一帧里的一条声音。tick = 统一时钟（与屏幕帧号同源，对齐判据靠它）。 */
export interface SoundEvent {
  tick: number;
  /** 帧内次序（声音是序列，不是集合：1 声脚步 + 1 声闷响 ≠ 反过来） */
  seq: number;
  text: string;
}

/**
 * 发声能力。参考版全开；声音侧变异体 = 关掉其中一项（或换成错误的触发）。
 * 与 `Capabilities` 分开且**互不影响**：这里是"播不播"，那里是"算不算"。
 */
export interface SoundCaps {
  footstep: boolean;
  wallBump: boolean;
  swing: boolean;
  killThud: boolean;
  hurtGrunt: boolean;
  pickupClick: boolean;
  deathThud: boolean;
  enemyFootstep: boolean;
}

export const ALL_SOUND_CAPS: SoundCaps = {
  footstep: true, wallBump: true, swing: true, killThud: true,
  hurtGrunt: true, pickupClick: true, deathThud: true, enemyFootstep: true,
};

export const SOUND_CAP_NAMES = Object.keys(ALL_SOUND_CAPS) as (keyof SoundCaps)[];

/**
 * 发声装置（rig）。`caps` 之外的两项刻意做成**行为**而不是开关：
 *  - `bumpOnMove`：正常移动也播闷响——**误报型**缺陷（触发条件写宽）。
 *    它在一个**单局、无参考版**的世界里就让耳朵说出屏幕反对的话，
 *    这正是"眼耳矛盾是独立异常源"的现成证据：不需要知道正确答案，只需要两个通道互相打架。
 *  - `shiftTicks`：整条声流挪 N 帧——**时钟错位型**缺陷（缓冲/事件队列 bug）。
 *    这是路线图 M4 那一栏预言过的故障："把上一步的声音当这一步的，大量误报"。
 *    它必须落进自己的桶，不许混进"事实矛盾"，否则判据自己就是那个 bug。
 */
export interface SoundRig {
  caps: SoundCaps;
  bumpOnMove?: boolean;
  shiftTicks?: number;
}

export const REFERENCE_RIG: SoundRig = { caps: ALL_SOUND_CAPS };

function moved(s: WorldState, p: WorldState): boolean {
  return s.player.x !== p.player.x || s.player.y !== p.player.y;
}

/** 出手是否真结算了：只按画面可见的「技能从灰到亮再回到灰」推，不读能力开关。
 *  参考版与 `attackCooldown` 变异体在这里会分叉，那是**应该**的——那是世界层的事。 */
function swung(prev: WorldState, action: Action | null): boolean {
  return action?.kind === 'attack' && prev.player.cooldown === 0;
}

function aliveOf(s: WorldState): number {
  return s.enemies.filter((e) => e.alive).length;
}

function takenCount(s: WorldState): number {
  return s.pickups.filter((p) => p.taken).length;
}

/** 敌人这一帧各自挪没挪（只数个数，位置一律不进声音）。 */
function enemiesMovedCount(prev: WorldState, next: WorldState): number {
  let n = 0;
  for (const e0 of prev.enemies) {
    if (!e0.alive) continue;
    const e1 = next.enemies.find((e) => e.id === e0.id);
    if (!e1) continue;
    if (e1.alive && (e1.x !== e0.x || e1.y !== e0.y)) n++;
  }
  return n;
}

/**
 * 一帧的声音（**未**套 rig 的时序错位）。
 *
 * 顺序写死，不许重排：位移 → 撞墙 → 挥击 → 击杀 → 受伤 → 拾取 → 敌人挪动 → 倒下。
 * 声音是序列，换了顺序就是另一段录音。
 */
export function soundFrame(prev: WorldState, action: Action | null, next: WorldState, caps: SoundCaps = ALL_SOUND_CAPS): string[] {
  const out: string[] = [];
  const dead = !prev.player.alive;

  // 倒下之后世界仍在推进（tick 会走），但玩家不再有任何动作声
  if (dead) return out;

  const isMove = action?.kind === 'move';
  const dx = isMove ? DX[(action as { dir: 0 | 1 | 2 | 3 }).dir]! : 0;
  const dy = isMove ? DY[(action as { dir: 0 | 1 | 2 | 3 }).dir]! : 0;
  const targetOut = isMove
    && (next.player.x !== prev.player.x + dx || next.player.y !== prev.player.y + dy);

  if (isMove && moved(prev, next)) {
    if (caps.footstep) out.push('一声脚步。');
  } else if (isMove && targetOut) {
    if (caps.wallBump) out.push('一声闷响，像撞上了硬物。');
  }

  if (swung(prev, action)) {
    if (caps.swing) out.push('一下破风声。');
    // 击杀声只按「画面上少了一个活的」分支——不说杀了几个、更不读 scoreOnKill
    const killed = aliveOf(prev) - aliveOf(next);
    if (killed > 0 && caps.killThud) out.push('一声短促的倒地声。');
  }

  if (next.player.hp < prev.player.hp && caps.hurtGrunt) out.push('一声闷哼。');

  if (takenCount(next) > takenCount(prev) && caps.pickupClick) {
    // ⚠️ 刻意**不**为"回血"发声：删掉 pickupHeals 时，拾取的声音必须一模一样。
    // 一发声就等于把缺陷的名字喊给 agent 听（§render 铁律 3 的同一条）。
    out.push('一声咔哒，像什么东西被拿了起来。');
  }

  const shuffled = enemiesMovedCount(prev, next);
  if (shuffled > 0 && caps.enemyFootstep) out.push(`远处有 ${shuffled} 处窸窣。`);

  if (prev.player.alive && !next.player.alive && caps.deathThud) out.push('一记沉重的倒地声。');

  return out;
}

/**
 * 帧号挪移——`shiftTicks` 的**唯一**实现处。
 * 整条流（`soundStream`）与逐帧账本（`GameSession.soundEvents`）都要挪，
 * 两处各写一份迟早漂移（台账 #13），所以只留这一个函数。
 */
export function shiftedTick(tick: number, rig: SoundRig): number {
  return Math.max(0, tick + (rig.shiftTicks ?? 0));
}

/**
 * 一帧**该播哪些句子**，rig 的行为项（`bumpOnMove`）在这里生效，时序项（`shiftTicks`）不在。
 *
 * 为什么单独暴露这一个函数：会话层（`GameSession`）是**逐帧**推进的，它没有整条状态序列，
 * 拿不到 `soundStream`。若它在自己的文件里再抄一份"帧→句子"的拼法（含 bumpOnMove 那条），
 * 就成了发声层的第二个主人，两处迟早漂移（台账 #13/#18）。
 * 所以整条流与逐帧账本**共用这一个入口**，只有帧号的挪移留在 `soundStream` 里做。
 */
export function frameSounds(prev: WorldState, action: Action | null, next: WorldState, rig: SoundRig = REFERENCE_RIG): string[] {
  const lines = soundFrame(prev, action, next, rig.caps);
  // 误报型：走得好好的也来一声闷响（触发条件写宽的真实形态）
  if (rig.bumpOnMove && action?.kind === 'move' && moved(prev, next)) lines.push('一声闷响，像撞上了硬物。');
  return lines;
}

/**
 * 整条动作序列的声流。纯函数，可反复重放（ddmin / 审计都靠这个前提）。
 *
 * `shiftTicks` 在这里生效：把第 t 帧的声音挪到 t+shift。
 * 注意它**不改内容只改帧号**——所以"内容仍然对得上、只是错位"这一族判决
 * 必须在判据侧单独成桶；把它判成事实矛盾就是判据在撒谎。
 */
export function soundStream(
  states: readonly WorldState[], actions: readonly (Action | null)[], rig: SoundRig = REFERENCE_RIG,
): SoundEvent[] {
  if (states.length !== actions.length) {
    throw new Error(`soundStream：状态数(${states.length}) 与动作数(${actions.length}) 不等——一帧状态配一个"进入该帧的动作"，首帧的动作必须是 null`);
  }
  const shift = rig.shiftTicks ?? 0;
  const out: SoundEvent[] = [];
  for (let i = 1; i < states.length; i++) {
    const lines = frameSounds(states[i - 1]!, actions[i], states[i]!, rig);
    const tick = Math.max(0, states[i]!.tick + shift);
    for (let seq = 0; seq < lines.length; seq++) out.push({ tick, seq, text: lines[seq]! });
  }
  return out;
}

/** 给 agent 的那一份：只有帧号 + 现象文本，别的一律不给。 */
export function earText(events: readonly SoundEvent[], uptoTick?: number): string {
  const rows = uptoTick === undefined ? events : events.filter((e) => e.tick <= uptoTick);
  if (!rows.length) return '（这一帧到这一帧之间，什么都没听见。）';
  const byTick = new Map<number, string[]>();
  for (const e of rows) {
    const list = byTick.get(e.tick) ?? [];
    list.push(e.text);
    byTick.set(e.tick, list);
  }
  return [...byTick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, list]) => `第 ${t} 帧：${list.join(' ')}`)
    .join('\n');
}
