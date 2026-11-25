export type BusinessErrorCode =
  | 'invalid_args'
  | 'invalid_decision'
  | 'not_found'
  | 'stale_step'
  | 'run_not_active'
  | 'conflict'
  | 'denied'
  | 'timeout'
  | 'audit_unavailable'
  | 'store_unavailable'
  | 'internal';

export class BusinessError extends Error {
  readonly code: BusinessErrorCode;
  readonly outcomeUnknown: boolean;

  constructor(code: BusinessErrorCode, message: string, opts: { outcomeUnknown?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'BusinessError';
    this.code = code;
    this.outcomeUnknown = opts.outcomeUnknown ?? false;
  }
}

export function asBusinessError(error: unknown, fallback: BusinessErrorCode = 'internal'): BusinessError {
  return error instanceof BusinessError
    ? error
    : new BusinessError(fallback, error instanceof Error ? error.message : String(error), { cause: error });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
