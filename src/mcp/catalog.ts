/** MCP 对外目录。只暴露三个分步工具、一个玩家侧资源模板和一个使用提示。 */
export const SERVER_INFO = { name: 'agent-harness', version: '0.1.0' } as const;

export const CAPABILITIES = {
  tools: { listChanged: false },
  resources: { subscribe: false, listChanged: false },
  prompts: { listChanged: false },
} as const;

const RUN_ID_SCHEMA = {
  type: 'string',
  pattern: '^mcp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  description: 'harness_start 返回的显式 run handle',
};

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thought', 'call'],
  properties: {
    thought: { type: 'string', description: '宿主大脑为什么采取这一步' },
    call: {
      type: 'object', additionalProperties: false, required: ['name', 'args'],
      properties: {
        name: { type: 'string', description: 'request.tools 中的一个工具名' },
        args: { type: 'object', additionalProperties: true },
      },
    },
    predict: { type: 'object', additionalProperties: true, description: '可选：对本次动作画面结果的预测' },
    surprise: {
      type: 'object', additionalProperties: true,
      properties: { unexpected: { type: 'boolean' }, why: { type: 'string' } },
    },
    testing: {
      description: '可选：本次预测检验哪条假设',
      oneOf: [
        { type: 'string' },
        { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' }, field: { type: 'string' } } },
      ],
    },
  },
};

export const TOOLS = [
  {
    name: 'harness_start',
    description: '开始一局。返回 run_id 与第一步 DecideRequest；server 不启动模型，下一步决策由宿主大脑读取 request 后产生。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        seed: { type: 'integer', minimum: 0, maximum: 0xffff_ffff, description: '世界种子；默认 6' },
        max_steps: { type: 'integer', minimum: 1, maximum: 200, description: '本局动作预算；默认 40' },
        max_wall_ms: { type: 'integer', minimum: 1000, maximum: 900000, description: '墙钟预算；默认 300000' },
      },
    },
  },
  {
    name: 'harness_step',
    description: '提交宿主大脑产生的一条 Decision。server 执行工具、客观核对预测/目标、更新假设板并返回下一步 request；重复或过期步号会被拒绝。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['run_id', 'expected_step', 'decision'],
      properties: {
        run_id: RUN_ID_SCHEMA,
        expected_step: { type: 'integer', minimum: 1, maximum: 201, description: '上一步 request.step；防止并发重复执行' },
        decision: DECISION_SCHEMA,
      },
    },
  },
  {
    name: 'harness_status',
    description: '读取一局的安全状态与当前 request。进行中不返回裁判侧数据；停止后返回完整证据路径与局末判决。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['run_id'],
      properties: { run_id: RUN_ID_SCHEMA },
    },
  },
] as const;

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'harness://run/{run_id}/agent-view',
    name: 'agent-view',
    description: '当前玩家可见屏幕与 DecideRequest；进行中不含 mutant、coverage、internalState 或 detection。',
    mimeType: 'application/json',
  },
] as const;

export const PROMPTS = [
  {
    name: 'arena-play',
    description: '把宿主接入分步游戏试玩：start → 读 request → step，直到模型自己 finish 或预算停止。',
    arguments: [],
  },
] as const;

export const ARENA_PLAY_PROMPT =
  '你是这局游戏的大脑，agent-harness 只是量具，不会替你调用模型。' +
  '先调 harness_start，完整阅读返回的 request（system、tools、messages、notes、hypotheses、goals）。' +
  '每一步只产生一个 Decision，用当前的 request.step 作为 expected_step 调 harness_step。' +
  '观察返回的 output 与 prediction，再决定下一步；不要把整串动作提前提交。' +
  '需要留痕时用 request.tools 里的 note，需要声明目标时用 goal。' +
  '任务完成、证据足够或无法推进时，由你提交 call.name="finish" 的 Decision。' +
  '不要读取或推断裁判侧文件；mutant、覆盖、内部状态与 detection 只在停止后交给人复盘。';
