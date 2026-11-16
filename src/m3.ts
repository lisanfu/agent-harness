#!/usr/bin/env node
/**
 * M3 成立性验证实验台。
 *
 * 目的不是"演示它能行"，是**证伪**：差分公证器在长程状态机上到底能不能用？
 * 七个实验，每个都可能给出否定答案。否定答案同样是成果。
 *
 *   E1 确定性基线      参考版自比必须 0 分叉。不过 → 后面全部作废
 *   E2 可检测性        每个变异体在 K 条随机序列上的分叉率。0% = 等价变异体（静默漏检）
 *   E3 定位精度        第一个分叉帧 vs 被删能力。分叉点是"症状 onset"，不是缺陷位置
 *   E4 最小化          ddmin 压缩率 / 1-minimal 达成率 / 测试预算
 *   E5 掩蔽            中途分叉但最终状态又相同的比例 → 证明"只比最终状态"会漏检
 *   E6 信号洁净度      首分叉字段是否局限在相关子系统（验证计数式随机的必要性）
 *   E7 哈希敏感性      不同种子必须分叉，同种子同动作必须不分叉（防假阳/假阴）
 *
 * 全程零模型、零依赖。裁判是代码。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ALL_CAPS, createWorld, randomActions, runSequence, worldHash,
  type Action,
} from './world/arena.ts';
import { ALL_MUTANTS, type Mutant } from './world/mutants.ts';
import { checkDeterminism, finalStateOnly, runDifferential } from './notary/diff.ts';
import { minimize } from './notary/ddmin.ts';

const ROOT = resolve(import.meta.dirname, '..');

interface Args { [k: string]: string | boolean }
function parseArgv(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
function num(v: string | boolean | undefined, d: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}
function pct(a: number, b: number): string {
  return b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(1)}%`;
}
function stats(xs: number[]): { min: number; max: number; mean: number; median: number } | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { min: s[0]!, max: s[s.length - 1]!, mean: Math.round(sum / s.length), median: s[Math.floor(s.length / 2)]! };
}

const log = (l: string) => process.stderr.write(`${l}\n`);

// ── E1 确定性基线 ────────────────────────────────────────────
function e1(seeds: number, len: number) {
  let bad = 0;
  const failures: { seed: number; salt: number }[] = [];
  for (let s = 0; s < seeds; s++) {
    for (let salt = 0; salt < 3; salt++) {
      const seed = 1000 + s * 7919;
      const acts = randomActions(seed, salt, len);
      if (!checkDeterminism(seed, acts)) { bad++; failures.push({ seed, salt }); }
    }
  }
  const total = seeds * 3;
  log(`E1 确定性基线：${total} 组（${seeds} 种子 × 3 序列 × ${len} 步）→ 不一致 ${bad} 组`);
  if (bad) log(`   ⚠️ 世界不确定，后续结论全部作废。失败样本：${JSON.stringify(failures.slice(0, 5))}`);
  return { total, inconsistent: bad, failures: failures.slice(0, 10), pass: bad === 0 };
}

// ── E2/E3/E5/E6 共用一次批量运行 ─────────────────────────────
interface CaseResult {
  mutant: string;
  seed: number;
  salt: number;
  diverged: boolean;
  firstStep: number | null;
  firstFields: string[];
  masked: boolean;
  finalOnlyDetects: boolean;
  divergedFrameCount: number;
  actions: Action[];
}

function batch(mutants: Mutant[], seeds: number, salts: number, len: number) {
  const cases: CaseResult[] = [];
  for (const m of mutants) {
    for (let s = 0; s < seeds; s++) {
      for (let salt = 0; salt < salts; salt++) {
        const seed = 1000 + s * 7919;
        const acts = randomActions(seed, salt, len);
        const r = runDifferential(seed, acts, m.caps, { runToEnd: true, verifyDeterminism: false });
        cases.push({
          mutant: m.id, seed, salt,
          diverged: r.diverged,
          firstStep: r.first?.step ?? null,
          firstFields: r.first ? r.first.fields.map((f) => f.path) : [],
          masked: r.masked,
          finalOnlyDetects: r.diverged ? finalStateOnly(seed, acts, m.caps) : false,
          divergedFrameCount: r.divergedSteps.length,
          actions: acts,
        });
      }
    }
  }
  return cases;
}

/**
 * E6 结构不变性 + 信号传播度。
 *
 * ⚠️ 这里换掉了一个我自己写错的指标。原本想测"首分叉字段是否局限在被删能力的子系统"，
 * 冒烟跑给出 M01=25%、M04=0%，看着像"信号被污染"。查下去发现是**指标错了**：
 *   - 删 wallBlocks：敌人巡逻也走 blocked()，所以敌人位置/朝向必然一起变
 *   - 删 attackKills：敌人不死 → 继续巡逻 → 位置变；且击杀计分也不触发 → score 变
 * 这些是**真实的因果传播**，不是噪声。能力删除本来就会跨子系统扩散。
 *
 * 换成两条真正成立的检查：
 *  1 结构不变性：walls / size / tick 由 createWorld 与固定步长决定，不依赖 caps，
 *    **永远不该出现在分叉字段里**。若出现 → 世界或公证器有 bug。
 *    注意：这不是"手写业务不变量"，而是对公证器自身正确性的自检。
 *  2 传播度：首分叉涉及几个顶层子系统。诚实报告传播广度，不假装信号是局部的。
 *    这直接支撑 E3 的结论：**首分叉字段路径 ≠ 缺陷位置**。
 */
const STRUCTURAL = /^(walls|size|tick)(\[|\.|$)/;

function topLevel(path: string): string {
  const m = /^([a-zA-Z_]+)/.exec(path);
  return m ? m[1]! : path;
}

function e6(cases: CaseResult[]) {
  const structuralViolations: { mutant: string; seed: number; paths: string[] }[] = [];
  const breadth: Record<string, { subsystems: string[]; avgFields: number; cases: number }> = {};
  for (const c of cases) {
    if (!c.diverged || !c.firstFields.length) continue;
    const bad = c.firstFields.filter((p) => STRUCTURAL.test(p));
    if (bad.length) structuralViolations.push({ mutant: c.mutant, seed: c.seed, paths: bad });
    const subs = [...new Set(c.firstFields.map(topLevel))].sort();
    const b = breadth[c.mutant] ?? (breadth[c.mutant] = { subsystems: [], avgFields: 0, cases: 0 });
    b.cases++;
    b.avgFields += c.firstFields.length;
    for (const s of subs) if (!b.subsystems.includes(s)) b.subsystems.push(s);
  }
  for (const k of Object.keys(breadth)) {
    const b = breadth[k]!;
    b.avgFields = b.cases ? Math.round(b.avgFields / b.cases) : 0;
    b.subsystems.sort();
  }
  return { structuralViolations, breadth, pass: structuralViolations.length === 0 };
}

/**
 * E2b 覆盖率救援。
 *
 * 冒烟跑发现 3 个变异体 0% 检出。这有两种可能，必须分清：
 *   (a) 公证器不行（真等价变异体，语义上无可观测差异）
 *   (b) 动作分布根本没触达该能力（覆盖率问题，不是公证器问题）
 *
 * 判别方法：**加大探索预算**（更长序列、更多样本），看检出率是否从 0 变成非 0。
 * 若变非 0 → 是 (b)，公证器健全，缺的是探索。这正是 agent 该干的活。
 * 若仍为 0 → 是 (a)，必须诚实报告差分有静默漏检。
 *
 * 关键：这个实验**不使用任何缺陷知识**，只加预算。所以它不是开卷考试。
 */
function e2b(undetected: Mutant[], longLen: number, longSalts: number, seeds: number) {
  return undetected.map((m) => {
    let diverged = 0, total = 0, firstSteps: number[] = [];
    let rescuedAt: { seed: number; salt: number; step: number } | null = null;
    for (let s = 0; s < seeds; s++) {
      for (let salt = 0; salt < longSalts; salt++) {
        const seed = 1000 + s * 7919;
        const acts = randomActions(seed, 10000 + salt, longLen);
        const r = runDifferential(seed, acts, m.caps, { runToEnd: false, verifyDeterminism: false });
        total++;
        if (r.diverged) {
          diverged++;
          firstSteps.push(r.first!.step);
          if (!rescuedAt) rescuedAt = { seed, salt: 10000 + salt, step: r.first!.step };
        }
      }
    }
    return {
      id: m.id, removed: m.removed, total, diverged,
      detectionRate: total ? diverged / total : 0,
      rescued: diverged > 0,
      rescuedAt,
      firstStep: stats(firstSteps),
    };
  });
}

/**
 * E2c 覆盖率曲线：检出率 vs 序列长度。
 *
 * 冒烟跑（30 步）有 3 个变异体 0% 检出，正式跑（80 步）全部检出。
 * 这说明"漏检"多半不是公证器失效，而是**动作序列根本没触达该能力**。
 * 这个实验把该判断量化：对每个变异体测多个长度下的检出率。
 *
 * 为什么重要：它直接决定 M1/M4 的探索策略该有多强。
 * 若某能力要 300 步才触达，随机探索基本无望，agent 必须自己学会朝目标走。
 * 同样**不使用任何缺陷知识**，只变长度。
 */
function e2c(mutants: Mutant[], lengths: number[], seeds: number, salts: number) {
  return mutants.map((m) => {
    const curve = lengths.map((L) => {
      let diverged = 0, total = 0;
      const firstSteps: number[] = [];
      for (let s = 0; s < seeds; s++) {
        for (let salt = 0; salt < salts; salt++) {
          const seed = 1000 + s * 7919;
          const acts = randomActions(seed, 20000 + salt, L);
          const r = runDifferential(seed, acts, m.caps, { runToEnd: false, verifyDeterminism: false });
          total++;
          if (r.diverged) { diverged++; firstSteps.push(r.first!.step); }
        }
      }
      return { length: L, diverged, total, rate: total ? diverged / total : 0, firstStep: stats(firstSteps) };
    });
    return { id: m.id, removed: m.removed, curve };
  });
}

// ── E4 最小化 ────────────────────────────────────────────────
function e4(cases: CaseResult[], mutants: Mutant[], perMutant: number, maxTests: number) {
  const rows: {
    mutant: string; seed: number; salt: number;
    original: number; minimized: number; tests: number;
    oneMinimal: boolean; budgetExhausted: boolean; stillDiverges: boolean;
    minimizedActions: Action[];
  }[] = [];
  for (const m of mutants) {
    const diverged = cases.filter((c) => c.mutant === m.id && c.diverged);
    for (const c of diverged.slice(0, perMutant)) {
      const r = minimize(c.seed, c.actions, m.caps, { maxTests });
      // 独立复核：最小化后的序列必须真的仍分叉（不能只信 ddmin 自己的话）
      const verify = runDifferential(c.seed, r.minimized, m.caps, { runToEnd: false, verifyDeterminism: false });
      rows.push({
        mutant: m.id, seed: c.seed, salt: c.salt,
        original: r.originalLength, minimized: r.minimized.length, tests: r.tests,
        oneMinimal: r.oneMinimal, budgetExhausted: r.budgetExhausted,
        stillDiverges: verify.diverged,
        minimizedActions: r.minimized,
      });
    }
  }
  return rows;
}

// ── E7 哈希敏感性 ────────────────────────────────────────────
function e7(len: number) {
  const seedA = 12345, seedB = 54321;
  const acts = randomActions(seedA, 0, len);
  const sameSeedSameActs = runDifferential(seedA, acts, ALL_CAPS, { verifyDeterminism: false }).diverged;
  const hA = worldHash(createWorld(seedA));
  const hB = worldHash(createWorld(seedB));
  const diffSeedDiffers = hA !== hB;
  // 同种子不同动作必须分叉（否则哈希对动作不敏感 = 假阴性）
  const acts2 = randomActions(seedA, 1, len);
  const r2 = runSequence(seedA, acts2, ALL_CAPS);
  const r1 = runSequence(seedA, acts, ALL_CAPS);
  const diffActsDiffer = r1.hashes[r1.hashes.length - 1] !== r2.hashes[r2.hashes.length - 1];
  log(`E7 哈希敏感性：同种子同动作分叉=${sameSeedSameActs}（应 false）｜不同种子初始态不同=${diffSeedDiffers}（应 true）｜同种子不同动作终态不同=${diffActsDiffer}（应 true）`);
  return { sameSeedSameActs, diffSeedDiffers, diffActsDiffer, pass: !sameSeedSameActs && diffSeedDiffers && diffActsDiffer };
}

async function main(): Promise<number> {
  const args = parseArgv(process.argv.slice(2));
  const seeds = num(args['seeds'], 8);
  const salts = num(args['salts'], 3);
  const len = num(args['len'], 80);
  const ddPerMutant = num(args['dd-per-mutant'], 2);
  const ddMaxTests = num(args['dd-max-tests'], 150);
  const longLen = num(args['long-len'], 400);
  const longSalts = num(args['long-salts'], 12);
  const curveSeeds = num(args['curve-seeds'], 6);
  const curveSalts = num(args['curve-salts'], 2);
  const outDir = resolve(typeof args['out'] === 'string' ? args['out'] : join(ROOT, 'runs', 'm3'));
  mkdirSync(outDir, { recursive: true });

  log(`M3 成立性验证｜种子数=${seeds} 每种子序列数=${salts} 序列长度=${len} 变异体=${ALL_MUTANTS.length}`);
  log('');

  const det = e1(seeds, len);
  if (!det.pass) {
    writeFileSync(join(outDir, 'findings.json'), JSON.stringify({ aborted: '确定性基线失败', det }, null, 2));
    return 1;
  }
  log('');

  const t0 = Date.now();
  const cases = batch(ALL_MUTANTS, seeds, salts, len);
  log(`批量差分完成：${cases.length} 例，用时 ${Date.now() - t0}ms`);
  log('');

  // E2 + E3 + E5
  const perMutant = ALL_MUTANTS.map((m) => {
    const cs = cases.filter((c) => c.mutant === m.id);
    const dv = cs.filter((c) => c.diverged);
    const masked = cs.filter((c) => c.masked);
    const finalOnly = cs.filter((c) => c.finalOnlyDetects);
    const missedByFinalOnly = dv.length - finalOnly.length;
    return {
      id: m.id, label: m.label, removed: m.removed,
      total: cs.length, diverged: dv.length,
      detectionRate: cs.length ? dv.length / cs.length : 0,
      equivalent: dv.length === 0,
      firstStep: stats(dv.map((c) => c.firstStep!).filter((x) => x !== null)),
      masked: masked.length,
      finalOnlyDetects: finalOnly.length,
      missedByFinalOnly,
    };
  });

  log('E2 可检测性 / E3 首分叉帧 / E5 掩蔽：');
  log('  变异体  删除能力                     分叉率      首分叉帧(min/中位/max)   掩蔽  只比终态漏检');
  for (const r of perMutant) {
    const fs = r.firstStep ? `${r.firstStep.min}/${r.firstStep.median}/${r.firstStep.max}` : '—';
    log(`  ${r.id}    ${r.removed.join('+').padEnd(28)} ${pct(r.diverged, r.total).padStart(7)}     ${fs.padEnd(22)} ${String(r.masked).padStart(4)}  ${String(r.missedByFinalOnly).padStart(6)}`);
  }
  const equiv = perMutant.filter((r) => r.equivalent);
  log('');
  if (equiv.length) log(`  ⚠️ 等价变异体（${equiv.length} 个，差分静默漏检）：${equiv.map((e) => `${e.id}(${e.removed.join('+')})`).join(', ')}`);
  else log('  无等价变异体：全部可被差分检出');
  const totalMasked = perMutant.reduce((a, b) => a + b.masked, 0);
  const totalMissed = perMutant.reduce((a, b) => a + b.missedByFinalOnly, 0);
  log(`  掩蔽合计 ${totalMasked} 例；"只比最终状态"合计漏检 ${totalMissed} 例`);
  log('');

  const clean = e6(cases);
  log('E6 结构不变性 + 信号传播度：');
  log(`  结构字段（walls/size/tick）出现在分叉里：${clean.structuralViolations.length} 例（必须 0，否则世界或公证器有 bug）`);
  if (!clean.pass) log(`  ⚠️ 违规样本：${JSON.stringify(clean.structuralViolations.slice(0, 3))}`);
  log('  首分叉传播广度（涉及几个顶层子系统 / 平均字段数）：');
  for (const m of ALL_MUTANTS) {
    const b = clean.breadth[m.id];
    if (!b) { log(`  ${m.id}  无分叉样本`); continue; }
    log(`  ${m.id}  ${b.subsystems.join('+').padEnd(28)} 平均 ${b.avgFields} 个字段（${b.cases} 例）`);
  }
  log('  → 传播是真实因果，不是噪声。所以**首分叉字段路径 ≠ 缺陷位置**。');
  log('');

  // E2b：0% 检出的变异体，加大探索预算看能不能救回来
  const undetected = ALL_MUTANTS.filter((m) => perMutant.find((r) => r.id === m.id)?.equivalent);
  let rescue: ReturnType<typeof e2b> = [];
  if (undetected.length) {
    const t2 = Date.now();
    rescue = e2b(undetected, longLen, longSalts, seeds);
    log(`E2b 覆盖率救援（序列 ${len} → ${longLen} 步，样本 ${salts} → ${longSalts}，用时 ${Date.now() - t2}ms）：`);
    for (const r of rescue) {
      log(`  ${r.id} ${r.removed.join('+').padEnd(26)} 检出 ${r.diverged}/${r.total} ${pct(r.diverged, r.total).padStart(7)}  ${r.rescued ? `✅ 救回（首分叉第 ${r.rescuedAt?.step} 步）→ 原因是覆盖率不足，不是公证器失效` : '❌ 仍 0% → 真等价变异体，差分静默漏检'}`);
    }
    log('');
  }

  const t3 = Date.now();
  const curve = e2c(ALL_MUTANTS, [10, 20, 40, 80, 160, 320], curveSeeds, curveSalts);
  log(`E2c 覆盖率曲线（检出率 vs 序列长度，${curveSeeds} 种子 × ${curveSalts} 序列，用时 ${Date.now() - t3}ms）：`);
  log('  变异体   10步    20步    40步    80步   160步   320步');
  for (const c of curve) {
    log(`  ${c.id}    ${c.curve.map((p) => pct(p.diverged, p.total).padStart(6)).join('  ')}`);
  }
  const hard = curve.filter((c) => (c.curve.find((p) => p.length === 80)?.rate ?? 0) < 0.5);
  log(`  → 80 步检出率 <50% 的"难触达"变异体：${hard.map((h) => h.id).join(', ') || '无'}`);
  log('');

  const t1 = Date.now();
  const dd = e4(cases, ALL_MUTANTS, ddPerMutant, ddMaxTests);
  log(`E4 最小化（${dd.length} 例，用时 ${Date.now() - t1}ms）：`);
  let stillOk = 0, oneMin = 0, exhausted = 0, sumOrig = 0, sumMin = 0, sumTests = 0;
  for (const r of dd) {
    if (r.stillDiverges) stillOk++;
    if (r.oneMinimal) oneMin++;
    if (r.budgetExhausted) exhausted++;
    sumOrig += r.original; sumMin += r.minimized; sumTests += r.tests;
  }
  log(`  最小化后仍分叉：${stillOk}/${dd.length}（必须 100%，否则 ddmin 有 bug）`);
  log(`  达成 1-minimal：${oneMin}/${dd.length}`);
  log(`  预算耗尽：${exhausted}/${dd.length}`);
  log(`  压缩：${sumOrig} 步 → ${sumMin} 步（${pct(sumOrig - sumMin, sumOrig)} 削减），平均 ${dd.length ? Math.round(sumTests / dd.length) : 0} 次谓词调用`);
  const worst = [...dd].sort((a, b) => b.minimized - a.minimized)[0];
  if (worst) log(`  最难压缩的一例：${worst.mutant} ${worst.original}→${worst.minimized} 步，1-minimal=${worst.oneMinimal}`);
  log('');

  const sens = e7(len);
  log('');

  const rescued = rescue.filter((r) => r.rescued).map((r) => r.id);
  const trulyEquivalent = rescue.filter((r) => !r.rescued).map((r) => r.id);

  const verdict = {
    determinismBaseline: det.pass,
    /** 短序列下 0% 检出的变异体 */
    undetectedAtShortLen: equiv.map((e) => e.id),
    /** 加大探索预算后救回的 → 覆盖率问题，公证器健全 */
    rescuedByMoreExploration: rescued,
    /** 加大预算仍 0% → 真等价变异体，差分静默漏检 */
    trulyEquivalent,
    detectionRateOverall: cases.length ? cases.filter((c) => c.diverged).length / cases.length : 0,
    singleMutantDetection: perMutant.filter((r) => r.id.startsWith('M')).map((r) => ({ id: r.id, rate: r.detectionRate })),
    maskedTotal: totalMasked,
    missedByFinalStateOnly: totalMissed,
    ddminStillDiverges: dd.length ? stillOk / dd.length : null,
    ddminOneMinimalRate: dd.length ? oneMin / dd.length : null,
    ddminCompression: sumOrig ? (sumOrig - sumMin) / sumOrig : null,
    ddminBudgetExhausted: exhausted,
    hashSensitivity: sens.pass,
    structuralInvariance: clean.pass,
    /** 80 步检出率 <50% 的变异体：能力难触达，随机探索不够 */
    hardToReachAt80: curve.filter((c) => (c.curve.find((p) => p.length === 80)?.rate ?? 0) < 0.5).map((c) => c.id),
    coverageCurve: curve.map((c) => ({ id: c.id, rates: c.curve.map((p) => ({ len: p.length, rate: p.rate })) })),
    /** 首分叉平均涉及的顶层子系统数：>1 说明信号会传播，字段路径不能当缺陷位置 */
    avgSubsystemBreadth: (() => {
      const bs = Object.values(clean.breadth);
      return bs.length ? bs.reduce((a, b) => a + b.subsystems.length, 0) / bs.length : null;
    })(),
  };

  const findings = {
    at: new Date().toISOString(),
    params: { seeds, salts, len, ddPerMutant, ddMaxTests, longLen, longSalts, curveSeeds, curveSalts },
    verdict,
    e1: det,
    perMutant,
    e6: clean,
    e2b: rescue,
    e2c: curve,
    e4: dd,
    e7: sens,
    cases: cases.map((c) => ({ ...c, actions: undefined })),
  };
  const file = join(outDir, 'findings.json');
  writeFileSync(file, JSON.stringify(findings, null, 2));
  log('── 成立性判定 ──');
  log(`  确定性基线：${det.pass ? '通过' : '失败'}`);
  log(`  结构不变性：${clean.pass ? '通过' : '失败'}`);
  log(`  哈希敏感性：${sens.pass ? '通过' : '失败'}`);
  log(`  短序列漏检 ${equiv.length} 个 → 加预算救回 ${rescued.length} 个，真等价 ${trulyEquivalent.length} 个`);
  log(`  ddmin 最小化后仍分叉：${dd.length ? pct(stillOk, dd.length) : 'n/a'}｜1-minimal：${dd.length ? pct(oneMin, dd.length) : 'n/a'}｜压缩：${pct(sumOrig - sumMin, sumOrig)}`);
  log(`  只比最终状态漏检：${totalMissed} 例（掩蔽 ${totalMasked} 例）`);
  log(`结论数据：${file}`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  process.stderr.write(`\n[fatal] ${(e as Error).message}\n${(e as Error).stack}\n`);
  process.exit(1);
});