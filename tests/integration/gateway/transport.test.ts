import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomCommand } from '@gongqi/contracts/v2';
import { createHttpRoomGateway } from '../../../apps/web/src/data/httpRoomGateway';
import { createCloudBaseRoomGatewayFromApp } from '../../../apps/web/src/data/cloudbaseRoomGateway';
import { RoomGatewayError } from '../../../apps/web/src/data/RoomGateway';

const command: CreateRoomCommand = {
  schemaVersion: 2,
  operationId: 'operation-transport-1',
  templateId: 'general',
  title: '周末安排',
  purpose: '确定两个人都接受的安排',
};

const createdRoom = {
  status: 'applied',
  roomId: 'room-transport-1',
  cycleId: 'cycle-transport-1',
  hostUid: 'trusted-uid',
  phase: 'COLLECTING',
  roomStatus: 'ACTIVE',
  snapshotVersion: 1,
  decisionRevision: 1,
  rosterRevision: 1,
  createdAt: '2026-11-04T10:00:00Z',
};

function response(body: unknown, status = 200) {
  return { status, json: vi.fn().mockResolvedValue(body) };
}

describe('explicit local HTTP transport', () => {
  it('sends an opaque bearer token and a strict action envelope without actorUid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      status: 200,
      body: { ok: true, value: createdRoom },
    }));
    const gateway = createHttpRoomGateway({
      baseUrl: 'http://127.0.0.1:5173/',
      getToken: () => 'opaque-test-token',
      fetchImpl,
    });

    await expect(gateway.request('createRoom', command)).resolves.toEqual(createdRoom);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:5173/gateway', expect.objectContaining({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer opaque-test-token',
      },
      body: JSON.stringify({ action: 'createRoom', input: command }),
    }));
    expect(JSON.stringify(fetchImpl.mock.calls[0]?.[1])).not.toContain('actorUid');
  });

  it('surfaces safe business and authentication codes without retrying identity', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ status: 200, body: { ok: false, error: { code: 'VERSION_CONFLICT' } } }))
      .mockResolvedValueOnce(response({ status: 401, body: { ok: false, error: { code: 'UNAUTHENTICATED' } } }));
    const gateway = createHttpRoomGateway({ baseUrl: 'http://local.test', getToken: () => 'token', fetchImpl });

    await expect(gateway.request('createRoom', command)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(gateway.request('createRoom', command)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed transport responses instead of casting them to business data', async () => {
    const gateway = createHttpRoomGateway({
      baseUrl: 'http://local.test',
      getToken: () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(response({ status: 200, body: { ok: true, value: { roomId: 'incomplete' } } })),
    });

    await expect(gateway.request('createRoom', command)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('CloudBase web transport', () => {
  function cloudFixture(options: { authenticated: boolean; result?: unknown }) {
    const signInAnonymously = vi.fn().mockResolvedValue({ data: { session: {} }, error: null });
    const getSession = vi.fn().mockResolvedValue({
      data: { session: options.authenticated ? {} : undefined },
      error: null,
    });
    const callFunction = vi.fn().mockResolvedValue({
      result: options.result ?? { status: 200, body: { ok: true, value: createdRoom } },
    });
    const onAuthStateChange = vi.fn();
    const app = {
      auth: { getSession, signInAnonymously, onAuthStateChange },
      callFunction,
    };
    return { app, signInAnonymously, getSession, callFunction, onAuthStateChange };
  }

  it('guards with getSession and never sends a bearer token or actorUid payload', async () => {
    const fixture = cloudFixture({ authenticated: true });
    const gateway = createCloudBaseRoomGatewayFromApp(fixture.app);

    await expect(gateway.request('createRoom', command)).resolves.toEqual(createdRoom);
    expect(fixture.signInAnonymously).not.toHaveBeenCalled();
    expect(fixture.callFunction).toHaveBeenCalledWith({
      name: 'gateway',
      data: { action: 'createRoom', input: command },
    });
    expect(JSON.stringify(fixture.callFunction.mock.calls[0])).not.toContain('actorUid');
  });

  it('uses the authorized anonymous provider only for initial session establishment', async () => {
    const fixture = cloudFixture({ authenticated: false });
    const gateway = createCloudBaseRoomGatewayFromApp(fixture.app);

    await gateway.request('createRoom', command);
    expect(fixture.signInAnonymously).toHaveBeenCalledOnce();
    await gateway.request('createRoom', command);
    expect(fixture.signInAnonymously).toHaveBeenCalledOnce();
    expect(fixture.getSession).toHaveBeenCalledOnce();
  });

  it('does not retry anonymous login after a gateway permission or authentication failure', async () => {
    const fixture = cloudFixture({
      authenticated: true,
      result: { status: 401, body: { ok: false, error: { code: 'UNAUTHENTICATED' } } },
    });
    const gateway = createCloudBaseRoomGatewayFromApp(fixture.app);

    const failure = gateway.request('createRoom', command);
    await expect(failure).rejects.toEqual(new RoomGatewayError('UNAUTHENTICATED', 401));
    await expect(failure).rejects.toBeInstanceOf(RoomGatewayError);
    expect(fixture.signInAnonymously).not.toHaveBeenCalled();
    expect(fixture.callFunction).toHaveBeenCalledOnce();
  });
});
