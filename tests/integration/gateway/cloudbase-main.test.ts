import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomCommand } from '@gongqi/contracts/v2';
import { createCloudBaseMain } from '../../../cloudbase/functions/gateway/src/main';
import type { GatewayRepository } from '../../../cloudbase/functions/gateway/src/gateway';

const command: CreateRoomCommand = {
  schemaVersion: 2,
  operationId: 'operation-cloud-1',
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

function fixture(uid?: string) {
  const repository = {
    createRoom: vi.fn().mockResolvedValue(createdRoom),
  } as unknown as GatewayRepository;
  const getUserInfo = vi.fn().mockReturnValue({ uid, openId: 'not-the-actor' });
  const main = createCloudBaseMain({ repository, getUserInfo });
  return { main, repository, getUserInfo };
}

describe('CloudBase event function adapter', () => {
  it('uses only auth.getUserInfo().uid as the trusted actor', async () => {
    const { main, repository, getUserInfo } = fixture('cloud-trusted-uid');
    const response = await main({ action: 'createRoom', input: command }, {});

    expect(getUserInfo).toHaveBeenCalledOnce();
    expect(repository.createRoom).toHaveBeenCalledWith('cloud-trusted-uid', command);
    expect(response).toEqual({ status: 200, body: { ok: true, value: createdRoom } });
  });

  it('fails closed when CloudBase has no authenticated uid', async () => {
    const { main, repository } = fixture(undefined);
    expect(await main({ action: 'createRoom', input: command }, {})).toEqual({
      status: 401,
      body: { ok: false, error: { code: 'UNAUTHENTICATED' } },
    });
    expect(repository.createRoom).not.toHaveBeenCalled();
  });

  it('rejects the synthetic Publishable-Key-only uid', async () => {
    const { main, repository } = fixture('anon');
    expect(await main({ action: 'createRoom', input: command }, {})).toEqual({
      status: 401,
      body: { ok: false, error: { code: 'UNAUTHENTICATED' } },
    });
    expect(repository.createRoom).not.toHaveBeenCalled();
  });

  it('accepts a real anonymous session uid', async () => {
    const { main, repository } = fixture('b3c1f1b0-5f3a-4c5a-9c6e-2f4d8a7b1c2d');
    expect(await main({ action: 'createRoom', input: command }, {})).toEqual({
      status: 200,
      body: { ok: true, value: createdRoom },
    });
    expect(repository.createRoom).toHaveBeenCalledOnce();
  });

  it('strips the platform-injected tcbContext before contract validation', async () => {
    const { main, repository } = fixture('cloud-trusted-uid');
    const response = await main(
      { action: 'createRoom', input: command, tcbContext: { envId: 'gongqi-dev' } },
      {},
    );

    expect(response).toEqual({ status: 200, body: { ok: true, value: createdRoom } });
    expect(repository.createRoom).toHaveBeenCalledWith('cloud-trusted-uid', command);
  });

  it('still rejects unknown client keys after the platform key is removed', async () => {
    const { main, repository } = fixture('cloud-trusted-uid');
    const response = await main(
      { action: 'createRoom', input: command, tcbContext: { envId: 'gongqi-dev' }, extra: 1 },
      {},
    );

    expect(response).toEqual({ status: 400, body: { ok: false, error: { code: 'INVALID_INPUT' } } });
    expect(repository.createRoom).not.toHaveBeenCalled();
  });
});
