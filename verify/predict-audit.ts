/**
 * M4-a 独立审计：**不复用 observe.ts / checkPrediction**，另写一套解析与核对，
 * 从证据文件里的原始屏幕重算一遍差异，再和引擎记录的逐项比对。
 * 理由：拿同一份代码验同一份代码，只能证明它自洽，不能证明它对。
 *
 * 版本纪律：三局跑在三个代码版本上（故障 #9/#10 的修正是中途落地的）。
 *   旧门：只核对世界动作（move/attack/pickup/wait）
 *   新门：世界动作 + look（#10：look 那步的感知错误最大，却被漏掉）
 * 审计必须**先认出这一局用的是哪道门**，再按那道门重算。认证方式不是"信我说的"，
 * 而是：引擎核对过的步号集合，必须与某一道门推出的集合**逐个相等**（不多不少）。
 * 对不上就是错，不许放宽。旧版账本里没有的字段（staticChecks / surpriseMalformed）
 * 单独报"版本差异"，不混进错误数，也不假装它通过了。
 *
 * 用法: node verify/predict-audit.ts <runDir> [<runDir> ...]
 */
import { readFileSync } from 'node:fs';
// 只借 createWorld 做**裁判侧旁证**（核对 agent 那句"(3,3) 是墙"）。
// 屏幕解析与差异核对一律自己重写，绝不 import observe.ts / predict.ts。
import { createWorld } from '../src/world/arena.ts';

const FIELDS = ['hpDelta', 'scoreDelta', 'playerAt', 'enemyCount', 'pickupCount', 'alive', 'attackReady'];
const WORLD = new Set(['move', 'attack', 'pickup', 'wait']);

/** 另写一套屏幕解析：刻意用不同的实现路径（正则整行匹配 + 逐字符计数） */
function mine(screen: string) {
  const lines = screen.split('\n');
  const grid = lines.filter((l) => /^\|.*\|$/.test(l)).map((l) => l.slice(1, -1));
  const uniform = grid.length > 0 && new Set(grid.map((r) => r.length)).size === 1;
  const cells: Record<string, [number, number][]> = { '@': [], E: [], '+': [], '#': [] };
  if (uniform) {
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y]!.length; x++) {
        const ch = grid[y]![x]!;
        if (ch in cells) cells[ch]!.push([x, y]);
      }
    }
  }
  const sort = (a: [number, number][]) => [...a].sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  const hpLine = lines.find((l) => /^HP /.test(l)) ?? '';
  const stLine = lines.find((l) => /^攻击：/.test(l)) ?? '';
  const hp = /(\-?\d+)\/(\-?\d+)/.exec(hpLine);
  const sc = /分数\s*(\-?\d+)/.exec(hpLine);
  const tk = /第\s*(\-?\d+)\s*帧/.exec(hpLine);
  return {
    gridOk: uniform,
    player: cells['@']!.length === 1 ? cells['@']![0]! : null,
    enemies: sort(cells.E!).length,
    pickups: sort(cells['+']!).length,
    hp: hp ? Number(hp[1]) : null,
    score: sc ? Number(sc[1]) : null,
    tick: tk ? Number(tk[1]) : null,
    alive: /状态：活着/.test(stLine) ? true : /状态：已倒下/.test(stLine) ? false : null,
    ready: /攻击：就绪/.test(stLine) ? true : /攻击：冷却中/.test(stLine) ? false : null,
  };
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function actuals(p: ReturnType<typeof mine>, n: ReturnType<typeof mine>) {
  const d = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);
  return {
    hpDelta: d(p.hp, n.hp), scoreDelta: d(p.score, n.score),
    playerAt: n.gridOk ? n.player : null,
    enemyCount: n.gridOk ? n.enemies : null,
    pickupCount: n.gridOk ? n.pickups : null,
    alive: n.alive, attackReady: n.ready,
  };
}

/** 归一化预测值：与引擎同样的宽容度，但独立实现 */
function want(field: string, v: unknown): unknown {
  const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
  const bool = (x: unknown) => (typeof x === 'boolean' ? x : typeof x === 'string' ? (x.trim().toLowerCase() === 'true' ? true : x.trim().toLowerCase() === 'false' ? false : null) : null);
  if (['hpDelta', 'scoreDelta', 'enemyCount', 'pickupCount'].includes(field)) return num(v);
  if (['alive', 'attackReady'].includes(field)) return bool(v);
  if (field === 'playerAt') {
    if (Array.isArray(v) && v.length === 2) { const x = num(v[0]), y = num(v[1]); return x === null || y === null ? null : [x, y]; }
    if (typeof v === 'string') { const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(v); return m ? [Number(m[1]), Number(m[2])] : null; }
    if (v && typeof v === 'object') { const o = v as Record<string, unknown>; const x = num(o['x']), y = num(o['y']); return x === null || y === null ? null : [x, y]; }
  }
  return null;
}

let grandBad = 0;
// 不带目录时循环一次都不执行，"总计不一致 0 处"＝零样本假通过。审计不许这么绿。
if (process.argv.slice(2).length === 0) {
  console.error('❌ 没有指定任何 run 目录 → 本脚本一行都没审。零样本审计＝假通过，拒绝以 0 退出。');
  console.error('   用法: node verify/predict-audit.ts runs/<runId> [...]');
  process.exit(1);
}
for (const dir of process.argv.slice(2)) {
  const rows = readFileSync(`${dir}/trace.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const header = JSON.parse(readFileSync(`${dir}/header.json`, 'utf8'));
  const result = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8'));
  const steps = rows.filter((r) => r.decision);
  const checked = steps.filter((s) => s.prediction);

  console.log(`\n===== M4-a 独立审计 ${dir} =====`);
  console.log(`样本量：步=${steps.length} 核对过的步=${checked.length} 事件 prediction_check=${rows.filter((r) => r.kind === 'prediction_check').length} surprise_judgment=${rows.filter((r) => r.kind === 'surprise_judgment').length}`);
  if (checked.length === 0) { console.log('❌ 零样本审计＝假通过，中止'); grandBad++; continue; }

  // ── 0. 先认出这一局用的是哪道门（不多不少，逐个相等）──
  const idx = (pred: (n: string) => boolean) => steps.filter((s) => pred(s.decision.call.name as string) && s.result.ok).map((s) => s.index);
  const oldGate = idx((n) => WORLD.has(n));
  const newGate = idx((n) => WORLD.has(n) || n === 'look');
  const engineGate = checked.map((s) => s.index);
  const gate = eq(engineGate, newGate) ? 'new(世界动作+look)' : eq(engineGate, oldGate) ? 'old(仅世界动作)' : null;
  let gateBad = 0;
  if (gate === null) {
    console.log(`❌ 引擎核对的步号 [${engineGate}] 与两道门都不吻合：old=[${oldGate}] new=[${newGate}]`);
    gateBad++;
  } else {
    console.log(`[门] 引擎核对步号=[${engineGate}] → 判定为 ${gate}，与该门推出的集合逐个相等 ✅`);
  }

  // ── 1. 从原始屏幕重算每一项差异 ──
  let cur = header.initialState.world.screen as string;
  let fieldCount = 0, legacy = 0;
  const mismatch: string[] = [], advBad: string[] = [], chainBad: string[] = [];
  let ok = 0, vio = 0, unv = 0, given = 0, missing = 0, statics = 0;
  const checkedSteps: number[] = [];
  const vioByStep = new Map<number, number>();

  for (const s of steps) {
    const name = s.decision.call.name as string;
    const isScreen = (WORLD.has(name) || name === 'look') && s.result.ok;
    if (!isScreen) continue;
    const prev = cur;
    const next = s.result.output as string;
    cur = next;
    const p = mine(prev), n = mine(next);

    // 帧链自洽：世界动作必须推进一帧，look 必须原地不动。
    // 这一条抓的是"prev 屏幕取错"的漂移——最阴的一种错：所有 delta 全错，却看着像模型预测错。
    // 放在 prediction 判断**之前**：门外的步也要验帧链，否则旧版的 look 就成了盲区。
    if (p.tick !== null && n.tick !== null) {
      const expectTick = name === 'look' ? p.tick : p.tick + 1;
      if (n.tick !== expectTick) chainBad.push(`第${s.index}步 ${name} 帧号 ${p.tick}→${n.tick}，应为 ${expectTick}`);
    } else chainBad.push(`第${s.index}步 ${name} 帧号解析不出（prev=${p.tick} next=${n.tick}）`);

    if (!s.prediction) continue;   // 门外的步（旧版的 look）不核对；门本身已在第 0 步验过

    const act = actuals(p, n);
    const adv = p.tick !== null && n.tick !== null && n.tick > p.tick;
    // 早期两局跑在 advanced 字段落地之前，证据里根本没有这个字段。
    // 那不是"不一致"，是版本差异——分开报，不混进错误数，也不假装它通过了。
    if (!('advanced' in s.prediction)) legacy++;
    else if (adv !== s.prediction.advanced) advBad.push(`第${s.index}步 advanced 引擎=${s.prediction.advanced} 重算=${adv}`);
    if (!adv) statics++;
    checkedSteps.push(s.index);
    vioByStep.set(s.index, s.prediction.violated);

    const pred = s.prediction.predicted ?? {};
    const g = Object.keys(pred).length > 0;
    if (g !== s.prediction.given) mismatch.push(`第${s.index}步 given 引擎=${s.prediction.given} 重算=${g}`);
    if (g) given++; else missing++;

    for (const d of s.prediction.diffs) {
      fieldCount++;
      const known = FIELDS.includes(d.field);
      const w = known ? want(d.field, d.predicted) : null;
      const a = known ? (act as Record<string, unknown>)[d.field] ?? null : null;
      const st = w === null || a === null ? 'unverifiable' : eq(w, a) ? 'ok' : 'violated';
      if (!eq(a, d.actual)) mismatch.push(`第${s.index}步 ${d.field} actual 引擎=${JSON.stringify(d.actual)} 重算=${JSON.stringify(a)}`);
      if (st !== d.status) mismatch.push(`第${s.index}步 ${d.field} status 引擎=${d.status} 重算=${st}`);
      if (st === 'ok') ok++; else if (st === 'violated') vio++; else unv++;
    }
  }

  console.log(`[重算] 核对步=${checkedSteps.length}（步号 ${checkedSteps.join(',')}）字段=${fieldCount} 相符=${ok} 不符=${vio} 无法核对=${unv} 不推进画面=${statics}`);
  console.log(`[重算] 逐项比对=${mismatch.length === 0 ? `全部 ${fieldCount} 个字段的 actual 与 status 与引擎一致 ✅` : `**${mismatch.length} 处不一致** ❌`}`);
  for (const m of mismatch.slice(0, 12)) console.log(`   - ${m}`);
  console.log(`[重算] advanced 判定=${advBad.length === 0 ? (legacy > 0 ? `新版 ${checkedSteps.length - legacy} 步一致 ✅（另 ${legacy} 步跑在字段落地前，证据无此字段，属版本差异）` : '一致 ✅') : advBad.join('; ') + ' ❌'}`);
  console.log(`[帧链] ${chainBad.length === 0 ? '每个出画面的步 prev→next 帧号自洽（look 不推进 / 动作 +1）✅' : '**' + chainBad.length + ' 处漂移** ❌ ' + chainBad.join('; ')}`);

  // ── 2. 账本聚合必须与逐步记录对得上 ──
  const ps = result.predictionStats;
  const expect: Record<string, number> = { checked: checkedSteps.length, given, missing, fields: fieldCount, ok, violated: vio, unverifiable: unv };
  if (ps && 'staticChecks' in ps) expect['staticChecks'] = statics;
  const aggBad = Object.entries(expect).filter(([k, v]) => ps?.[k] !== v).map(([k, v]) => `${k} 账本=${ps?.[k]} 重算=${v}`);
  const verDiff = ['staticChecks', 'surpriseMalformed'].filter((k) => ps && !(k in ps));
  console.log(`[账本] ${aggBad.length === 0 ? '聚合逐项对得上 ✅' : '**对不上** ❌ ' + aggBad.join('; ')}${verDiff.length ? `（该版本账本无 ${verDiff.join('/')} 字段，属版本差异，未参与比对）` : ''}`);

  // ── 3. surprise 判断的指代必须真实存在 ──
  const sj = rows.filter((r) => r.kind === 'surprise_judgment').map((r) => r.payload);
  let sjBad = 0, notSurprised = 0;
  for (const j of sj) {
    if (j.aboutStep !== null) {
      if (!checkedSteps.includes(j.aboutStep)) { console.log(`   ❌ 判断指向第${j.aboutStep}步，但那一步没被核对`); sjBad++; }
      if (vioByStep.get(j.aboutStep) !== j.aboutViolated) { console.log(`   ❌ aboutViolated 与该步实际违反数不符`); sjBad++; }
      if (j.unexpected === false && (j.aboutViolated ?? 0) > 0) notSurprised++;
    }
    if (j.unexpected === null && ps?.surpriseMalformed === undefined) sjBad++;
  }
  console.log(`[判断] surprise_judgment=${sj.length} 指代核对=${sjBad === 0 ? '全部可追溯 ✅' : `${sjBad} 处错 ❌`}；重算"判不符却说不意外"=${notSurprised} 账本=${ps?.violatedButNotSurprised}`);
  if (ps && notSurprised !== ps.violatedButNotSurprised) { console.log('   ❌ 与账本不符'); sjBad++; }

  // ── 4. 工具返回必须仍是纯画面（对账文本不许污染证据）──
  const polluted = steps.filter((s) => String(s.result.output).includes('预测对照'));
  console.log(`[证据纯度] 被对账文本污染的工具返回=${polluted.length} ${polluted.length === 0 ? '✅' : '❌'}`);

  // ── 5. 送达审计：回填原文必须落盘，且能推出它进过 payload ──
  // 判据（与 predict-loop.test.ts 同一条规则，但这里只看证据文件）：
  //   history 整份下发 → 第 N 步回填的原文，只要存在第 N+1 步决策，就一定在那次请求里。
  // 三局真跑跑在这个事件落地之前，证据里没有它 —— 那是版本差异，单独报，不假装通过。
  const fb = rows.filter((r) => r.kind === 'prediction_feedback').map((r) => r.payload);
  if (fb.length === 0) {
    console.log(`[送达] 证据里无 prediction_feedback 事件（该版本尚未落盘回填原文）→ 送达只能由接线测试 + 模型引用佐证，属已知证据缺口`);
  } else {
    let fbBad = 0, undelivered = 0;
    if (fb.length !== checked.length) { console.log(`   ❌ 回填事件 ${fb.length} 条 ≠ 核对 ${checked.length} 次`); fbBad++; }
    for (const f of fb) {
      const nextStep = steps.find((s) => s.index === f.aboutStep + 1);
      if (!nextStep) { undelivered++; continue; }   // 整局在这一步结束：留档但没送到，不算错
      const name = steps.find((s) => s.index === f.aboutStep)?.decision.call.name;
      // 落盘原文必须与"画面 + 空行 + 原文"的合成规则一致；画面取该步工具返回
      const screen = steps.find((s) => s.index === f.aboutStep)?.result.output;
      if (typeof f.text !== 'string' || !f.text.startsWith('预测对照')) { console.log(`   ❌ 第${f.aboutStep}步回填原文形状不对`); fbBad++; }
      if (typeof screen !== 'string' || screen.includes('预测对照')) { console.log(`   ❌ 第${f.aboutStep}步画面被污染`); fbBad++; }
      if (!name) { console.log(`   ❌ 第${f.aboutStep}步找不到对应决策`); fbBad++; }
    }
    console.log(`[送达] 回填事件=${fb.length} 可推出已送达=${fb.length - undelivered} 整局结束未送达=${undelivered} 形状核对=${fbBad === 0 ? '✅' : fbBad + ' 处错 ❌'}`);
    grandBad += fbBad;
  }

  // ── 6. 违反明细（给报告用）──
  console.log('[违反明细]');
  for (const s of checked) {
    for (const d of s.prediction.diffs) {
      if (d.status === 'violated') console.log(`   第${s.index}步 ${s.decision.call.name} ${d.field}: 预测 ${JSON.stringify(d.predicted)} → 画面 ${JSON.stringify(d.actual)}`);
    }
  }
  grandBad += gateBad + mismatch.length + advBad.length + chainBad.length + aggBad.length + sjBad + polluted.length;
}

// ── 附：核对 agent 在 M08 局里那句"(3,3) 是墙"的推断 ──
const w = createWorld(6);
console.log(`\n[旁证] seed=6 的墙表含 "3,3" = ${w.walls.includes('3,3')}；玩家出生 [${w.player.x},${w.player.y}]；初始敌人 ${w.enemies.filter((e) => e.alive).length} 个、物品 ${w.pickups.filter((p) => !p.taken).length} 个`);
console.log(`\n===== 总计不一致 ${grandBad} 处 =====`);
process.exit(grandBad === 0 ? 0 : 1);