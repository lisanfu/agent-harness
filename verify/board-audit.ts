/**
 * M4-b1 假设板独立审计：**不 import board.ts / prompt.ts / parse.ts**，
 * 另写一套状态机与文本解析，从证据文件重算一遍板子，再与引擎记录逐项比对。
 * 理由与 predict-audit 相同：拿同一份代码验同一份代码，只能证明它自洽，不能证明它对。
 *
 * 分工边界（刻意不重叠）：
 *   predict-audit.ts 负责「差异本身算得对不对」——它从原始屏幕重算 actual/status。
 *   本脚本把 diffs 的 status 当作**已被兄弟脚本审过的输入**，只审新增的那部分：
 *   归因分类、计数累加、状态机、渲染文本、出声名单、账本聚合、主客观分侧。
 *
 * 版本纪律：M4-b 之前跑的证据里根本没有 hypothesis_* 事件。
 * 那不是"不一致"，是版本差异——单独报，不混进错误数，也不假装它通过了。
 * 但只要认定这一局是新版，样本量为 0 就立刻中止：零样本审计＝假通过。
 *
 * 用法: node verify/board-audit.ts <runDir> [<runDir> ...]
 */
import { readFileSync } from 'node:fs';

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const STATUSES = ['proposed', 'confirmed', 'retired'];

interface H {
  id: string; text: string; status: string; statusWhy: string;
  createdAtStep: number; statusAtStep: number;
  checks: number; supported: number; contradicted: number; unverifiable: number;
}
const blank = (id: string, text: string, status: string, why: string, step: number): H =>
  ({ id, text, status, statusWhy: why, createdAtStep: step, statusAtStep: step, checks: 0, supported: 0, contradicted: 0, unverifiable: 0 });

/**
 * 另写一套假设板文本解析：逐行正则抽取，与渲染器的"拼字符串"路径完全不同。
 * 分区锚点刻意用硬编码字面量而不是 import 常量——渲染器改了抬头，
 * 审计应当**大声失败**，而不是跟着一起改、继续互相印证。
 */
/** 条目头 / 计数行的形状：审计侧自己写死，不 import 渲染器。 */
const HEAD_RE = /^- (\S+) \[(\w+)\] (.*)$/;
const COUNT_RE = /^    客观核对 (\d+) 次：支持 (\d+) \/ 反对 (\d+) \/ 无法核对 (\d+)$/;

function parseBoard(text: string): { active: H[]; retired: H[]; notes: string[] } {
  const lines = text.split('\n');
  const iActive = lines.findIndex((l) => l.includes('可检验假设'));
  const iRetired = lines.findIndex((l) => l.includes('已淘汰'));
  const notes: string[] = [];
  for (const l of lines) { const m = /^(\d+)\. (.*)$/.exec(l); if (m) notes.push(m[2]!); }
  const grab = (from: number, to: number): H[] => {
    if (from < 0) return [];
    const out: H[] = [];
    const seg = lines.slice(from + 1, to < 0 ? lines.length : to);
    for (let i = 0; i < seg.length; i++) {
      const m = HEAD_RE.exec(seg[i]!);
      if (!m) continue;
      // 历史证据里正文可能跨行（旧版写入路径没拦换行，见故障 #19）。
      // 审计读的是**已经发生的证据**，所以按"下一个条目头之前都属于本条目"收续行；
      // 但计数行必须落在本条目内——缺失照样大声失败，这条不放。
      const bodyLines = [m[3]!];
      let c: RegExpExecArray | null = null;
      for (let j = i + 1; j < seg.length && c === null; j++) {
        const l = seg[j]!;
        if (HEAD_RE.test(l)) break;
        c = COUNT_RE.exec(l);
        if (!c) bodyLines.push(l);
      }
      if (!c) throw new Error(`假设 ${m[1]} 的条目里没有计数行，渲染形状不对`);
      // 正文里可能带"（你的理由：…）"，拆出来（它由渲染器追加在整段正文末尾）
      const body = bodyLines.join('\n');
      const w = /（你的理由：([\s\S]*)）$/.exec(body);
      out.push({
        id: m[1]!, status: m[2]!, text: w ? body.slice(0, w.index) : body, statusWhy: w ? w[1]! : '',
        createdAtStep: -1, statusAtStep: -1,
        checks: Number(c[1]), supported: Number(c[2]), contradicted: Number(c[3]), unverifiable: Number(c[4]),
      });
    }
    return out;
  };
  return { active: grab(iActive, iRetired), retired: grab(iRetired, -1), notes };
}

/**
 * 该出声的事实条件，独立重写一遍（刻意不 import board.ts 的 attention）。
 * 两条互斥：被反对必然 checks>0，所以一条假设最多一个出声理由、最多一行提示。
 */
function needsAttention(h: H): boolean {
  if (h.contradicted > 0 && h.status !== 'retired') return true;
  return h.status === 'confirmed' && h.checks === 0;
}

/** 独立重算一次归因该落到哪个类别。不看引擎写的 problem，自己判。 */
function classify(
  testing: { id: string | null; field?: string } | undefined,
  state: Map<string, H>,
  prediction: { diffs: { field: string; status: string }[] } | undefined,
): { problem: string | null; use: { field: string; status: string }[] } {
  if (!testing) return { problem: null, use: [] };
  if (testing.id === null) return { problem: 'malformed', use: [] };
  if (!state.has(testing.id)) return { problem: 'unknown_target', use: [] };
  if (!prediction) return { problem: 'not_checked', use: [] };
  const use = testing.field === undefined
    ? prediction.diffs
    : prediction.diffs.filter((d) => d.field === testing.field);
  if (testing.field !== undefined && use.length === 0) return { problem: 'field_absent', use: [] };
  return { problem: null, use };
}

let grandBad = 0;
// 不带目录时循环一次都不执行，"总计不一致 0 处"就成了零样本假通过——审计最怕的就是这个。
if (process.argv.slice(2).length === 0) {
  console.error('❌ 没有指定任何 run 目录 → 本脚本一行都没审。零样本审计＝假通过，拒绝以 0 退出。');
  console.error('   用法: node verify/board-audit.ts runs/<runId> [...]（或先跑 verify/board-fixture.ts 生成夹具再审它）');
  process.exit(1);
}
for (const dir of process.argv.slice(2)) {
  const rows = readFileSync(`${dir}/trace.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const result = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8'));
  const steps = rows.filter((r) => r.decision);
  const writes = rows.filter((r) => r.kind === 'hypothesis_write').map((r) => r.payload);
  const boards = rows.filter((r) => r.kind === 'hypothesis_board').map((r) => r.payload);
  const hchecks = rows.filter((r) => r.kind === 'hypothesis_check').map((r) => r.payload);
  const hfb = rows.filter((r) => r.kind === 'hypothesis_feedback').map((r) => r.payload);

  console.log(`\n===== M4-b1 假设板独立审计 ${dir} =====`);
  const hasBoard = 'hypothesisStats' in result;
  if (!hasBoard && writes.length === 0 && boards.length === 0) {
    console.log('[版本] 证据里无 hypothesisStats / hypothesis_* 事件 → 该局跑在 M4-b 之前，属版本差异，本脚本不审它（也不假装通过）');
    continue;
  }
  console.log(`样本量：步=${steps.length} 写入事件=${writes.length} 板面快照=${boards.length} 归因事件=${hchecks.length} 归因出声=${hfb.length}`);
  if (steps.length === 0) { console.log('❌ 零样本审计＝假通过，中止'); grandBad++; continue; }
  if (!hasBoard) { console.log('❌ 有 hypothesis_* 事件却没有 hypothesisStats：账本缺项'); grandBad++; }

  const bad: string[] = [];
  const hs = result.hypothesisStats as Record<string, number> | undefined;
  // 版本纪律：故障 #13 的修正（自称 confirmed 却零核对也要出声）是中途落地的。
  // 旧版账本没有 confirmedNoChecks 字段，旧版板面也不会有那条提示——那是版本差异，不是不一致。
  // 按旧判据审它，但**必须大声报出来**：静默降级等于给篡改证据开了一条免检通道。
  const legacyNag = !hs || !('confirmedNoChecks' in hs);
  if (legacyNag) console.log('[版本] 账本无 confirmedNoChecks → 该局跑在故障 #13 修正之前，出声名单按旧判据（仅"被反对却未淘汰"）核对；零核对提示当时不存在，属版本差异，不混进错误数也不假装它通过了');
  const state = new Map<string, H>();
  const order: string[] = [];
  const counters = { attributed: 0, unattributed: 0, unknownTarget: 0, malformed: 0, notChecked: 0, fieldAbsent: 0, revised: 0 };
  const problemKey: Record<string, keyof typeof counters> = {
    unknown_target: 'unknownTarget', malformed: 'malformed', not_checked: 'notChecked', field_absent: 'fieldAbsent',
  };
  let plainNotes = 0;
  // 故障 #19 的版本差异计数：跨行正文的写入（新合约会拒，旧合约放过）
  let legacyMultiline = 0;

  // 板面快照是**决策前**渲染的，所以必须在处理该步的写入与归因**之前**比对。
  const boardAt = new Map<number, { text: string; nagging: string[] }>();
  for (const b of boards) boardAt.set(b.step, b);
  const writesAt = new Map<number, typeof writes>();
  for (const w of writes) {
    if (!writesAt.has(w.step)) writesAt.set(w.step, []);
    writesAt.get(w.step)!.push(w);
  }

  for (const s of steps) {
    const n = s.index as number;

    // ── 1. 板面快照 vs 独立重算的状态 ──
    const b = boardAt.get(n);
    const nonEmpty = state.size > 0 || plainNotes > 0;
    if (nonEmpty && !b) bad.push(`第${n}步板子非空却没有 hypothesis_board 快照：渲染了没落盘 = 故障 #11`);
    if (!nonEmpty && b) bad.push(`第${n}步板子是空的却落了快照`);
    if (b) {
      let parsed: ReturnType<typeof parseBoard>;
      try { parsed = parseBoard(b.text); } catch (e) { bad.push(`第${n}步板面解析失败：${(e as Error).message}`); parsed = { active: [], retired: [], notes: [] }; }
      const mineActive = [...state.values()].filter((h) => h.status !== 'retired');
      const mineRetired = [...state.values()].filter((h) => h.status === 'retired');
      const cmp = (label: string, got: H[], want: H[]) => {
        if (got.length !== want.length) { bad.push(`第${n}步 ${label} 条数 文本=${got.length} 重算=${want.length}`); return; }
        for (let i = 0; i < want.length; i++) {
          const g = got[i]!, w = want[i]!;
          for (const k of ['id', 'status', 'text', 'statusWhy', 'checks', 'supported', 'contradicted', 'unverifiable'] as const) {
            if (!eq(g[k], w[k])) bad.push(`第${n}步 ${label} ${w.id}.${k} 文本=${JSON.stringify(g[k])} 重算=${JSON.stringify(w[k])}`);
          }
        }
      };
      cmp('活跃区', parsed.active, mineActive);
      cmp('淘汰区', parsed.retired, mineRetired);
      // 出声名单必须由事实推出，不是引擎随口报的。
      // 两条互斥（被反对必然 checks>0）：被反对却未淘汰 / 自称 confirmed 却零核对（故障 #13）。
      const nag = [...state.values()]
        .filter((h) => (legacyNag ? h.contradicted > 0 && h.status !== 'retired' : needsAttention(h)))
        .map((h) => h.id);
      if (!eq([...b.nagging].sort(), [...nag].sort())) bad.push(`第${n}步 nagging 文本=${JSON.stringify(b.nagging)} 重算=${JSON.stringify(nag)}`);
      // 目标故障的直接判据：已淘汰的 id 绝不允许出现在活跃区
      for (const h of parsed.active) {
        if (h.status === 'retired') bad.push(`第${n}步 ${h.id} 已 retired 却仍在活跃区 → 假规则继续回喂`);
      }
      // 出声文本必须与名单一致（有名单就必须有提示行，反之亦然）
      const nagLines = b.text.split('\n').filter((l: string) => l.includes('代码提示：'));
      if (nagLines.length !== nag.length) bad.push(`第${n}步 提示行 ${nagLines.length} 条 ≠ 应出声 ${nag.length} 条`);
    }

    // ── 2. 写入：独立重放状态机 ──
    for (const w of writesAt.get(n) ?? []) {
      const inp = w.input as { id: string; text?: string; status?: string; why?: string };
      const id = String(inp.id ?? '').trim();
      const text = inp.text === undefined ? undefined : String(inp.text).trim();
      const status = inp.status === undefined ? undefined : String(inp.status).trim();
      const why = inp.why === undefined ? undefined : String(inp.why).trim();
      const cur = state.get(id);
      // 独立判该不该被拒
      let shouldOk = true;
      if (!id) shouldOk = false;
      else if (status !== undefined && !STATUSES.includes(status)) shouldOk = false;
      else if (text !== undefined && !text) shouldOk = false;
      // 故障 #19：跨行正文在新合约下会被拒。但**已发生的证据不能用今天的尺子追判**——
      // 那和故障 #16 是同一家族（旧版与新版长得一模一样，硬判只会造出伪不一致）。
      // 所以这里只数出来、单独一行报出去，不进 shouldOk；新合约本身由 test/board.test.ts 守。
      else if (text !== undefined && text.includes('\n')) legacyMultiline++;
      else if (!cur && text === undefined) shouldOk = false;
      else if (cur && text === undefined && status === undefined) shouldOk = false;
      if (shouldOk !== w.ok) bad.push(`第${n}步 ${id} 写入判定 引擎=${w.ok} 重算=${shouldOk}`);
      if (!shouldOk) {
        if (w.after !== null) bad.push(`第${n}步 ${id} 被拒却留下了 after 快照`);
        continue;
      }
      if (!cur) {
        state.set(id, blank(id, text!, status ?? 'proposed', why ?? '', n));
        order.push(id);
        if (!w.created) bad.push(`第${n}步 ${id} 是新建却没标 created`);
      } else {
        const textChanged = text !== undefined && text !== cur.text;
        const statusChanged = status !== undefined && status !== cur.status;
        if (textChanged !== w.textChanged) bad.push(`第${n}步 ${id} textChanged 引擎=${w.textChanged} 重算=${textChanged}`);
        if (statusChanged !== w.statusChanged) bad.push(`第${n}步 ${id} statusChanged 引擎=${w.statusChanged} 重算=${statusChanged}`);
        if (textChanged) { cur.text = text!; counters.revised++; }
        if (statusChanged) { cur.status = status!; cur.statusAtStep = n; }
        if (why !== undefined && why) cur.statusWhy = why;
      }
      // 引擎留下的 after 快照必须与重算结果一致（步号也核）
      const after = w.after as H | null;
      const mine = state.get(id)!;
      if (!after) bad.push(`第${n}步 ${id} 成功写入却没有 after 快照`);
      else for (const k of ['id', 'text', 'status', 'statusWhy', 'createdAtStep', 'statusAtStep', 'checks', 'supported', 'contradicted', 'unverifiable'] as const) {
        if (!eq(after[k], mine[k])) bad.push(`第${n}步 ${id} after.${k} 引擎=${JSON.stringify(after[k])} 重算=${JSON.stringify(mine[k])}`);
      }
    }

    // ── 3. 归因：独立分类 + 独立累加 ──
    const t = s.decision.testing as { id: string | null; field?: string } | undefined;
    const { problem, use } = classify(t, state, s.prediction);
    if (t) {
      const rec = hchecks.find((c) => c.step === n);
      if (!rec) bad.push(`第${n}步 声明了 testing 却没有 hypothesis_check 事件`);
      else {
        if (rec.problem !== problem) bad.push(`第${n}步 归因分类 引擎=${rec.problem} 重算=${problem}`);
        if (rec.id !== t.id) bad.push(`第${n}步 归因 id 引擎=${rec.id} 重算=${t.id}`);
        const sUp = use.filter((d) => d.status === 'ok').length;
        const cOn = use.filter((d) => d.status === 'violated').length;
        const uNv = use.filter((d) => d.status === 'unverifiable').length;
        if (rec.supported !== sUp || rec.contradicted !== cOn || rec.unverifiable !== uNv) {
          bad.push(`第${n}步 归因增量 引擎=${rec.supported}/${rec.contradicted}/${rec.unverifiable} 重算=${sUp}/${cOn}/${uNv}`);
        }
        if (!eq(rec.fields, use.map((d) => d.field))) bad.push(`第${n}步 归因字段 引擎=${JSON.stringify(rec.fields)} 重算=${JSON.stringify(use.map((d) => d.field))}`);
      }
      if (problem === null) {
        counters.attributed++;
        const h = state.get(t.id!)!;
        h.checks += use.length;
        h.supported += use.filter((d) => d.status === 'ok').length;
        h.contradicted += use.filter((d) => d.status === 'violated').length;
        h.unverifiable += use.filter((d) => d.status === 'unverifiable').length;
      } else counters[problemKey[problem]!]++;
      // 归因失败也必须出声（不丢），成功也要出声（增量可追溯）
      if (!hfb.some((f) => f.aboutStep === n)) bad.push(`第${n}步 有归因却没有 hypothesis_feedback 出声原文`);
    } else {
      if (s.prediction) counters.unattributed++;
      if (hchecks.some((c) => c.step === n)) bad.push(`第${n}步 没声明 testing 却记了归因 = 猜目标 = 伪造归因`);
    }

    // 纯笔记通道：无 id 且成功的 note
    if (s.decision.call.name === 'note' && s.result.ok && (s.decision.call.args as Record<string, unknown>)['id'] === undefined) plainNotes++;
  }

  // ── 4. 局末快照 vs 独立重算 ──
  const finalH = result.hypotheses as H[] | undefined;
  if (!finalH) { bad.push('result.json 缺 hypotheses'); }
  else {
    if (!eq(finalH.map((h) => h.id), order)) bad.push(`局末 id 顺序 引擎=${JSON.stringify(finalH.map((h) => h.id))} 重算=${JSON.stringify(order)}`);
    for (const h of finalH) {
      const m = state.get(h.id);
      if (!m) { bad.push(`局末多出假设 ${h.id}`); continue; }
      for (const k of ['text', 'status', 'statusWhy', 'createdAtStep', 'statusAtStep', 'checks', 'supported', 'contradicted', 'unverifiable'] as const) {
        if (!eq(h[k], m[k])) bad.push(`局末 ${h.id}.${k} 引擎=${JSON.stringify(h[k])} 重算=${JSON.stringify(m[k])}`);
      }
      if (h.supported + h.contradicted + h.unverifiable !== h.checks) bad.push(`局末 ${h.id} 计数不闭合`);
    }
  }

  // ── 5. 账本聚合 ──
  const nagFinal = [...state.values()].filter((h) => h.contradicted > 0 && h.status !== 'retired').map((h) => h.id);
  const noChecksFinal = [...state.values()].filter((h) => h.status === 'confirmed' && h.checks === 0).map((h) => h.id);
  const expect: Record<string, number> = {
    proposed: [...state.values()].filter((h) => h.status === 'proposed').length,
    confirmed: [...state.values()].filter((h) => h.status === 'confirmed').length,
    retired: [...state.values()].filter((h) => h.status === 'retired').length,
    revised: counters.revised,
    plainNotes,
    attributed: counters.attributed,
    unattributed: counters.unattributed,
    unknownTarget: counters.unknownTarget,
    malformed: counters.malformed,
    notChecked: counters.notChecked,
    fieldAbsent: counters.fieldAbsent,
    contradictedNotRetired: nagFinal.length,
  };
  // 旧版没有这项，单独报版本差异，不混进错误数（与 predict-audit 对 staticChecks 同一条纪律）
  if (!legacyNag) expect['confirmedNoChecks'] = noChecksFinal.length;
  const aggBad = hs ? Object.entries(expect).filter(([k, v]) => hs[k] !== v).map(([k, v]) => `${k} 账本=${hs[k]} 重算=${v}`) : ['hypothesisStats 缺失'];
  console.log(`[重算] 假设 ${state.size} 条（${order.join(', ') || '无'}）；纯笔记 ${plainNotes} 条；归因成功 ${counters.attributed} 步`);
  console.log(`[状态机] 写入 ${writes.length} 次（被拒 ${writes.filter((w) => !w.ok).length} 次）；板面快照 ${boards.length} 份逐项比对`);
  console.log(`[形状] 跨行正文的写入 = ${legacyMultiline} 次${legacyMultiline ? '——该局跑在故障 #19 之前（当时写入路径不拦换行），属版本差异：不追判成不一致，也不因此说板面合约已验证；新合约由 test/board.test.ts 守' : '（合约要求一条假设占一行，本局无违例）'}`);
  console.log(`[账本] ${aggBad.length === 0 ? `${Object.keys(expect).length} 项聚合逐项对得上 ✅` : '**对不上** ❌ ' + aggBad.join('; ')}${legacyNag ? '（另：confirmedNoChecks 属版本差异，未参与比对）' : ''}`);
  console.log(`[闭合] ${bad.some((x) => x.includes('不闭合')) ? '❌ 存在三态之和 ≠ checks' : '每条假设 支持+反对+无法核对 === 核对次数 ✅'}`);
  console.log(`[驻留] 收手时仍被反对却未淘汰 = ${nagFinal.length} 条${nagFinal.length ? `（${nagFinal.join(', ')}）` : ''}`);
  console.log(`[脱钩] 收手时自称 confirmed 却零客观核对 = ${noChecksFinal.length} 条${noChecksFinal.length ? `（${noChecksFinal.join(', ')}）→ 淘汰机制永不触发` : ''}${legacyNag ? '［该版本既不出声也不记账，属版本差异］' : ''}`);

  // ── 6. 送达：板面原文落盘了，且那一步真的发生过请求 ──
  // 判据：假设板由循环层在 decide **之前**渲染并随请求下发，
  // 所以只要"第 N 步发生过请求"，就能推出"第 N 步的板面进过那次 payload"。
  // 请求发生过有两种证据，必须分开记：
  //   a) 第 N 步有步记录 → 决策成功，最强证据
  //   b) 无步记录，但有该步的 brain_error / brain_retry → 请求发出去了、大脑没给出可用决策
  //      真跑里免费额度 429 就长这样：板子渲染了、请求撞墙了、整局终止（runs/20261113-215401-s6 第 10 步）
  // 两者都没有 = 渲染了却连请求都没发出，那才是缺陷。
  // 刻意不把 b) 算成"未送达"：prediction_feedback 是**决策后**回填，整局结束就真的没送到；
  // 板子是**决策前**下发，请求撞墙时它已经在 payload 里了。两个通道时序不同，判据必须不同。
  const attempted = new Set<number>();
  for (const r of rows) if (r.kind === 'brain_error' || r.kind === 'brain_retry') attempted.add(r.payload.step as number);
  let delivered = 0, failedStep = 0, neverSent = 0;
  for (const bb of boards) {
    if (steps.some((s) => s.index === bb.step)) delivered++;
    else if (attempted.has(bb.step)) failedStep++;
    else neverSent++;
  }
  console.log(`[送达] 板面快照=${boards.length} 决策成功可证=${delivered} 请求已发出但该步无决策=${failedStep} 连请求都没发出=${neverSent}`);
  if (neverSent) bad.push(`${neverSent} 份板面快照既无步记录也无 brain_error/brain_retry：渲染了却没发请求`);

  // ── 7. 主客观分侧（defect.json 若存在）──
  let sideBad = 0;
  try {
    const defect = JSON.parse(readFileSync(`${dir}/defect.json`, 'utf8'));
    const claimed = (defect.agentClaims?.hypotheses ?? []) as Record<string, unknown>[];
    const counted = (defect.hypothesisChecks ?? []) as Record<string, unknown>[];
    for (const c of claimed) for (const k of ['checks', 'supported', 'contradicted', 'unverifiable']) {
      if (k in c) { console.log(`   ❌ 客观计数 ${k} 混进了 agentClaims`); sideBad++; }
    }
    for (const c of counted) for (const k of ['text', 'status', 'statusWhy']) {
      if (k in c) { console.log(`   ❌ 主观字段 ${k} 混进了 hypothesisChecks`); sideBad++; }
    }
    if (!eq(claimed.map((c) => c['id']), counted.map((c) => c['id']))) { console.log('   ❌ 两侧 id 对不上，无法对账'); sideBad++; }
    if (!eq(defect.hypothesisStats, result.hypothesisStats)) { console.log('   ❌ defect.json 与 result.json 的账本不一致'); sideBad++; }
    console.log(`[分侧] 主观 ${claimed.length} 条 / 客观 ${counted.length} 条，靠 id 对账 ${sideBad === 0 ? '✅' : '❌'}`);
  } catch { console.log('[分侧] 无 defect.json（files 模式），跳过'); }

  for (const x of bad.slice(0, 20)) console.log(`   ❌ ${x}`);
  if (bad.length > 20) console.log(`   …另有 ${bad.length - 20} 处`);
  console.log(`[结论] 本局不一致 ${bad.length + aggBad.length + sideBad} 处`);
  grandBad += bad.length + aggBad.length + sideBad;
}

console.log(`\n===== 总计不一致 ${grandBad} 处 =====`);
process.exit(grandBad === 0 ? 0 : 1);