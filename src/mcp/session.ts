/**
 * MCP 分步会话：宿主出大脑，量具出执行、核对、停止条件与证据。
 *
 * 三条安全边界：
 *  1. 不接收宿主任意输出路径；根目录只能由启动 server 的操作者配置。
 *  2. 进行中的 response / resource 只含玩家可见事实，不含 mutant、coverage、internalState 或 detection。
 *  3. run id 是随机显式 handle；恢复只允许本输出根下的 checkpoint，不接受路径参数。
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HarnessEngine, type EngineCheckpoint } from '../engine.ts';
import { ErrCode, HarnessError } from '../errors.ts';
import { parseDecision, repairHint } from '../parse.ts';
import { isWorldTool, toWorldActions } from '../tools/game.ts';
import type { Decision, DecideRequest, HarnessConfig, RunResult, StepRecord } from '../types.ts';
import {
  ARENA_TASK, createArenaWorld, finalizeArenaWorld,
  type ArenaFinalizeOptions, type ArenaRunResult, type ArenaWorld, type ArenaWorldOptions,
} from '../world/harness.ts';
import { judgeStamp } from '../world/detect.ts';
import { RpcError } from './protocol.ts';

export interface McpSessionOptions {
  /** 只能由 server 启动参数/环境变量给出，绝不来自 MCP 工具参数。 */
  outDir?: string;
  maxActiveRuns?: number;
  maxSteps?: number;
  maxWallMs?: number;
  world?: ArenaWorldOptions;
  provenance?: 'real' | 'fixture';
  brainId?: string;
  finalizeOptions?: ArenaFinalizeOptions;
  log?: (line: string) => void;
}

interface InFlight {
  step: number;
  decision: Decision;
}

interface McpCheckpoint {
  version: 2;
  runId: string;
  revision: number;
  initialWorldHash: string;
  config: HarnessConfig;
  world: ArenaWorldOptions;
  engine: EngineCheckpoint;
  pending?: DecideRequest | null;
  /** 动作执行前的预写。恢复时若仍在，说明无法证明动作是否完成：只停，绝不重放它。 */
  inFlight?: InFlight;
  finalized?: ArenaRunResult;
}

interface SessionEntry {
  runId: string;
  runDir: string;
  config: HarnessConfig;
  worldOptions: ArenaWorldOptions;
  world: ArenaWorld;
  engine: HarnessEngine;
  pending: DecideRequest | null;
  inFlight?: InFlight;
  revision: number;
  checkpointRaw: string;
  queue: Promise<unknown>;
  finalized?: ArenaRunResult;
  finalizing?: Promise<ArenaRunResult>;
}

const RUN_ID = /^mcp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START_KEYS = ['seed', 'max_steps', 'max_wall_ms'] as const;
const STEP_KEYS = ['run_id', 'expected_step', 'decision'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(params: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new RpcError(-32602, `不接受的参数：${key}`);
  }
}

interface FileLock { path: string; owner: string }

/**
 * 本地输出根上的跨进程互斥。队列只保护一个进程，文件锁保护共用同一 outDir 的多个 server。
 * 锁文件带 pid：进程真死后可回收；解析不全的锁按占用处理，绝不误删另一个正在写的锁。
 */
async function acquireFileLock(path: string): Promise<FileLock> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const owner = randomUUID();
    try {
      writeFileSync(path, `${JSON.stringify({ owner, pid: process.pid, at: Date.now() })}\n`, { flag: 'wx' });
      return { path, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let alive = true;
    try {
      const holder = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
      if (typeof holder.pid === 'number' && Number.isInteger(holder.pid)) {
        try { process.kill(holder.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
      }
    } catch {
      // 文件正在创建/读取的瞬间保持占用，不把半写的锁当成死者。
    }
    if (!alive) {
      // 不做"多个等待者竞争删旧锁"：删锁与新建之间没有 CAS，另一个等待者可能误删刚建的新锁。
      // 锁属于死进程时 fail-closed，让操作者确认没有活动进程后显式清理。
      throw new RpcError(-32000, `锁文件 ${path} 属于已退出进程；确认没有活动 server 后请显式删除该锁文件`);
    }
    if (Date.now() >= deadline) throw new RpcError(-32000, '同一 run 正被另一个 server 进程处理，请稍后重试');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function releaseFileLock(lock: FileLock): void {
  try {
    const holder = JSON.parse(readFileSync(lock.path, 'utf8')) as { owner?: unknown };
    if (holder.owner === lock.owner) unlinkSync(lock.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireFileLock(path);
  try { return await operation(); }
  finally { releaseFileLock(lock); }
}

function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RpcError(-32602, `${name} 必须是 ${min}..${max} 的整数`);
  }
  return value;
}

function copyWorldOptions(options: ArenaWorldOptions): ArenaWorldOptions {
  return {
    seed: options.seed,
    ...(options.mutant !== undefined ? { mutant: options.mutant } : {}),
    ...(options.doPredict !== undefined ? { doPredict: options.doPredict } : {}),
    ...(options.doGoal !== undefined ? { doGoal: options.doGoal } : {}),
    ...(options.doEar !== undefined ? { doEar: options.doEar } : {}),
    ...(options.soundMutant !== undefined ? { soundMutant: options.soundMutant } : {}),
  };
}

/** 局末才交裁判侧结果；进行中永远不走这个出口。 */
export function publicFinalResult(result: ArenaRunResult): Record<string, unknown> {
  return {
    kind: 'finished',
    ...(result.certified === false ? { certified: false } : {}),
    run_id: result.run.runId,
    run_dir: result.run.runDir,
    stop_reason: result.run.stopReason,
    step_count: result.run.steps.length,
    finish_summary: result.run.finishSummary ?? null,
    action_sequence: result.run.actionSequence,
    notes: result.run.notes,
    hypotheses: result.run.hypotheses,
    goals: result.run.goals,
    brain_retries: result.run.brainRetries ?? 0,
    parse_failures: result.run.parseFailures ?? 0,
    prediction_stats: result.run.predictionStats ?? null,
    hypothesis_stats: result.run.hypothesisStats,
    goal_stats: result.run.goalStats ?? null,
    initial_hash: result.initialHash,
    world_actions: result.worldActions,
    evidence_consistent: result.evidenceConsistent,
    replay_matches_live_session: result.replayMatchesLiveSession,
    files: result.files,
    notary: result.notary,
    detection: result.detection,
    ear: result.ear,
  };
}

export class McpSessionManager {
  private readonly outDir: string;
  private readonly maxActiveRuns: number;
  private readonly maxSteps: number;
  private readonly maxWallMs: number;
  private readonly worldOptions: ArenaWorldOptions;
  private readonly provenance: 'real' | 'fixture';
  private readonly brainId: string;
  private readonly finalizeOptions: ArenaFinalizeOptions;
  private readonly log: (line: string) => void;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly loading = new Map<string, Promise<SessionEntry>>();
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: McpSessionOptions = {}) {
    this.outDir = resolve(opts.outDir ?? join(process.cwd(), 'sandbox', 'mcp'));
    this.maxActiveRuns = boundedInt(opts.maxActiveRuns, 8, 1, 64, 'maxActiveRuns');
    this.maxSteps = boundedInt(opts.maxSteps, 40, 1, 200, 'maxSteps');
    this.maxWallMs = boundedInt(opts.maxWallMs, 300_000, 1_000, 900_000, 'maxWallMs');
    this.worldOptions = copyWorldOptions(opts.world ?? { seed: 6 });
    this.provenance = opts.provenance ?? 'real';
    this.brainId = opts.brainId ?? 'mcp-host';
    this.finalizeOptions = { ...(opts.finalizeOptions ?? {}) };
    this.log = opts.log ?? (() => {});
    mkdirSync(this.outDir, { recursive: true });
  }

  get outputRoot(): string { return this.outDir; }

  async start(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    rejectUnknown(params, START_KEYS);
    const seed = boundedInt(params.seed, this.worldOptions.seed, 0, 0xffff_ffff, 'seed');
    const maxSteps = boundedInt(params.max_steps, this.maxSteps, 1, 200, 'max_steps');
    const maxWallMs = boundedInt(params.max_wall_ms, this.maxWallMs, 1_000, 900_000, 'max_wall_ms');
    const operation = this.startQueue.then(() => withFileLock(join(this.outDir, '.mcp-start.lock'), async () => {
      if (this.activeCount() >= this.maxActiveRuns) {
        throw new RpcError(-32000, `进行中的局已达上限 ${this.maxActiveRuns}；请先收手或等预算停止`);
      }
      const runId = `mcp-${randomUUID()}`;
      const config: HarnessConfig = {
        task: ARENA_TASK,
        sandbox: join(this.outDir, 'sandbox'),
        seed,
        maxSteps,
        maxWallMs,
        maxContextChars: 12_000,
        keepRecent: 8,
        maxParseRetry: 2,
        repeatLimit: 3,
        outDir: this.outDir,
        provenance: this.provenance,
      };
      mkdirSync(config.sandbox, { recursive: true });
      const worldOptions = { ...copyWorldOptions(this.worldOptions), seed };
      let world: ArenaWorld;
      try {
        world = createArenaWorld(worldOptions);
      } catch (error) {
        throw new RpcError(-32602, `世界配置不可用：${(error as Error).message}`);
      }
      const engine = this.makeEngine(config, worldOptions, world, undefined, runId);
      const pending = engine.prepare();
      const entry = this.newEntry(runId, config, worldOptions, world, engine, pending);
      this.entries.set(runId, entry);
      this.save(entry);
      this.log(`[mcp] start ${runId} seed=${seed} max_steps=${maxSteps}`);
      return {
        kind: 'started',
        run_id: runId,
        step: pending?.step ?? 0,
        max_steps: maxSteps,
        stopped: engine.stopped,
        ...(pending ? { request: pending } : {}),
        ...(engine.stopped ? { result: publicFinalResult(await this.finish(entry)) } : {}),
      };
    }));
    this.startQueue = operation.catch(() => undefined);
    return operation;
  }

  async step(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    rejectUnknown(params, STEP_KEYS);
    const runId = this.requireRunId(params.run_id);
    const expected = boundedInt(params.expected_step, -1, 1, 201, 'expected_step');
    if (!isRecord(params.decision)) throw new RpcError(-32602, 'decision 必须是宿主产生的 JSON 对象');
    const loaded = await this.load(runId);
    return withFileLock(join(loaded.runDir, '.mcp-lock.json'), async () => {
      const entry = await this.refresh(loaded);
      return this.serial(entry, async () => {
      if (!entry.engine.checkBudget()) {
        this.save(entry);
        return { kind: 'finished', ...publicFinalResult(await this.finish(entry)) };
      }
      const actualExpected = entry.engine.stepCount + 1;
      if (expected !== actualExpected) {
        throw new RpcError(-32602, `expected_step=${expected} 已过期；当前应提交第 ${actualExpected} 步`);
      }
      if (!entry.pending) entry.pending = entry.engine.prepare();
      if (entry.engine.stopped) return { kind: 'finished', ...publicFinalResult(await this.finish(entry)) };
      const pending = entry.pending;
      if (!pending) throw new RpcError(-32603, 'Internal error: missing decision request');

      let decision: Decision;
      try {
        // 复用 CLI 的同一解析器：容错、留档与输出契约不能有 MCP 特供的第二套。
        decision = parseDecision(JSON.stringify(params.decision));
      } catch (error) {
        const he = error instanceof HarnessError ? error : new HarnessError(ErrCode.BRAIN_PARSE, String(error));
        entry.engine.noteParseFailure(params.decision, he.toInfo());
        const failures = entry.engine.checkpoint().parseFailures;
        if (failures > entry.config.maxParseRetry) {
          entry.engine.failBrain();
          this.save(entry);
          return { ...publicFinalResult(await this.finish(entry)), kind: 'brain_failed' };
        }
        const request = entry.engine.addRepair(repairHint(he, entry.engine.tools.map((t) => t.name)));
        entry.pending = request;
        this.save(entry);
        return { kind: 'repair_required', run_id: runId, request, repair: request.messages.at(-1)?.content ?? '' };
      }

      entry.pending = null;
      const inFlight: InFlight = { step: pending.step, decision };
      entry.inFlight = inFlight;
      this.save(entry); // 先写意图，再执行；断电恢复后宁可停，也不能把同一动作打两遍。
      let record: StepRecord;
      try {
        record = await entry.engine.execute(decision, 0);
      } catch (error) {
        entry.engine.interrupt(inFlight);
        throw error;
      }
      entry.inFlight = undefined;
      try {
        this.save(entry);
      } catch (error) {
        entry.inFlight = inFlight;
        entry.engine.interrupt(inFlight);
        throw error;
      }
      if (entry.engine.stopped) return { kind: 'finished', ...publicFinalResult(await this.finish(entry)) };
      const request = entry.engine.prepare();
      entry.pending = request;
      this.save(entry);
      return {
        kind: 'stepped',
        run_id: runId,
        observation: {
          step: record.index,
          tool: decision.call.name,
          ok: record.result.ok,
          output: record.result.output,
          ...(record.result.error ? { error: record.result.error } : {}),
          ...(record.prediction ? { prediction: record.prediction } : {}),
        },
        stopped: false,
        request,
      };
      });
    });
  }

  async status(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    rejectUnknown(params, ['run_id']);
    const loaded = await this.load(this.requireRunId(params.run_id));
    return withFileLock(join(loaded.runDir, '.mcp-lock.json'), async () => {
      const entry = await this.refresh(loaded);
      return this.serial(entry, async () => {
      if (!entry.engine.stopped && !entry.engine.checkBudget()) this.save(entry);
      if (!entry.engine.stopped && !entry.pending) {
        entry.pending = entry.engine.prepare();
        this.save(entry);
      }
      const base = {
        kind: 'status',
        run_id: entry.runId,
        step: entry.engine.stepCount,
        next_step: entry.engine.stopped ? null : entry.engine.stepCount + 1,
        max_steps: entry.config.maxSteps,
        stopped: entry.engine.stopped,
      };
      if (entry.engine.stopped) return { ...base, stop_reason: entry.engine.stop, result: publicFinalResult(await this.finish(entry)) };
      return { ...base, request: entry.pending };
      });
    });
  }

  /** 玩家侧 resource：与 tools 返回同源，不另开一条能读到裁判数据的路径。 */
  async agentView(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    rejectUnknown(params, ['run_id']);
    const loaded = await this.load(this.requireRunId(params.run_id));
    return withFileLock(join(loaded.runDir, '.mcp-lock.json'), async () => {
      const entry = await this.refresh(loaded);
      return this.serial(entry, async () => {
      if (!entry.engine.stopped && !entry.engine.checkBudget()) this.save(entry);
      if (!entry.engine.stopped && !entry.pending) {
        entry.pending = entry.engine.prepare();
        this.save(entry);
      }
      if (entry.engine.stopped) {
        return {
          run_id: entry.runId,
          stopped: true,
          stop_reason: entry.engine.stop,
          result: publicFinalResult(await this.finish(entry)),
        };
      }
      return {
        run_id: entry.runId,
        stopped: false,
        screen: entry.world.screen(),
        request: entry.pending,
      };
      });
    });
  }

  private newEntry(
    runId: string,
    config: HarnessConfig,
    worldOptions: ArenaWorldOptions,
    world: ArenaWorld,
    engine: HarnessEngine,
    pending: DecideRequest | null,
    checkpointRaw = '',
    revision = 0,
  ): SessionEntry {
    return {
      runId, runDir: engine.writer.runDir, config, worldOptions, world, engine, pending,
      revision, checkpointRaw,
      queue: Promise.resolve(),
    };
  }

  private makeEngine(
    config: HarnessConfig,
    worldOptions: ArenaWorldOptions,
    world: ArenaWorld,
    restored?: EngineCheckpoint,
    runId?: string,
  ): HarnessEngine {
    return new HarnessEngine({
      registry: world.registry,
      config,
      brainId: this.brainId,
      ...(runId ? { runId } : {}),
      log: this.log,
      judgement: judgeStamp(),
      worldHash: world.worldHash,
      loopFingerprint: world.loopFingerprint,
      initialWorld: world.initialWorld,
      screen: world.screen,
      ...(world.prediction ? { prediction: world.prediction } : {}),
      ...(world.goal ? { goal: world.goal } : {}),
      ...(restored ? { restored } : {}),
    });
  }

  private requireRunId(value: unknown): string {
    if (typeof value !== 'string' || !RUN_ID.test(value)) {
      throw new RpcError(-32602, 'run_id 必须是 harness_start 返回的 mcp UUID handle');
    }
    return value;
  }

  private activeCount(): number {
    let count = 0;
    // 磁盘 checkpoint 是唯一事实源：内存可能被另一个 server 收手，也可能正在 finalize。
    // 只数未 finalized 的目录；宁可在新局启动时保守一瞬，也不让重启释放名额。
    for (const dirent of readdirSync(this.outDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !RUN_ID.test(dirent.name)) continue;
      let checkpoint: McpCheckpoint;
      try {
        checkpoint = JSON.parse(readFileSync(join(this.outDir, dirent.name, 'mcp-checkpoint.json'), 'utf8')) as McpCheckpoint;
      } catch {
        throw new RpcError(-32603, `Internal error: invalid checkpoint in ${dirent.name}`);
      }
      if (checkpoint.runId !== dirent.name) throw new RpcError(-32603, `Internal error: checkpoint identity mismatch in ${dirent.name}`);
      if (!checkpoint.finalized) count++;
    }
    return count;
  }

  private serial<T>(entry: SessionEntry, operation: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(operation, operation);
    entry.queue = next.catch(() => undefined);
    return next;
  }

  private async load(runId: string): Promise<SessionEntry> {
    const live = this.entries.get(runId);
    if (live) return live;
    const pending = this.loading.get(runId);
    if (pending) return pending;

    // 恢复本身可能 await 世界重放；在它完成前，后来的请求必须等同一份装配结果，
    // 不能各自造一个 entry、各自绕过 serial 队列（重启后同 run 并发回归）。
    const operation = this.restore(runId);
    this.loading.set(runId, operation);
    try {
      return await operation;
    } finally {
      if (this.loading.get(runId) === operation) this.loading.delete(runId);
    }
  }

  private readCheckpoint(runId: string): { checkpoint: McpCheckpoint; raw: string } {
    const path = join(this.outDir, runId, 'mcp-checkpoint.json');
    if (!existsSync(path)) throw new RpcError(-32002, '找不到这个 run；它可能属于另一个 server 输出根');
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); }
    catch { throw new RpcError(-32603, 'Internal error: invalid checkpoint'); }
    let checkpoint: McpCheckpoint;
    try { checkpoint = JSON.parse(raw) as McpCheckpoint; }
    catch { throw new RpcError(-32603, 'Internal error: invalid checkpoint'); }
    if (
      checkpoint.version !== 2 || checkpoint.runId !== runId ||
      !Number.isInteger(checkpoint.revision) || checkpoint.revision < 1 ||
      typeof checkpoint.initialWorldHash !== 'string' ||
      !checkpoint.engine || checkpoint.engine.version !== 1 || checkpoint.engine.runId !== runId ||
      !isRecord(checkpoint.config) || !isRecord(checkpoint.world)
    ) {
      throw new RpcError(-32603, 'Internal error: invalid checkpoint identity');
    }
    return { checkpoint, raw };
  }

  private async restore(runId: string): Promise<SessionEntry> {
    const live = this.entries.get(runId);
    if (live) return live;
    const { checkpoint, raw } = this.readCheckpoint(runId);
    return this.assemble(runId, checkpoint, raw);
  }

  /** 文件锁内刷新：另一个 server 可能已经推进了同一 run，本地 entry 不能继续用旧快照。 */
  private async refresh(entry: SessionEntry): Promise<SessionEntry> {
    const { checkpoint, raw } = this.readCheckpoint(entry.runId);
    if (raw !== entry.checkpointRaw) {
      const next = await this.assemble(entry.runId, checkpoint, raw);
      entry = next;
    }
    if (checkpoint.inFlight && !entry.engine.stopped) entry.engine.interrupt(checkpoint.inFlight);
    return entry;
  }

  private async assemble(runId: string, checkpoint: McpCheckpoint, raw: string): Promise<SessionEntry> {
    const config = checkpoint.config;
    if (config.outDir !== this.outDir || !Number.isInteger(config.seed) || !Array.isArray(checkpoint.engine.steps)) {
      throw new RpcError(-32603, 'Internal error: checkpoint belongs to another output root');
    }
    const worldOptions = copyWorldOptions(checkpoint.world);
    if (worldOptions.seed !== config.seed) throw new RpcError(-32603, 'Internal error: checkpoint seed mismatch');
    const world = createArenaWorld(worldOptions);
    if (checkpoint.initialWorldHash !== world.session.initialHash()) {
      throw new RpcError(-32603, 'Internal error: initial world hash mismatch');
    }

    // 逐步重放并逐步对哈希，不只核末态：中间分叉、终态又相同的掩蔽轨迹也必须拒绝。
    const actions: ReturnType<typeof toWorldActions> = [];
    for (const step of checkpoint.engine.steps) {
      if (step.result.ok && isWorldTool(step.decision.call.name)) {
        const action = toWorldActions([step.decision.call])[0]!;
        await world.session.apply(action);
        actions.push(action);
      }
      if (step.stateHash !== world.session.stateHash()) {
        throw new RpcError(-32603, `Internal error: replayed state hash mismatch at step ${step.index}`);
      }
    }
    const liveActions = world.session.actionSequence();
    if (JSON.stringify(actions) !== JSON.stringify(liveActions)) {
      throw new RpcError(-32603, 'Internal error: world replay diverged');
    }
    const engine = this.makeEngine(config, worldOptions, world, checkpoint.engine, runId);
    const pending = checkpoint.pending ?? null;
    if (pending && (pending.step !== engine.stepCount + 1 || engine.stopped)) {
      throw new RpcError(-32603, 'Internal error: checkpoint request step mismatch');
    }
    if (pending) engine.resume(pending);
    if (checkpoint.inFlight && (
      checkpoint.inFlight.step !== engine.stepCount + 1 || !isRecord(checkpoint.inFlight.decision) || pending !== null
    )) {
      throw new RpcError(-32603, 'Internal error: checkpoint in-flight step mismatch');
    }
    const entry = this.newEntry(
      runId, config, worldOptions, world, engine, pending, raw, checkpoint.revision,
    );
    entry.inFlight = checkpoint.inFlight;
    if (checkpoint.finalized) entry.finalized = checkpoint.finalized;
    this.entries.set(runId, entry);
    this.log(`[mcp] resume ${runId} steps=${engine.stepCount}`);
    return entry;
  }

  private save(entry: SessionEntry): void {
    const checkpoint: McpCheckpoint = {
      version: 2,
      runId: entry.runId,
      revision: entry.revision + 1,
      initialWorldHash: entry.world.session.initialHash(),
      config: entry.config,
      world: copyWorldOptions(entry.worldOptions),
      engine: entry.engine.checkpoint(),
      pending: entry.pending,
      ...(entry.inFlight ? { inFlight: entry.inFlight } : {}),
      ...(entry.finalized ? { finalized: entry.finalized } : {}),
    };
    const raw = `${JSON.stringify(checkpoint, null, 2)}\n`;
    const path = join(entry.runDir, 'mcp-checkpoint.json');
    const temp = `${path}.tmp`;
    writeFileSync(temp, raw);
    renameSync(temp, path);
    entry.revision = checkpoint.revision;
    entry.checkpointRaw = raw;
  }

  private async finish(entry: SessionEntry): Promise<ArenaRunResult> {
    if (entry.finalized) return entry.finalized;
    if (entry.finalizing) return entry.finalizing;
    entry.finalizing = (async () => {
      const run = entry.engine.finalize();
      const result = await finalizeArenaWorld(entry.world, run, this.finalizeOptions);
      entry.finalized = result;
      this.save(entry);
      this.log(`[mcp] finish ${entry.runId} stop=${run.stopReason} evidence=${run.runDir}`);
      return result;
    })();
    try {
      return await entry.finalizing;
    } finally {
      entry.finalizing = undefined;
    }
  }
}

/** 防止操作者把 MCP 临时证据写进已发布的 runs/ 或仓库根目录。 */
export function assertDedicatedOutputRoot(root: string, repositoryRoot: string): string {
  const resolved = resolve(root);
  const repo = resolve(repositoryRoot);
  const rel = relative(repo, resolved);
  if (!rel || rel === 'runs' || rel.startsWith(`runs${sep}`) || resolved === parseRoot(repo)) {
    throw new Error('MCP 输出根必须是专用目录，不能是仓库根或 runs/');
  }
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) return resolved; // 显式选择仓库外的专用目录
  if (['src', 'test', 'verify'].some((part) => rel === part || rel.startsWith(`${part}${sep}`))) {
    throw new Error('MCP 输出根不能写进 src/、test/ 或 verify/');
  }
  return resolved;
}

function parseRoot(path: string): string {
  return resolve(path, '/');
}
