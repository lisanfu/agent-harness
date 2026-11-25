/** 业务 Agent 最小底座的公共契约。模型决定做什么，runtime 决定允许怎么做。 */
export type ToolEffect = 'read' | 'draft' | 'external';

export type TicketStatus = 'open' | 'pending_customer' | 'resolved';

export interface TicketRecord {
  id: string;
  subject: string;
  customerMessage: string;
  status: TicketStatus;
  revision: number;
  tags: string[];
  draftReply: string | null;
  internalNotes: string[];
}

/** 只暴露给宿主大脑的业务视图；内部字段由存储适配器保留。 */
export interface TicketView {
  id: string;
  subject: string;
  customerMessage: string;
  status: TicketStatus;
  revision: number;
  tags: string[];
  draftReply: string | null;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  tags: string[];
}

export interface BusinessToolSpec {
  name: string;
  description: string;
  effect: ToolEffect;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Decision {
  thought: string;
  call: ToolCall;
}

export interface Observation {
  step: number;
  tool: string;
  ok: boolean;
  output: unknown;
  error?: { code: string; message: string };
  outcomeCertain: boolean;
}

export interface BusinessRequest {
  kind: 'business_request';
  runId: string;
  step: number;
  maxSteps: number;
  remainingMs: number;
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  ticket: TicketView;
  tools: BusinessToolSpec[];
  recentObservations: Observation[];
}

export interface BusinessRunResult {
  kind: 'business_finished';
  runId: string;
  status: 'finished' | 'stopped' | 'interrupted';
  stopReason: 'finish' | 'max_steps' | 'wall_clock' | 'tool_outcome_unknown' | 'audit_failed' | 'store_unavailable';
  stepCount: number;
  finishSummary: string | null;
  outcomeCertain: boolean;
  ticket: TicketView;
  auditPath: string;
  resultPath: string;
  resultWritten: boolean;
}

export interface StartedResult {
  kind: 'started';
  runId: string;
  request: BusinessRequest;
}

export interface SteppedResult {
  kind: 'stepped';
  observation: Observation;
  request: BusinessRequest;
}

export interface RepairRequiredResult {
  kind: 'repair_required';
  error: { code: string; message: string; hint: string };
  request: BusinessRequest;
}

export interface FinishedResult {
  kind: 'finished';
  result: BusinessRunResult;
}

export type StepResult = SteppedResult | RepairRequiredResult | FinishedResult;

export interface StartInput {
  ticketId: string;
  maxSteps?: number;
  maxWallMs?: number;
}

export interface StepInput {
  runId: string;
  expectedStep: number;
  decision: Decision;
}
