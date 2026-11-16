/**
 * 确定性竞技场世界 —— M3 差分公证器的底物（M2 的一个切片）。
 *
 * 为什么 M3 需要先造世界：差分公证器要比对"参考版 vs 变异版"，
 * 没有可重放的世界就无从比对。所以这里顺手把 M2 的核心纪律落地。
 *
 * 五条确定性纪律（违反任何一条，后面所有结论作废）：
 *  1. 只用整数。浮点会跨平台累积末位差。
 *  2. 世界层禁读时钟。时间就是 tick，由外部固定步长推进。
 *  3. 禁 Math.random。随机一律走下面的 rand01(seed, tick, salt)。
 *  4. 系统执行顺序固定，写死在 step() 里，不许重排。
 *  5. step() 是纯函数：不改入参，返回新状态。ddmin 要反复重跑，改入参会污染。
 *
 * ⚠️ 关键设计：为什么用「计数式随机」而不是 createRng 的有状态流？
 *   有状态流：rand() 每调一次推进一次。变异体若跳过某个系统（比如敌人不再巡逻），
 *   该系统的 rand() 调用就消失了 → 后续所有随机数错位 → 产生**与缺陷无关的假分叉**。
 *   计数式：rand01(seed, tick, salt) 是纯函数，只依赖 (种子, 第几帧, 哪个实体)。
 *   删掉任何系统都不会让别的实体的随机数移位。
 *   这是确定性仿真里真实存在的坑（帧同步游戏的经典问题），不是假想。
 */
import { hashState } from '../rng.ts';

export const Dir = { Up: 0, Right: 1, Down: 2, Left: 3 } as const;
export type DirValue = (typeof Dir)[keyof typeof Dir];

export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

export type Action =
  | { kind: 'move'; dir: DirValue }
  | { kind: 'attack' }
  | { kind: 'pickup' }
  | { kind: 'wait' };

export interface Player {
  x: number; y: number;
  hp: number; maxHp: number;
  cooldown: number;
  score: number;
  alive: boolean;
}

export interface Enemy { id: number; x: number; y: number; hp: number; alive: boolean; dir: DirValue }
export interface Pickup { id: number; x: number; y: number; taken: boolean }

export interface WorldState {
  tick: number;
  size: number;
  /** 墙，存 "x,y" 且排序，保证 canonical 稳定 */
  walls: string[];
  player: Player;
  enemies: Enemy[];
  pickups: Pickup[];
}

/**
 * 能力清单。参考版全开；变异体 = 关掉其中一项（语义变异：删掉一个必需能力）。
 * 用开关而不是改代码，是为了让"缺陷位置"可精确标注，便于度量定位精度。
 * 局限：这是语义变异的**模拟**，真正的代码级变异（StrykerJS 那种）是下一步。
 */
export interface Capabilities {
  wallBlocks: boolean;      // 墙挡住移动
  enemyPatrol: boolean;     // 敌人每帧巡逻
  contactDamage: boolean;   // 接触敌人扣血
  attackKills: boolean;     // 攻击杀死相邻敌人
  attackCooldown: boolean;  // 攻击有冷却
  pickupHeals: boolean;     // 拾取回血
  deathAtZeroHp: boolean;   // 血量归零死亡
  scoreOnKill: boolean;     // 击杀计分
  hpClamp: boolean;         // 血量夹在 [0, maxHp]
}

export const ALL_CAPS: Capabilities = {
  wallBlocks: true, enemyPatrol: true, contactDamage: true,
  attackKills: true, attackCooldown: true, pickupHeals: true,
  deathAtZeroHp: true, scoreOnKill: true, hpClamp: true,
};

export const CAP_NAMES = Object.keys(ALL_CAPS) as (keyof Capabilities)[];

/** 计数式随机：纯函数，无流状态。见文件头的设计说明。 */
function mix32(a: number): number {
  a = a >>> 0;
  a ^= a >>> 16; a = Math.imul(a, 0x7feb352d);
  a ^= a >>> 15; a = Math.imul(a, 0x846ca68b);
  a ^= a >>> 16;
  return a >>> 0;
}

export function rand01(seed: number, tick: number, salt: number): number {
  const h = mix32((seed >>> 0) ^ Math.imul(tick + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b));
  return h / 4294967296;
}

export function randInt(seed: number, tick: number, salt: number, n: number): number {
  return Math.floor(rand01(seed, tick, salt) * n) % n;
}

const SIZE = 8;
const ENEMY_COUNT = 3;
const PICKUP_COUNT = 3;
const CONTACT_DMG = 2;
const HEAL_AMOUNT = 3;
const COOLDOWN_TICKS = 3;

export function createWorld(seed: number): WorldState {
  const walls: string[] = [];
  // 墙由种子决定，但同一 seed 必然同一张图
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x === 0 && y === 0) continue;              // 出生点留空
      if (rand01(seed, 0, 1000 + y * SIZE + x) < 0.14) walls.push(`${x},${y}`);
    }
  }
  walls.sort();
  const wallSet = new Set(walls);

  const freeCells: { x: number; y: number }[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!wallSet.has(`${x},${y}`) && !(x === 0 && y === 0)) freeCells.push({ x, y });
    }
  }
  // 用计数式随机挑不重复的格子
  const picked: { x: number; y: number }[] = [];
  const used = new Set<number>();
  let salt = 0;
  while (picked.length < ENEMY_COUNT + PICKUP_COUNT && picked.length < freeCells.length) {
    const i = randInt(seed, 0, 5000 + salt, freeCells.length);
    salt++;
    if (used.has(i)) continue;
    used.add(i);
    picked.push(freeCells[i]!);
  }

  const enemies: Enemy[] = [];
  const pickups: Pickup[] = [];
  for (let i = 0; i < ENEMY_COUNT; i++) {
    const c = picked[i];
    if (!c) break;
    enemies.push({ id: i, x: c.x, y: c.y, hp: 1, alive: true, dir: randInt(seed, 0, 7000 + i, 4) as DirValue });
  }
  for (let i = 0; i < PICKUP_COUNT; i++) {
    const c = picked[ENEMY_COUNT + i];
    if (!c) break;
    pickups.push({ id: i, x: c.x, y: c.y, taken: false });
  }

  return {
    tick: 0, size: SIZE, walls,
    player: { x: 0, y: 0, hp: 10, maxHp: 10, cooldown: 0, score: 0, alive: true },
    enemies, pickups,
  };
}

function isWall(s: WorldState, x: number, y: number): boolean {
  return s.walls.includes(`${x},${y}`);
}
function inBounds(s: WorldState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < s.size && y < s.size;
}
function blocked(s: WorldState, caps: Capabilities, x: number, y: number): boolean {
  if (!inBounds(s, x, y)) return true;                 // 边界永远挡，这不是能力
  return caps.wallBlocks && isWall(s, x, y);
}

/** 深拷贝：step 必须纯，ddmin 会反复重跑同一前缀 */
function clone(s: WorldState): WorldState {
  return {
    tick: s.tick, size: s.size, walls: [...s.walls],
    player: { ...s.player },
    enemies: s.enemies.map((e) => ({ ...e })),
    pickups: s.pickups.map((p) => ({ ...p })),
  };
}

/**
 * 一帧。系统顺序写死，不许重排：
 *   1 输入 → 2 冷却衰减 → 3 敌人巡逻 → 4 接触伤害 → 5 血量夹取 → 6 死亡判定 → 7 tick++
 * 顺序本身就是规则的一部分。换了顺序就是另一个世界。
 */
export function step(prev: WorldState, action: Action, caps: Capabilities, seed: number): WorldState {
  const s = clone(prev);
  const p = s.player;
  const tick = s.tick;

  // ── 1 输入（死亡后所有动作一律无效，这是规则不是能力）──
  if (p.alive) {
    if (action.kind === 'move') {
      const nx = p.x + DX[action.dir]!;
      const ny = p.y + DY[action.dir]!;
      if (!blocked(s, caps, nx, ny)) { p.x = nx; p.y = ny; }
    } else if (action.kind === 'attack') {
      const ready = !caps.attackCooldown || p.cooldown === 0;
      if (ready) {
        if (caps.attackCooldown) p.cooldown = COOLDOWN_TICKS;
        if (caps.attackKills) {
          for (const e of s.enemies) {
            if (!e.alive) continue;
            const dist = Math.abs(e.x - p.x) + Math.abs(e.y - p.y);
            if (dist <= 1) {
              e.hp -= 1;
              if (e.hp <= 0) { e.alive = false; if (caps.scoreOnKill) p.score += 1; }
            }
          }
        }
      }
    } else if (action.kind === 'pickup') {
      for (const it of s.pickups) {
        if (it.taken || it.x !== p.x || it.y !== p.y) continue;
        it.taken = true;
        if (caps.pickupHeals) p.hp += HEAL_AMOUNT;
      }
    }
    // wait: 什么都不做
  }

  // ── 2 冷却衰减 ──
  if (p.cooldown > 0) p.cooldown -= 1;

  // ── 3 敌人巡逻 ──
  if (caps.enemyPatrol) {
    for (const e of s.enemies) {
      if (!e.alive) continue;
      const nx = e.x + DX[e.dir]!;
      const ny = e.y + DY[e.dir]!;
      if (blocked(s, caps, nx, ny)) {
        // 撞墙换向：用计数式随机，删掉别的系统不会让这里移位
        e.dir = randInt(seed, tick, 9000 + e.id, 4) as DirValue;
      } else {
        e.x = nx; e.y = ny;
      }
    }
  }

  // ── 4 接触伤害 ──
  if (caps.contactDamage && p.alive) {
    for (const e of s.enemies) {
      if (e.alive && e.x === p.x && e.y === p.y) p.hp -= CONTACT_DMG;
    }
  }

  // ── 5 血量夹取 ──
  if (caps.hpClamp) {
    if (p.hp > p.maxHp) p.hp = p.maxHp;
    if (p.hp < 0) p.hp = 0;
  }

  // ── 6 死亡判定 ──
  if (caps.deathAtZeroHp && p.hp <= 0) p.alive = false;

  // ── 7 推进时间 ──
  s.tick = tick + 1;
  return s;
}

export function worldHash(s: WorldState): string {
  return hashState(s);
}

/**
 * 局势指纹：**不含 tick** 的世界哈希。
 *
 * 为什么必须有第二个哈希（真跑三局换来的教训）：
 *   worldHash 含 tick，而 tick 每帧自增 —— 帧哈希永远不同。
 *   死循环检测若拿它判"状态没变"，就永远判不出循环（检测彻底失效）；
 *   若只比动作签名（旧行为），又会把"直线走图"误判成死循环：
 *   真模型三局全被砍在 7~12 步，而玩家其实每步都在前进
 *   (4,2)→(5,2)→(6,2)→(7,2)。后果是 agent 从没机会调 finish，
 *   M07 也永远走不到 hp=0，公证器报"未分叉"——**harness 自己造成的假阴性**。
 *
 * 两个哈希各司其职，不能互相替代：
 *   worldHash      帧身份，含 tick，用于重放逐位比对（M3 公证器）
 *   situationHash  局势身份，不含 tick，用于"这一步有没有进展"（死循环检测）
 *
 * 前端类比：Redux 里同一个 action type 连续 dispatch 不算死循环，
 * 只要 state 在变就是正常推进；死循环是 state → 同一个 state。
 * tick 相当于 Date.now()，它不该参与"局面是否相同"的判断。
 */
export function situationHash(s: WorldState): string {
  const { tick: _tick, ...rest } = s;
  return hashState(rest);
}

/** 跑一整条动作序列，返回每帧状态与哈希。纯函数，可反复重跑。 */
export function runSequence(
  seed: number, actions: readonly Action[], caps: Capabilities,
): { states: WorldState[]; hashes: string[] } {
  let s = createWorld(seed);
  const states: WorldState[] = [s];
  const hashes: string[] = [worldHash(s)];
  for (const a of actions) {
    s = step(s, a, caps, seed);
    states.push(s);
    hashes.push(worldHash(s));
  }
  return { states, hashes };
}

/** 生成一条动作序列（实验用）。同样走计数式随机，可复现。 */
export function randomActions(seed: number, salt: number, n: number): Action[] {
  const out: Action[] = [];
  for (let i = 0; i < n; i++) {
    const r = randInt(seed, i, 30000 + salt, 10);
    if (r < 5) out.push({ kind: 'move', dir: (r % 4) as DirValue });
    else if (r < 7) out.push({ kind: 'attack' });
    else if (r < 9) out.push({ kind: 'pickup' });
    else out.push({ kind: 'wait' });
  }
  return out;
}