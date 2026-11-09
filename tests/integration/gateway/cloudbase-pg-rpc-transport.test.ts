import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomCommand } from '@gongqi/contracts/v2';
import { CloudBasePgRpcTransport } from '../../../cloudbase/functions/gateway/src/repositories/cloudBasePgRpcTransport';
import { PgV2Repository } from '../../../cloudbase/functions/gateway/src/repositories/pgV2Repository';

const command: CreateRoomCommand = {
  schemaVersion: 2,
  operationId: 'operation-cloud-rpc-1',
  templateId: 'general',
  title: '周末安排',
  purpose: '确定两个人都接受的安排',
};

const createdRoom = {
  status: 'applied',
  roomId: 'room-cloud-1',
  cycleId: 'cycle-cloud-1',
  hostUid: 'cloud-trusted-uid',
  phase: 'COLLECTING',
  roomStatus: 'ACTIVE',
  snapshotVersion: 1,
  decisionRevision: 1,
  rosterRevision: 1,
  createdAt: '2026-11-04T10:00:00Z',
};

function fixture(fetchMock: ReturnType<typeof vi.fn>, timeoutMs?: number) {
  return new CloudBasePgRpcTransport({
    envId: 'gongqi-dev-d9grxerai94b966a1',
    apiKey: 'service-role-test-key',
    fetch: fetchMock as typeof fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CloudBase PostgreSQL HTTPS RPC transport', () => {
  it('calls the environment RPC endpoint with a command payload and service-role bearer key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, value: createdRoom }));
    const repository = new PgV2Repository(fixture(fetchMock));

    await expect(repository.createRoom('cloud-trusted-uid', command)).resolves.toEqual(createdRoom);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://gongqi-dev-d9grxerai94b966a1.api.tcloudbasegateway.com/v1/rdb/rest/rpc/gq_create_room');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer service-role-test-key');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ p_actor_uid: 'cloud-trusted-uid', p_payload: command });
  });

  it('uses the snapshot function room-id parameter instead of a command payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, value: {} }));
    const transport = fixture(fetchMock);

    await transport.call('cloud-trusted-uid', 'gq_get_snapshot', ['room-cloud-1']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url).endsWith('/gq_get_snapshot')).toBe(true);
    expect(JSON.parse(init.body)).toEqual({
      p_actor_uid: 'cloud-trusted-uid',
      p_room_id: 'room-cloud-1',
    });
  });

  it('preserves business error codes from the RPC envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'ROOM_NOT_FOUND' },
    }));
    const repository = new PgV2Repository(fixture(fetchMock));

    await expect(repository.createRoom('cloud-trusted-uid', command)).rejects.toMatchObject({
      name: 'PgV2CommandError',
      code: 'ROOM_NOT_FOUND',
    });
  });

  it('fails closed on HTTP errors without retrying or exposing response details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('private-upstream-details', { status: 503 }));
    const transport = fixture(fetchMock);

    await expect(transport.call('cloud-trusted-uid', 'gq_create_room', [command]))
      .rejects.toThrow('CLOUDBASE_PG_RPC_HTTP_ERROR');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects invalid JSON responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not-json', { status: 200 }));
    const transport = fixture(fetchMock);

    await expect(transport.call('cloud-trusted-uid', 'gq_create_room', [command]))
      .rejects.toThrow('CLOUDBASE_PG_RPC_INVALID_RESPONSE');
  });

  it('aborts slow requests without exposing the service-role key', async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const transport = fixture(fetchMock, 1);

    const failure = await transport.call('cloud-trusted-uid', 'gq_create_room', [command])
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'CLOUDBASE_PG_RPC_TIMEOUT' });
    expect(String(failure)).not.toContain('service-role-test-key');
  });
});
