/**
 * ⚠️ 测试替身（TEST DOUBLE），不是大脑。
 *
 * 它按预写脚本吐决策，没有任何智能。唯一用途是单元测试 harness 的机械部分：
 * 停止条件、死循环检测、解析回炉、证据完整性。
 *
 * 严禁把它当作"离线兜底大脑"用在真实运行里——那正是被明确否决的
 * "启发式冒充模型决策"。所以默认禁止在 CLI 里使用，必须显式 --i-know-mock-is-not-a-brain。
 */
import { ErrCode, HarnessError } from '../errors.ts';
import type { Brain, Decision, DecideRequest } from '../types.ts';

export class MockBrain implements Brain {
  readonly id = 'mock:TEST-DOUBLE';
  private i = 0;
  private readonly script: (Decision | string)[];

  constructor(script: (Decision | string)[]) {
    this.script = script;
  }

  decide(_req: DecideRequest): Promise<Decision> {
    const item = this.script[this.i++];
    if (item === undefined) {
      return Promise.resolve({
        thought: '脚本耗尽，收尾',
        call: { name: 'finish', args: { summary: 'mock 脚本耗尽' } },
      });
    }
    if (typeof item === 'string') {
      // 故意返回坏输出，用来测试解析回炉路径
      throw new HarnessError(ErrCode.BRAIN_PARSE, `mock 故意输出不可解析内容：${item}`, { raw: item });
    }
    return Promise.resolve(item);
  }
}