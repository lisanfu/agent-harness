/**
 * 差分公证器 + ddmin 测试。
 *
 * 这里的断言分两类，刻意分开：
 *  A. 机制正确性（diffFields 路径、前置检查真的会拦、runToEnd 语义）
 *  B. **方法论的负面结论**——掩蔽会漏检、首分叉字段≠缺陷位置、ddmin 非单调。
 *
 * B 类用的种子/长度全部是实验探针实测出来后硬编码的夹具，不是测试里现场搜索。
 * 理由：现场搜索既慢又会随实现漂移，把"结论"变成"每次重新发现"，回归就失去意义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CAPS, randomActions, type Action } from '../src/world/arena.ts';
import { ALL_MUTANTS, findMutant } from '../src/world/mutants.ts';
import {
  checkDeterminism, diffFields, finalStateOnly, runDifferential,
} from '../src/notary/diff.ts';
import { minimize } from '../src/notary/ddmin.ts';
import { ErrCode, HarnessError } from '../src/errors.ts';

const STRUCTURAL = /^(walls|size|tick)(\[|\.|$)/;

// ───────────────────── A. 机制正确性 ─────────────────────

test('diffFields 产出可读路径：player.hp / enemies[1].x', () => {
  const a = { player: { hp: 10, x: 0 }, enemies: [{ x: 1 }, { x: 2 }] };
  const b = { player: { hp: 8, x: 0 }, enemies: [{ x: 1 }, { x: 5 }] };
  const d = diffFields(a, b);
  assert.deepEqual(d.map((f) => f.path).sort(), ['enemies[1].x', 'player.hp']);
  assert.deepEqual(d.find((f) => f.path === 'player.hp'), { path: 'player.hp', ref: 10, mut: 8 });
});

test('diffFields 对象键序无关、数组顺序敏感（与 canonical 哈希同一套纪律）', () => {
  assert.deepEqual(diffFields({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  assert.equal(diffFields([1, 2], [2, 1]).length, 2);
});

test('diffFields 处理长度不等、缺键、根标量', () => {
  assert.deepEqual(diffFields([1], [1, 2]).map((f) => f.path), ['[1]']);
  assert.deepEqual(diffFields({ a: 1 }, {}).map((f) => f.path), ['a']);
  assert.deepEqual(diffFields(1, 2), [{ path: '(root)', ref: 1, mut: 2 }]);
  assert.deepEqual(diffFields(null, null), []);
});

test('checkDeterminism：多种子多序列逐帧一致', () => {
  for (const seed of [1, 2, 7, 42]) {
    for (const salt of [0, 3]) {
      assert.equal(checkDeterminism(seed, randomActions(seed, salt, 50)), true);
    }
  }
});

test('确定性前置检查失败必须抛 E_CONFIG，而不是报出一个假缺陷', () => {
  // 注入一个"世界不确定"的探针。这条分支以前从未被执行过——
  // 和 errors.ts 里"捕不到的 TimeoutError"同一个坑，现在真跑一遍。
  assert.throws(
    () => runDifferential(1, randomActions(1, 0, 10), findMutant('M02').caps, {
      determinismProbe: () => false,
    }),
    (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.code, ErrCode.CONFIG);
      assert.match(e.message, /确定性前置检查失败/);
      assert.match(e.message, /Math\.random|时钟/, '拒绝理由必须可行动：告诉人去哪儿查');
      return true;
    },
  );
});

test('verifyDeterminism:false 时探针不被调用（批量实验省时间的开关真的有效）', () => {
  let called = 0;
  const r = runDifferential(1, randomActions(1, 0, 10), findMutant('M02').caps, {
    verifyDeterminism: false,
    determinismProbe: () => { called++; return false; },
  });
  assert.equal(called, 0);
  assert.equal(r.diverged, true);
});

test('参考版 vs 参考版：不该分叉，也不该报掩蔽', () => {
  const r = runDifferential(5, randomActions(5, 0, 80), ALL_CAPS);
  assert.equal(r.diverged, false);
  assert.equal(r.first, null);
  assert.equal(r.masked, false);
  assert.equal(r.stepsRun, 80);
  assert.equal(r.finalRefHash, r.finalMutHash);
  assert.deepEqual(r.divergedSteps, []);
});

test('M02（敌人静止）第 1 步就分叉：最易检出的缺陷', () => {
  for (const seed of [1, 2, 3, 8]) {
    const r = runDifferential(seed, randomActions(seed, 0, 30), findMutant('M02').caps);
    assert.equal(r.diverged, true);
    assert.equal(r.first!.step, 1);
  }
});

test('runToEnd:false 在首分叉处停：stepsRun 等于首分叉步，且不误报掩蔽', () => {
  const acts = randomActions(1, 0, 20);
  const full = runDifferential(1, acts, findMutant('M05').caps);
  const early = runDifferential(1, acts, findMutant('M05').caps, { runToEnd: false });
  assert.equal(early.stepsRun, full.first!.step);
  assert.equal(early.divergedSteps.length, 1);
  assert.equal(early.masked, false, '提前停时无法判断掩蔽，必须诚实报 false');
  assert.equal(early.first!.step, full.first!.step);
  assert.equal(early.first!.refHash, full.first!.refHash);
});

test('变异体清单完整：9 单 + 3 双，removed 与 caps 一致', () => {
  assert.equal(ALL_MUTANTS.length, 12);
  for (const m of ALL_MUTANTS) {
    for (const k of m.removed) assert.equal(m.caps[k], false, `${m.id} 的 ${k} 应为 false`);
    const on = Object.keys(ALL_CAPS).filter((k) => !m.removed.includes(k as keyof typeof ALL_CAPS));
    for (const k of on) assert.equal(m.caps[k as keyof typeof ALL_CAPS], true);
  }
  assert.throws(() => findMutant('M99'), /未知变异体/);
});

// ───────────────────── B. 方法论的负面结论（实测夹具）─────────────────────

test('掩蔽夹具：中途分叉 10 帧，最终状态却完全相同', () => {
  // 实测：seed=1 salt=0 len=20 M05（攻击无冷却）。冷却是瞬态，3 帧后再收敛。
  const acts = randomActions(1, 0, 20);
  const r = runDifferential(1, acts, findMutant('M05').caps);
  assert.equal(r.diverged, true);
  assert.equal(r.first!.step, 2);
  assert.equal(r.divergedSteps.length, 10);
  assert.deepEqual(r.first!.fields.map((f) => f.path), ['player.cooldown']);
  assert.equal(r.masked, true);
  assert.equal(r.finalRefHash, r.finalMutHash);
});

test('只比最终状态会漏检上面那个缺陷（朴素做法的对照实验）', () => {
  const acts = randomActions(1, 0, 20);
  const caps = findMutant('M05').caps;
  assert.equal(finalStateOnly(1, acts, caps), false, '朴素做法：看不见缺陷');
  assert.equal(runDifferential(1, acts, caps).diverged, true, '逐帧差分：看得见');
});

test('未掩蔽时两种做法结论一致（说明差异只来自掩蔽，不是实现 bug）', () => {
  const acts = randomActions(1, 0, 80);
  const caps = findMutant('M02').caps;
  const r = runDifferential(1, acts, caps);
  assert.equal(r.masked, false);
  assert.equal(finalStateOnly(1, acts, caps), r.diverged);
});

test('首分叉字段路径 ≠ 缺陷位置：删的是墙，症状先出现在敌人身上', () => {
  // 实测：seed=1 salt=0 len=80 M01（wallBlocks 被删）。
  // 敌人也走 blocked()，穿墙后敌人轨迹先变 → 首分叉落在 enemies[1]。
  // 这不是信号污染，是真实的因果传播。把它写成断言，防止以后有人"修"掉它。
  const r = runDifferential(1, randomActions(1, 0, 80), findMutant('M01').caps);
  assert.equal(r.first!.step, 11);
  const paths = r.first!.fields.map((f) => f.path);
  assert.ok(paths.some((p) => p.startsWith('enemies')), `期望跨子系统传播，实际：${paths.join(', ')}`);
  assert.ok(!paths.some((p) => p.startsWith('player')), '此夹具首分叉恰好不含玩家字段');
});

test('结构不变性：任何变异体都不该让 walls/size/tick 分叉', () => {
  let cases = 0;
  for (const m of ALL_MUTANTS) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const salt of [0, 1]) {
        const r = runDifferential(seed, randomActions(seed, salt, 80), m.caps, { verifyDeterminism: false });
        cases++;
        if (!r.first) continue;
        for (const f of r.first.fields) {
          assert.ok(!STRUCTURAL.test(f.path), `${m.id} 在 seed=${seed} salt=${salt} 污染了结构字段 ${f.path}`);
        }
      }
    }
  }
  assert.equal(cases, 144);
});

test('ddmin 非单调夹具：删掉第 1 个动作，分叉就消失（所以不能简单二分）', () => {
  // 实测：seed=2 salt=3 len=40 M03（接触不扣血）。第 1 步是"走到敌人那边"的前提。
  const acts = randomActions(2, 3, 40);
  const caps = findMutant('M03').caps;
  assert.equal(runDifferential(2, acts, caps, { runToEnd: false }).diverged, true);
  assert.equal(
    runDifferential(2, acts.slice(1), caps, { runToEnd: false }).diverged,
    false,
    '前缀不可删：谓词非单调，二分法会在这里给出错误答案',
  );
});

test('ddmin 夹具：40 步 → 10 步，仍分叉且 1-minimal', () => {
  const acts = randomActions(2, 3, 40);
  const caps = findMutant('M03').caps;
  const m = minimize(2, acts, caps, { maxTests: 400 });
  assert.equal(m.originalLength, 40);
  assert.equal(m.minimized.length, 10);
  assert.equal(m.oneMinimal, true);
  assert.equal(m.budgetExhausted, false);
  assert.equal(m.emptyAlreadyDiverges, false, '缺陷不在世界生成，空序列不该分叉');
  assert.ok(m.tests > 0 && m.tests <= 400);

  // 独立复核：不信 minimize 自己的说法，重新跑一遍差分
  assert.equal(runDifferential(2, m.minimized, caps).diverged, true);
  // 独立复核 1-minimal：删任何单个动作都不再分叉
  for (let i = 0; i < m.minimized.length; i++) {
    const without = m.minimized.filter((_, j) => j !== i);
    assert.equal(
      runDifferential(2, without, caps, { runToEnd: false }).diverged,
      false,
      `删掉第 ${i} 个动作仍分叉 → 不是 1-minimal`,
    );
  }
});

test('ddmin 预算耗尽必须诚实报告，且不得声称 1-minimal', () => {
  const acts = randomActions(2, 3, 40);
  const m = minimize(2, acts, findMutant('M03').caps, { maxTests: 1 });
  assert.equal(m.budgetExhausted, true);
  assert.equal(m.oneMinimal, false, '预算耗尽时不能假装拿到了最小解');
  assert.equal(m.tests, 1);
});

test('ddmin 结果永不长于原序列，且对易检出缺陷能压到很短', () => {
  for (const id of ['M01', 'M02', 'M05', 'D03']) {
    const acts = randomActions(4, 1, 60);
    const m = minimize(4, acts, findMutant(id).caps, { maxTests: 400 });
    assert.ok(m.minimized.length <= 60, `${id} 最小化后反而变长了`);
    assert.equal(m.budgetExhausted, false, `${id} 预算不该耗尽`);
    assert.equal(runDifferential(4, m.minimized, findMutant(id).caps).diverged, true);
  }
  // M02 第 1 步就分叉 → 应该能压到 1 步
  const m2 = minimize(4, randomActions(4, 1, 60), findMutant('M02').caps, { maxTests: 400 });
  assert.equal(m2.minimized.length, 1);
});

test('空序列不分叉：所有变异体都不影响世界生成', () => {
  for (const m of ALL_MUTANTS) {
    const r = runDifferential(6, [] as Action[], m.caps);
    assert.equal(r.diverged, false, `${m.id} 竟然在初始状态就分叉`);
    assert.equal(r.stepsRun, 0);
  }
});