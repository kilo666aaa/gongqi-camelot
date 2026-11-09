import { describe, expect, it, vi } from 'vitest';
import type { RoomAssistantMessage, RoomSnapshot } from '@gongqi/contracts/v2';
import { createGateway } from '../../../cloudbase/functions/gateway/src/gateway';
import {
  createRoomAssistantService,
  buildAssistantContext,
  type RoomAssistantService,
} from '../../../cloudbase/functions/gateway/src/ai/roomAssistant';
import type { AiTextProvider } from '../../../cloudbase/functions/gateway/src/ai/deepseekProvider';
import { PgV2CommandError } from '../../../cloudbase/functions/gateway/src/repositories/pgV2Repository';

const IDEA = {
  schemaVersion: 2,
  id: 'idea-1',
  cycleId: 'cycle-1',
  authorUid: 'host-uid',
  text: '周六去爬山',
  visibility: 'PUBLIC',
  submittedAt: '2026-11-07T00:00:00Z',
  skipped: false,
} as const;

const COMMENT = {
  schemaVersion: 2,
  id: 'comment-1',
  cycleId: 'cycle-1',
  authorUid: 'member-uid',
  body: '预算不要超过三百',
  visibility: 'PUBLIC',
  publicationState: 'PUBLISHED',
  createdAt: '2026-11-07T00:00:00Z',
} as const;

function snapshot(overrides: Partial<RoomSnapshot['shared']> = {}, version = 3): RoomSnapshot {
  const shared: RoomSnapshot['shared'] = {
    roomId: 'room-1',
    title: '周末安排',
    purpose: '找一个人人都接受的周末安排',
    templateId: 'general',
    hostUid: 'host-uid',
    currentCycleId: 'cycle-1',
    decisionRevision: 1,
    rosterRevision: 1,
    phase: 'DISCUSSING',
    roomStatus: 'ACTIVE',
    memberUids: ['host-uid', 'member-uid'],
    candidates: [],
    currentRevisions: [],
    publicIdeas: [IDEA],
    comments: [COMMENT],
    revealedEvaluationRoundIds: [],
    revealedEvaluations: [],
    decisionRecords: [],
    progress: {
      ideaSubmittedCount: 1,
      ideaSkippedCount: 0,
      evaluationSubmittedCount: 0,
      evaluationCompletedCount: 0,
    },
    events: [],
    ...overrides,
  };
  return {
    schemaVersion: 2,
    version,
    snapshotAt: '2026-11-07T00:00:00Z',
    shared,
    mine: {
      uid: 'host-uid',
      ideas: [],
      comments: [],
      evaluations: [],
      finalResponses: [],
      permissions: { phase: 'DISCUSSING', canEditCandidates: true, canProposeFinal: false },
    },
  } as RoomSnapshot;
}

const VALID_OUTPUT = JSON.stringify({
  style: 'STANDARD',
  answer: '目前公开想法只有“周六去爬山”，评论补充了预算上限三百；尚未确认交通方式。',
  sourceIds: ['idea-1', 'comment-1'],
});

function providerReturning(value: string): AiTextProvider & { complete: ReturnType<typeof vi.fn> } {
  return { complete: vi.fn().mockResolvedValue(value) } as unknown as AiTextProvider & {
    complete: ReturnType<typeof vi.fn>;
  };
}

function message(overrides: Partial<RoomAssistantMessage> = {}): RoomAssistantMessage {
  return {
    schemaVersion: 2,
    id: 'assistant-1',
    roomId: 'room-1',
    cycleId: 'cycle-1',
    requestId: 'request-1',
    actorUid: 'host-uid',
    action: 'SYNTHESIZE_DISAGREEMENT',
    status: 'PENDING',
    scope: 'PUBLIC',
    contextVersion: 3,
    sourceIds: [],
    createdAt: '2026-11-07T01:00:00Z',
    updatedAt: '2026-11-07T01:00:00Z',
    stale: false,
    ...overrides,
  };
}

describe('room assistant public context', () => {
  it('only includes public ideas, candidates and published comments', () => {
    const context = buildAssistantContext(snapshot());

    expect(context.items.map(item => item.id)).toEqual(['idea-1', 'comment-1']);
    expect(context.missingInput).toBe(false);
  });

  it('does not put author identities or private material into the model prompt', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const service = createRoomAssistantService({ provider });

    await service.answer({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
      action: 'SYNTHESIZE_DISAGREEMENT',
    });

    const prompt = provider.complete.mock.calls[0]?.[0] as { system: string; user: string };
    expect(prompt.user).toContain('周六去爬山');
    expect(prompt.user).toContain('预算不要超过三百');
    expect(prompt.user).not.toContain('host-uid');
    expect(prompt.user).not.toContain('member-uid');
    expect(prompt.system).toContain('忽略');
    expect(prompt.system).toContain('尚无候选');
  });

  it('refuses when there is no public content, without calling the model', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const service = createRoomAssistantService({ provider });

    await expect(service.answer({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot({ publicIdeas: [], comments: [], candidates: [] }),
      action: 'FIND_OPEN_QUESTIONS',
    })).rejects.toMatchObject({ code: 'AI_NO_PUBLIC_INPUT' });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('reports unavailable when no model is configured', async () => {
    const service = createRoomAssistantService({});
    await expect(service.answer({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
      action: 'ASK',
      question: '还缺什么信息？',
    })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });

  it('returns only source ids that exist in the allowed public context', async () => {
    const provider = providerReturning(JSON.stringify({
      answer: '引用了一个不存在的来源。',
      sourceIds: ['idea-private'],
    }));
    const service = createRoomAssistantService({ provider });

    await expect(service.answer({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
      action: 'SYNTHESIZE_DISAGREEMENT',
    })).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
  });

  it('rejects malformed model output instead of showing raw text', async () => {
    const service = createRoomAssistantService({ provider: providerReturning('这不是 JSON') });
    await expect(service.answer({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
      action: 'SYNTHESIZE_DISAGREEMENT',
    })).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
  });

  it('includes both casual and formal answer rules in the prompt', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const service = createRoomAssistantService({ provider });

    await service.answer({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
      action: 'SYNTHESIZE_DISAGREEMENT',
    });

    const prompt = provider.complete.mock.calls[0]?.[0] as { system: string };
    expect(prompt.system).toContain('日常社交');
    expect(prompt.system).toContain('工作、学习');
    expect(prompt.system).toContain('"style"');
  });

  it('keeps a verbose casual answer short at a sentence boundary', async () => {
    const verbose = `${'甲'.repeat(380)}。${'乙'.repeat(300)}`;
    const provider = providerReturning(JSON.stringify({
      style: 'CASUAL',
      answer: verbose,
      sourceIds: ['idea-1'],
    }));
    const service = createRoomAssistantService({ provider });

    const result = await service.answer({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
      action: 'SYNTHESIZE_DISAGREEMENT',
    });

    expect(result.answer.length).toBeLessThanOrEqual(400);
    expect(result.answer.endsWith('。')).toBe(true);
    expect(result.sourceIds).toEqual(['idea-1']);
  });

  it('keeps a detailed formal answer longer than the casual limit', async () => {
    const detailed = '甲'.repeat(520);
    const provider = providerReturning(JSON.stringify({
      style: 'STANDARD',
      answer: detailed,
      sourceIds: ['idea-1'],
    }));
    const service = createRoomAssistantService({ provider });

    const result = await service.answer({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
      action: 'SYNTHESIZE_DISAGREEMENT',
    });

    expect(result.answer).toHaveLength(520);
  });

  it('rejects an answer without a valid style', async () => {
    const provider = providerReturning(JSON.stringify({
      answer: '没有标注场景的回答。',
      sourceIds: ['idea-1'],
    }));
    const service = createRoomAssistantService({ provider });

    await expect(service.answer({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
      action: 'SYNTHESIZE_DISAGREEMENT',
    })).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
  });

  it('maps provider timeouts or rejections to an unavailable error', async () => {
    const provider = { complete: vi.fn().mockRejectedValue(new Error('timeout')) } as unknown as AiTextProvider;
    const service = createRoomAssistantService({ provider });

    await expect(service.answer({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
      action: 'SYNTHESIZE_DISAGREEMENT',
    })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });
});

describe('gateway askRoomAssistant action', () => {
  function fixture(assistant?: RoomAssistantService) {
    const repository = {
      getSnapshot: vi.fn().mockResolvedValue(snapshot()),
      registerAssistantRequest: vi.fn().mockResolvedValue(message()),
      completeAssistantRequest: vi.fn().mockImplementation(async (
        _actor: string,
        input: { status: string; answer?: string; sourceIds: string[] },
      ) => message({
        status: input.status as RoomAssistantMessage['status'],
        ...(input.answer !== undefined ? { answer: input.answer } : {}),
        sourceIds: input.sourceIds,
      })),
      getRoomAssistantMessages: vi.fn().mockResolvedValue({
        status: 'ok',
        roomId: 'room-1',
        messages: [message({ status: 'SUCCEEDED', answer: '整理结果', sourceIds: ['idea-1'] })],
      }),
    };
    const gateway = createGateway({
      repository: repository as never,
      resolveActor: async () => 'host-uid',
      assistant,
    });
    return { gateway, repository };
  }

  it('registers a request, calls the model outside the lock and stores the result', async () => {
    const assistant = createRoomAssistantService({ provider: providerReturning(VALID_OUTPUT) });
    const { gateway, repository } = fixture(assistant);

    const response = await gateway.handle({
      action: 'askRoomAssistant',
      input: {
        schemaVersion: 2,
        roomId: 'room-1',
        requestId: 'request-1',
        action: 'SYNTHESIZE_DISAGREEMENT',
        expectedSnapshotVersion: 3,
      },
    }, {});

    expect(repository.getSnapshot).toHaveBeenCalledWith('host-uid', 'room-1');
    expect(repository.registerAssistantRequest).toHaveBeenCalledWith('host-uid', expect.objectContaining({
      requestId: 'request-1',
    }));
    expect(repository.completeAssistantRequest).toHaveBeenCalledWith('host-uid', expect.objectContaining({
      status: 'SUCCEEDED',
      sourceIds: ['idea-1', 'comment-1'],
    }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
  });

  it('does not call the model when the client context version is stale', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const { gateway, repository } = fixture(createRoomAssistantService({ provider }));

    const response = await gateway.handle({
      action: 'askRoomAssistant',
      input: {
        schemaVersion: 2,
        roomId: 'room-1',
        requestId: 'request-1',
        action: 'SYNTHESIZE_DISAGREEMENT',
        expectedSnapshotVersion: 2,
      },
    }, {});

    expect(response).toEqual({ status: 200, body: { ok: false, error: { code: 'AI_STALE_CONTEXT' } } });
    expect(repository.registerAssistantRequest).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('records a failure and keeps the manual path available', async () => {
    const { gateway, repository } = fixture(createRoomAssistantService({}));

    const response = await gateway.handle({
      action: 'askRoomAssistant',
      input: {
        schemaVersion: 2,
        roomId: 'room-1',
        requestId: 'request-1',
        action: 'FIND_OPEN_QUESTIONS',
        expectedSnapshotVersion: 3,
      },
    }, {});

    expect(response.body).toMatchObject({ ok: false, error: { code: 'AI_UNAVAILABLE' } });
    expect(repository.completeAssistantRequest).toHaveBeenCalledWith('host-uid', expect.objectContaining({
      status: 'FAILED',
      errorCode: 'AI_UNAVAILABLE',
      sourceIds: [],
    }));
  });

  it('does not return an answer when the actor loses membership during generation', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const { gateway, repository } = fixture(createRoomAssistantService({ provider }));
    repository.completeAssistantRequest.mockRejectedValue(new PgV2CommandError('NOT_MEMBER'));

    const response = await gateway.handle({
      action: 'askRoomAssistant',
      input: {
        schemaVersion: 2,
        roomId: 'room-1',
        requestId: 'request-1',
        action: 'SYNTHESIZE_DISAGREEMENT',
        expectedSnapshotVersion: 3,
      },
    }, {});

    expect(response).toEqual({ status: 200, body: { ok: false, error: { code: 'NOT_MEMBER' } } });
  });

  it('returns an existing result for a replayed request without calling the model', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const { gateway, repository } = fixture(createRoomAssistantService({ provider }));
    repository.registerAssistantRequest.mockResolvedValue(message({
      status: 'SUCCEEDED',
      answer: '之前的回答',
      sourceIds: ['idea-1'],
    }));

    const response = await gateway.handle({
      action: 'askRoomAssistant',
      input: {
        schemaVersion: 2,
        roomId: 'room-1',
        requestId: 'request-1',
        action: 'SYNTHESIZE_DISAGREEMENT',
        expectedSnapshotVersion: 3,
      },
    }, {});

    expect(provider.complete).not.toHaveBeenCalled();
    expect(repository.completeAssistantRequest).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ ok: true });
  });

  it('requires a question for ASK and rejects questions on the quick actions', async () => {
    const { gateway, repository } = fixture(createRoomAssistantService({}));

    const missingQuestion = await gateway.handle({
      action: 'askRoomAssistant',
      input: {
        schemaVersion: 2,
        roomId: 'room-1',
        requestId: 'request-1',
        action: 'ASK',
        expectedSnapshotVersion: 3,
      },
    }, {});
    const unexpectedQuestion = await gateway.handle({
      action: 'askRoomAssistant',
      input: {
        schemaVersion: 2,
        roomId: 'room-1',
        requestId: 'request-2',
        action: 'SYNTHESIZE_DISAGREEMENT',
        question: '帮我投票',
        expectedSnapshotVersion: 3,
      },
    }, {});

    expect(missingQuestion.status).toBe(400);
    expect(unexpectedQuestion.status).toBe(400);
    expect(repository.getSnapshot).not.toHaveBeenCalled();
  });

  it('reads assistant history for the trusted member', async () => {
    const { gateway, repository } = fixture(createRoomAssistantService({}));

    const response = await gateway.handle({
      action: 'getRoomAssistantMessages',
      input: { roomId: 'room-1' },
    }, {});

    expect(repository.getRoomAssistantMessages).toHaveBeenCalledWith('host-uid', 'room-1');
    expect(response.body).toMatchObject({ ok: true });
  });
});
