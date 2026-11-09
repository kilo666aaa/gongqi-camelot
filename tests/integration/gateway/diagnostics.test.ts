import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateway, type GatewayRepository } from '../../../cloudbase/functions/gateway/src/gateway';
import { PgV2Repository, type PgV2RpcTransport } from '../../../cloudbase/functions/gateway/src/repositories/pgV2Repository';

function lines(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function gatewayWith(transport: PgV2RpcTransport) {
  return createGateway({
    repository: new PgV2Repository(transport) as unknown as GatewayRepository,
    resolveActor: async () => 'trusted-anon-uid',
  });
}

describe('redacted stage diagnostics', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.GQ_DIAG_LOG = '1';
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.GQ_DIAG_LOG;
    log.mockRestore();
  });

  it('stays silent unless explicitly enabled', async () => {
    delete process.env.GQ_DIAG_LOG;
    const gateway = createGateway({
      repository: { createRoom: vi.fn() } as unknown as GatewayRepository,
      resolveActor: async () => 'trusted-anon-uid',
    });

    await gateway.handle({ action: 'unknownAction', input: {} }, {});

    expect(log).not.toHaveBeenCalled();
  });

  it('marks the request stage for a wrapped or extra-keyed event without logging values', async () => {
    const gateway = createGateway({
      repository: { createRoom: vi.fn() } as unknown as GatewayRepository,
      resolveActor: async () => 'trusted-anon-uid',
    });

    await gateway.handle({
      body: { action: 'getSnapshot', input: { roomId: 'private-room-id' } },
      headers: { authorization: 'secret-token' },
    }, {});

    const [line] = lines(log);
    expect(line).toMatchObject({
      tag: 'GQ_DIAG',
      stage: 'request',
      httpStatus: 400,
      code: 'INVALID_INPUT',
      eventType: 'object',
      eventKeys: ['body', 'headers'],
    });
    expect(String(log.mock.calls[0]![0])).not.toContain('private-room-id');
    expect(String(log.mock.calls[0]![0])).not.toContain('secret-token');
  });

  it('records the raw event type when the platform does not parse the JSON body', async () => {
    const gateway = createGateway({
      repository: { createRoom: vi.fn() } as unknown as GatewayRepository,
      resolveActor: async () => 'trusted-anon-uid',
    });

    await gateway.handle('{"action":"getSnapshot","input":{"roomId":"r1"}}', {});

    const [line] = lines(log);
    expect(line).toMatchObject({ stage: 'request', eventType: 'string', code: 'INVALID_INPUT' });
  });

  it('marks the snapshot-query stage separately from the envelope stage', async () => {
    const gateway = createGateway({
      repository: { getSnapshot: vi.fn() } as unknown as GatewayRepository,
      resolveActor: async () => 'trusted-anon-uid',
    });

    await gateway.handle({ action: 'getSnapshot', input: { roomId: 'r1', uid: 'other' } }, {});

    const [line] = lines(log);
    expect(line).toMatchObject({
      stage: 'snapshot-query',
      action: 'getSnapshot',
      inputKeys: ['roomId', 'uid'],
    });
  });

  it('marks the RPC envelope stage and exposes only response key names', async () => {
    const gateway = gatewayWith({
      call: vi.fn().mockResolvedValue({ data: { ok: false } }),
    });

    const response = await gateway.handle({ action: 'getSnapshot', input: { roomId: 'r1' } }, {});

    expect(response).toEqual({ status: 400, body: { ok: false, error: { code: 'INVALID_INPUT' } } });
    const [line] = lines(log);
    expect(line).toMatchObject({
      stage: 'rpc-envelope',
      rpcEnvelopeKeys: ['data'],
      code: 'INVALID_INPUT',
    });
  });

  it('keeps the RPC status and business code that prove the database was reached', async () => {
    const gateway = gatewayWith({
      call: vi.fn().mockResolvedValue({ ok: false, error: { code: 'ROOM_NOT_FOUND' } }),
    });

    const response = await gateway.handle({ action: 'getSnapshot', input: { roomId: 'r1' } }, {});

    expect(response).toEqual({ status: 200, body: { ok: false, error: { code: 'ROOM_NOT_FOUND' } } });
    const [line] = lines(log);
    expect(line).toMatchObject({ stage: 'rpc-envelope', code: 'ROOM_NOT_FOUND' });
  });

  it('marks the response stage when the snapshot shape is rejected', async () => {
    const gateway = gatewayWith({
      call: vi.fn().mockResolvedValue({ ok: true, value: { schemaVersion: 2 } }),
    });

    const response = await gateway.handle({ action: 'getSnapshot', input: { roomId: 'r1' } }, {});

    expect(response).toEqual({ status: 400, body: { ok: false, error: { code: 'INVALID_INPUT' } } });
    const [line] = lines(log);
    expect(line).toMatchObject({ stage: 'response', code: 'INVALID_INPUT' });
    expect(line!.issues).toBeInstanceOf(Array);
    expect(String(log.mock.calls[0]![0])).not.toContain('r1');
  });

  it('never logs credential material on the actor stage', async () => {
    const gateway = createGateway({
      repository: { createRoom: vi.fn() } as unknown as GatewayRepository,
      resolveActor: async () => { throw new Error('token=SECRET_ABC123'); },
    });

    const response = await gateway.handle({ action: 'getSnapshot', input: { roomId: 'r1' } }, {});

    expect(response).toEqual({ status: 401, body: { ok: false, error: { code: 'UNAUTHENTICATED' } } });
    const [line] = lines(log);
    expect(line).toMatchObject({ stage: 'actor', code: 'UNAUTHENTICATED', errorCode: 'UNAUTHENTICATED' });
    expect(String(log.mock.calls[0]![0])).not.toContain('SECRET_ABC123');
  });
});
