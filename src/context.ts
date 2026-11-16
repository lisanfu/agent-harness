/**
 * 上下文管理。harness 最容易被忽略、却最决定成败的一脏。
 *
 * 原则：
 *  1. system 永不截断（它是任务与契约）
 *  2. 假设板（notes）单独常驻，不随消息被截掉——否则"我为什么在撞这扇门"会丢
 *  3. 保留最近 keepRecent 条，中间省略并「显式标注省略了多少条」
 *     显式标注很重要：让大脑知道自己失忆了，而不是以为世界本来就这样
 *  4. 预算按字符估算，不是精确 token。诚实标注为估算。
 */
import type { Message } from './types.ts';

export interface ContextBudget {
  maxContextChars: number;
  keepRecent: number;
}

export interface BuiltContext {
  messages: Message[];
  chars: number;
  dropped: number;
  /**
   * 地板（system + 最近 keepRecent 条）本身就大于预算时为 true。
   * 预算是软约束：契约和近期记忆优先于省钱。但超了必须说出来，
   * 否则使用者以为截断在生效，实际上下文一路膨胀——这种沉默的失效最难查。
   */
  overBudget: boolean;
}

export function estimateChars(messages: readonly Message[]): number {
  let n = 0;
  for (const m of messages) n += m.content.length + 16; // 16 ≈ role/结构开销
  return n;
}

export function buildContext(
  system: string,
  history: readonly Message[],
  budget: ContextBudget,
): BuiltContext {
  const sys: Message = { role: 'system', content: system };
  const sysChars = sys.content.length + 16;
  const room = Math.max(0, budget.maxContextChars - sysChars);

  // 先保证最近 keepRecent 条一定在
  const recent = history.slice(-budget.keepRecent);
  const older = history.slice(0, Math.max(0, history.length - recent.length));

  const kept: Message[] = [];
  let used = estimateChars(recent);
  // 从旧到新回填，能塞多少塞多少（保留时间顺序）
  for (let i = older.length - 1; i >= 0; i--) {
    const m = older[i]!;
    const cost = m.content.length + 16;
    if (used + cost > room) break;
    kept.unshift(m);
    used += cost;
  }

  const dropped = older.length - kept.length;
  const messages: Message[] = [sys];
  if (dropped > 0) {
    messages.push({
      role: 'system',
      content: `[上下文已截断：省略了中间 ${dropped} 条较早的消息。如需早期信息，请用工具重新读取，不要凭记忆猜测。]`,
    });
  }
  messages.push(...kept, ...recent);
  const chars = estimateChars(messages);
  return { messages, chars, dropped, overBudget: chars > budget.maxContextChars };
}