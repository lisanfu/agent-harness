/**
 * 目标通道审计脚本自身的回归：**证明 goal-audit.ts 抓得住错**。
 *
 * 一个从没抓出过错误的审计脚本，与"直接 print ✅"没有区别（故障 #8 在审计层同样成立）。
 * 所以这里拿一份干净夹具，逐次注入**一处**已知错误，要求审计：
 *   1. 退出码非 0
 *   2. 输出里出现对应的判据关键词（不是随便哪里报错都算抓住）
 * 任何一处漏抓，本脚本失败。
 *
 * 反向对照同样必须有：只会拒绝的判据和只会放过的判据一样没用。
 *   对照 1：板面快照那一步补上 brain_error 证据 → 送达判据必须改判为"请求发出过"并放行
 *   对照 2：抹干净 goal_* 事件、goalStats、initialState.goals 与 seams → 必须认成版本差异，报出来且退出码 0
 *   对照 3：接口给了却一次都没调用 goal → 必须认成"零使用"这条一等的负结果，不能报成故障
 *   对照 4：如实声明 seams.goal=false 且没有 goal 产物 → 必须认成消融对照组（M4-e 的真对照），放行
 *
 * ⚠️ 对照 2/4 与注入 4/5 是同一组判据的两侧：审计对"通道没开"是**不审就放行**的，
 *    这种放行随时可能被当成免检通道——所以"声明没开但产物还在"必须是注入 5 那条硬故障。
 *    写审计时每一次 continue（跳过不审）都该配一条这样的对照。
 *
 * 用法: node verify/goal-audit-selftest.ts
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const AUDIT = join(HERE, 'goal-audit.ts');

const base = execFileSync(process.execPath, [join(HERE, 'goal-fixture.ts')], { encoding: 'utf8' }).trim();
const work = mkdtempSync(join(tmpdir(), 'goal-selftest-'));
console.log(`干净夹具: ${base}`);

const read = (dir: string, f: string): any => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const write = (dir: string, f: string, v: unknown): void => writeFileSync(join(dir, f), `${JSON.stringify(v, null, 2)}\n`);
const rowsOf = (dir: string): Record<string, any>[] =>
  readFileSync(join(dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const dump = (dir: string, rows: unknown[]): void =>
  writeFileSync(join(dir, 'trace.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

/** 取最后一份"某条目标带代码提示"的板面，改掉它的提示行，写回 trace */
function replaceNag(dir: string, id: string, mut: (line: string) => string): boolean {
  const rows = rowsOf(dir);
  const boards = rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'goal_board');
  for (const { r } of [...boards].reverse()) {
    const lines: string[] = r.payload.text.split('\n');
    let head = -1;
    for (let i = 0; i < lines.length; i++) if (new RegExp(`^- ${id} \\[`).test(lines[i]!)) head = i;
    if (head < 0) continue;
    for (let i = head; i < lines.length; i++) {
      if (lines[i]!.includes('代码提示：')) { lines[i] = mut(lines[i]!); r.payload.text = lines.join('\n'); dump(dir, rows); return true; }
    }
  }
  return false;
}

/** 造一份"指向从没发生过的步"的板面快照：正文照抄最后一份，只把步号改掉 */
function phantomBoard(dir: string): number {
  const rows = rowsOf(dir);
  const last = rows.filter((r) => r.kind === 'goal_board').at(-1)!;
  const step = Math.max(...rows.filter((r) => r.decision).map((r) => r.index as number)) + 5;
  rows.push({ kind: 'goal_board', at: new Date().toISOString(), payload: { ...(last.payload as object), step } });
  dump(dir, rows);
  return step;
}

interface Case { name: string; keyword: string; mutate: (dir: string) => void }

const cases: Case[] = [
  // ── 局末账本与快照 ──
  {
    name: '局末客观计数被改小（画面上明明一直不满足，反证被抹掉）',
    keyword: '局末 G1.unmet',
    mutate: (dir) => {
      const r = read(dir, 'result.json');
      r.goals[0].unmet = 0;
      write(dir, 'result.json', r);
    },
  },
  {
    name: '局末 checks 被改大（三态之和不再等于判定次数）',
    keyword: '三态之和',
    mutate: (dir) => {
      const r = read(dir, 'result.json');
      r.goals[0].checks += 3;
      write(dir, 'result.json', r);
    },
  },
  {
    name: '账本聚合被改（画面满足却未收口的条数报成 0）',
    keyword: 'metNotClosed',
    mutate: (dir) => {
      const r = read(dir, 'result.json');
      r.goalStats.metNotClosed = 0;
      write(dir, 'result.json', r);
    },
  },
  // 关键词按审计的实际措辞来，不迁就旧文案：判据改了词，自检就得跟着改，
  // 否则"抓住了"只是关键词过期前的运气。
  {
    name: '删掉 goalStats 想把审计降级成旧版（seams 声明通道开着，就不许冒充没这回事）',
    keyword: '被删了或没落盘',
    mutate: (dir) => {
      const r = read(dir, 'result.json');
      delete r.goalStats;
      write(dir, 'result.json', r);
    },
  },
  {
    name: '开关与产物对不上（声明 seams.goal=false 却留着整套 goal 证据）',
    keyword: '开关与产物互相矛盾',
    mutate: (dir) => {
      // 这一条专门堵"免检通道"：审计对 seams.goal=false 是放行不审的，
      // 所以篡改者改一个布尔就能整局免检——除非这条判据在。
      const h = read(dir, 'header.json');
      h.seams.goal = false;
      write(dir, 'header.json', h);
    },
  },

  // ── 判定事件 ──
  {
    name: '删掉一次判定（判了却没落盘 = 故障 #11）',
    keyword: '没有 goal_check 事件',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const idx = rows.findIndex((r) => r.kind === 'goal_check');
      rows.splice(idx, 1);
      dump(dir, rows);
    },
  },
  {
    name: '伪造一次判定：给没有完成条件的目标记一次达成',
    keyword: '凭空记一次达成',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const g4 = rows.filter((r) => r.kind === 'goal_write' && r.payload.id === 'G4').at(-1)!;
      rows.push({ kind: 'goal_check', at: g4.at, payload: { step: g4.payload.step + 1, id: 'G4', met: true, firstMet: false, diffs: [], totals: { checks: 1, met: 1, unmet: 0, unverifiable: 0 } } });
      dump(dir, rows);
    },
  },
  {
    name: 'met 被翻（不满足改成满足 = 凭空制造成功）',
    keyword: 'met 引擎=',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const c = rows.find((r) => r.kind === 'goal_check' && r.payload.met === false)!;
      c.payload.met = true;
      dump(dir, rows);
    },
  },
  {
    name: 'actual 被改（画面上是 3 改成 0 = 篡改证据本身）',
    keyword: 'actual 引擎=',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const c = rows.find((r) => r.kind === 'goal_check' && r.payload.diffs.length > 0 && r.payload.id === 'G1')!;
      c.payload.diffs[0].actual = 0;
      dump(dir, rows);
    },
  },

  // ── 状态机与渲染 ──
  {
    name: '被拒的写入冒充成功',
    keyword: '写入判定',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const w = rows.find((r) => r.kind === 'goal_write' && !r.payload.ok)!;
      w.payload.ok = true;
      dump(dir, rows);
    },
  },
  {
    name: '代码代模型改了 status（声明 open，落盘变 achieved）',
    keyword: '代码代它改了',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const w = rows.find((r) => r.kind === 'goal_write' && r.payload.id === 'G6' && r.payload.input.status === 'achieved')!;
      w.payload.after.status = 'open';
      dump(dir, rows);
    },
  },
  {
    name: '宽容度变成静默改写（args 是 3，事件里记成 99）',
    keyword: '静默改写',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const w = rows.find((r) => r.kind === 'goal_write' && r.payload.id === 'G10')!;
      w.payload.input.doneWhen = { enemyCount: 99 };
      dump(dir, rows);
    },
  },
  {
    name: '已收口的目标被塞回"在追"区（目标故障本身）',
    keyword: '却在在追区',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const idx = rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'goal_board').at(-1)!.i;
      const p = rows[idx]!.payload;
      const lines: string[] = p.text.split('\n');
      const head = lines.findIndex((l) => l.startsWith('- G1 ['));
      const block = lines.slice(head, head + 3);
      lines.splice(head, 3);
      const iActive = lines.findIndex((l) => l.includes('在追的目标'));
      lines.splice(iActive + 1, 0, ...block);
      p.text = lines.join('\n');
      dump(dir, rows);
    },
  },
  {
    name: '板面快照被删（渲染了却没落盘）',
    keyword: '没有 goal_board 快照',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const idx = rows.findIndex((r) => r.kind === 'goal_board');
      rows.splice(idx, 1);
      dump(dir, rows);
    },
  },
  {
    name: '出声名单被清空（该提示的不提示）',
    keyword: 'nagging 文本=',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const b = rows.find((r) => r.kind === 'goal_board' && r.payload.nagging.length > 0)!;
      b.payload.nagging = [];
      dump(dir, rows);
    },
  },
  {
    name: '提示行被删一条（名单与行数不再一致）',
    keyword: '提示行',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const idx = rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'goal_board').at(-1)!.i;
      const p = rows[idx]!.payload;
      p.text = p.text.split('\n').filter((l: string) => !l.includes('代码提示：')).join('\n');
      dump(dir, rows);
    },
  },
  {
    name: '出声文案对目标形状说谎（旧文案："字段全不在词表内"）',
    keyword: '文案谎称',
    mutate: (dir) => {
      // G5 的条件是 {enemyDir:1}：字段确实不在词表内，但它是"有完成条件"的那一类。
      // 夹具当初就是把这条按旧文案印成"没有可核对的完成条件"，被独立重算抓出来的。
      const ok = replaceNag(dir, 'G5', () => '    代码提示：这条目标判不出结果——没有可核对的完成条件，或条件里的字段全不在词表内。补不补由你判断。');
      if (!ok) throw new Error('夹具里没有带提示的 G5 板面');
    },
  },
  {
    name: '回填指代不存在的步（播报与事实脱钩）',
    keyword: '没有首次满足却回填了',
    mutate: (dir) => {
      const rows = rowsOf(dir);
      const f = rows.find((r) => r.kind === 'goal_feedback')!;
      f.payload.aboutStep = 1;
      dump(dir, rows);
    },
  },
  {
    name: '板面渲染了却连请求都没发出（既无步记录也无 brain 事件）',
    keyword: '连请求都没发出',
    mutate: (dir) => { phantomBoard(dir); },
  },

  // ── 跨通道：画面侧 vs 内部状态侧 ──
  {
    name: 'coverage 说血量从没到 0，画面里却明明印着 HP 0',
    keyword: '跨通道矛盾',
    mutate: (dir) => {
      const c = read(dir, 'coverage.json');
      c.hpZeroReached = false;
      write(dir, 'coverage.json', c);
    },
  },
  {
    name: 'coverage.hpSeen 被裁短（agent 见过的血量值与内部账本不符）',
    keyword: 'hp 轨迹不一致',
    mutate: (dir) => {
      const c = read(dir, 'coverage.json');
      c.hpSeen = [10];
      write(dir, 'coverage.json', c);
    },
  },

  // ── 主客观分侧 ──
  {
    name: '客观计数混进主观陈述侧',
    keyword: '混进了 agentClaims',
    mutate: (dir) => {
      const d = read(dir, 'defect.json');
      d.agentClaims.goals[0].checks = 5;
      write(dir, 'defect.json', d);
    },
  },
  {
    name: '主观正文混进客观计数侧（两侧成了同一份数据复读）',
    keyword: '混进了 goalChecks',
    mutate: (dir) => {
      const d = read(dir, 'defect.json');
      d.goalChecks[0].text = '把场上活着的敌人数清零';
      write(dir, 'defect.json', d);
    },
  },
  {
    name: '声明事件被抹掉却留着非 0 账本（把"没用过"伪造成都市量过的样子）',
    keyword: '没有任何写入，账本却记了',
    mutate: (dir) => {
      const rows = rowsOf(dir).filter((r) => !String(r.kind ?? '').startsWith('goal_'));
      dump(dir, rows);
      const r = read(dir, 'result.json');
      r.goals = [];
      write(dir, 'result.json', r);
      // 只留 declared=10：与"一次都没调用"直接矛盾
    },
  },
];

const controls: { name: string; keyword?: string; mutate: (dir: string) => void }[] = [
  {
    // 送达判据不能只会拒绝：请求发出去但大脑撞墙（真跑里免费额度 429 就长这样）必须放行
    name: '同一步补上 brain_error 证据 → 必须放行（请求确实发出过）',
    mutate: (dir) => {
      const step = phantomBoard(dir);
      const rows = rowsOf(dir);
      rows.push({ kind: 'brain_error', at: new Date().toISOString(), payload: { step, attempt: 0, error: { code: 'E_BRAIN_RATE_LIMIT', message: '自检注入：模拟额度撞墙' } } });
      dump(dir, rows);
      const r = read(dir, 'result.json');
      r.stopReason = 'brain_failed';
      write(dir, 'result.json', r);
    },
  },
  {
    // 版本纪律的反向对照：证据里根本没有目标通道时，不许报成不一致，也不许假装审过。
    // ⚠️ 真·旧版证据三样都没有：goal_* 事件、goalStats、initialState.goals，**外加 seams 整块**
    // （seams 是后来才落地的声明，旧版 header 里根本不存在这个键）。
    // 少抹一样就变成"新版但通道没跑"或"新版谎报开关"，那种该抓不该放。
    name: '抹掉全部 goal_* 事件、goalStats、initialState.goals 与 seams → 必须认成版本差异并通过（退出码 0）',
    mutate: (dir) => {
      const rows = rowsOf(dir).filter((r) => !String(r.kind ?? '').startsWith('goal_'));
      dump(dir, rows);
      const r = read(dir, 'result.json');
      delete r.goalStats;
      write(dir, 'result.json', r);
      const h = read(dir, 'header.json');
      delete h.initialState.goals;
      delete h.seams;
      write(dir, 'header.json', h);
      const d = read(dir, 'defect.json');
      delete d.goalStats;
      write(dir, 'defect.json', d);
    },
  },
  {
    // 使用率判据也不能只会报警：接口给了、大脑一次都没用，是**一等的负结果**，
    // 审不出东西就必须放它过去（同时把账本归零这件事本身要一致）。
    name: '接口给了但一次 goal 都没调用 → 必须认成"零使用"并放行（退出码 0）',
    keyword: '[使用率]',
    mutate: (dir) => {
      const rows = rowsOf(dir).filter((r) => !String(r.kind ?? '').startsWith('goal_'));
      dump(dir, rows);
      const r = read(dir, 'result.json');
      r.goals = [];
      for (const k of Object.keys(r.goalStats as Record<string, number>)) r.goalStats[k] = 0;
      write(dir, 'result.json', r);
      const d = read(dir, 'defect.json');
      d.agentClaims.goals = [];
      d.goalChecks = [];
      for (const k of Object.keys(d.goalStats as Record<string, number>)) d.goalStats[k] = 0;
      write(dir, 'defect.json', d);
    },
  },
  {
    // 消融对照不是免检通道，但它也不该被报成故障：这一局的目的就是"没有目标通道"。
    // 与注入 5 的区别只有一件事——证据是**干净地没有**，而不是"声明没有、产物还在"。
    name: '如实关掉目标通道（seams.goal=false 且无任何 goal 产物）→ 必须认成消融对照组并放行（退出码 0）',
    keyword: '[消融]',
    mutate: (dir) => {
      const rows = rowsOf(dir).filter((r) => !String(r.kind ?? '').startsWith('goal_'));
      dump(dir, rows);
      const r = read(dir, 'result.json');
      delete r.goalStats;
      r.goals = [];
      write(dir, 'result.json', r);
      const h = read(dir, 'header.json');
      h.seams = { ...(h.seams as Record<string, unknown>), goal: false };
      delete h.initialState.goals;
      write(dir, 'header.json', h);
      // harness 在通道关着时写的是 null（不是缺键），这里照它本来的形状改
      const d = read(dir, 'defect.json');
      d.goalStats = null;
      d.agentClaims.goals = [];
      d.goalChecks = [];
      write(dir, 'defect.json', d);
    },
  },
];

function run(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [AUDIT, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

let failed = 0;
const clean = run(base);
if (clean.code !== 0) { console.log(`❌ 干净夹具就没通过审计，自检无效：\n${clean.out}`); process.exit(1); }
console.log('干净夹具审计通过 ✅（基线成立）\n');

for (const [i, c] of cases.entries()) {
  const dir = join(work, `case${i}`);
  cpSync(base, dir, { recursive: true });
  c.mutate(dir);
  const r = run(dir);
  const hit = r.out.includes(c.keyword);
  const caught = r.code !== 0 && hit;
  console.log(`${caught ? '✅' : '❌'} ${i + 1}. ${c.name} → 退出码=${r.code} 关键词「${c.keyword}」${hit ? '命中' : '未命中'}`);
  if (!caught) { failed++; console.log(r.out.split('\n').filter((l) => l.includes('❌') || l.includes('结论') || l.includes('[版本]')).join('\n')); }
}

console.log('');
for (const [i, c] of controls.entries()) {
  const dir = join(work, `control${i}`);
  cpSync(base, dir, { recursive: true });
  c.mutate(dir);
  const r = run(dir);
  const ok = r.code === 0 && (c.keyword === undefined || r.out.includes(c.keyword));
  console.log(`${ok ? '✅' : '❌'} 反向对照 ${i + 1}. ${c.name} → 退出码=${r.code}（应为 0）${c.keyword ? `＋关键词「${c.keyword}」${r.out.includes(c.keyword) ? '命中' : '未命中'}` : ''}`);
  if (!ok) { failed++; console.log(r.out.split('\n').filter((l) => l.includes('❌') || l.includes('结论') || l.includes('[版本]')).join('\n')); }
}

console.log(`\n===== 注入 ${cases.length} 处错误，漏抓 ${failed} 处；反向对照 ${controls.length} 组 =====`);
process.exit(failed === 0 ? 0 : 1);
