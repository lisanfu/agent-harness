/**
 * 文档数字审计（verify/doc-numbers.ts）的回归测试。
 *
 * 这一条防的不是代码坏，是**说明书坏**：#35（字节/字符混用）、#44（文档 603 字节 vs 磁盘 703）、
 * #45（文档印测试 8828 行，克隆里重算 8840）三条是同一族——数字从一个地方被抄进另一个地方，
 * 抄完之后原物又变了。前两条靠人在复核时重新量，第三条证明"记得重量"这件事本身靠不住。
 *
 * 三条纪律：
 *  1. **先证明检查器忠于它自己声明的口径**：文档说 `wc -l`，检查器就必须给出 `wc -l` 的数。
 *     这一条不是我事先想到的——是它第一次跑就报出"src 文档 9642 / 实测 9671"，
 *     而 9671 才是错的那个（我拿 `split('\n')` 冒充 `wc -l`，29 个文件各多算 1 行）。
 *  2. **注入必须当场红**：改一个数、删一句、重复一句、表格改一行，四种都要被抓。
 *  3. **不核要出声**：解析不到的行只能标成"当众声明不核"，不许标成通过（台账 #17 零样本假通过同族）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  CLAIMS, INVARIANTS, auditDocs, auditOrganTable, chineseToNumber, countMatches,
  lineCount, median, measuredSnapshot, organTableLines, resolvePaths,
} from '../verify/doc-numbers.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SCRIPT = join(ROOT, 'verify', 'doc-numbers.ts');
const DOCS = ['README.md', 'HAND-CODING.md', 'KNOWLEDGE.md'] as const;

const realDocs = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of DOCS) out[f] = readFileSync(join(ROOT, f), 'utf8');
  return out;
};

// ───────── 1. 口径：检查器必须等于它自己声称的那条命令 ─────────

test('lineCount 就是 wc -l：数换行符，最后一行不带换行符也不许多算一行（#45 的第一次现身）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docnum-caliber-'));
  try {
    const withNl = join(dir, 'a.ts');
    const noNl = join(dir, 'b.ts');
    writeFileSync(withNl, '一\n二\n三\n', 'utf8');
    writeFileSync(noNl, '一\n二\n三', 'utf8');
    assert.equal(lineCount(withNl), 3, '结尾有换行：三行应为 3');
    assert.equal(lineCount(noNl), 2, '结尾无换行：wc -l 就是 2。第一版用 split("\\n") 得到 3，' +
      '与 wc -l 差 1——这正是"文档 src 9642 / 检查器 9671"那一片红的成因：检查器不忠于它自己声明的口径');
    // 一次只喂一个文件：多个文件时 GNU wc 会再印一行"总计"，别把它读成第三个数
    const shellNums = [withNl, noNl].map((p) => {
      const s = spawnSync('wc', ['-l', p], { encoding: 'utf8' });
      return Number(String(s.stdout).trim().split(/\s+/)[0]);
    });
    assert.deepEqual(shellNums, [lineCount(withNl), lineCount(noNl)], `与 wc -l 不符：wc 给 ${shellNums}`);
    writeFileSync(join(dir, 'empty.ts'), '', 'utf8');
    assert.equal(lineCount(join(dir, 'empty.ts')), 0, '空文件必须是 0 行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lineCount 对仓库真实文件的读数能被 `find … | xargs wc -l` 复核（三个目录逐个核）', () => {
  for (const dir of ['src', 'test', 'verify']) {
    const shell = spawnSync('sh', ['-c', `find ${dir} -name '*.ts' | xargs wc -l | tail -1`], { cwd: ROOT, encoding: 'utf8' });
    const shellTotal = Number(String(shell.stdout).trim().split(/\s+/)[0]);
    assert.ok(Number.isFinite(shellTotal) && shellTotal > 0, `${dir}：wc -l 没给出数`);
    const files = spawnSync('sh', ['-c', `find ${dir} -name '*.ts' | sort`], { cwd: ROOT, encoding: 'utf8' })
      .stdout.trim().split('\n').filter(Boolean);
    assert.equal(files.reduce((a, f) => a + lineCount(join(ROOT, f)), 0), shellTotal, `${dir}：lineCount 合计 ≠ wc -l 合计`);
  }
});

test('中位数与中文数词的口径都写死在这里：奇数取下标 floor((n-1)/2)，四十四 == 44', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([5, 1, 3, 9]), 3, '偶数个取下中位，不许偷偷平均（文档要能重算出同一个数）');
  assert.equal(chineseToNumber('四十四'), 44);
  assert.equal(chineseToNumber('十'), 10);
  assert.equal(chineseToNumber('七'), 7);
  assert.equal(chineseToNumber('一百'), null, '超出射程就返回 null，绝不猜一个数');
});

// ───────── 2. 反向对照：真文档必须全绿，且检查器真的有在数格子 ─────────

test('反向对照：当前仓库的活文档 0 处不符（这条红了 = 文档数字又腐化了）', () => {
  const res = auditDocs(realDocs());
  const bad = [...res.claims.filter((c) => c.status !== 'ok').map((c) => `${c.id} ${c.status}：${c.reason}`),
    ...res.rows.filter((r) => r.status === 'bad').map((r) => `表格「${r.organ}」：${r.detail}`),
    ...res.invariants.filter((i) => !i.ok).map((i) => `${i.id} ${i.detail}`)];
  assert.deepEqual(bad, [], `文档数字与实测不符 ${res.mismatches} 处：\n${bad.join('\n')}`);
});

test('CLI 的退出码真的有牙：文档相符时 rc=0（不许只让纯函数绿而命令永远绿）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status ?? -1, 0, `verify:docs 应 rc=0，实际输出：\n${r.stdout}${r.stderr}`);
  assert.ok((r.stdout ?? '').includes('全部相符'), '输出必须把结论说成人话');
  const p = spawnSync(process.execPath, [SCRIPT, '--print'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(p.status ?? -1, 0);
  assert.ok((p.stdout ?? '').includes('test 行'), '--print 必须给出可抄的实测值');
});

test('检查器不许靠"清空射程"通过：每格要么有实测口径，要么当众写明不核', () => {
  assert.ok(CLAIMS.length >= 8, `锚点只剩 ${CLAIMS.length} 条，射程明显被缩过`);
  const ids = CLAIMS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, '锚点 id 不许重复');
  for (const c of CLAIMS) {
    assert.ok(c.groups.length > 0, `${c.id}：一个捕获组都没有的锚点等于没在核`);
    assert.ok(c.caliber.length > 5, `${c.id}：必须写清口径`);
    for (const g of c.groups) {
      if (g.measure === null) assert.ok((g.why ?? '').length > 5, `${c.id}/${g.name}：不核必须给理由`);
    }
  }
  assert.equal(INVARIANTS.filter((i) => i.caliber.length > 5).length, INVARIANTS.length, '恒等式也要有口径');
});

// ───────── 3. 注入：四种篡改，四种当场红 ─────────

/** 从活文档里掏出当前那行合计句，注入不许把数字写死（写死了 = 文档一改就误报前提没了） */
function currentTotalLine(): string {
  const line = (readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n').find((l) => l.startsWith('源码合计 ')) ?? '');
  assert.ok(line.length > 0, '注入前提：README 里没有以「源码合计 」开头的行');
  return line;
}

test('注入 1：合计句把任一数字改动一位 → 该锚点必须报 bad', () => {
  const line = currentTotalLine();
  for (const bump of [1, 2]) {
    const docs = realDocs();
    docs['README.md'] = docs['README.md']!.replace(line, line.replace(/源码合计 (\d+)/, (_m, n: string) => `源码合计 ${Number(n) + bump}`));
    const d1 = auditDocs(docs).claims.find((c) => c.id === 'D1')!;
    assert.equal(d1.status, 'bad', `把 src 行数改 +${bump} 后仍放行`);
  }
  // 另一格：test 行数。这一位正是 #45 真正腐化的地方
  const docs = realDocs();
  docs['README.md'] = docs['README.md']!.replace(line, line.replace(/，测试 (\d+)/, (_m, n: string) => `，测试 ${Number(n) - 12}`));
  const d1 = auditDocs(docs).claims.find((c) => c.id === 'D1')!;
  assert.equal(d1.status, 'bad', 'test 行数少印 12 行（#45 的实际偏差）必须被抓');
  const hit = d1.groups.find((g) => g.name === 'test 行')!;
  assert.ok(!hit.ok && hit.measured !== null, `要给出实测值：${JSON.stringify(hit)}`);
});

test('注入 2：删掉整句锚点 → 必须报 missing，不许因"没找到"而通过', () => {
  const docs = realDocs();
  const line = currentTotalLine();
  docs['README.md'] = docs['README.md']!.replace(line, '源码合计若干行（本行数字已被人改成散文）。');
  const d1 = auditDocs(docs).claims.find((c) => c.id === 'D1')!;
  assert.equal(d1.status, 'missing');
  assert.ok(d1.reason.includes('命中 0 次'), d1.reason);
});

test('注入 3：把同一句话复制一遍（数字不一样的两份）→ 必须报 ambiguous 而不是挑一份', () => {
  const docs = realDocs();
  const readme = docs['README.md']!;
  const line = currentTotalLine();
  docs['README.md'] = readme.replace(line, `${line}\n\n${line.replace(/源码合计 (\d+)/, (_m, n: string) => `源码合计 ${Number(n) + 1}`)}`);
  const d1 = auditDocs(docs).claims.find((c) => c.id === 'D1')!;
  assert.equal(d1.status, 'ambiguous', '两份"当前数字"必须报歧义');
  assert.ok(d1.reason.includes('命中 2 次'), d1.reason);
});

test('注入 4：五脏清单某一行的行数被改 → 报错要点出是哪一行、实测多少', () => {
  const docs = realDocs();
  const before = auditOrganTable(docs['README.md']!);
  assert.equal(before.filter((r) => r.status === 'bad').length, 0, '前提：表格现在逐行相符');
  docs['README.md'] = docs['README.md']!.replace('`src/world/ear.ts` | 767 |', '`src/world/ear.ts` | 768 |');
  const rows = auditOrganTable(docs['README.md']!);
  const bad = rows.filter((r) => r.status === 'bad');
  assert.equal(bad.length, 1, '应且仅应报出被改的那一行');
  assert.ok(bad[0]!.detail.includes('767'), `detail 要给出实测值：${bad[0]!.detail}`);
  assert.ok(bad[0]!.organ.includes('眼耳矛盾判据'), `要点出是哪一行：${bad[0]!.organ}`);
});

test('注入 5：中文数词被改（当前条数→九十九）而清单没加条目 → bad', () => {
  const docs = realDocs();
  assert.match(docs['KNOWLEDGE.md']!, /^## 今天真实学到的[一二三四五六七八九十]+条（优先掌握）$/m, '注入前提：标题句式');
  docs['KNOWLEDGE.md'] = docs['KNOWLEDGE.md']!.replace(/^(## 今天真实学到的)[一二三四五六七八九十]+(条（优先掌握）)$/m, '$1九十九$2');
  const d6 = auditDocs(docs).claims.find((c) => c.id === 'D6')!;
  assert.equal(d6.status, 'bad');
  assert.ok((d6.groups[0]?.measured ?? '').includes('解析为 99'), d6.groups[0]?.measured);
});

test('注入 6：表格文件格指向不存在的文件 → 只能"当众不核"，不许算通过', () => {
  const rows = auditOrganTable(
    '| 器官 | 职责 | 文件 | 行数 | 类比 |\n|---|---|---|---|---|\n| X | y | `src/根本没有.ts` | 1 | z |\n',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'skip', '解析不到文件时必须出声，不许静默 ok');
  assert.ok(rows[0]!.detail.includes('不核'), rows[0]!.detail);
});

test('注入 7：KNOWLEDGE 清单被删一条 → 恒等式 I1 的实测两侧当场分家', () => {
  const knowledge = readFileSync(join(ROOT, 'KNOWLEDGE.md'), 'utf8');
  assert.ok(countMatches(knowledge, '- [ ] ') > 0, '前提：清单有条目');
  const fewer = knowledge.replace(/\n- \[ \] [^\n]*/, '');
  assert.equal(countMatches(fewer, '- [ ] '), countMatches(knowledge, '- [ ] ') - 1, '注入必须真的少一条');
  const ledger = countMatches(readFileSync(join(ROOT, 'README.md'), 'utf8'), '\n### #');
  assert.notEqual(ledger, countMatches(fewer, '- [ ] '), '少一条之后台账与清单不该再相等');
});

// ───────── 4. 解析件：别把表格外的事读成表格 ─────────

test('只吃五脏清单那一张表：README 其它表格不进射程', () => {
  const rows = organTableLines(readFileSync(join(ROOT, 'README.md'), 'utf8'));
  assert.ok(rows.length >= 25, `表格只剩 ${rows.length} 行`);
  assert.ok(rows.every((r) => r.startsWith('|')), '取到的必须都是表格行');
  assert.ok(!rows.some((r) => r.includes('| 单元 + 集成测试 |')), '§0 事实表不许混进来');
});

test('文件格解析：大括号展开、裸文件名沿用上一个目录，且只认仓库里真存在的路径', () => {
  const brains = resolvePaths('`src/brain/{index,mock,openai,stdio}.ts`');
  assert.deepEqual(brains, ['src/brain/index.ts', 'src/brain/mock.ts', 'src/brain/openai.ts', 'src/brain/stdio.ts']);
  const mixed = resolvePaths('`src/world/lexicon.ts`、`detect.ts`、`src/m4f.ts`');
  assert.deepEqual(mixed, ['src/world/lexicon.ts', 'src/world/detect.ts', 'src/m4f.ts']);
  assert.deepEqual(resolvePaths('`src/没有这个文件.ts`'), []);
});

test('--json 与纯函数一致；measuredSnapshot 全是可抄的数', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status ?? -1, 0);
  const j = JSON.parse(r.stdout ?? '{}') as { claims: unknown[]; mismatches: number };
  assert.equal(j.claims.length, CLAIMS.length, 'JSON 输出要把每条锚点都摊开');
  assert.equal(j.mismatches, 0);
  const snap = measuredSnapshot();
  for (const [k, v] of Object.entries(snap)) {
    assert.ok(Number.isFinite(Number(v)) || typeof v === 'string', `${k} 不是可抄的数：${String(v)}`);
  }
  assert.equal(snap['自测清单条数'], countMatches(readFileSync(join(ROOT, 'KNOWLEDGE.md'), 'utf8'), '- [ ] '));
});
