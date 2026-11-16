/**
 * 游戏会话：M1 的「手」+ 裁判侧账本。
 *
 * 三条纪律：
 *  1. **只有一只手**：动作严格串行。apply 是异步的（真实引擎就是"发输入→等下一帧"），
 *     所以必须显式排队。不排队的话两个并发 apply 会读到同一帧状态，后写的覆盖先写的，
 *     动作序列与实际轨迹错位 → 重放当场作废。这条有测试真的并发打一遍。
 *  2. **逐帧哈希落盘**：M3 实测 15 例掩蔽（中途分叉、终态又相同），
 *     只存最终状态会系统性漏检。所以每帧都记 hash。
 *  3. **内部状态只给裁判和日志**：`internalState()` 刻意不出现在任何工具的输出里。
 *     agent 拿到的只有 `screen()`。覆盖统计同理——它是给我们看的诊断，不是给 agent 的提示。
 */
import {
  ALL_CAPS, DX, DY, createWorld, situationHash, step, worldHash,
  type Action, type Capabilities, type WorldState,
} from './arena.ts';
import { describe, render, renderInitial } from './render.ts';

export interface ApplyResult {
  /** 动作后的屏幕文本。agent 唯一能看到的东西 */
  screen: string;
  events: string[];
  tick: number;
  hash: string;
}

export interface Frame {
  tick: number;
  /** null = 初始帧 */
  action: Action | null;
  hash: string;
  events: string[];
}

/**
 * 状态覆盖账本。M3 的硬约束：「必须记录状态覆盖，而不只是步数」。
 *
 * 为什么这些字段：M07（血量归零不死亡）80 步检出率只有 4.2%，
 * 因为它要求 hp 恰好到 0。有了 hpZeroReached 这种字段，
 * 就能直接回答"没检出是因为没走到，还是因为公证器不行"。
 *
 * 全部由代码从内部状态算出，**绝不返回给 agent**（那等于开卷考试）。
 */
export interface Coverage {
  ticks: number;
  /** 走到过多少不同格子（地图共 size² 格） */
  cellsVisited: number;
  cellsTotal: number;
  /** 见过哪些血量值。M07 的前提是这里出现 0 */
  hpSeen: number[];
  hpZeroReached: boolean;
  hpBelowZeroReached: boolean;
  hpAboveMaxReached: boolean;
  died: boolean;
  /** 与敌人相邻过（攻击的前提） */
  adjacentEnemyReached: boolean;
  /** 在相邻有敌人时挥过击（attackKills / scoreOnKill 的前提）。
   *  与 adjacentEnemyReached 分开：站得近不等于出手过，缺陷版里正是"出手了但没杀死"。 */
  attackedWhileAdjacent: boolean;
  /** 被敌人贴身过（接触伤害的前提） */
  touchedByEnemy: boolean;
  /** 站在拾取物上（拾取的前提） */
  stoodOnPickup: boolean;
  /** 满血时站在拾取物上（hpClamp / pickupHeals 的前提） */
  pickupAtFullHp: boolean;
  pickupsTaken: number;
  kills: number;
  /** 冷却中仍尝试攻击（attackCooldown 的前提） */
  attacksWhileCooldown: number;
  /** 尝试撞墙 / 撞边界（wallBlocks 的前提，无论是否真被挡） */
  wallAttempts: number;
  boundaryAttempts: number;
}

function emptyCoverage(size: number): Coverage {
  return {
    ticks: 0, cellsVisited: 0, cellsTotal: size * size, hpSeen: [],
    hpZeroReached: false, hpBelowZeroReached: false, hpAboveMaxReached: false, died: false,
    adjacentEnemyReached: false, attackedWhileAdjacent: false, touchedByEnemy: false, stoodOnPickup: false, pickupAtFullHp: false,
    pickupsTaken: 0, kills: 0, attacksWhileCooldown: 0, wallAttempts: 0, boundaryAttempts: 0,
  };
}

export class GameSession {
  readonly seed: number;
  readonly caps: Capabilities;
  private state: WorldState;
  private readonly frameLog: Frame[] = [];
  private readonly actions: Action[] = [];
  private readonly visited = new Set<string>();
  private readonly hpSeen = new Set<number>();
  private readonly cov: Coverage;
  /** 串行队列：这就是「只有一只手」的实现 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(seed: number, caps: Capabilities = ALL_CAPS) {
    this.seed = seed;
    this.caps = caps;
    this.state = createWorld(seed);
    this.cov = emptyCoverage(this.state.size);
    const h = worldHash(this.state);
    this.frameLog.push({ tick: 0, action: null, hash: h, events: [] });
    this.observe(this.state, null);
  }

  /** 初始屏。重放三要素里的「初始状态」以此哈希为准。 */
  initialHash(): string {
    return this.frameLog[0]!.hash;
  }

  screen(): string {
    const last = this.frameLog[this.frameLog.length - 1]!;
    return this.state.tick === 0 ? renderInitial(this.state) : render(this.state, last.events);
  }

  /**
   * 执行一个动作。严格串行：即使调用方并发打进来，也按到达顺序一帧一帧推进。
   * 排队而不是加锁拒绝，因为"手"该把动作做完，而不是把并发调用丢掉。
   */
  apply(action: Action): Promise<ApplyResult> {
    const run = this.queue.then(() => this.applyNow(action));
    // 一次失败不该卡死整条队列（否则后面所有动作都永远 pending）
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async applyNow(action: Action): Promise<ApplyResult> {
    // 帧边界。真实引擎是异步的：发出输入，等下一帧回来。
    // 这个 await 点正是「不排队就会丢更新」的原因，别删。
    await Promise.resolve();

    const prev = this.state;
    this.preObserve(prev, action);
    const next = step(prev, action, this.caps, this.seed);
    const events = describe(prev, action, next);
    this.state = next;
    this.actions.push(action);
    const hash = worldHash(next);
    this.frameLog.push({ tick: next.tick, action, hash, events });
    this.observe(next, prev);
    return { screen: render(next, events), events, tick: next.tick, hash };
  }

  /** 动作前的意图统计：撞墙/撞边界/冷却中攻击，这些只有看意图才知道 */
  private preObserve(s: WorldState, action: Action): void {
    if (!s.player.alive) return;
    if (action.kind === 'move') {
      const nx = s.player.x + DX[action.dir]!;
      const ny = s.player.y + DY[action.dir]!;
      const out = nx < 0 || ny < 0 || nx >= s.size || ny >= s.size;
      if (out) this.cov.boundaryAttempts++;
      else if (s.walls.includes(`${nx},${ny}`)) this.cov.wallAttempts++;
    } else if (action.kind === 'attack' && s.player.cooldown > 0) {
      this.cov.attacksWhileCooldown++;
    } else if (action.kind === 'attack') {
      // 相邻判定用曼哈顿距离 ≤1，与 arena.step() 里攻击命中的几何完全同一口径，
      // 两处各写一套迟早漂移（故障 #13 的教训：一个判据只能有一个主人）。
      // 冷却中的攻击走不到这里（上面那条分支先截了）——那一下根本没结算，谈不上击杀前提。
      const near = s.enemies.some(
        (e) => e.alive && Math.abs(e.x - s.player.x) + Math.abs(e.y - s.player.y) <= 1,
      );
      if (near) this.cov.attackedWhileAdjacent = true;
    } else if (action.kind === 'pickup') {
      const on = s.pickups.some((p) => !p.taken && p.x === s.player.x && p.y === s.player.y);
      if (on) {
        this.cov.stoodOnPickup = true;
        if (s.player.hp >= s.player.maxHp) this.cov.pickupAtFullHp = true;
      }
    }
  }

  /** 动作后的状态统计 */
  private observe(s: WorldState, prev: WorldState | null): void {
    const p = s.player;
    this.visited.add(`${p.x},${p.y}`);
    this.hpSeen.add(p.hp);
    this.cov.ticks = s.tick;
    this.cov.cellsVisited = this.visited.size;
    this.cov.hpSeen = [...this.hpSeen].sort((a, b) => a - b);
    if (p.hp <= 0) this.cov.hpZeroReached = true;
    if (p.hp < 0) this.cov.hpBelowZeroReached = true;
    if (p.hp > p.maxHp) this.cov.hpAboveMaxReached = true;
    if (!p.alive) this.cov.died = true;
    if (s.enemies.some((e) => e.alive && Math.abs(e.x - p.x) + Math.abs(e.y - p.y) <= 1)) {
      this.cov.adjacentEnemyReached = true;
    }
    if (s.enemies.some((e) => e.alive && e.x === p.x && e.y === p.y)) this.cov.touchedByEnemy = true;
    this.cov.pickupsTaken = s.pickups.filter((x) => x.taken).length;
    if (prev) {
      const before = prev.enemies.filter((e) => e.alive).length;
      const after = s.enemies.filter((e) => e.alive).length;
      if (after < before) this.cov.kills += before - after;
    }
  }

  /** 覆盖账本。给裁判/日志/实验报告，**不给 agent**。 */
  coverage(): Coverage {
    return { ...this.cov, hpSeen: [...this.cov.hpSeen] };
  }

  /** 逐帧账本。M3 证明只存终态会漏检掩蔽缺陷，所以每帧都留。 */
  frames(): readonly Frame[] {
    return this.frameLog;
  }

  /** 纯动作序列：可脱离 harness 独立重放的那份证物 */
  actionSequence(): Action[] {
    return [...this.actions];
  }

  stateHash(): string {
    return worldHash(this.state);
  }

  /**
   * 局势指纹（不含 tick）。给死循环检测用，判"这一步有没有进展"。
   * 与 stateHash() 刻意分开：帧哈希含 tick 永远在变，拿它判循环会永远判不出。
   */
  situationHash(): string {
    return situationHash(this.state);
  }

  /**
   * 内部状态。**只给裁判和日志**。
   * 刻意不在任何 Tool 里调用它——眼睛不准读心，这是零说明书评测的前提。
   */
  internalState(): WorldState {
    return this.state;
  }
}