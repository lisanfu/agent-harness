/**
 * 游戏工具：M1 的「眼睛」和「手」暴露给大脑的唯一接口。
 *
 * 设计纪律：
 *  1. **Tool 接口一字不改**。session 用闭包持有，不往 ToolContext 里塞游戏字段——
 *     否则文件工具和 game 工具会共用一个越来越胖的上下文，器官边界就糊了。
 *  2. **描述只给接口，不给策略**。"朝一个方向走一格，dir 只能是 up/right/down/left"
 *     相当于键盘上印的字母。绝不写"优先探索未访问区域""注意边界值"——那是答案，
 *     给了就等于开卷考试，测出来的"发现缺陷能力"是假的。有测试守这条界线。
 *  3. **区分「工具失败」与「游戏语义」**。朝墙走不是工具错误，是一次合法动作 +
 *     可见后果（你没动）。把它报成 E_TOOL_ARGS 会让大脑以为参数写错了，从而乱改参数。
 *     只有方向词不认识才是真的参数错误。
 *  4. **拒绝理由必须可行动**（ACI 那一课）：不说 "invalid"，说"只能用这四个词"。
 *  5. 每个动作工具都回传新屏幕。人玩游戏就是"按一下→看一眼"，不该逼它额外调 look。
 */
import { ErrCode, readable } from '../errors.ts';
import type { Tool, ToolResult } from '../types.ts';
import type { Action } from '../world/arena.ts';
import { parseDir } from '../world/render.ts';
import type { ApplyResult, GameSession } from '../world/session.ts';
import { finish, note } from './builtin.ts';

function acted(r: ApplyResult): ToolResult {
  return { ok: true, output: r.screen };
}

/**
 * 工厂：产出的每个工具都用闭包绑定**这一个** session。
 *
 * 刻意不用模块级变量承接 session：那是可变单例，同进程跑参考版 + 变异版对照时
 * 后建的会覆盖先建的，两个世界串台，差分结论直接作废。闭包没有这个问题。
 */
export function gameTools(session: GameSession): Tool[] {
  const look: Tool = {
    name: 'look',
    description: '看一眼当前屏幕：地图、你的血量与分数、刚才发生的事。不消耗游戏时间。',
    params: {},
    run(): ToolResult {
      return { ok: true, output: session.screen() };
    },
  };

  const move: Tool = {
    name: 'move',
    description: '朝一个方向走一格。dir 只能是 up / right / down / left 之一。',
    params: { dir: { type: 'string', description: '方向：up / right / down / left', required: true } },
    async run(args): Promise<ToolResult> {
      const d = parseDir(args['dir']);
      if (!d.ok) return readable(ErrCode.TOOL_ARGS, d.reason);
      return acted(await session.apply({ kind: 'move', dir: d.dir }));
    },
  };

  const attack: Tool = {
    name: 'attack',
    description: '挥击一次，打紧邻你上下左右四格的敌人。',
    params: {},
    async run(): Promise<ToolResult> {
      return acted(await session.apply({ kind: 'attack' }));
    },
  };

  const pickup: Tool = {
    name: 'pickup',
    description: '拾取你脚下这一格上的东西。',
    params: {},
    async run(): Promise<ToolResult> {
      return acted(await session.apply({ kind: 'pickup' }));
    },
  };

  const wait: Tool = {
    name: 'wait',
    description: '原地不动，让时间推进一帧。',
    params: {},
    async run(): Promise<ToolResult> {
      return acted(await session.apply({ kind: 'wait' }));
    },
  };

  // note / finish 直接复用文件版：假设板与收手是通用器官，不该为游戏重造一份
  return [look, move, attack, pickup, wait, note, finish];
}

/** 工具名 → 世界动作。用于从 agent 的动作序列里滤出可重放的那部分。 */
export const WORLD_TOOL_NAMES = ['move', 'attack', 'pickup', 'wait'] as const;

export function isWorldTool(name: string): boolean {
  return (WORLD_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 把 harness 的 ToolCall 序列翻译成世界动作序列。
 * look / note / finish 不推进游戏时间，必须滤掉——否则重放会多出帧，哈希全错。
 * 方向词非法的那一步也滤掉：它当时被工具层拒绝了，世界里根本没发生。
 */
export function toWorldActions(calls: readonly { name: string; args: Record<string, unknown> }[]): Action[] {
  const out: Action[] = [];
  for (const c of calls) {
    if (c.name === 'move') {
      const d = parseDir(c.args['dir']);
      if (d.ok) out.push({ kind: 'move', dir: d.dir });
    } else if (c.name === 'attack') out.push({ kind: 'attack' });
    else if (c.name === 'pickup') out.push({ kind: 'pickup' });
    else if (c.name === 'wait') out.push({ kind: 'wait' });
  }
  return out;
}