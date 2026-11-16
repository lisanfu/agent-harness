/**
 * 视网膜：内部状态 → 屏幕文本。M1「眼睛」的唯一通道。
 *
 * 铁律（违反即破坏零说明书评测）：
 *  1. agent 只能拿到这里产出的文本，拿不到 WorldState。内部状态只给裁判和日志。
 *  2. **有损投影**：敌人朝向、敌人 id、敌人血量、墙表 JSON、冷却计数一律不上屏。
 *     真实屏幕也不显示这些。显示了就等于让 agent 读心。
 *  3. **能力无关**：文案只描述「做了什么 + 画面上可见的结果」，绝不描述内部因果。
 *     删掉 pickupHeals 时，文案仍是「你拾取了地上的东西」——血条没涨才是证据。
 *     如果文案变成「没什么感觉」，等于把缺陷答案念给 agent 听，评测当场作废。
 *  4. 纯函数：不读时钟、不用随机。同一状态必产出同一文本。
 *
 * 图例（@=你 E=敌人 …）属于**接口**，相当于键盘上印的字母，不是策略手册。
 * 这里绝不出现「优先探索」「注意边界值」这类话——那是答案。
 */
import { Dir, type Action, type WorldState } from './arena.ts';

const DIR_NAME = ['上', '右', '下', '左'] as const;

/** 屏幕符号。刻意不用箭头表示敌人朝向——那会泄露内部 dir 字段。 */
const SYM = { player: '@', enemy: 'E', pickup: '+', wall: '#', floor: '.' } as const;

export interface Screen {
  /** 完整屏幕文本，agent 看到的就是这个，一字不多 */
  text: string;
  /** 本帧现象描述（也是纯画面事实，不含内部因果） */
  events: string[];
}

/** 画地图。只画可见物：死掉的敌人和已拾取的物品从画面上消失。 */
function grid(s: WorldState): string[] {
  const cells: string[][] = [];
  for (let y = 0; y < s.size; y++) {
    const row: string[] = [];
    for (let x = 0; x < s.size; x++) row.push(s.walls.includes(`${x},${y}`) ? SYM.wall : SYM.floor);
    cells.push(row);
  }
  for (const it of s.pickups) if (!it.taken) cells[it.y]![it.x] = SYM.pickup;
  for (const e of s.enemies) if (e.alive) cells[e.y]![e.x] = SYM.enemy;
  // 玩家最后画，站在物品/敌人格子上时以玩家为准（和真实渲染的图层顺序一致）
  cells[s.player.y]![s.player.x] = SYM.player;

  const bar = `+${'-'.repeat(s.size)}+`;
  return [bar, ...cells.map((r) => `|${r.join('')}|`), bar];
}

/** 血条。数字 + 条形，和真实 HUD 一样。这是可观测量，不是内部字段泄露。 */
function hpBar(s: WorldState): string {
  const p = s.player;
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.round((p.hp / p.maxHp) * width)));
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${p.hp}/${p.maxHp}`;
}

/**
 * 现象描述：只从「动作 + 画面可见变化」推导，不看能力开关。
 *
 * 为什么这样设计：变异体删掉某项能力时，**文案必须一模一样**，
 * 只有血条/分数/存活这些可观测量不同。缺陷这才叫「需要自己发现」。
 */
export function describe(prev: WorldState, action: Action | null, next: WorldState): string[] {
  const out: string[] = [];
  const a = prev.player;
  const b = next.player;

  if (!a.alive) {
    out.push('你已经倒下，动作没有效果。');
    return out;
  }

  if (action) {
    if (action.kind === 'move') {
      const d = DIR_NAME[action.dir];
      if (a.x === b.x && a.y === b.y) out.push(`你朝${d}撞上了障碍，没能移动。`);
      else out.push(`你朝${d}走了一格。`);
    } else if (action.kind === 'attack') {
      // 冷却是否就绪：画面上表现为「技能灰着」，不显示剩余计数
      const ready = a.cooldown === 0;
      if (!ready) {
        out.push('你的攻击还没准备好。');
      } else {
        // ⚠️ 只按**可见几何**描述：身边有没有敌人。
        // 刻意不按"打死了几个"分支——那样 attackKills 被删时会说"什么也没打到"，
        // 可敌人明明就在身边。这既是错误的现象描述，也等于把缺陷答案念给 agent 听。
        // 击杀与否由画面（敌人消失）和分数去证明，文案必须保持中立。
        const near = prev.enemies.some(
          (e) => e.alive && Math.abs(e.x - a.x) + Math.abs(e.y - a.y) <= 1,
        );
        out.push(near ? '你朝身边的敌人挥击。' : '你挥击，但身边没有敌人。');
      }
    } else if (action.kind === 'pickup') {
      const taken = prev.pickups.filter((p) => !p.taken).length - next.pickups.filter((p) => !p.taken).length;
      // 注意：这里不说「感觉恢复了」也不说「没什么感觉」——回血与否只能从血条看
      out.push(taken > 0 ? '你拾取了地上的东西。' : '你脚下没有可拾取的东西。');
    } else {
      out.push('你原地等待。');
    }
  }

  // 敌人是否撞到你身上：这是画面可见的位置重合，不是内部伤害结算
  const touched = next.enemies.some((e) => e.alive && e.x === b.x && e.y === b.y);
  if (touched) out.push('有敌人贴到了你身上。');

  if (a.alive && !b.alive) out.push('你倒下了。');
  return out;
}

/** 渲染一帧。prev 用于推导现象；首帧传 null。 */
export function render(s: WorldState, events: readonly string[] = []): string {
  const p = s.player;
  const lines = [
    ...grid(s),
    `HP ${hpBar(s)}   分数 ${p.score}   第 ${s.tick} 帧`,
    `攻击：${p.cooldown === 0 ? '就绪' : '冷却中'}   状态：${p.alive ? '活着' : '已倒下'}`,
  ];
  if (events.length) {
    lines.push('刚才发生：');
    for (const e of events.slice(-3)) lines.push(`  - ${e}`);
  }
  lines.push(`图例：${SYM.player}=你 ${SYM.enemy}=敌人 ${SYM.pickup}=可拾取 ${SYM.wall}=墙 ${SYM.floor}=空地`);
  return lines.join('\n');
}

/** 首屏：没有「刚才发生」，只有画面。 */
export function renderInitial(s: WorldState): string {
  return render(s, []);
}

/** 方向字符串 → Dir。白名单之外一律拒绝，拒绝理由必须可行动。 */
export function parseDir(v: unknown): { ok: true; dir: (typeof Dir)[keyof typeof Dir] } | { ok: false; reason: string } {
  const map: Record<string, (typeof Dir)[keyof typeof Dir]> = {
    up: Dir.Up, right: Dir.Right, down: Dir.Down, left: Dir.Left,
  };
  const key = String(v ?? '').trim().toLowerCase();
  const d = map[key];
  if (d === undefined) {
    return { ok: false, reason: `方向 "${String(v)}" 不认识。只能用 up / right / down / left 这四个词。` };
  }
  return { ok: true, dir: d };
}