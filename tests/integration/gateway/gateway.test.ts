import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomCommand } from '@gongqi/contracts/v2';
import { createGateway, type GatewayRepository } from '../../../cloudbase/functions/gateway/src/gateway';
import { PgV2CommandError } from '../../../cloudbase/functions/gateway/src/repositories/pgV2Repository';

const command: CreateRoomCommand = {
  schemaVersion: 2,
  operationId: 'operation-1',
  templateId: 'general',
  title: '周末安排',
  purpose: '确定两个人都接受的安排',
};

const createdRoom = {
  status: 'applied',
  roomId: 'room-1',
  cycleId: 'cycle-1',
  hostUid: 'trusted-host',
  phase: 'COLLECTING',
  roomStatus: 'ACTIVE',
  snapshotVersion: 1,
  decisionRevision: 1,
  rosterRevision: 1,
  createdAt: '2026-11-04T10:00:00Z',
};

function fixture(overrides: Partial<GatewayRepository> = {}) {
  const repository = {
    createRoom: vi.fn().mockResolvedValue(createdRoom),
    getSnapshot: vi.fn().mockResolvedValue({ schemaVersion: 2 }),
    ...overrides,
  } as unknown as GatewayRepository;
  const resolveActor = vi.fn().mockResolvedValue('trusted-host');
  const gateway = createGateway({ repository, resolveActor });
  return { gateway, repository, resolveActor };
}

describe('trusted gateway dispatcher', () => {
  it('uses only the resolved actor and validates a command before repository access', async () => {
    const { gateway, repository, resolveActor } = fixture();
    const response = await gateway.handle({ action: 'createRoom', input: command }, { requestId: 'request-1' });

    expect(resolveActor).toHaveBeenCalledWith({ requestId: 'request-1' });
    expect(repository.createRoom).toHaveBeenCalledWith('trusted-host', command);
    expect(response).toEqual({ status: 200, body: { ok: true, value: createdRoom } });
  });

  it('rejects actor impersonation and unknown envelope fields before repository access', async () => {
    const { gateway, repository } = fixture();
    const response = await gateway.handle({
      action: 'createRoom',
      actorUid: 'attacker',
      input: { ...command, actorUid: 'attacker' },
    }, {});

    expect(response).toEqual({ status: 400, body: { ok: false, error: { code: 'INVALID_INPUT' } } });
    expect(repository.createRoom).not.toHaveBeenCalled();
  });

  it('fails closed when trusted authentication is absent or invalid', async () => {
    const { repository } = fixture();
    const unauthenticated = createGateway({
      repository,
      resolveActor: async () => { throw new Error('missing session'); },
    });

    expect(await unauthenticated.handle({ action: 'createRoom', input: command }, {})).toEqual({
      status: 401,
      body: { ok: false, error: { code: 'UNAUTHENTICATED' } },
    });
    expect(repository.createRoom).not.toHaveBeenCalled();
  });

  it('rejects unknown actions without reaching a repository method', async () => {
    const { gateway, repository } = fixture();
    const response = await gateway.handle({ action: 'deleteEverything', input: {} }, {});

    expect(response).toEqual({ status: 400, body: { ok: false, error: { code: 'INVALID_INPUT' } } });
    expect(repository.createRoom).not.toHaveBeenCalled();
    expect(repository.getSnapshot).not.toHaveBeenCalled();
  });

  it('preserves safe business error codes and hides unexpected failures', async () => {
    const conflict = fixture({
      createRoom: vi.fn().mockRejectedValue(new PgV2CommandError('VERSION_CONFLICT')),
    });
    expect(await conflict.gateway.handle({ action: 'createRoom', input: command }, {})).toEqual({
      status: 200,
      body: { ok: false, error: { code: 'VERSION_CONFLICT' } },
    });

    const failure = fixture({ createRoom: vi.fn().mockRejectedValue(new Error('private SQL details')) });
    expect(await failure.gateway.handle({ action: 'createRoom', input: command }, {})).toEqual({
      status: 500,
      body: { ok: false, error: { code: 'INTERNAL_ERROR' } },
    });
  });

  it('dispatches changeRoster with the trusted actor and rejects impersonation', async () => {
    const changeRoster = vi.fn().mockResolvedValue({
      status: 'applied',
      roomId: 'room-1',
      uid: 'bob',
      action: 'REMOVE',
      memberStatus: 'REMOVED',
      phase: 'COLLECTING',
      decisionRevision: 2,
      rosterRevision: 2,
      updatedAt: '2026-11-07T10:00:00Z',
    });
    const { gateway } = fixture({ changeRoster });
    const rosterCommand = {
      schemaVersion: 2,
      operationId: 'roster-operation-1',
      expectedDecisionRevision: 1,
      roomId: 'room-1',
      targetUid: 'bob',
      action: 'REMOVE',
    };

    expect(await gateway.handle({ action: 'changeRoster', input: rosterCommand }, {})).toEqual({
      status: 200,
      body: { ok: true, value: expect.objectContaining({ uid: 'bob', memberStatus: 'REMOVED' }) },
    });
    expect(changeRoster).toHaveBeenCalledWith('trusted-host', rosterCommand);

    expect(await gateway.handle({
      action: 'changeRoster',
      input: { ...rosterCommand, actorUid: 'attacker' },
    }, {})).toEqual({ status: 400, body: { ok: false, error: { code: 'INVALID_INPUT' } } });
  });

  it('dispatches archive, close and delete through one host lifecycle command', async () => {
    const changeRoomLifecycle = vi.fn().mockResolvedValue({
      status: 'applied',
      roomId: 'room-1',
      action: 'CLOSE',
      roomStatus: 'CLOSED',
      phase: 'COLLECTING',
      decisionRevision: 2,
      rosterRevision: 2,
      snapshotVersion: 4,
      revokedMemberCount: 1,
      updatedAt: '2026-11-07T10:00:00Z',
    });
    const { gateway } = fixture({ changeRoomLifecycle });
    const base = {
      schemaVersion: 2,
      operationId: 'lifecycle-operation-1',
      expectedDecisionRevision: 1,
      roomId: 'room-1',
    };

    for (const [action, target] of [['archiveRoom', 'ARCHIVE'], ['closeRoom', 'CLOSE'], ['deleteRoom', 'DELETE']] as const) {
      expect(await gateway.handle({ action, input: base }, {})).toEqual({
        status: 200,
        body: { ok: true, value: expect.objectContaining({ roomId: 'room-1' }) },
      });
      expect(changeRoomLifecycle).toHaveBeenCalledWith('trusted-host', target, base);
    }

    expect(await gateway.handle({
      action: 'closeRoom',
      input: { ...base, actorUid: 'attacker' },
    }, {})).toEqual({ status: 400, body: { ok: false, error: { code: 'INVALID_INPUT' } } });
  });

  it('dispatches startNextCycle and transferHost with the trusted host actor', async () => {
    const startNextCycle = vi.fn().mockResolvedValue({
      status: 'applied',
      roomId: 'room-1',
      previousCycleId: 'cycle-1',
      cycleId: 'cycle-2',
      cycleNumber: 2,
      phase: 'COLLECTING',
      decisionRevision: 2,
      rosterRevision: 1,
      snapshotVersion: 6,
      updatedAt: '2026-11-07T10:00:00Z',
    });
    const transferHost = vi.fn().mockResolvedValue({
      status: 'applied',
      roomId: 'room-1',
      hostUid: 'bob',
      previousHostUid: 'trusted-host',
      phase: 'DISCUSSING',
      decisionRevision: 1,
      rosterRevision: 2,
      snapshotVersion: 7,
      updatedAt: '2026-11-07T10:00:00Z',
    });
    const { gateway } = fixture({ startNextCycle, transferHost });
    const cycleCommand = {
      schemaVersion: 2,
      operationId: 'next-cycle-operation-1',
      expectedDecisionRevision: 1,
      roomId: 'room-1',
      nextCycleId: 'cycle-2',
    };
    const transferCommand = {
      schemaVersion: 2,
      operationId: 'transfer-host-operation-1',
      expectedDecisionRevision: 1,
      roomId: 'room-1',
      targetUid: 'bob',
    };

    expect(await gateway.handle({ action: 'startNextCycle', input: cycleCommand }, {})).toEqual({
      status: 200,
      body: { ok: true, value: expect.objectContaining({ cycleId: 'cycle-2' }) },
    });
    expect(startNextCycle).toHaveBeenCalledWith('trusted-host', cycleCommand);

    expect(await gateway.handle({ action: 'transferHost', input: transferCommand }, {})).toEqual({
      status: 200,
      body: { ok: true, value: expect.objectContaining({ hostUid: 'bob' }) },
    });
    expect(transferHost).toHaveBeenCalledWith('trusted-host', transferCommand);

    for (const [action, input] of [
      ['startNextCycle', { ...cycleCommand, actorUid: 'attacker' }],
      ['transferHost', { ...transferCommand, actorUid: 'attacker' }],
    ] as const) {
      expect(await gateway.handle({ action, input }, {})).toEqual({
        status: 400,
        body: { ok: false, error: { code: 'INVALID_INPUT' } },
      });
    }
  });

  it('validates getSnapshot separately and passes the same trusted actor', async () => {
    const { gateway, repository } = fixture();
    expect(await gateway.handle({ action: 'getSnapshot', input: { roomId: 'room-1' } }, {})).toEqual({
      status: 200,
      body: { ok: true, value: { schemaVersion: 2 } },
    });
    expect(repository.getSnapshot).toHaveBeenCalledWith('trusted-host', 'room-1');

    expect(await gateway.handle({ action: 'getSnapshot', input: { roomId: 'room-1', uid: 'other' } }, {}))
      .toEqual({ status: 400, body: { ok: false, error: { code: 'INVALID_INPUT' } } });
  });
});
