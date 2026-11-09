export type AiErrorCode =
  | 'AI_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_RATE_LIMITED'
  | 'AI_INVALID_OUTPUT'
  | 'AI_PHASE_NOT_ELIGIBLE'
  | 'AI_NO_PUBLIC_INPUT'
  | 'AI_STALE_CONTEXT';

export class AiError extends Error {
  constructor(readonly code: AiErrorCode) {
    super(code);
    this.name = 'AiError';
  }
}
