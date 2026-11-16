/**
 * 独立复核：完全脱离 GameSession / runDifferential，
 * 只用 runSequence + diffFields 从证据文件重算一遍判决。
 *
 * 为什么它必须独立于被测代码：拿同一份代码验同一份代码，只能证明它自洽，不能证明它对。
 * 所以这里**不 import** harness.ts / session.ts / notary 的判决入口，只借最底层的
 * 纯函数（runSequence / diffFields）自己重算首分叉、自己判 1-minimal。
 *
 * 用法: node verify/replay.ts <runDir>
 */
import { readFileSync } from 'node:fs';
import { runSequence, ALL_CAPS, type Action } from '../src/world/arena.ts';
import { findMutant } from '../src/world/mutants.ts';
import { diffFields } from '../src/notary/diff.ts';

// 缺参数要说得出口，不能让人去猜一条 TypeError：那是脚本的故障，不是被验对象的故障。
if (process.argv[2] === undefined) {
  console.error('用法: node verify/replay.ts <runDir>（需要 arena 局的 defect.json + world.jsonl，见 npm run verify:m4）');
  process.exit(2);
}
const dir = process.argv[2]!.replace(/\/+$/, '');
const defect = JSON.parse(readFileSync(`${dir}/defect.json`, 'utf8'));
const header = JSON.parse(readFileSync(`${dir}/header.json`, 'utf8'));
const actions = defect.fullWorldActions as Action[];
const logged = readFileSync(`${dir}/world.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

console.log(`\n===== 独立复核 ${dir} =====`);
console.log(`seed=${defect.seed}  mutant=${defect.mutant ?? '（对照组）'}  世界动作=${actions.length}`);

// ── 1. 逐帧重放：必须用「这一局实际跑的能力」 ──
// 变异局的 world.jsonl 落盘的是变异版帧；拿参考版去比对必然从第1帧就不同，
// 那不是重放失败，那正是缺陷本身。前提错了，结论就全错。
const playedCaps = defect.mutant ? findMutant(defect.mutant).caps : ALL_CAPS;
const ref = runSequence(defect.seed, actions, playedCaps);
const bad: number[] = [];
for (let i = 0; i < Math.max(ref.hashes.length, logged.length); i++) {
  if (ref.hashes[i] !== logged[i]?.hash) bad.push(i);
}
console.log(`[重放] 帧数 重算=${ref.hashes.length} 落盘=${logged.length}`);
console.log(`[重放] 初始哈希 重算=${ref.hashes[0]} header=${header.initialState.world.hash} defect=${defect.initialHash}`);
console.log(`[重放] 初始三方一致=${ref.hashes[0] === header.initialState.world.hash && ref.hashes[0] === defect.initialHash}`);
console.log(`[重放] 逐帧比对=${bad.length === 0 ? `全部 ${ref.hashes.length} 帧逐位相同 ✅` : `**不一致帧: ${bad.join(',')}** ❌`}`);
console.log(`[重放] 末帧哈希=${ref.hashes.at(-1)}`);

// ── 2. 变异体分叉：自己算，不信 notary 字段 ──
if (!defect.mutant) { console.log('[分叉] 对照组无变异体，跳过'); process.exit(bad.length === 0 ? 0 : 1); }
const mut = findMutant(defect.mutant);
// 分叉必须拿「参考版」对「变异版」，两份都独立重算
const refWorld = runSequence(defect.seed, actions, ALL_CAPS);
const m = runSequence(defect.seed, actions, mut.caps);
let first: { step: number; fields: string[] } | null = null;
let divergedFrames = 0;
for (let i = 0; i < refWorld.states.length; i++) {
  const d = diffFields(refWorld.states[i], m.states[i]!);
  if (d.length) { divergedFrames++; if (!first) first = { step: i, fields: d.map((x) => x.path) }; }
}
const n = defect.notary;
// 阴性局（从未分叉）必须单独处理：undefined !== null，且"终态相同"在从未分叉时
// 不叫掩蔽——掩蔽的定义是"中途分叉过、终态又相同"。前提不清就会冤枉被测系统。
const neverDiverged = first === null;
console.log(`[分叉] 独立算: 首分叉第 ${first?.step ?? '无'} 步，分叉帧数=${divergedFrames}`);
console.log(`[分叉] 公证器: 首分叉第 ${n.firstStep ?? '无'} 步，分叉帧数=${n.divergedFrames}`);
const stepAgree = (first?.step ?? null) === (n.firstStep ?? null) && divergedFrames === n.divergedFrames;
console.log(`[分叉] 首分叉一致=${stepAgree}`);
console.log(`[分叉] 独立首分叉字段=${first?.fields.join(', ') ?? '（无）'}`);
console.log(`[分叉] 公证器首分叉字段=${n.firstFields.join(', ') || '（无）'}`);
if (neverDiverged) {
  console.log(`[分叉] 从未分叉 → 掩蔽概念不适用；公证器 masked=${n.masked}（应为 false）`);
} else {
  console.log(`[分叉] 掩蔽(中途分叉但终态又相同)=${refWorld.hashes.at(-1) === m.hashes.at(-1)}（公证器称 ${n.masked}）`);
}

// ── 3. 1-minimal：最小序列仍分叉，且去掉任一步就不分叉 ──
const diverges = (acts: Action[]) => {
  const a = runSequence(defect.seed, acts, ALL_CAPS);
  const b = runSequence(defect.seed, acts, mut.caps);
  return a.states.some((s, i) => diffFields(s, b.states[i]!).length > 0);
};
let oneMinimal: boolean | null = null;
if (!n.minimized) {
  console.log(`[最小化] 无（未分叉就不该有最小化）；独立确认该序列确实不分叉=${!diverges(actions)}`);
} else {
  const min = n.minimized.actions as Action[];
  const minDiv = diverges(min);
  const emptyDiv = diverges([]);
  const subChecks = min.map((_, i) => ({ drop: i, stillDiv: diverges(min.filter((__, j) => j !== i)) }));
  oneMinimal = minDiv && subChecks.every((c) => !c.stillDiv);
  console.log(`[最小化] ${n.minimized.originalLength}→${min.length} 步: ${JSON.stringify(min)}`);
  console.log(`[最小化] 最小序列仍分叉=${minDiv}；空序列分叉=${emptyDiv}`);
  console.log(`[最小化] 逐个删一步后是否仍分叉=${JSON.stringify(subChecks)}`);
  console.log(`[最小化] 独立判定 1-minimal=${oneMinimal}（公证器称 ${n.minimized.oneMinimal}）`);
}

const ok = bad.length === 0 && stepAgree
  && (oneMinimal === null ? !n.minimized && !diverges(actions) : oneMinimal === n.minimized.oneMinimal)
  && (neverDiverged ? n.masked === false : true);
console.log(`\n===== 复核结论: ${ok ? '全部通过 ✅' : '存在不一致 ❌'} =====`);
process.exit(ok ? 0 : 1);