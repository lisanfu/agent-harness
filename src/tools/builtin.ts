/**
 * 内置工具：最小一套，但覆盖 harness 需要验证的全部路径。
 *   list_dir / read_file —— 观察（M1 的"眼睛"将来替换成 DOM 感知）
 *   note               —— 假设板，长期记忆雏形（M4 会长大）
 *   finish             —— 显式停止条件，由大脑自己决定何时收手
 *
 * 全部限制在沙箱内，不提供 shell 执行——最小 harness 不该自带任意命令执行能力。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { ErrCode, readable } from '../errors.ts';
import type { Tool, ToolContext, ToolResult } from '../types.ts';
import { SandboxEscape, resolveInSandbox } from './registry.ts';

const MAX_READ = 8000;

function denied(e: unknown): ToolResult {
  if (e instanceof SandboxEscape) return readable(ErrCode.TOOL_DENIED, e.message);
  const err = e as NodeJS.ErrnoException;
  if (err?.code === 'ENOENT') {
    return readable(ErrCode.TOOL_ARGS, `目标不存在：${err.message}`, '先用 list_dir 看看有什么，再决定读哪个。');
  }
  return readable(ErrCode.TOOL_RUNTIME, `访问失败：${err?.message ?? String(e)}`);
}

export const listDir: Tool = {
  name: 'list_dir',
  description: '列出沙箱内某个目录的条目。path 省略则为沙箱根。',
  params: { path: { type: 'string', description: '相对沙箱根的目录路径', required: false } },
  run(args, ctx: ToolContext): ToolResult {
    try {
      const dir = resolveInSandbox(ctx.sandbox, String(args['path'] ?? '.'));
      const entries = readdirSync(dir, { withFileTypes: true })
        .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
        .sort();
      return {
        ok: true,
        output: entries.length ? entries.join('\n') : '（空目录）',
      };
    } catch (e) {
      return denied(e);
    }
  },
};

export const readFile: Tool = {
  name: 'read_file',
  description: `读取沙箱内一个文本文件，最多返回 ${MAX_READ} 字符。`,
  params: { path: { type: 'string', description: '相对沙箱根的文件路径', required: true } },
  run(args, ctx: ToolContext): ToolResult {
    try {
      const file = resolveInSandbox(ctx.sandbox, String(args['path']));
      const st = statSync(file);
      if (st.isDirectory()) {
        return readable(ErrCode.TOOL_ARGS, `"${String(args['path'])}" 是目录不是文件。`, '请改用 list_dir。');
      }
      const text = readFileSync(file, 'utf8');
      const clipped = text.length > MAX_READ;
      return {
        ok: true,
        output: clipped
          ? `${text.slice(0, MAX_READ)}\n[…已截断，共 ${text.length} 字符]`
          : text || '（空文件）',
      };
    } catch (e) {
      return denied(e);
    }
  },
};

/**
 * 假设板（M4-b 长大）。两条通道并存，界线清楚：
 *   只给 text        → 纯笔记，M1 语义与输出**一字不改**（跨轮对照的口径不能变）
 *   带 id            → 一条可检验的假设，可被 testing 归因、可由模型自己淘汰
 *
 * 为什么长假设而不只是加字段：真跑两局都独立发明了"敌人会新生成"这条假规则，
 * 其中一局写成"规则已确认"存进板子，然后每一步原样回喂。
 * 只进不出的记忆 = 错误单调累积。状态与客观计数就是给它的出口。
 *
 * 分工：**status 由模型声明，代码绝不改**；核对计数由代码累加，模型无权写。
 * 工具层只做参数归一化，全部校验交给 Board——拒绝理由才不会两处各说一套。
 */
export const note: Tool = {
  name: 'note',
  description: '把假设或发现写进假设板，跨步骤常驻、不会被上下文截断丢掉。只给 text 是一条纯笔记；带 id 则立一条可检验的假设，之后可改它的正文或状态。',
  params: {
    text: { type: 'string', description: '正文。不带 id 时必填；带 id 新建时必填，改写已有假设时可选', required: false },
    id: { type: 'string', description: '假设编号，由你自己起（例如 H1）。带上它才是结构化假设', required: false },
    status: { type: 'string', description: '假设状态，只能是 proposed / confirmed / retired。retired 表示你决定不再拿它当依据（仍留档）。必须带 id', required: false },
    why: { type: 'string', description: '这次改状态或改正文的理由，会随假设一起留档。必须带 id', required: false },
  },
  run(args, ctx: ToolContext): ToolResult {
    const has = (k: string): boolean => args[k] !== undefined && args[k] !== null;
    const text = has('text') ? String(args['text']).trim() : undefined;
    const status = has('status') ? String(args['status']).trim() : undefined;
    const why = has('why') ? String(args['why']).trim() : undefined;

    if (!has('id')) {
      // 给了 status/why 却没有 id：绝不静默降级成纯笔记。
      // 降级会把"模型想立一条可检验假设"这个行为抹掉，事后归因就分不清了。
      if (status !== undefined || why !== undefined) {
        return readable(
          ErrCode.TOOL_ARGS,
          'status / why 只对带 id 的结构化假设有意义。',
          '要立一条可检验的假设，请同时给 id 与 text；要写纯笔记，请只给 text。',
        );
      }
      if (!text) return readable(ErrCode.TOOL_ARGS, 'note 的内容不能为空。');
      ctx.note(text);
      return { ok: true, output: `已记录（假设板现有 ${ctx.notes().length} 条）` };
    }

    const id = String(args['id']).trim();
    if (!id) return readable(ErrCode.TOOL_ARGS, 'id 不能是空白。', '要写纯笔记请只给 text，不要给 id。');
    if (!ctx.board) {
      return readable(ErrCode.TOOL_ARGS, `本局没有启用结构化假设板，无法处理 id="${id}"。`, '请只给 text 写纯笔记。');
    }
    const w = ctx.board.write({
      id,
      ...(text !== undefined ? { text } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(why !== undefined ? { why } : {}),
    });
    if (!w.ok) return readable(ErrCode.TOOL_ARGS, w.message);
    return { ok: true, output: w.message };
  },
};

/**
 * 目标器官（M4-b2）。与 note 并列，但**界线完全不同**：
 * note 记的是"我认为世界怎么运作"（规律，不可机器判定），
 * goal 记的是"我要把局面制造成哪个状态"（等值条件，代码每步可客观判定）。
 *
 * 为什么它是**独立工具**而不是 note 的一个字段：两者的判据不同。
 * 假设靠模型自己声明 testing 来归因，目标靠代码每步判定；
 * 塞进同一工具会让"计数单位"含糊（故障 #13 的根源就是把两种东西混在一块板上）。
 *
 * 分工同假设板：**status 归模型，判定计数归代码**。
 * 工具层只做参数归一化与 JSON 套壳容错，全部校验交给 Goals——
 * 一个类别一个主人，拒绝理由才不会两处各说一套。
 *
 * ⚠️ 这个工具**不在 builtinTools() 里**：文件模式没有画面，
 * 注册一个永远判不出结果的接口等于给模型一件摆设（也污染跨轮对照的契约）。
 * 只有世界层给了 GoalSeam，循环层才注册它。
 */
export const goal: Tool = {
  name: 'goal',
  description: '立一条目标或改写它：声明"你要把局面制造成哪个状态"，并给出完成条件 doneWhen。代码每一步拿画面客观判定它满足没有，计数由代码累加。',
  params: {
    id: { type: 'string', description: '目标编号，由你自己起（例如 G1）。必填', required: true },
    text: { type: 'string', description: '目标正文。新建时必填；改写已有目标时可选', required: false },
    doneWhen: { type: 'object', description: '完成条件：画面字段 → 期望值，只认等值。可用字段见下面「目标与完成条件」说明。留空则这条目标无法客观判定', required: false },
    status: { type: 'string', description: '目标状态，只能是 open / achieved / abandoned。必须由你声明，代码绝不替你改', required: false },
    why: { type: 'string', description: '这次立它 / 改它 / 收口或放弃它的理由，会随目标一起留档', required: false },
  },
  run(args, ctx: ToolContext): ToolResult {
    if (!ctx.goals) {
      // 绝不静默收下：那会把"模型表达了目标导向意图"这个行为抹掉，事后无法归因。
      return readable(ErrCode.TOOL_ARGS, '本局没有启用目标通道（没有可核对的画面），goal 工具不可用。',
        '请用 note 记下你的判断，它不需要画面就能留档。');
    }
    const has = (k: string): boolean => args[k] !== undefined && args[k] !== null;
    const id = has('id') ? String(args['id']).trim() : '';
    const text = has('text') ? String(args['text']).trim() : undefined;
    const status = has('status') ? String(args['status']).trim() : undefined;
    const why = has('why') ? String(args['why']).trim() : undefined;

    // doneWhen 的 JSON 字符串套壳由注册表拆（与所有 object 型参数同一条规则，一个主人）。
    // 这里刻意不再"修好"它：拆成什么样就交给器官判形状，器官会留原文并记 malformed。
    // 猜一个条件等于伪造模型没写过的意图。
    const raw = args['doneWhen'];

    const w = ctx.goals.write({
      id,
      ...(text !== undefined ? { text } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(why !== undefined ? { why } : {}),
      ...(raw !== undefined && raw !== null ? { doneWhen: raw } : {}),
    });
    if (!w.ok) return readable(ErrCode.TOOL_ARGS, w.message);
    return { ok: true, output: w.message };
  },
};

export const finish: Tool = {  name: 'finish',
  description: '当你认为任务已完成、或证据已足够、或确认走不下去时调用它收手。必须给出结论。',
  params: { summary: { type: 'string', description: '你的结论与依据', required: true } },
  run(args): ToolResult {
    return { ok: true, output: `已收尾：${String(args['summary'])}` };
  },
};

export function builtinTools(): Tool[] {
  return [listDir, readFile, note, finish];
}

/** 初始状态快照：重放三要素之一，必须可序列化 */
export function snapshotSandbox(sandbox: string): string[] {
  try {
    return readdirSync(sandbox)
      .map((n) => {
        try {
          return `${statSync(`${sandbox}/${n}`).isDirectory() ? 'd' : 'f'} ${relative(sandbox, `${sandbox}/${n}`)}`;
        } catch {
          return `? ${n}`;
        }
      })
      .sort();
  } catch {
    return [];
  }
}