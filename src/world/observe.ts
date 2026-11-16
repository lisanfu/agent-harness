/**
 * 观察提取器：屏幕文本 → 可观测量。M4 预测-对照的「对照基准」。
 *
 * 铁律（和 render.ts 是一对）：
 *  1. **只吃屏幕文本，绝不读 WorldState**。render 是「状态→文本」的有损投影，
 *     这里是「文本→观测量」的逆投影。两者都只经过屏幕这条唯一通道。
 *     如果这里直接读内部状态，预测-对照就变成「拿答案对答案」，
 *     agent 的空间推理错误（M1 实测自报坐标越界 19 次）永远暴露不出来。
 *  2. 纯函数：不读时钟、不用随机。同一文本必产出同一观测量。
 *  3. **解析不出来就给 null，不抛错、不猜**。屏幕是 agent 唯一的信息源，
 *     某一行缺失时应当记「无法核对」，而不是崩掉整局或伪造一个值。
 *     「无法核对」≠「预测被违反」——这个区分在 predict.ts 里兑现。
 *  4. 不解释语义：这里只提取「画面上有什么」，不推断「为什么」。
 */

export interface Observation {
  /** 地图边长（格子数）。解析不到为 null */
  size: number | null;
  /** 玩家坐标 [x, y]，从 '@' 在网格里的位置数出来 */
  player: [number, number] | null;
  /** 活敌人坐标，按 (y,x) 排序，保证可比对 */
  enemies: [number, number][];
  /** 未拾取物品坐标，按 (y,x) 排序 */
  pickups: [number, number][];
  /** 墙坐标，按 (y,x) 排序 */
  walls: [number, number][];
  hp: number | null;
  maxHp: number | null;
  score: number | null;
  tick: number | null;
  /** 攻击是否就绪（画面上是「就绪/冷却中」，不是剩余计数） */
  attackReady: boolean | null;
  alive: boolean | null;
  /** 「刚才发生」里的现象描述原文 */
  events: string[];
}

const sortXY = (a: [number, number], b: [number, number]) => (a[1] - b[1]) || (a[0] - b[0]);

/** 从屏幕文本提取观测量。任何字段解析失败都给 null / 空数组，绝不抛错。 */
export function observe(screen: string): Observation {
  const lines = String(screen ?? '').split('\n');

  // ── 网格：'|' 开头 '|' 结尾的行，按出现顺序即 y=0..size-1 ──
  const rows: string[] = [];
  for (const l of lines) {
    if (l.length >= 2 && l.startsWith('|') && l.endsWith('|')) rows.push(l.slice(1, -1));
  }
  const size = rows.length > 0 && rows.every((r) => r.length === rows[0]!.length) ? rows[0]!.length : null;

  const find = (sym: string): [number, number][] => {
    const out: [number, number][] = [];
    rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) if (r[x] === sym) out.push([x, y]);
    });
    return out.sort(sortXY);
  };

  const players = find('@');
  const player: [number, number] | null = players.length === 1 ? players[0]! : null;

  // ── HUD：HP [##########] 10/10   分数 0   第 0 帧 ──
  const hud = lines.find((l) => l.startsWith('HP ')) ?? '';
  const hpMatch = /HP\s+\[[#-]*\]\s+(-?\d+)\/(-?\d+)/.exec(hud);
  const scoreMatch = /分数\s+(-?\d+)/.exec(hud);
  const tickMatch = /第\s+(-?\d+)\s+帧/.exec(hud);

  // ── 状态行：攻击：就绪   状态：活着 ──
  const st = lines.find((l) => l.startsWith('攻击：')) ?? '';
  const atkMatch = /攻击：(就绪|冷却中)/.exec(st);
  const aliveMatch = /状态：(活着|已倒下)/.exec(st);

  // ── 现象：「刚才发生：」之后、以 '  - ' 开头的行 ──
  const events: string[] = [];
  let inEvents = false;
  for (const l of lines) {
    if (l.trim() === '刚才发生：') { inEvents = true; continue; }
    if (inEvents) {
      if (l.startsWith('  - ')) events.push(l.slice(4));
      else if (l.trim() !== '') inEvents = false;
    }
  }

  return {
    size,
    player,
    enemies: find('E'),
    pickups: find('+'),
    walls: find('#'),
    hp: hpMatch ? Number(hpMatch[1]) : null,
    maxHp: hpMatch ? Number(hpMatch[2]) : null,
    score: scoreMatch ? Number(scoreMatch[1]) : null,
    tick: tickMatch ? Number(tickMatch[1]) : null,
    attackReady: atkMatch ? atkMatch[1] === '就绪' : null,
    alive: aliveMatch ? aliveMatch[1] === '活着' : null,
    events,
  };
}