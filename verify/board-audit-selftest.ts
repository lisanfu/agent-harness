/**
 * 审计脚本自身的回归：**证明 board-audit.ts 抓得住错**。
 *
 * 为什么必须有这一步：一个从没抓出过错误的审计脚本，与"直接 print ✅"没有区别。
 * 故障 #8 的教训在审计层同样成立——「审计跑了」不等于「审计起作用」。
 * 所以这里拿一份干净夹具，逐次注入**一处**已知错误，要求审计：
 *   1. 退出码非 0
 *   2. 输出里出现对应的判据关键词（不是随便哪里报错都算抓住）
 * 任何一处漏抓，本脚本失败。
 *
 * 用法: node verify/board-audit-selftest.ts
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const ROOT = resolve(HERE, '..');
const AUDIT = join(HERE, 'board-audit.ts');

// 先生成一份干净夹具（确定性，覆盖全部归因路径）
const base = execFileSync(process.execPath, [join(HERE, 'board-fixture.ts')], { encoding: 'utf8' }).trim();
const work = mkdtempSync(join(tmpdir(), 'board-selftest-'));
console.log(`干净夹具: ${base}`);

const read = (dir: string, f: string): unknown => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const write = (dir: string, f: string, v: unknown): void => writeFileSync(join(dir, f), `${JSON.stringify(v, null, 2)}\n`);
const readRows = (dir: string): Record<string, unknown>[] =>
  readFileSync(join(dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const writeRows = (dir: string, rows: unknown[]): void =>
  writeFileSync(join(dir, 'trace.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

interface Case { name: string; keyword: string; also?: string; mutate: (dir: string) => void }

const cases: Case[] = [
  {
    name: '局末计数被改大（假规则的反证被抹掉）',
    keyword: 'contradicted',
    mutate: (dir) => {
      const r = read(dir, 'result.json') as { hypotheses: { contradicted: number }[] };
      r.hypotheses[0]!.contradicted = 0;
      write(dir, 'result.json', r);
    },
  },
  {
    name: '已淘汰的假设被塞回活跃区（目标故障本身）',
    keyword: '仍在活跃区',
    mutate: (dir) => {
      const rows = readRows(dir);
      // 找最后一份板面快照：此时 H1 已 retired，只该出现在淘汰区
      const idx = rows.map((r, i) => ({ r, i })).filter((x) => x.r['kind'] === 'hypothesis_board').at(-1)!.i;
      const p = rows[idx]!['payload'] as { text: string };
      const retiredLine = p.text.split('\n').find((l) => l.startsWith('- H1 [retired]'))!;
      p.text = p.text.replace(
        /(可检验假设[^\n]*\n)/,
        `$1${retiredLine}\n    客观核对 4 次：支持 2 / 反对 2 / 无法核对 0\n`,
      );
      writeRows(dir, rows);
    },
  },
  {
    name: '板面快照里的计数与重算不符',
    keyword: '文本=',
    mutate: (dir) => {
      const rows = readRows(dir);
      const idx = rows.map((r, i) => ({ r, i })).filter((x) => x.r['kind'] === 'hypothesis_board').at(-1)!.i;
      const p = rows[idx]!['payload'] as { text: string };
      p.text = p.text.replace(/客观核对 \d+ 次：支持 \d+ \/ 反对 \d+/, '客观核对 99 次：支持 99 / 反对 0');
      writeRows(dir, rows);
    },
  },
  {
    name: '归因分类被改（把未知 id 冒充成成功归因）',
    keyword: '归因分类',
    mutate: (dir) => {
      const rows = readRows(dir);
      const c = rows.find((r) => r['kind'] === 'hypothesis_check' && (r['payload'] as { problem: string }).problem === 'unknown_target')!;
      (c['payload'] as { problem: string | null }).problem = null;
      writeRows(dir, rows);
    },
  },
  {
    name: '删掉一份板面快照（渲染了却没落盘）',
    keyword: '没有 hypothesis_board 快照',
    mutate: (dir) => {
      const rows = readRows(dir);
      const idx = rows.findIndex((r) => r['kind'] === 'hypothesis_board');
      rows.splice(idx, 1);
      writeRows(dir, rows);
    },
  },
  {
    name: '出声名单被改（该提示的不提示）',
    keyword: 'nagging',
    mutate: (dir) => {
      const rows = readRows(dir);
      const b = rows.filter((r) => r['kind'] === 'hypothesis_board' && ((r['payload'] as { nagging: string[] }).nagging.length > 0))[0]!;
      (b['payload'] as { nagging: string[] }).nagging = [];
      writeRows(dir, rows);
    },
  },
  {
    name: '被拒的写入冒充成功',
    keyword: '写入判定',
    mutate: (dir) => {
      const rows = readRows(dir);
      const w = rows.find((r) => r['kind'] === 'hypothesis_write' && !(r['payload'] as { ok: boolean }).ok)!;
      (w['payload'] as { ok: boolean }).ok = true;
      writeRows(dir, rows);
    },
  },
  {
    name: '客观计数混进主观陈述侧',
    keyword: '混进了 agentClaims',
    mutate: (dir) => {
      const d = read(dir, 'defect.json') as { agentClaims: { hypotheses: Record<string, unknown>[] } };
      d.agentClaims.hypotheses[0]!['checks'] = 4;
      write(dir, 'defect.json', d);
    },
  },
  {
    name: '账本聚合被改（驻留条数报成 0）',
    keyword: 'contradictedNotRetired',
    mutate: (dir) => {
      const r = read(dir, 'result.json') as { hypothesisStats: Record<string, number> };
      r.hypothesisStats['contradictedNotRetired'] = 0;
      write(dir, 'result.json', r);
    },
  },
  {
    name: '没声明 testing 却记了归因（猜目标 = 伪造归因）',
    keyword: '猜目标',
    mutate: (dir) => {
      const rows = readRows(dir);
      const s = rows.filter((r) => r['decision']).find((r) => {
        const dec = r['decision'] as { testing?: unknown; call: { name: string } };
        return dec.testing === undefined && r['prediction'] !== undefined;
      })!;
      rows.push({ kind: 'hypothesis_check', at: new Date().toISOString(), payload: { step: s['index'], id: 'H1', field: null, problem: null, fields: ['enemyCount'], supported: 1, contradicted: 0, unverifiable: 0 } });
      writeRows(dir, rows);
    },
  },
  {
    name: '板面渲染了却连请求都没发出（既无步记录也无 brain 事件）',
    keyword: '连请求都没发出',
    mutate: (dir) => { phantomBoard(dir); },
  },
  {
    name: '零核对提示行被删（自称成立却不出声 = 淘汰机制永不触发）',
    keyword: '提示行',
    mutate: (dir) => {
      const rows = readRows(dir);
      const idx = rows.map((r, i) => ({ r, i })).filter((x) => x.r['kind'] === 'hypothesis_board').at(-1)!.i;
      const p = rows[idx]!['payload'] as { text: string };
      p.text = p.text.split('\n').filter((l) => !l.includes('客观核对是 0 次')).join('\n');
      writeRows(dir, rows);
    },
  },
  {
    name: '账本把"自称成立却零核对"报成 0',
    keyword: 'confirmedNoChecks',
    mutate: (dir) => {
      const r = read(dir, 'result.json') as { hypothesisStats: Record<string, number> };
      r.hypothesisStats['confirmedNoChecks'] = 0;
      write(dir, 'result.json', r);
    },
  },
  {
    // 版本降级不许成为免检通道：删掉新字段想蒙混过关，必须既大声报版本、又照样被抓
    name: '删掉 confirmedNoChecks 字段想把审计降级成旧版',
    keyword: 'nagging',
    also: '[版本]',
    mutate: (dir) => {
      const r = read(dir, 'result.json') as { hypothesisStats: Record<string, number> };
      delete r.hypothesisStats['confirmedNoChecks'];
      write(dir, 'result.json', r);
    },
  },
  {
    // 故障 #19 的另一半：解析改成"容忍跨行正文"之后，缺计数行仍然必须大声失败。
    // 只会放宽的判据等于没有判据——所以放宽和守住要各钉一个用例。
    name: '删掉一条假设的计数行（条目形状歪了）',
    keyword: '没有计数行',
    mutate: (dir) => {
      const rows = readRows(dir);
      const idx = rows.map((r, i) => ({ r, i })).filter((x) => x.r['kind'] === 'hypothesis_board').at(-1)!.i;
      const p = rows[idx]!['payload'] as { text: string };
      const lines = p.text.split('\n');
      const k = lines.map((l, i) => ({ l, i })).filter((x) => /^    客观核对 /.test(x.l)).at(-1)!.i;
      lines.splice(k, 1);
      p.text = lines.join('\n');
      writeRows(dir, rows);
    },
  },
];

/** 造一份"指向从没发生过的步"的板面快照：正文照抄最后一份，只把步号改掉 */
function phantomBoard(dir: string): number {
  const rows = readRows(dir);
  const last = rows.filter((r) => r['kind'] === 'hypothesis_board').at(-1)!;
  const step = Math.max(...rows.filter((r) => r['decision']).map((r) => r['index'] as number)) + 5;
  rows.push({ kind: 'hypothesis_board', at: new Date().toISOString(), payload: { ...(last['payload'] as object), step } });
  writeRows(dir, rows);
  return step;
}

/**
 * 反向对照：证明送达判据不是"一律放过"。
 * 第 11 例注入的是"渲染了却连请求都没发出"；这里给同一步补上 brain_error 证据
 * （真跑里 429 撞墙就长这样），审计必须改判为"请求已发出但该步无决策"并放行。
 * 只会拒绝的判据和只会放过的判据一样没用——两边都要钉住。
 */
const controls: { name: string; expect?: string; mutate: (dir: string) => void }[] = [
  {
    name: '同一步补上 brain_error 证据 → 必须放行（请求确实发出过）',
    mutate: (dir) => {
      const step = phantomBoard(dir);
      const rows = readRows(dir);
      rows.push({ kind: 'brain_error', at: new Date().toISOString(), payload: { step, attempt: 0, error: { code: 'E_BRAIN_RATE_LIMIT', message: '自检注入：模拟免费额度撞墙' } } });
      writeRows(dir, rows);
      // 让注入的证据内部自洽：大脑在这一步撞墙，整局就该停在这里
      const r = read(dir, 'result.json') as { stopReason: string };
      r.stopReason = 'brain_failed';
      write(dir, 'result.json', r);
    },
  },
  {
    // 故障 #19 的真实形状：跨行正文是**旧合约合法写下**的证据（真跑 runs/m4e-goal-off/20261114-084406-s6
    // 三条假设全是这样写的）。审计拿今天的尺子追判昨天的证据＝伪不一致；
    // 但也不能一声不响地放过——所以要求它专门报一行 [形状]，把数目摊在桌面上。
    name: '历史证据里假设正文跨行 → 不追判成不一致，但必须单独出声',
    expect: '跨行正文的写入 = 1 次',
    mutate: (dir) => {
      const MULTI = '攻击能一次清掉相邻多个敌人\n- 第3帧相邻 2 个敌人只掉 1 点血';
      const rows = readRows(dir);
      for (const r of rows) {
        const p = r['payload'] as Record<string, any>;
        if (r['kind'] === 'hypothesis_write' && p.input && p.input.id === 'H2') {
          p.input.text = MULTI;
          if (p.after) p.after.text = MULTI;
        }
        if (r['kind'] === 'hypothesis_board' && typeof p.text === 'string') {
          p.text = p.text.split('攻击能一次清掉相邻多个敌人').join(MULTI);
        }
      }
      writeRows(dir, rows);
      const res = read(dir, 'result.json') as { hypotheses: { id: string; text: string }[] };
      const h = res.hypotheses.find((x) => x.id === 'H2');
      if (h) h.text = MULTI;
      write(dir, 'result.json', res);
    },
  },
];

let failed = 0;
// 先确认干净夹具本身是通的，否则后面的"抓住"毫无意义
const clean = run(base);
if (clean.code !== 0) { console.log(`❌ 干净夹具就没通过审计，自检无效：\n${clean.out}`); process.exit(1); }
console.log('干净夹具审计通过 ✅（基线成立）\n');

for (const [i, c] of cases.entries()) {
  const dir = join(work, `case${i}`);
  cpSync(base, dir, { recursive: true });
  c.mutate(dir);
  const r = run(dir);
  const hit = r.out.includes(c.keyword) && (c.also === undefined || r.out.includes(c.also));
  const caught = r.code !== 0 && hit;
  console.log(`${caught ? '✅' : '❌'} ${i + 1}. ${c.name} → 退出码=${r.code} 关键词「${c.keyword}」${r.out.includes(c.keyword) ? '命中' : '未命中'}${c.also ? `＋「${c.also}」${r.out.includes(c.also) ? '命中' : '未命中'}` : ''}`);
  if (!caught) { failed++; console.log(r.out.split('\n').filter((l) => l.includes('❌') || l.includes('结论') || l.includes('[版本]')).join('\n')); }
}

console.log('');
for (const [i, c] of controls.entries()) {
  const dir = join(work, `control${i}`);
  cpSync(base, dir, { recursive: true });
  c.mutate(dir);
  const r = run(dir);
  const hit = c.expect === undefined || r.out.includes(c.expect);
  const ok = r.code === 0 && hit;
  console.log(`${ok ? '✅' : '❌'} 反向对照 ${i + 1}. ${c.name} → 退出码=${r.code}（应为 0）${c.expect ? `＋「${c.expect}」${hit ? '命中' : '未命中'}` : ''}`);
  if (!ok) { failed++; console.log(r.out.split('\n').filter((l) => l.includes('❌') || l.includes('结论') || l.includes('形状')).join('\n')); }
}

function run(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [AUDIT, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

console.log(`\n===== 注入 ${cases.length} 处错误，漏抓 ${failed} 处；反向对照 ${controls.length} 组 =====`);
process.exit(failed === 0 ? 0 : 1);