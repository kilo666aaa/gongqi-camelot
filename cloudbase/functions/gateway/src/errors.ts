import { ZodError } from 'zod';
import { AiError } from './ai/errors';
import { PgV2CommandError } from './repositories/pgV2Repository';

export interface GatewayErrorBody {
  ok: false;
  error: { code: string };
}

export interface GatewayResponse {
  status: number;
  body: { ok: true; value: unknown } | GatewayErrorBody;
}

export class GatewayAuthError extends Error {
  constructor() {
    super('UNAUTHENTICATED');
    this.name = 'GatewayAuthError';
  }
}

export function gatewayErrorResponse(error: unknown): GatewayResponse {
  if (error instanceof GatewayAuthError) {
    return { status: 401, body: { ok: false, error: { code: 'UNAUTHENTICATED' } } };
  }
  if (error instanceof ZodError) {
    return { status: 400, body: { ok: false, error: { code: 'INVALID_INPUT' } } };
  }
  if (error instanceof PgV2CommandError || error instanceof AiError) {
    return { status: 200, body: { ok: false, error: { code: error.code } } };
  }
  return { status: 500, body: { ok: false, error: { code: 'INTERNAL_ERROR' } } };
}
