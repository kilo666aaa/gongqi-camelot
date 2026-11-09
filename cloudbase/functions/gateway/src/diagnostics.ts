import { ZodError } from 'zod';

export type GatewayStage =
  | 'actor'
  | 'request'
  | 'command'
  | 'snapshot-query'
  | 'ai-suggest'
  | 'ai-assistant'
  | 'rpc-transport'
  | 'rpc-envelope'
  | 'response';

const SAFE_TOKEN = /^[A-Za-z0-9_$-]{1,40}$/;
const MAX_KEYS = 12;
const MAX_ISSUES = 6;
const MAX_PATH = 6;

let currentStage: GatewayStage = 'actor';
let transportStatus: number | undefined;
let envelopeKeys: string[] | undefined;

export function resetDiagnostic(): void {
  currentStage = 'actor';
  transportStatus = undefined;
  envelopeKeys = undefined;
}

export function setStage(stage: GatewayStage): void {
  currentStage = stage;
}

export function noteTransportStatus(status: number): void {
  transportStatus = status;
}

export function noteEnvelopeShape(value: unknown): void {
  envelopeKeys = safeKeys(value);
}

export function diagnosticsEnabled(): boolean {
  return process.env.GQ_DIAG_LOG === '1';
}

/** Whitelisted: key names only, never values. */
function safeKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>)
    .filter(key => SAFE_TOKEN.test(key))
    .sort()
    .slice(0, MAX_KEYS);
}

function safeAction(request: unknown): string | undefined {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined;
  const action = (request as Record<string, unknown>).action;
  return typeof action === 'string' && SAFE_TOKEN.test(action) ? action : undefined;
}

function safeIssues(error: ZodError): Array<{ path: string[]; code: string }> {
  return error.issues.slice(0, MAX_ISSUES).map(issue => ({
    path: issue.path
      .map(segment => (typeof segment === 'number' ? String(segment) : String(segment)))
      .filter(segment => SAFE_TOKEN.test(segment))
      .slice(0, MAX_PATH),
    code: issue.code,
  }));
}

export interface DiagnosticOutcome {
  httpStatus: number;
  code: string;
}

/**
 * Emits a single structured line with whitelisted metadata only:
 * stage, event shape (key names), action token, Zod paths/codes, RPC status.
 * No payload values, headers, tokens, keys or free text.
 */
export function recordDiagnostic(
  request: unknown,
  outcome: DiagnosticOutcome,
  error?: unknown,
): void {
  if (!diagnosticsEnabled()) return;

  const line: Record<string, unknown> = {
    tag: 'GQ_DIAG',
    stage: currentStage,
    httpStatus: outcome.httpStatus,
    code: outcome.code,
    eventType: request === null ? 'null' : Array.isArray(request) ? 'array' : typeof request,
    eventKeys: safeKeys(request),
  };

  if (request && typeof request === 'object' && !Array.isArray(request)) {
    const input = (request as Record<string, unknown>).input;
    if (input && typeof input === 'object' && !Array.isArray(input)) line.inputKeys = safeKeys(input);
    const action = safeAction(request);
    if (action) line.action = action;
  }
  if (transportStatus !== undefined) line.rpcStatus = transportStatus;
  if (envelopeKeys) line.rpcEnvelopeKeys = envelopeKeys;

  if (error instanceof ZodError) {
    line.issueCount = error.issues.length;
    line.issues = safeIssues(error);
  } else if (error instanceof Error) {
    line.errorName = error.name;
    if (SAFE_TOKEN.test(error.message)) line.errorCode = error.message;
  }

  console.log(JSON.stringify(line));
}
