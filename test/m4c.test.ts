/**
 * M4-c 双通道上限表的单元测试。
 *
 * 这张表的全部意义压在一句话上：**有一族缺陷对屏幕逐字节不可见，只有第二条通道看得见。**
 * 所以这里最要紧的不是"数字对不对"，而是三条防伪断言：
 *  1. 阴性对照（R0：参考版 vs 参考版）两条通道都必须零分叉——仪器漏气时整张表作废；
 *  2. 反向对照（世界层 M01/M04/M08 走同一张表）**一列都不许出现"仅耳可见"**——
 *     否则"仅耳可见"是判据自己造的桶，不是世界的性质（台账 #18：交叉核对两侧必须是同一个量的两种算法）；
 *  3. 眼睛那一侧必须还是 M4-f 冻结的 `diffScreens`，不在这里另写一份（否则两处迟早漂移）。
 * 另加恒等式：四格之和 === 案例数（#21 的老规矩）。
 *
 * ⚠️ 不跑真模型、不跑整批上限表（那是 `npm run verify:ear:ceiling`，几分钟量级）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CAPS, randomActions, runSequence, type Action } from '../src/world/arena.ts';
import { diffScreens, playSequence } from '../src/world/detect.ts';
import { REFERENCE_SOUND, SOUND_MUTANTS, findMutant } from '../src/world/mutants.ts';
import { REFERENCE_RIG, soundStream } from '../src/world/sound.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactProblems, compareArtifacts, cueFired, diffSounds, groupByTick, tally, tableGuardProblems, twoChannelCase,
  type CellTally, type ChannelCase,
} from '../src/m4c.ts';

const acts = (seed: number, n = 40): Action[] => randomActions(seed, 4000, n);

// ─────────────────────────── 阴性对照 ───────────────────────────

test('R0 参考版 vs 参考版：两条通道都必须零分叉', async () => {
  for (const seed of [6, 7, 11]) {
    const c = await twoChannelCase(seed, acts(seed), 0, {}, { rig: REFERENCE_SOUND.rig }, { sound: 'R0' });
    assert.equal(c.eye.diverged, false, `seed=${seed} 参考版屏幕自己分了叉：重放不确定，整批作废`);
    assert.equal(c.ear.diverged, false, `seed=${seed} 参考版声流自己分了叉：发声层不是纯函数`);
    assert.equal(c.cell, '两者都不可见');
  }
});

// ─────────────────────── 主结论：屏幕看不见的那一族 ───────────────────────

test('发声层缺陷对屏幕逐字节不可见：十个 S 变异体一列"两者都可见"都不许有', async () => {
  const cases: ChannelCase[] = [];
  for (const seed of [6, 8]) {
    const a = acts(seed, 60);
    for (const s of SOUND_MUTANTS) {
      cases.push(await twoChannelCase(seed, a, cases.length, {}, { rig: s.rig }, { sound: s.id }));
    }
  }
  assert.equal(cases.length, SOUND_MUTANTS.length * 2);
  for (const c of cases) {
    assert.equal(c.eye.diverged, false, `${c.sound} 竟然在屏幕上露出了脸：那它就不是输出层缺陷`);
    assert.ok(c.cell === '仅耳可见' || c.cell === '两者都不可见', `${c.sound} 落进了奇怪的格子：${c.cell}`);
  }
  const onlyEar = cases.filter((c) => c.cell === '仅耳可见');
  assert.ok(onlyEar.length >= SOUND_MUTANTS.length, `${cases.length} 例里只有 ${onlyEar.length} 例仅耳可见，语料太瘦`);
});

test('反向对照：世界层缺陷不会被这张表算成"仅耳可见"', async () => {
  // M01 穿墙 / M04 不击杀 / M08 不计分——缺陷在 step() 里，屏幕一定看得见（或根本没达成）。
  // 若它们里有任何一例落进"仅耳可见"，说明分叉面判错了，上面那条主结论也就不可信。
  for (const id of ['M01', 'M04', 'M08']) {
    const m = findMutant(id);
    const c = await twoChannelCase(6, acts(6, 60), 0, {}, { caps: m.caps }, { sound: 'REF', world: id });
    assert.notEqual(c.cell, '仅耳可见', `${id} 是**世界层**缺陷，落进"仅耳可见"= 判据在造桶`);
  }
});

test('世界层缺陷会带着耳朵一起分叉（发声跟着画面走，不是独立乱响）', async () => {
  // M01 穿墙 ⇒ 位置变了 ⇒ 脚步/闷响的选择也变。屏幕分叉时耳朵**也**分叉，落"两者都可见"。
  // 这一条钉的是"耳朵没有自己乱说话"：它分叉当且仅当画面证据支持它分叉。
  const m = findMutant('M01');
  let 两者都可见 = 0;
  for (const seed of [6, 7, 8, 42]) {
    const c = await twoChannelCase(seed, acts(seed, 60), 0, {}, { caps: m.caps }, { sound: 'REF', world: 'M01' });
    if (c.eye.diverged) {
      assert.equal(c.ear.diverged, true, `seed=${seed}：屏幕分叉而耳朵静默 = 声流没跟着状态走`);
      assert.equal(c.cell, '两者都可见');
      两者都可见++;
    }
  }
  assert.ok(两者都可见 >= 2, `夹具太瘦：M01 在这四个种子上只分叉 ${两者都可见} 次`);
});

// ───────────────── 口径守卫：错位必须被"帧号"量出来 ─────────────────

test('S10 时钟错位：只比内容或只数句数的口径都看不见它，diffSounds 看得见', async () => {
  const a = acts(23, 50);
  const states = runSequence(6, a, ALL_CAPS).states;
  const actsAll: (Action | null)[] = [null, ...a];
  const good = soundStream(states, actsAll, REFERENCE_RIG);
  const late = soundStream(states, actsAll, { caps: { ...REFERENCE_RIG.caps }, shiftTicks: 1 });

  // 错误口径一：只看内容多重集（不管哪一帧响的）
  const multiset = (xs: typeof good) => xs.map((e) => e.text).sort().join('|');
  assert.equal(multiset(good), multiset(late), '夹具不成立：错位本该内容完全相同');
  // 错误口径二：只数每帧几句
  const counts = (xs: typeof good) => [...groupByTick(xs).entries()].map(([t, l]) => `${t}:${l.length}`).join('|');
  assert.notEqual(counts(good), counts(late), '帧号后移后每帧句数的键本该一起挪动');
  // 正确口径：帧号 + 帧内句子序列
  const d = diffSounds(good, late);
  assert.equal(d.diverged, true, 'diffSounds 对整条晚一帧的声流报零分叉 = S10 这一族永远进不了表');
  assert.ok(d.first !== null && d.first >= 1);
});

test('前提没达成 ≠ 通道看不见：没死过人时 S07 落在"两者都不可见"而不是漏检', async () => {
  // S07 = 自身倒地声丢失。25 步随机游走通常死不了；死了才谈得上分叉。
  const a = acts(31, 25);
  const c = await twoChannelCase(31, a, 0, {}, { rig: SOUND_MUTANTS[6]!.rig }, { sound: 'S07' });
  assert.equal(c.eye.diverged, false);
  const died = /一记沉重的倒地声。/.test((await soundTexts(31, a)).join(''));
  if (!died) {
    assert.equal(c.cell, '两者都不可见', '没触发过的前提被记成"耳朵分叉"= 上限表在虚报战果');
    assert.equal(c.refSoundEvents, (await soundTexts(31, a)).length);
  } else {
    assert.equal(c.cell, '仅耳可见');
  }
});

async function soundTexts(seed: number, a: readonly Action[]): Promise<string[]> {
  return soundStream(runSequence(seed, a, ALL_CAPS).states, [null, ...a]).map((e) => e.text);
}

// ───────────────── 分母：前提达成（世界侧独立算）─────────────────

test('前提对账：手造轨迹里"这记该响"的每一格，耳朵必须真的分叉', async () => {
  // 三条各自只触发一记的动作序列，**用世界状态亲手造**，不靠随机语料碰运气。
  // 断言两侧：世界侧谓词说该响（cueFired=true）且耳朵侧分叉（cell=仅耳可见）。
  // 任一侧单独成立都不算——那正是"分母是猜的"那种表。
  const bumpIntoWall: Action[] = [{ kind: 'move', dir: 0 }]; // 出生点 [0,0]，往上出界 ⇒ 撞墙
  const states = runSequence(6, bumpIntoWall, ALL_CAPS).states;
  const actsAll: (Action | null)[] = [null, ...bumpIntoWall];
  // 夹具自证：世界这边确实"想上挪却没挪"（画面上玩家还在 [0,0]）
  assert.equal(states[1]!.player.x, 0);
  assert.equal(states[1]!.player.y, 0);
  assert.equal(cueFired('wallBump', states, actsAll), true, '夹具不成立：这一帧没构成撞墙');
  assert.equal(cueFired('footstep', states, actsAll), false, '夹具不成立：没挪动却算成了脚步');

  const s02 = SOUND_MUTANTS.find((s) => s.cue === 'wallBump')!;
  const c = await twoChannelCase(6, bumpIntoWall, 0, {}, { rig: s02.rig }, { sound: s02.id });
  assert.equal(c.cueFired, true);
  assert.equal(c.eye.diverged, false, '撞墙只是不发声，屏幕不该有任何变化');
  assert.equal(c.cell, '仅耳可见');
});

test('前提对账本身会红：rig 与标签接错时必须抛错，不许静默出一张错表', async () => {
  // 故意把"删拾取声"的 rig 标成 S01（脚步声）。世界侧说脚步该响，耳朵侧说两版一样。
  // 这条测的是**仪器的自检**：台账 #8/#15 那一族——判据说了却没接线，或者接线接错。
  const s06 = SOUND_MUTANTS.find((s) => s.cue === 'pickupClick')!;
  const walk: Action[] = [{ kind: 'move', dir: 1 }, { kind: 'move', dir: 2 }];
  await assert.rejects(
    () => twoChannelCase(6, walk, 0, {}, { rig: s06.rig }, { sound: 'S01' }),
    /前提对账失败/,
    'rig 与标签错位却没报错：上限表可以在完全接错线的情况下产出一张漂亮的表',
  );
});

test('达成前提的那些局，耳朵分叉率必须 100%：漏一格就是声流或口径漏了', async () => {
  const cases: ChannelCase[] = [];
  for (const seed of [6, 7, 8, 42]) {
    const a = acts(seed, 120);
    for (const s of SOUND_MUTANTS) {
      cases.push(await twoChannelCase(seed, a, cases.length, {}, { rig: s.rig }, { sound: s.id }));
    }
  }
  const meta = new Map<string, { kind: 'sound' | 'world' | 'reference'; label: string }>();
  for (const s of SOUND_MUTANTS) meta.set(s.id, { kind: 'sound', label: s.label });
  const table = tally(cases, meta);
  assert.equal(table.length, SOUND_MUTANTS.length);
  let 量到过 = 0;
  for (const t of table) {
    assert.notEqual(t.前提达成, null, `${t.id} 的前提列没算出来：发声层行不该是 null`);
    if (!t.前提达成) continue; // 这一格这批语料没触发——**闸门**负责让它红，这里不假装看见了
    量到过++;
    // 达成前提的那些局，耳朵分叉率必须是 100%（这一族的通道上限＝全看得见，只要它露过脸）
    assert.equal(t.仅耳可见, t.前提达成, `${t.id} 有 ${t.前提达成 - t.仅耳可见} 例"该响却没让耳朵分叉"`);
    assert.equal(t.耳分叉率, '100.0%');
    assert.equal(t.两者都可见, 0, `${t.id} 是输出层缺陷，屏幕那一侧不该分叉`);
  }
  assert.ok(量到过 >= 6, `${量到过}/10 格有前提达成，语料太瘦，这张表说明不了什么`);
});

test('闸门自检：三道闸每一道都必须响得起来（注入改过的表，逐条要求它红）', () => {
  const row = (over: Partial<CellTally>): CellTally => ({
    id: 'S01', kind: 'sound', label: '', cases: 10, fired: 10, 前提达成: 10,
    两者都可见: 0, 仅眼可见: 0, 仅耳可见: 10, 两者都不可见: 0,
    仅耳可见率: '100.0%', 耳分叉率: '100.0%', 首耳分叉帧中位: 3, ...over,
  });
  const clean = [
    row({}),
    row({ id: 'R0', kind: 'reference', 前提达成: null, fired: 0, 仅耳可见: 0, 两者都不可见: 10, 仅耳可见率: '0.0%', 耳分叉率: '—', 首耳分叉帧中位: null }),
    row({ id: 'M01', kind: 'world', 前提达成: null, 仅耳可见: 0, 两者都可见: 9, 两者都不可见: 1, 仅耳可见率: '0.0%', 耳分叉率: '—' }),
  ];
  assert.deepEqual(tableGuardProblems(clean), [], '一张完全正常的表被判成有问题：闸门是摆设，只会误伤');
  // 闸一：阴性对照漏气
  assert.ok(tableGuardProblems([clean[0]!, row({ id: 'R0', kind: 'reference', 前提达成: null, 仅耳可见: 1, 两者都不可见: 9 })])
    .some((p) => p.includes('漏气')), 'R0 自己分了叉却没红 = 仪器漏气会被当成缺陷');
  // 闸二：反向对照造桶
  assert.ok(tableGuardProblems([clean[1]!, clean[2]!, row({ id: 'M01', kind: 'world', 前提达成: null, 仅耳可见: 3 })])
    .some((p) => p.includes('世界层')), '世界层缺陷被算成"仅耳可见"却没红 = 判据在造桶而无人看管');
  // 闸三：从没触发却出了一格
  assert.ok(tableGuardProblems([row({ 前提达成: 0, 仅耳可见: 0, 两者都不可见: 10, 耳分叉率: '—' }), clean[1]!, clean[2]!])
    .some((p) => p.includes('从没触发')), '"这格压根没量过"被静默算进 0%（§10.13 那一族）');
  // 闸四：对照缺席
  assert.ok(tableGuardProblems([row({})]).some((p) => p.includes('阴性对照行')), '对照行整行缺席时闸门放行 = 少一行比错一行更隐蔽');
});


// ─────────────────────────── 恒等式与聚合 ───────────────────────────

test('tally：四格之和 === 案例数，且每一格都真被填到过', async () => {
  const cases: ChannelCase[] = [];
  const meta = new Map<string, { kind: 'sound' | 'world' | 'reference'; label: string }>();
  meta.set('R0', { kind: 'reference', label: REFERENCE_SOUND.label });
  for (const s of SOUND_MUTANTS) {
    meta.set(s.id, { kind: 'sound', label: s.label });
    cases.push(await twoChannelCase(6, acts(6, 60), cases.length, {}, { rig: s.rig }, { sound: s.id }));
  }
  cases.push(await twoChannelCase(6, acts(6, 60), cases.length, {}, { rig: REFERENCE_SOUND.rig }, { sound: 'R0' }));
  const table = tally(cases, meta);
  assert.equal(table.reduce((s, t) => s + t.cases, 0), cases.length, '聚合把案例弄丢或弄重了');
  for (const t of table) {
    const sum = t.两者都可见 + t.仅眼可见 + t.仅耳可见 + t.两者都不可见;
    assert.equal(sum, t.cases, `${t.id} 四格之和 ${sum} ≠ 案例数 ${t.cases}`);
  }
  const onlyEar = table.reduce((s, t) => s + t.仅耳可见, 0);
  const invisible = table.reduce((s, t) => s + t.两者都不可见, 0);
  assert.ok(onlyEar > 0 && invisible > 0, `这张表只跑出了两种格子（仅耳 ${onlyEar} / 都不可见 ${invisible}），聚合逻辑没被真正遍历`);
});

test('眼睛那一侧不许有第二套口径：ChannelCase.eye 必须逐字段等于 diffScreens 的结果', async () => {
  const a = acts(17, 50);
  const m = findMutant('M07');
  const c = await twoChannelCase(17, a, 0, {}, { caps: m.caps }, { sound: 'REF', world: 'M07' });
  const direct = diffScreens(await playSequence(17, ALL_CAPS, a), await playSequence(17, m.caps, a));
  assert.deepEqual(c.eye, { diverged: direct.diverged, first: direct.firstStep, frames: direct.frames });
});

// ─────────────────── 逐字节重算核对（--check） ───────────────────
// 上限表对外的全部说服力来自一句可执行的话：**任何人重算都得到同一份字节**。
// `--check` 就是这句话的实现，所以它自己必须会被"字节变了"抓到，也不会被"文件不在"糊过去。

const FAKE = { jsonl: '{"a":1}\n{"a":2}\n', summaryText: '{\n  "totals": { "仅耳可见": 2 }\n}\n' };

function withPublished(write: (dir: string) => void, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'm4c-check-'));
  try {
    write(dir);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('--check：两份产物逐字节相同 → 无分歧', () => {
  withPublished(
    (dir) => {
      writeFileSync(join(dir, 'ear_ceiling.jsonl'), FAKE.jsonl);
      writeFileSync(join(dir, 'ear_ceiling_summary.json'), FAKE.summaryText);
    },
    (dir) => {
      const lines = compareArtifacts(dir, FAKE);
      assert.deepEqual(artifactProblems(lines), [], `一致却报分歧：${lines.join(' | ')}`);
      assert.equal(lines.length, 2, '两份产物都该被点到名，不能只比一份');
    },
  );
});

test('--check：jsonl 第 2 行差一个字节也要报，且给出行号与两边原文', () => {
  withPublished(
    (dir) => {
      writeFileSync(join(dir, 'ear_ceiling.jsonl'), '{"a":1}\n{"a":9}\n');
      writeFileSync(join(dir, 'ear_ceiling_summary.json'), FAKE.summaryText);
    },
    (dir) => {
      const problems = artifactProblems(compareArtifacts(dir, FAKE));
      assert.equal(problems.length, 1, `只改了一行 jsonl，就该恰好报一条：${problems.join(' | ')}`);
      assert.match(problems[0]!, /ear_ceiling\.jsonl/);
      assert.match(problems[0]!, /第 2 行/, '必须给行号，否则报"不一致"等于让人自己 diff');
      assert.match(problems[0]!, /"a":9/, '已发布那一侧的原文要贴出来');
      assert.match(problems[0]!, /"a":2/, '重算那一侧的原文也要贴出来');
    },
  );
});

test('--check：证据目录不存在时报 [证据缺失] 并算分歧（"没测到"绝不算通过，§10.13）', () => {
  const dir = join(tmpdir(), `m4c-check-不存在-${process.pid}-${Date.now()}`);
  const problems = artifactProblems(compareArtifacts(dir, FAKE));
  assert.equal(problems.length, 2, `两份产物都缺，就该各报一条：${problems.join(' | ')}`);
  for (const p of problems) assert.match(p, /\[证据缺失\]/);
  // 只缺一份时也只报那一份——否则"部分跳过"会伪装成"部分通过"
  withPublished(
    (d) => void writeFileSync(join(d, 'ear_ceiling.jsonl'), FAKE.jsonl),
    (d) => {
      const some = artifactProblems(compareArtifacts(d, FAKE));
      assert.equal(some.length, 1);
      assert.match(some[0]!, /ear_ceiling_summary\.json/);
    },
  );
});

test('--check：比对的是字节，不是"聚合数字相同"（重排案例必须被抓到）', () => {
  const shuffled = '{"a":2}\n{"a":1}\n';
  withPublished(
    (dir) => {
      writeFileSync(join(dir, 'ear_ceiling.jsonl'), shuffled);
      writeFileSync(join(dir, 'ear_ceiling_summary.json'), FAKE.summaryText);
    },
    (dir) => {
      // 两份内容互为重排：任何"求和/计数相同就算一致"的实现都会在这里放过去
      const sorted = (x: string): string => x.split('\n').filter(Boolean).sort().join('\n');
      assert.equal(sorted(shuffled), sorted(FAKE.jsonl), '夹具本身要先成立：数字相同、字节不同');
      assert.equal(artifactProblems(compareArtifacts(dir, FAKE)).length, 1);
    },
  );
});

test('--check：报的是磁盘字节数，不是 JS 字符数（台账 #35：中文键名让两者差一截）', () => {
  // 产物里有中文键名 ⇒ `str.length` 数的是字符，磁盘上数的是字节。
  // 这句话要是写错，守卫宣称的口径和实际的口径就不是一回事——它自己成了它要防的东西。
  const CN = { jsonl: '{"仅耳可见":159}\n', summaryText: FAKE.summaryText };
  assert.ok(
    Buffer.from(CN.jsonl, 'utf8').length > CN.jsonl.length,
    '夹具本身要先成立：这一段解码后的字符数与字节数必须不同，否则这条测试什么都没测',
  );
  withPublished(
    (dir) => {
      writeFileSync(join(dir, 'ear_ceiling.jsonl'), CN.jsonl);
      writeFileSync(join(dir, 'ear_ceiling_summary.json'), CN.summaryText);
    },
    (dir) => {
      const line = compareArtifacts(dir, CN).find((l) => l.includes('ear_ceiling.jsonl'))!;
      const onDisk = readFileSync(join(dir, 'ear_ceiling.jsonl')).length;
      assert.match(line, new RegExp(`（${onDisk} 字节）`), `✅ 那行的数字必须等于磁盘字节数（实际 ${line}）`);
      assert.notEqual(onDisk, CN.jsonl.length, '字符数与字节数不同，所以这条断言不是在自证');
    },
  );
});

test('--check：同一段解码结果、不同字节 → 判不一致（比 Buffer 才拦得住）', () => {
  // 0xEF 0xBF 0x0A 解码成 "\uFFFD\n"，和 0xEF 0xBF 0xBD 0x0A 是同一个字符串、不同的字节。
  // 旧实现比 `readFileSync(p,'utf8') === want`，这一格会被放过去——"逐字节"就成了口头上逐字节。
  const want = '\uFFFD\n';
  const lossy = Buffer.from([0xef, 0xbf, 0x0a]);
  assert.equal(lossy.toString('utf8'), want, '夹具本身要先成立：字节不同、解码相同');
  assert.notEqual(lossy.length, Buffer.from(want, 'utf8').length);
  withPublished(
    (dir) => {
      writeFileSync(join(dir, 'ear_ceiling.jsonl'), lossy);
      writeFileSync(join(dir, 'ear_ceiling_summary.json'), FAKE.summaryText);
    },
    (dir) => {
      const problems = artifactProblems(compareArtifacts(dir, { jsonl: want, summaryText: FAKE.summaryText }));
      assert.equal(problems.length, 1, `解码相同但字节不同，必须判不一致：${problems.join(' | ')}`);
      assert.match(problems[0]!, /ear_ceiling\.jsonl/);
    },
  );
});
