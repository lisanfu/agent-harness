import { createHash } from 'node:crypto';
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BusinessRunResult, Decision, TicketRecord } from './types.ts';
import { toTicketView } from './store.ts';

export interface AuditEvent {
  at: string;
  runId: string;
  step: number;
  type: 'run_started' | 'decision_received' | 'repair_required' | 'action_completed' | 'run_finished';
  tool?: string;
  argsSha256?: string;
  thoughtSha256?: string;
  outputSha256?: string;
  outputBytes?: number;
  ok?: boolean;
  outcomeCertain?: boolean;
  durationMs?: number;
  errorCode?: string;
  stopReason?: string;
  ticketRevision?: number;
  maxSteps?: number;
  maxWallMs?: number;
}

export interface RunJournal {
  readonly auditPath: string;
  readonly resultPath: string;
  append(event: AuditEvent): Promise<void>;
  finish(result: BusinessRunResult): Promise<void>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function outputSummary(output: unknown): { outputSha256: string; outputBytes: number } {
  const text = JSON.stringify(output) ?? 'null';
  return {
    outputSha256: createHash('sha256').update(text).digest('hex'),
    outputBytes: Buffer.byteLength(text),
  };
}

export function decisionEvent(runId: string, step: number, decision: Decision): AuditEvent {
  return {
    at: new Date().toISOString(),
    runId,
    step,
    type: 'decision_received',
    tool: decision.call.name,
    argsSha256: sha256(decision.call.args),
    thoughtSha256: sha256(decision.thought),
  };
}

/** JSONL 审计 + 原子局末结果。默认不写原始 thought、工具参数或工具输出。 */
export class JsonlRunJournal implements RunJournal {
  readonly auditPath: string;
  readonly resultPath: string;
  readonly runId: string;

  constructor(outDir: string, runId: string) {
    this.runId = runId;
    const runDir = resolve(outDir, runId);
    this.auditPath = join(runDir, 'audit.jsonl');
    this.resultPath = join(runDir, 'result.json');
  }

  async append(event: AuditEvent): Promise<void> {
    await mkdir(resolve(this.auditPath, '..'), { recursive: true });
    await appendFile(this.auditPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async finish(result: BusinessRunResult): Promise<void> {
    await mkdir(resolve(this.resultPath, '..'), { recursive: true });
    const temporary = `${this.resultPath}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      await rename(temporary, this.resultPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** 测试用内存账本；不冒充真实持久化。 */
export class MemoryRunJournal implements RunJournal {
  readonly auditPath = 'memory://audit.jsonl';
  readonly resultPath = 'memory://result.json';
  readonly events: AuditEvent[] = [];
  result: BusinessRunResult | null = null;

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  async finish(result: BusinessRunResult): Promise<void> {
    this.result = structuredClone(result);
  }
}

export function startedEvent(runId: string, ticket: TicketRecord, maxSteps: number, maxWallMs: number): AuditEvent {
  return {
    at: new Date().toISOString(),
    runId,
    step: 0,
    type: 'run_started',
    ticketRevision: ticket.revision,
    maxSteps,
    maxWallMs,
  };
}
