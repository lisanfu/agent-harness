/**
 * M4-b2 目标通道独立审计：**不 import goal.ts / prompt.ts / world/goal.ts / value.ts**，
 * 另写一套状态机、屏幕解析、等值核对与合取判据，从证据文件把整条目标通道重算一遍，
 * 再与引擎记录逐项比对。理由与前两个审计相同：拿同一份代码验同一份代码，
 * 只能证明它自洽，不能证明它对。
 *
 * 分工边界（刻意不重叠）：
 *   predict-audit.ts 审「预测差异算得对不对」——那是两帧之间的**差值**。
 *   board-audit.ts   审归因分类与假设状态机——那是规律，代码判不出真假。
 *   本脚本只审目标通道：声明校验、条件归一化、逐步判定与三态合取、计数、渲染、
 *   出声名单、送达、账本聚合、主客观分侧，外加 b2 新增的**跨通道对账**。
 *
 * 跨通道是这一份的核心增量：目标判定吃的是**画面**（有损投影的逆投影），
 * coverage 吃的是**内部状态**。两条完全独立的路径若在同一局里给出矛盾答案，
 * 错的一定是 harness 而不是 agent——hp=0 那条尤其致命，M07 全靠它。
 *
 * 版本纪律：goal_* 事件与 goalStats 是 M4-b2 才落地的。
 *   证据里没有 → 那是版本差异，单独报，不混进错误数，也不假装它通过了。
 *   一旦认定这一局是新版，样本量为 0 立刻中止：零样本审计＝假通过。
 *
 * 用法: node verify/goal-audit.ts <runDir> [<runDir> ...]
 */
import { readFileSync } from 'node:fs';

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 独立实现的 canonical：排序键的稳定 JSON。条件是否被改写要靠它比，字段顺序不算改写。 */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  }
  return v;
}
const canonStr = (v: unknown): string => JSON.stringify(canon(v));

const STATUSES = ['open', 'achieved', 'abandoned'];
const FIELDS = ['hp', 'score', 'playerAt', 'enemyCount', 'pickupCount', 'alive', 'attackReady'];

interface G {
  id: string; text: string; status: string; statusWhy: string;
  doneWhen: Record<string, unknown> | null; doneWhenRaw?: unknown;
  createdAtStep: number; statusAtStep: number;
  checks: number; met: number; unmet: number; unverifiable: number;
  firstMetStep: number | null; lastCheckedStep: number | null;
}
const blank = (id: string, text: string, status: string, why: string, step: number): G =>
  ({ id, text, status, statusWhy: why, doneWhen: null, createdAtStep: step, statusAtStep: step,
    checks: 0, met: 0, unmet: 0, unverifiable: 0, firstMetStep: null, lastCheckedStep: null });

/** 有没有可核对的条件。空对象与 null 一样判不出，绝不能凭空记一次达成。 */
const checkable = (g: G): boolean => g.doneWhen !== null && Object.keys(g.doneWhen).length > 0;

/** 该不该出声。三条互斥，所以一条目标最多一行提示——判据独立重写，绝不 import goal.ts。 */
function attention(g: G): 'met_not_closed' | 'closed_never_met' | 'uncheckable' | null {
  if (g.met > 0 && g.status === 'open') return 'met_not_closed';
  if (g.status === 'achieved' && g.met === 0) return 'closed_never_met';
  if (g.status === 'open' && (!checkable(g) || (g.checks > 0 && g.met === 0 && g.unmet === 0))) return 'uncheckable';
  return null;
}

// ── 另写一套屏幕解析：走 indexOf / split / includes 这条路，与 observe.ts 的逐字符循环不同 ──
function mine(screen: string) {
  const rows = screen.split('\n')
    .filter((l) => l.length > 2 && l[0] === '|' && l[l.length - 1] === '|')
    .map((l) => l.slice(1, -1));
  const widths = new Set(rows.map((r) => r.length));
  const gridOk = rows.length > 0 && widths.size === 1;
  const count = (ch: string) => rows.reduce((n, r) => n + r.split(ch).length - 1, 0);
  const at = (ch: string): [number, number] | null => {
    for (let y = 0; y < rows.length; y++) { const x = rows[y]!.indexOf(ch); if (x >= 0) return [x, y]; }
    return null;
  };
  const hud = screen.split('\n').find((l) => l.indexOf('HP ') === 0) ?? '';
  const hp = /(\-?\d+)\/(\-?\d+)/.exec(hud);
  return {
    gridOk,
    hp: hp ? Number(hp[1]) : null,
    score: /分数\s*(\-?\d+)/.test(hud) ? Number(/分数\s*(\-?\d+)/.exec(hud)![1]) : null,
    tick: /第\s*(\-?\d+)\s*帧/.test(hud) ? Number(/第\s*(\-?\d+)\s*帧/.exec(hud)![1]) : null,
    player: gridOk ? at('@') : null,
    enemies: gridOk ? count('E') : null,
    pickups: gridOk ? count('+') : null,
    alive: screen.includes('状态：活着') ? true : screen.includes('状态：已倒下') ? false : null,
    ready: screen.includes('攻击：就绪') ? true : screen.includes('攻击：冷却中') ? false : null,
  };
}
type Mine = ReturnType<typeof mine>;
/** 画面上七个可核对量。网格没解析出来时计数与坐标一律 null，空值会被读成"画面里没有敌人"。 */
function actuals(m: Mine): Record<string, unknown> {
  return {
    hp: m.hp, score: m.score, playerAt: m.player,
    enemyCount: m.enemies, pickupCount: m.pickups, alive: m.alive, attackReady: m.ready,
  };
}
const isScreen = (t: unknown): boolean =>
  typeof t === 'string' && /(^|\n)HP /.test(t) && /\n\|.*\|/.test(t);

/** 期望值的归一化：与引擎同档宽容度，但独立实现。认不出就 null，绝不猜一个值。 */
function wantOf(field: string, v: unknown): unknown {
  const asNum = (x: unknown): number | null =>
    typeof x === 'number' && Number.isFinite(x) ? x
      : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null;
  const asBool = (x: unknown): boolean | null =>
    typeof x === 'boolean' ? x
      : typeof x === 'string' && /^(true|false)$/i.test(x.trim()) ? x.trim().toLowerCase() === 'true' : null;
  if (field === 'hp' || field === 'score' || field === 'enemyCount' || field === 'pickupCount') return asNum(v);
  if (field === 'alive' || field === 'attackReady') return asBool(v);
  if (field === 'playerAt') {
    if (Array.isArray(v) && v.length === 2) { const x = asNum(v[0]), y = asNum(v[1]); return x === null || y === null ? null : [x, y]; }
    if (typeof v === 'string') { const p = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(v); return p ? [Number(p[1]), Number(p[2])] : null; }
    if (v && typeof v === 'object') { const o = v as Record<string, unknown>; const x = asNum(o['x']), y = asNum(o['y']); return x === null || y === null ? null : [x, y]; }
  }
  return null;
}

/** 逐字段核对 + 合取。三态的优先序独立写一遍：violated 压过 unverifiable，其余无法核对才算无法判定。 */
function evalCond(cond: Record<string, unknown>, m: Mine) {
  const act = actuals(m);
  const diffs: { field: string; predicted: unknown; actual: unknown; status: string }[] = [];
  for (const [field, raw] of Object.entries(cond)) {
    const known = FIELDS.includes(field);
    const want = known ? wantOf(field, raw) : null;
    const actual = known ? act[field] ?? null : null;
    const status = want === null || actual === null ? 'unverifiable' : eq(want, actual) ? 'ok' : 'violated';
    diffs.push({ field, predicted: raw, actual, status });
  }
  const met = diffs.length === 0 ? null
    : diffs.some((d) => d.status === 'violated') ? false
      : diffs.some((d) => d.status === 'unverifiable') ? null : true;
  return { diffs, met };
}

/**
 * 另写一套目标板文本解析：逐行正则抽取，与渲染器的拼字符串路径完全不同。
 * 抬头字面量刻意硬编码——渲染器改了抬头，审计必须**大声失败**，
 * 而不是跟着 import 常量一起改、继续互相印证。
 */
function parseGoals(text: string): { active: G[]; closed: G[] } {
  const lines = text.split('\n');
  const iActive = lines.findIndex((l) => l.includes('在追的目标'));
  const iClosed = lines.findIndex((l) => l.includes('已收口或已放弃'));
  const grab = (from: number, to: number): G[] => {
    if (from < 0) return [];
    const seg = lines.slice(from + 1, to < 0 ? lines.length : to);
    const out: G[] = [];
    for (let i = 0; i < seg.length; i++) {
      const head = /^- (\S+) \[(\w+)\] (.*)$/.exec(seg[i]!);
      if (!head) continue;
      const condLine = seg[i + 1] ?? '';
      const cj = /^    完成条件 (.*)$/.exec(condLine);
      const noCond = /^    完成条件：还没有可核对的条件/.test(condLine);
      if (!cj && !noCond) throw new Error(`目标 ${head[1]} 的第二行不是完成条件行，渲染形状不对`);
      const cnt = /^    客观判定 (\d+) 次：满足 (\d+) \/ 不满足 (\d+) \/ 无法核对 (\d+)$/.exec(seg[i + 2] ?? '');
      if (!cnt) throw new Error(`目标 ${head[1]} 没有客观判定行，渲染形状不对`);
      const first = /^    首次满足：第 (\d+) 步$/.exec(seg[i + 3] ?? '');
      const body = head[3]!;
      const why = /（你的理由：(.*)）$/.exec(body);
      const g = blank(head[1]!, why ? body.slice(0, why.index) : body, head[2]!, why ? why[1]! : '', -1);
      g.doneWhen = cj ? JSON.parse(cj[1]!) as Record<string, unknown> : null;
      if (noCond) g.doneWhen = null;
      g.checks = Number(cnt[1]); g.met = Number(cnt[2]); g.unmet = Number(cnt[3]); g.unverifiable = Number(cnt[4]);
      g.firstMetStep = first ? Number(first[1]) : null;
      g.createdAtStep = -1; g.statusAtStep = -1; g.lastCheckedStep = null;
      g.doneWhenRaw = undefined;
      out.push(g);
      // 一条目标最多一行提示；提示行不参与逐字段比对，另由文案一致性检查管
      if (seg[i + 4] !== undefined && seg[i + 4]!.includes('代码提示：')) i += 1;
    }
    return out;
  };
  return { active: grab(iActive, iClosed), closed: grab(iClosed, -1) };
}

let grandBad = 0;
// 不带目录的 "总计不一致 0 处" 是最坏的一种假通过：审计一行没审，报表却全绿。
// npm run verify:goal 必须始终带上要审的 run 目录，否则这条判据直接把它拦下来。
if (process.argv.slice(2).length === 0) {
  console.error('❌ 没有指定任何 run 目录 → 本脚本一行都没审。零样本审计＝假通过，拒绝以 0 退出。');
  console.error('   用法: node verify/goal-audit.ts runs/<runId> [...]（或先跑 verify/goal-fixture.ts 生成夹具再审它）');
  process.exit(1);
}
for (const dir of process.argv.slice(2)) {
  const rows = readFileSync(`${dir}/trace.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  const header = JSON.parse(readFileSync(`${dir}/header.json`, 'utf8'));
  const result = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8'));
  const steps = rows.filter((r) => r.decision);
  const writes = rows.filter((r) => r.kind === 'goal_write').map((r) => r.payload);
  const boards = rows.filter((r) => r.kind === 'goal_board').map((r) => r.payload);
  const checks = rows.filter((r) => r.kind === 'goal_check').map((r) => r.payload);
  const fbs = rows.filter((r) => r.kind === 'goal_feedback').map((r) => r.payload);

  console.log(`\n===== M4-b2 目标通道独立审计 ${dir} =====`);
  const hasGoal = 'goalStats' in result;
  // 先认"这一局到底有没有目标通道"，再决定审不审。三条来源，可信度不同，必须分开用：
  //   seams.goal          循环层的**声明**（最可信，但它自己也能被删）
  //   initialState.goals  器官存在时才会写的**旁证**
  //   goal_* 事件/goalStats 通道**真跑过**的痕迹
  const declared = header.seams?.goal as boolean | undefined;
  const seamByEvidence = Array.isArray(header.initialState?.goals);
  const anyGoal = writes.length + checks.length + boards.length + fbs.length > 0 || hasGoal;

  if (declared === false) {
    if (anyGoal) {
      console.log(`   ❌ header 声明 seams.goal=false，证据里却留着 ${writes.length + checks.length + boards.length + fbs.length} 条 goal_* 事件（goalStats=${hasGoal}）：开关与产物互相矛盾`);
      grandBad++;
    } else {
      console.log('[消融] seams.goal=false 且没有任何 goal 产物 → 这一局**如实**关掉了目标通道（M4-e 的对照组）');
      console.log('        本脚本无物可审：这一局既不算通过，也不算失败，它的作用是给"有没有目标通道"提供一个真对照组。');
    }
    continue;
  }
  if (declared === undefined && !seamByEvidence && !hasGoal && !anyGoal) {
    console.log('[版本] 证据里没有 seams 声明、没有 initialState.goals、也没有任何 goal 产物');
    console.log('        → 该局跑在 M4-b2 之前，属版本差异，本脚本不审它（也不假装通过）');
    console.log('        ⚠️ 残余局限：把 seams 整块删掉仍能冒充这一档。证据层防得住部分删改，防不住全删——');
    console.log('          后者只能靠运行记录与 outDir 命名区分，报告里必须写清这条界线。');
    continue;
  }
  if (declared === undefined) {
    console.log('[版本] 证据里没有 seams 声明（该局跑在声明落地之前）→ 只能按 initialState.goals 与 goal_* 产物倒推通道开没开');
  }
  console.log(`样本量：步=${steps.length} 写入=${writes.length} 判定=${checks.length} 板面快照=${boards.length} 首次满足回填=${fbs.length}`);
  if (steps.length === 0) { console.log('❌ 零样本审计＝假通过，中止'); grandBad++; continue; }
  if (!hasGoal) { console.log('❌ 通道是开着的（声明或产物为证），账本里却没有 goalStats：被删了或没落盘'); grandBad++; }
  // 三种"零样本"必须分开说，混为一谈就把被测对象的行为读成了 harness 的故障：
  //   接口没给（上面已 return）／ 接口给了但大脑一次都没用 ／ 用了却一条都没判
  if (hasGoal && writes.length === 0) {
    // 文案必须如实报出"这条结论是哪来的"：旧版证据没有 seams，就不能说"seams.goal=true 且 goalStats 在"。
    // 审计自己也得遵守"文案与形状一致"——它对模型提的那条要求，不能对自己豁免。
    const basis = declared === true ? 'seams.goal=true 且 goalStats 在'
      : '无 seams 声明，仅 goalStats 在（按产物倒推通道开着）';
    console.log(`[使用率] 接口给了（${basis}）却一次 goal 调用都没有 → 这是**一等的负结果**，不是通过也不是故障`);
    console.log('        报告里要写成"该局模型没用目标通道"，而不是"目标通道已验证"。无可审样本，本局到此为止。');
    const zero = ['declared', 'revised', 'conditionRevised', 'rejected', 'checks', 'met', 'unmet', 'unverifiable']
      .filter((k) => (result.goalStats as Record<string, number>)?.[k] !== 0);
    if (zero.length) { console.log(`   ❌ 没有任何写入，账本却记了这些项非 0：${zero.join(', ')}`); grandBad += zero.length; }
    continue;
  }
  if (hasGoal && checks.length === 0) { console.log('❌ 有声明却一条判定都没发生：接缝给了但没跑＝故障 #8 的第三种形态'); grandBad++; }

  const bad: string[] = [];
  const gs = result.goalStats as Record<string, number> | undefined;

  // ── 索引：按步号分桶 ──
  const writesAt = new Map<number, Record<string, any>[]>();
  for (const w of writes) { if (!writesAt.has(w.step)) writesAt.set(w.step, []); writesAt.get(w.step)!.push(w); }
  const checkAt = new Map<string, Record<string, any>>();
  for (const c of checks) checkAt.set(`${c.step}|${c.id}`, c);
  const boardAt = new Map<number, Record<string, any>>();
  for (const b of boards) boardAt.set(b.step, b);

  const state = new Map<string, G>();
  const order: string[] = [];
  const cnt = { declared: 0, revised: 0, conditionRevised: 0, rejected: 0, malformed: 0,
    checks: 0, met: 0, unmet: 0, unverifiable: 0 };
  let cur = mine(header.initialState?.world?.screen ?? '');
  if (!isScreen(header.initialState?.world?.screen)) bad.push('header 里的初始画面解析不出来，后续判定全部失去基准');
  const hpTrail: number[] = [];
  if (cur.hp !== null) hpTrail.push(cur.hp);
  const firstHpZeroStep = { step: -1 };

  for (const s of steps) {
    const n = s.index as number;

    // ── 1. 板面快照 vs 到上一步为止的重算 ──
    // 快照是 decide **之前**渲染的，所以必须在本步写入与判定**之前**比对。
    const b = boardAt.get(n);
    const nonEmpty = state.size > 0;
    if (nonEmpty && !b) bad.push(`第${n}步目标板非空却没有 goal_board 快照：渲染了没落盘 = 故障 #11`);
    if (!nonEmpty && b) bad.push(`第${n}步目标板是空的却落了快照`);
    if (b) {
      let parsed: ReturnType<typeof parseGoals>;
      try { parsed = parseGoals(b.text); } catch (e) { bad.push(`第${n}步板面解析失败：${(e as Error).message}`); parsed = { active: [], closed: [] }; }
      const mine_ = (want: 'open' | 'closed') => [...state.values()].filter((g) => want === 'open' ? g.status === 'open' : g.status !== 'open');
      const cmp = (label: string, got: G[], want: G[]) => {
        if (got.length !== want.length) { bad.push(`第${n}步 ${label} 条数 文本=${got.length} 重算=${want.length}`); return; }
        for (let i = 0; i < want.length; i++) {
          const g = got[i]!, w = want[i]!;
          for (const k of ['id', 'status', 'text', 'statusWhy', 'checks', 'met', 'unmet', 'unverifiable', 'firstMetStep'] as const) {
            if (!eq(g[k], w[k])) bad.push(`第${n}步 ${label} ${w.id}.${k} 文本=${JSON.stringify(g[k])} 重算=${JSON.stringify(w[k])}`);
          }
          if (canonStr(g.doneWhen) !== canonStr(w.doneWhen)) bad.push(`第${n}步 ${label} ${w.id}.doneWhen 文本=${canonStr(g.doneWhen)} 重算=${canonStr(w.doneWhen)}`);
        }
      };
      cmp('在追区', parsed.active, mine_('open'));
      cmp('留档区', parsed.closed, mine_('closed'));
      // 目标故障的直接判据：非 open 的目标绝不允许出现在"在追"区（那等于已收口的意图继续回喂）
      for (const g of parsed.active) if (g.status !== 'open') bad.push(`第${n}步 ${g.id} 状态是 ${g.status} 却在在追区`);
      for (const g of parsed.closed) if (g.status === 'open') bad.push(`第${n}步 ${g.id} 还在追却被塞进留档区`);

      // 出声名单必须由事实推出，不是引擎随口报的
      const nag = [...state.values()].filter((g) => attention(g) !== null).map((g) => g.id);
      if (!eq([...b.nagging].sort(), [...nag].sort())) bad.push(`第${n}步 nagging 文本=${JSON.stringify(b.nagging)} 重算=${JSON.stringify(nag)}`);
      const nagLines = b.text.split('\n').filter((l: string) => l.includes('代码提示：'));
      if (nagLines.length !== nag.length) bad.push(`第${n}步 提示行 ${nagLines.length} 条 ≠ 应出声 ${nag.length} 条`);

      // 文案与事实一致：出声说的是代码算出的事实，一旦与这条目标的形状矛盾，
      // 模型据它做的任何修正都建在谎上。夹具里的 G9（{hp,enemyCount,foo}）就是被抓出来的那一条。
      const nagById = new Map<string, string>();
      {
        const ls: string[] = b.text.split('\n'); let last = '';
        for (const l of ls) { const h = /^- (\S+) \[/.exec(l); if (h) last = h[1]!; if (l.includes('代码提示：')) nagById.set(last, l); }
      }
      for (const id of nag) {
        const g = state.get(id)!;
        const text = nagById.get(id);
        if (text === undefined) { bad.push(`第${n}步 ${id} 该出声却没有提示行`); continue; }
        const a = attention(g);
        if (!text.includes('由你判断') && !text.includes('代码不会')) bad.push(`第${n}步 ${id} 提示没把判断权交回模型：${text}`);
        for (const w of ['你应该', '建议', '请标 achieved', '该收手', '优先']) if (text.includes(w)) bad.push(`第${n}步 ${id} 越界措辞「${w}」`);
        if (a === 'met_not_closed' && !text.includes('画面已经满足过')) bad.push(`第${n}步 ${id} met_not_closed 却念了别的文案`);
        if (a === 'closed_never_met' && !text.includes('从未满足过')) bad.push(`第${n}步 ${id} closed_never_met 却念了别的文案`);
        if (a === 'uncheckable') {
          if (!text.includes('判不出结果')) bad.push(`第${n}步 ${id} uncheckable 却念了别的文案`);
          if (checkable(g)) {
            // 有完成条件却每轮都判不出：不能说"没写条件"，也不能说"字段全不在词表内"
            if (text.includes('还没有可核对的完成条件')) bad.push(`第${n}步 ${id} 明明写了条件，文案却说它没有`);
            if (text.includes('全不在词表内')) bad.push(`第${n}步 ${id} 条件里有可判字段，文案谎称"全不在词表内"`);
            if (!new RegExp(`判定 ${g.checks} 轮的结果全是「无法核对」`).test(text)) bad.push(`第${n}步 ${id} 文案没如实报出 ${g.checks} 轮全无法核对`);
          } else if (!text.includes('还没有可核对的完成条件')) {
            bad.push(`第${n}步 ${id} 没有条件，文案却不含"还没有可核对的完成条件"`);
          }
        }
      }
    }

    // ── 2. 写入：独立重放状态机 ──
    for (const w of writesAt.get(n) ?? []) {
      const inp = w.input as Record<string, unknown>;
      const id = String(inp['id'] ?? '').trim();
      const text = inp['text'] === undefined ? undefined : String(inp['text']).trim();
      const status = inp['status'] === undefined ? undefined : String(inp['status']).trim();
      const why = inp['why'] === undefined ? undefined : String(inp['why']).trim();
      const given = inp['doneWhen'] !== undefined && inp['doneWhen'] !== null;
      const malformed = given && (typeof inp['doneWhen'] !== 'object' || Array.isArray(inp['doneWhen']));
      const cond: Record<string, unknown> | null = given ? (malformed ? null : { ...(inp['doneWhen'] as Record<string, unknown>) }) : null;
      const cur0 = state.get(id);

      // 该不该被拒，独立判一遍
      let ok = true;
      if (!id) ok = false;
      else if (status !== undefined && !STATUSES.includes(status)) ok = false;
      else if (text !== undefined && !text) ok = false;
      else if (!cur0 && text === undefined) ok = false;
      else if (cur0 && text === undefined && status === undefined && inp['doneWhen'] === undefined) ok = false;
      if (ok !== w.ok) bad.push(`第${n}步 ${id} 写入判定 引擎=${w.ok} 重算=${ok}`);
      if (!ok) {
        if (w.after !== null) bad.push(`第${n}步 ${id} 被拒却留下了 after 快照`);
        cnt.rejected++;
        continue;
      }
      // 形状歪：收下并留原文，绝不猜（整条拒绝会抹掉"模型确实想立目标"这个行为）
      if (malformed) cnt.malformed++;
      if (!cur0) {
        const g = blank(id, text!, status ?? 'open', why ?? '', n);
        g.doneWhen = cond;
        if (malformed) g.doneWhenRaw = inp['doneWhen'];
        state.set(id, g); order.push(id);
        cnt.declared++;
        if (!w.created) bad.push(`第${n}步 ${id} 是新建却没标 created`);
      } else {
        const textChanged = text !== undefined && text !== cur0.text;
        const statusChanged = status !== undefined && status !== cur0.status;
        const conditionChanged = inp['doneWhen'] !== undefined
          && canonStr({ c: cond, r: malformed ? inp['doneWhen'] : null })
            !== canonStr({ c: cur0.doneWhen, r: cur0.doneWhenRaw ?? null });
        if (textChanged !== w.textChanged) bad.push(`第${n}步 ${id} textChanged 引擎=${w.textChanged} 重算=${textChanged}`);
        if (statusChanged !== w.statusChanged) bad.push(`第${n}步 ${id} statusChanged 引擎=${w.statusChanged} 重算=${statusChanged}`);
        if (conditionChanged !== w.conditionChanged) bad.push(`第${n}步 ${id} conditionChanged 引擎=${w.conditionChanged} 重算=${conditionChanged}`);
        if (textChanged) { cur0.text = text!; cnt.revised++; }
        if (conditionChanged) cnt.conditionRevised++;
        if (statusChanged) { cur0.status = status!; cur0.statusAtStep = n; }
        if (why !== undefined && why) cur0.statusWhy = why;
        if (inp['doneWhen'] !== undefined) {
          cur0.doneWhen = cond;
          if (malformed) cur0.doneWhenRaw = inp['doneWhen']; else delete cur0.doneWhenRaw;
        }
      }
      const after = w.after as Record<string, any>;
      const m = state.get(id)!;
      for (const k of ['id', 'text', 'status', 'statusWhy', 'createdAtStep', 'statusAtStep', 'checks', 'met', 'unmet', 'unverifiable', 'firstMetStep', 'lastCheckedStep'] as const) {
        if (after && !eq(after[k], m[k])) bad.push(`第${n}步 ${id} after.${k} 引擎=${JSON.stringify(after[k])} 重算=${JSON.stringify(m[k])}`);
      }
      if (after && canonStr(after['doneWhen']) !== canonStr(m.doneWhen)) bad.push(`第${n}步 ${id} after.doneWhen 引擎=${canonStr(after['doneWhen'])} 重算=${canonStr(m.doneWhen)}`);
      // 代码不许改 status：板上那条状态必须永远是模型上一次声明的值
      if (status !== undefined && after && after['status'] !== status) bad.push(`第${n}步 ${id} 声明 status=${status}，落盘却是 ${after['status']} = 代码代它改了`);
    }

    // 声明了 goal 却没有写入事件：只允许是"参数在校验层就被拒"那一种
    if (s.decision.call.name === 'goal') {
      const has = (writesAt.get(n) ?? []).length > 0;
      if (!has && s.result.ok) bad.push(`第${n}步 调了 goal、工具还成功，却没有 goal_write 事件 = 声明凭空消失`);
      if (!has && !s.result.ok) {
        // 校验层拒绝的理由必须可行动（ACI），不能只是一句 invalid
        const msg = String(s.result.output ?? '');
        if (!msg) bad.push(`第${n}步 goal 被拒却没有留下任何理由`);
      }
    }
    // 宽容度不许变成静默改写：事件里的 input 可以与模型字面给的 args 不同，
    // 但只允许"字符串 JSON 解析成同一个对象"这一种差异。
    for (const w of writesAt.get(n) ?? []) {
      const lit = (s.decision.call.args as Record<string, unknown>)['doneWhen'];
      const rec = (w.input as Record<string, unknown>)['doneWhen'];
      if (eq(lit, rec)) continue;
      let parsed: unknown = null;
      try { parsed = typeof lit === 'string' ? JSON.parse(lit) : null; } catch { parsed = null; }
      if (parsed === null || !eq(canon(parsed), canon(rec))) bad.push(`第${n}步 ${w.id} input.doneWhen=${canonStr(rec)} 与模型字面 args=${JSON.stringify(lit)} 不是同一意图 = 静默改写`);
    }

    // ── 3. 画面推进：只有真正返回画面的步才换帧 ──
    if (s.result.ok && isScreen(s.result.output)) cur = mine(s.result.output as string);
    if (cur.hp !== null && cur.hp <= 0 && firstHpZeroStep.step < 0) firstHpZeroStep.step = n;
    if (cur.hp !== null && hpTrail[hpTrail.length - 1] !== cur.hp) hpTrail.push(cur.hp);

    // ── 4. 判定：每步对**每条有完成条件的目标**判一次，不看 status ──
    for (const g of [...state.values()]) {
      if (!checkable(g)) {
        if (checkAt.has(`${n}|${g.id}`)) bad.push(`第${n}步 ${g.id} 没有可核对的条件却被判了一次 = 凭空记一次达成`);
        continue;
      }
      const { diffs, met } = evalCond(g.doneWhen!, cur);
      const firstMet = met === true && g.firstMetStep === null;
      g.checks++; cnt.checks++;
      if (met === true) { g.met++; cnt.met++; if (firstMet) g.firstMetStep = n; }
      else if (met === false) { g.unmet++; cnt.unmet++; }
      else { g.unverifiable++; cnt.unverifiable++; }
      g.lastCheckedStep = n;
      const rec = checkAt.get(`${n}|${g.id}`);
      if (!rec) { bad.push(`第${n}步 ${g.id} 有完成条件却没有 goal_check 事件：判定跑了没落盘`); continue; }
      if (rec.met !== met) bad.push(`第${n}步 ${g.id} met 引擎=${JSON.stringify(rec.met)} 重算=${JSON.stringify(met)}`);
      if (rec.firstMet !== firstMet) bad.push(`第${n}步 ${g.id} firstMet 引擎=${rec.firstMet} 重算=${firstMet}`);
      if (rec.diffs.length !== diffs.length) bad.push(`第${n}步 ${g.id} diffs 条数 引擎=${rec.diffs.length} 重算=${diffs.length}`);
      for (let i = 0; i < diffs.length; i++) {
        const a = rec.diffs[i], e = diffs[i];
        if (!a) { bad.push(`第${n}步 ${g.id} diffs[${i}] 引擎少一条`); continue; }
        if (a.field !== e.field) bad.push(`第${n}步 ${g.id} diffs[${i}].field 引擎=${a.field} 重算=${e.field}`);
        if (a.status !== e.status) bad.push(`第${n}步 ${g.id} ${e.field} status 引擎=${a.status} 重算=${e.status}`);
        if (!eq(a.actual, e.actual)) bad.push(`第${n}步 ${g.id} ${e.field} actual 引擎=${JSON.stringify(a.actual)} 重算=${JSON.stringify(e.actual)}`);
        if (!eq(canon(a.predicted), canon(e.predicted))) bad.push(`第${n}步 ${g.id} ${e.field} predicted 引擎=${canonStr(a.predicted)} 重算=${canonStr(e.predicted)}`);
      }
      for (const k of ['checks', 'met', 'unmet', 'unverifiable'] as const) {
        if (rec.totals[k] !== g[k]) bad.push(`第${n}步 ${g.id} totals.${k} 引擎=${rec.totals[k]} 重算=${g[k]}`);
      }
      // 三态闭合：满足+不满足+无法核对必须等于判定次数，一个都不许多出来或少出来
      if (g.met + g.unmet + g.unverifiable !== g.checks) bad.push(`第${n}步 ${g.id} 三态之和 ≠ checks`);
    }
  }

  // 引擎多记的判定（重算里没有这条步/这条目标）
  for (const c of checks) if (!state.has(c.id)) bad.push(`判定事件出现从没立过的目标 ${c.id}`);
  if (checks.length !== cnt.checks) bad.push(`goal_check 事件 ${checks.length} 条 ≠ 重算判定 ${cnt.checks} 次：有一边多记或漏记`);

  // ── 5. 局末快照与账本聚合 ──
  const finalG = result.goals as Record<string, any>[] | undefined;
  if (!finalG) bad.push('result.json 缺 goals');
  else {
    if (!eq(finalG.map((g) => g.id), order)) bad.push(`局末 id 顺序 引擎=${JSON.stringify(finalG.map((g) => g.id))} 重算=${JSON.stringify(order)}`);
    for (const g of finalG) {
      const m = state.get(g.id);
      if (!m) { bad.push(`局末多出目标 ${g.id}`); continue; }
      for (const k of ['text', 'status', 'statusWhy', 'createdAtStep', 'statusAtStep', 'checks', 'met', 'unmet', 'unverifiable', 'firstMetStep', 'lastCheckedStep'] as const) {
        if (!eq(g[k], m[k])) bad.push(`局末 ${g.id}.${k} 引擎=${JSON.stringify(g[k])} 重算=${JSON.stringify(m[k])}`);
      }
      if (canonStr(g.doneWhen) !== canonStr(m.doneWhen)) bad.push(`局末 ${g.id}.doneWhen 引擎=${canonStr(g.doneWhen)} 重算=${canonStr(m.doneWhen)}`);
      if (g.met + g.unmet + g.unverifiable !== g.checks) bad.push(`局末 ${g.id} 三态之和 ≠ checks`);
      // 计数只能来自判定事件：标了 achieved/abandoned 也照样每步判，
      // 否则被测对象一句话就能关掉评测指标。
      const judged = checks.filter((c) => c.id === g.id).length;
      if (judged !== g.checks) bad.push(`局末 ${g.id} 声称判定 ${g.checks} 次，事件里只有 ${judged} 次`);
    }
  }
  const expect: Record<string, number> = {
    open: [...state.values()].filter((g) => g.status === 'open').length,
    achieved: [...state.values()].filter((g) => g.status === 'achieved').length,
    abandoned: [...state.values()].filter((g) => g.status === 'abandoned').length,
    declared: cnt.declared, revised: cnt.revised, conditionRevised: cnt.conditionRevised,
    rejected: cnt.rejected, conditionMalformed: cnt.malformed,
    withCondition: [...state.values()].filter(checkable).length,
    checks: cnt.checks, met: cnt.met, unmet: cnt.unmet, unverifiable: cnt.unverifiable,
    metNotClosed: [...state.values()].filter((g) => attention(g) === 'met_not_closed').length,
    closedNeverMet: [...state.values()].filter((g) => attention(g) === 'closed_never_met').length,
    uncheckable: [...state.values()].filter((g) => attention(g) === 'uncheckable').length,
  };
  const aggBad = gs ? Object.entries(expect).filter(([k, v]) => gs[k] !== v).map(([k, v]) => `${k} 账本=${gs[k]} 重算=${v}`) : ['goalStats 缺失'];
  if (gs && gs.met + gs.unmet + gs.unverifiable !== gs.checks) aggBad.push(`全局三态之和 ${gs.met + gs.unmet + gs.unverifiable} ≠ checks ${gs.checks}`);
  console.log(`[重算] 目标 ${state.size} 条（${order.join(', ') || '无'}）；判定 ${cnt.checks} 次：满足 ${cnt.met} / 不满足 ${cnt.unmet} / 无法核对 ${cnt.unverifiable}`);
  console.log(`[状态机] 写入 ${writes.length}（新建 ${cnt.declared} / 改正文 ${cnt.revised} / 改条件 ${cnt.conditionRevised} / 形状歪 ${cnt.malformed} / 被拒 ${cnt.rejected}）；板面快照 ${boards.length} 份逐项比对`);
  console.log(`[账本] ${aggBad.length === 0 ? `${Object.keys(expect).length} 项聚合逐项对得上 ✅` : '**对不上** ❌ ' + aggBad.join('; ')}`);
  const closedBad = bad.some((x) => x.includes('三态之和')) || aggBad.some((x) => x.includes('三态之和'));
  console.log(`[闭合] ${closedBad ? '❌ 存在 满足+不满足+无法核对 ≠ checks（目标级或全局级）' : '每条目标与全局都满足 满足+不满足+无法核对 === 判定次数 ✅'}`);
  const nagFinal = ['met_not_closed', 'closed_never_met', 'uncheckable'].map((a) =>
    `${a}=[${[...state.values()].filter((g) => attention(g) === a).map((g) => g.id).join(',')}]`);
  console.log(`[脱钩] 收手时 ${nagFinal.join(' ')}（代码只数不改，status 的主人始终是模型）`);

  // ── 6. 跨通道：画面推出来的 hp vs 内部状态推出来的 coverage ──
  let crossBad = 0;
  try {
    const cov = JSON.parse(readFileSync(`${dir}/coverage.json`, 'utf8'));
    const screenHpZero = firstHpZeroStep.step >= 0;
    if (cov.hpZeroReached !== screenHpZero) {
      console.log(`   ❌ 跨通道矛盾：画面侧 hp≤0 ${screenHpZero ? `首次在第 ${firstHpZeroStep.step} 步` : '从未'}，内部侧 hpZeroReached=${cov.hpZeroReached}`);
      crossBad++;
    } else {
      console.log(`[跨通道] hp≤0：画面侧=${screenHpZero}${screenHpZero ? `（第 ${firstHpZeroStep.step} 步）` : ''} 内部侧=${cov.hpZeroReached} → 两条独立路径一致 ${cov.hpZeroReached ? '✅（正样本）' : '✅（负样本：本局没把血量打到 0，此项未被正样本检验）'}`);
    }
    const screenHpSet = [...new Set(hpTrail)].sort((a, b) => a - b);
    const covHp = [...(cov.hpSeen as number[])].sort((a, b) => a - b);
    if (!eq(screenHpSet, covHp)) { console.log(`   ❌ hp 轨迹不一致：画面侧=[${screenHpSet}] 内部侧=[${covHp}]`); crossBad++; }
    else console.log(`[跨通道] agent 见过的血量值 [${screenHpSet}] === coverage.hpSeen，${screenHpSet.length} 个值逐个对得上 ✅`);

    // 专门盯 hp:0 这类目标：它判为满足是**从画面算出来的**，必须能在内部账本里找到同一件事
    for (const g of [...state.values()]) {
      const wantHpZero = g.doneWhen !== null && 'hp' in g.doneWhen && wantOf('hp', g.doneWhen['hp']) === 0;
      if (!wantHpZero) continue;
      if (g.met > 0 && !cov.hpZeroReached) { console.log(`   ❌ ${g.id} 靠画面判成满足，内部账本却说血量从没到 0 = 两条通道必有一条在撒谎`); crossBad++; }
      if (cov.hpZeroReached && g.createdAtStep <= firstHpZeroStep.step && g.met === 0) {
        console.log(`   ❌ 第 ${firstHpZeroStep.step} 步画面上 hp≤0 且 ${g.id} 当时已立着，判定却一次都没满足 = 目标通道漏判`);
        crossBad++;
      }
      if (cov.hpZeroReached && g.met > 0 && g.firstMetStep !== firstHpZeroStep.step) {
        console.log(`   ❌ ${g.id} 首次满足在第 ${g.firstMetStep} 步，而画面侧 hp≤0 首次出现在第 ${firstHpZeroStep.step} 步`);
        crossBad++;
      }
    }
  } catch { console.log('[跨通道] 无 coverage.json（files 模式）→ 这一项无法审，不算通过也不算失败'); }

  // ── 7. 送达 ──
  // 两个通道时序不同，判据必须不同（与 board-audit 同一条纪律）：
  //   goal_board  在 decide **之前**随请求下发 → 该步有决策、或有 brain_error/retry，就算发出过
  //   goal_feedback 在 execute **之后**回填进 tool 消息 → 只有存在第 N+1 步决策才推得出送达
  const attempted = new Set<number>();
  for (const r of rows) if (r.kind === 'brain_error' || r.kind === 'brain_retry') attempted.add(r.payload.step as number);
  let delivered = 0, failedStep = 0, neverSent = 0;
  for (const b of boards) {
    if (steps.some((s) => s.index === b.step)) delivered++;
    else if (attempted.has(b.step)) failedStep++;
    else neverSent++;
  }
  console.log(`[送达] 板面快照=${boards.length} 决策成功可证=${delivered} 请求已发出但该步无决策=${failedStep} 连请求都没发出=${neverSent}`);
  if (neverSent) bad.push(`${neverSent} 份板面快照既无步记录也无 brain_error/brain_retry：渲染了却没发请求`);

  const firstMetAt = new Map<number, string[]>();
  for (const c of checks) if (c.firstMet) firstMetAt.set(c.step, [...(firstMetAt.get(c.step) ?? []), c.id]);
  let fbBad = 0;
  if (fbs.length !== firstMetAt.size) { console.log(`   ❌ 回填事件 ${fbs.length} 条 ≠ 首次满足的步 ${firstMetAt.size} 步：重复播报或漏播报`); fbBad++; }
  for (const f of fbs) {
    const ids = firstMetAt.get(f.aboutStep) ?? [];
    if (!ids.length) { console.log(`   ❌ 第${f.aboutStep}步没有首次满足却回填了`); fbBad++; continue; }
    const lines = String(f.text).split('\n');
    if (lines.length !== ids.length) { console.log(`   ❌ 第${f.aboutStep}步回填 ${lines.length} 行 ≠ 首次满足 ${ids.length} 条`); fbBad++; }
    for (const id of ids) if (!String(f.text).includes(id)) { console.log(`   ❌ 第${f.aboutStep}步回填没提到 ${id}`); fbBad++; }
    if (!String(f.text).includes('目标判定：')) { console.log(`   ❌ 第${f.aboutStep}步回填原文形状不对`); fbBad++; }
    for (const w of ['你应该', '建议', '该收手', '优先']) if (String(f.text).includes(w)) { console.log(`   ❌ 回填越界措辞「${w}」`); fbBad++; }
    if (!String(f.text).includes('由你判断')) { console.log(`   ❌ 第${f.aboutStep}步回填没把判断权交回模型`); fbBad++; }
  }
  const undelivered = fbs.filter((f) => !steps.some((s) => s.index === f.aboutStep + 1)).length;
  console.log(`[送达] 回填事件=${fbs.length} 可推出已送达=${fbs.length - undelivered} 整局在这一步结束=${undelivered} 形状与指代=${fbBad === 0 ? '✅' : `${fbBad} 处错 ❌`}`);

  // ── 8. 主客观分侧（defect.json 若存在）──
  let sideBad = 0;
  try {
    const defect = JSON.parse(readFileSync(`${dir}/defect.json`, 'utf8'));
    const claimed = (defect.agentClaims?.goals ?? []) as Record<string, unknown>[];
    const counted = (defect.goalChecks ?? []) as Record<string, unknown>[];
    // 主观侧混进计数 = 对账永远核不出矛盾；客观侧混进正文与状态 = 两侧成了同一份数据复读
    for (const c of claimed) for (const k of ['checks', 'met', 'unmet', 'unverifiable', 'firstMetStep', 'lastCheckedStep']) {
      if (k in c) { console.log(`   ❌ 客观计数 ${k} 混进了 agentClaims`); sideBad++; }
    }
    for (const c of counted) for (const k of ['text', 'status', 'statusWhy', 'doneWhen']) {
      if (k in c) { console.log(`   ❌ 主观字段 ${k} 混进了 goalChecks`); sideBad++; }
    }
    if (!eq(claimed.map((c) => c['id']), counted.map((c) => c['id']))) { console.log('   ❌ 两侧 id 对不上，无法对账'); sideBad++; }
    if (!eq(defect.goalStats, result.goalStats)) { console.log('   ❌ defect.json 与 result.json 的目标准账本不一致'); sideBad++; }
    // 两侧靠 id 对账：主观声明 achieved 而客观 met=0，必须在这份文件里同时看得见
    const closedButNeverMet = claimed.filter((c) => c['status'] === 'achieved')
      .filter((c) => (counted.find((x) => x['id'] === c['id'])?.['met'] ?? -1) === 0).map((c) => c['id']);
    console.log(`[分侧] 主观 ${claimed.length} 条 / 客观 ${counted.length} 条，靠 id 对账 ${sideBad === 0 ? '✅' : '❌'}；自称 achieved 却客观从未满足 = ${closedButNeverMet.length} 条${closedButNeverMet.length ? `（${closedButNeverMet.join(', ')}）` : ''}`);
    if (gs && closedButNeverMet.length !== gs.closedNeverMet) { console.log('   ❌ 两侧对账出的脱钩条数与账本不符'); sideBad++; }
  } catch { console.log('[分侧] 无 defect.json（files 模式），跳过'); }

  for (const x of bad.slice(0, 20)) console.log(`   ❌ ${x}`);
  if (bad.length > 20) console.log(`   …另有 ${bad.length - 20} 处`);
  console.log(`[结论] 本局不一致 ${bad.length + aggBad.length + crossBad + fbBad + sideBad} 处`);
  grandBad += bad.length + aggBad.length + crossBad + fbBad + sideBad;
}

console.log(`\n===== 总计不一致 ${grandBad} 处 =====`);
process.exit(grandBad === 0 ? 0 : 1);
