import { z, ZodError } from 'zod';
import {
  parseGatewayResult,
  type GatewayAction,
  type GatewayInputMap,
  type GatewayResultMap,
} from '@gongqi/contracts/v2';

export interface RoomGateway {
  request<Action extends GatewayAction>(
    action: Action,
    input: GatewayInputMap[Action],
  ): Promise<GatewayResultMap[Action]>;
}

export class RoomGatewayError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'RoomGatewayError';
  }
}

const gatewayResponseSchema = z.object({
  status: z.number().int(),
  body: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
    z.object({
      ok: z.literal(false),
      error: z.object({ code: z.string().regex(/^[A-Z0-9_]+$/) }).strict(),
    }).strict(),
  ]),
}).strict();

export function unwrapGatewayResponse<Action extends GatewayAction>(
  action: Action,
  response: unknown,
): GatewayResultMap[Action] {
  try {
    const envelope = gatewayResponseSchema.parse(response);
    if (!envelope.body.ok) {
      throw new RoomGatewayError(envelope.body.error.code, envelope.status);
    }
    return parseGatewayResult(action, envelope.body.value);
  } catch (error) {
    if (error instanceof RoomGatewayError) throw error;
    if (error instanceof ZodError) throw new RoomGatewayError('INVALID_RESPONSE', 0);
    throw error;
  }
}
