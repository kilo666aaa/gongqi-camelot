import { describe, expect, it, vi } from 'vitest';
import type { RoomSnapshot } from '@gongqi/contracts/v2';
import { createGateway } from '../../../cloudbase/functions/gateway/src/gateway';
import { PgV2CommandError } from '../../../cloudbase/functions/gateway/src/repositories/pgV2Repository';
import { createDeepSeekProvider } from '../../../cloudbase/functions/gateway/src/ai/deepseekProvider';
import { createSuggestCandidatesService, type AiTextProvider } from '../../../cloudbase/functions/gateway/src/ai/suggestCandidates';

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
    phase: 'CANDIDATE_REVIEW',
    roomStatus: 'ACTIVE',
    memberUids: ['host-uid', 'member-uid'],
    candidates: [],
    currentRevisions: [],
    publicIdeas: [IDEA],
    comments: [],
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
      permissions: { phase: 'CANDIDATE_REVIEW', canEditCandidates: true, canOpenEvaluation: true },
    },
  } as RoomSnapshot;
}

const VALID_OUTPUT = JSON.stringify({
  suggestions: [
    { title: '周六上午爬山', body: '周六 9:00 在山脚集合，带水和轻食。', sourceIdeaIds: ['idea-1'] },
  ],
});

function providerReturning(value: string): AiTextProvider & { complete: ReturnType<typeof vi.fn> } {
  return { complete: vi.fn().mockResolvedValue(value) } as unknown as AiTextProvider & {
    complete: ReturnType<typeof vi.fn>;
  };
}

describe('AI suggestCandidates scope and fallback', () => {
  it('refuses before collection has ended and never calls the model', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const service = createSuggestCandidatesService({ provider });

    await expect(service.suggest({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot({ phase: 'COLLECTING', publicIdeas: [] }),
    })).rejects.toMatchObject({ code: 'AI_PHASE_NOT_ELIGIBLE' });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('refuses when no public input exists, without inventing ideas', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const service = createSuggestCandidatesService({ provider });

    await expect(service.suggest({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot({ publicIdeas: [] }),
    })).rejects.toMatchObject({ code: 'AI_NO_PUBLIC_INPUT' });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('reports unavailable when no model is configured', async () => {
    const service = createSuggestCandidatesService({});

    await expect(service.suggest({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
    })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });

  it('returns traceable suggestions for public input only', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const service = createSuggestCandidatesService({ provider, now: () => new Date('2026-11-07T01:02:03Z') });

    const result = await service.suggest({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
    });

    expect(result).toEqual({
      status: 'suggested',
      roomId: 'room-1',
      snapshotVersion: 3,
      scope: 'PUBLIC',
      generatedAt: '2026-11-07T01:02:03.000Z',
      suggestions: [
        { title: '周六上午爬山', body: '周六 9:00 在山脚集合，带水和轻食。', sourceIdeaIds: ['idea-1'] },
      ],
    });
    const prompt = provider.complete.mock.calls[0]?.[0] as { system: string; user: string };
    expect(prompt.user).toContain('idea-1');
    expect(prompt.user).toContain('周六去爬山');
    expect(prompt.user).not.toContain('host-uid');
  });

  it('rejects suggestions that cite a non-public or unknown idea', async () => {
    const provider = providerReturning(JSON.stringify({
      suggestions: [
        { title: '私自方案', body: '引用不在公开范围的想法。', sourceIdeaIds: ['idea-private'] },
      ],
    }));
    const service = createSuggestCandidatesService({ provider });

    await expect(service.suggest({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
    })).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
  });

  it('rejects malformed model output instead of showing partial text', async () => {
    const provider = providerReturning('这不是 JSON');
    const service = createSuggestCandidatesService({ provider });

    await expect(service.suggest({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
    })).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
  });

  it('marks the result stale when the room version changed during generation', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const service = createSuggestCandidatesService({ provider });

    await expect(service.suggest({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot(),
      revalidate: async () => 4,
    })).rejects.toMatchObject({ code: 'AI_STALE_CONTEXT' });
  });

  it('caches by room and snapshot version so polling does not re-bill the model', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const service = createSuggestCandidatesService({ provider, now: () => new Date('2026-11-07T01:00:00Z') });

    await service.suggest({ actorUid: 'host-uid', roomId: 'room-1', snapshot: snapshot() });
    await service.suggest({ actorUid: 'member-uid', roomId: 'room-1', snapshot: snapshot() });

    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('limits repeated uncached model calls per actor and room', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const service = createSuggestCandidatesService({
      provider,
      now: () => new Date('2026-11-07T01:00:00Z'),
      rateLimitMs: 5_000,
    });

    await service.suggest({ actorUid: 'host-uid', roomId: 'room-1', snapshot: snapshot({}, 3) });
    await expect(service.suggest({
      actorUid: 'host-uid',
      roomId: 'room-1',
      snapshot: snapshot({}, 4),
    })).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
});

describe('DeepSeek provider adapter', () => {
  it('calls the OpenAI-compatible endpoint with the configured model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: VALID_OUTPUT } }] }),
    });
    const provider = createDeepSeekProvider({ apiKey: 'test-key', fetchImpl });

    await expect(provider.complete({ system: '系统', user: '用户' })).resolves.toBe(VALID_OUTPUT);
    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body) as { model: string; messages: { role: string }[] };
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages.map(message => message.role)).toEqual(['system', 'user']);
  });

  it('maps aborts to a timeout and non-2xx responses to unavailable', async () => {
    const timeoutProvider = createDeepSeekProvider({
      apiKey: 'test-key',
      fetchImpl: vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    });
    await expect(timeoutProvider.complete({ system: 's', user: 'u' }))
      .rejects.toMatchObject({ code: 'AI_TIMEOUT' });

    const unavailableProvider = createDeepSeekProvider({
      apiKey: 'test-key',
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }),
    });
    await expect(unavailableProvider.complete({ system: 's', user: 'u' }))
      .rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });
});

describe('gateway suggestCandidates action', () => {
  function fixture(ai?: ReturnType<typeof createSuggestCandidatesService>) {
    const repository = {
      getSnapshot: vi.fn().mockResolvedValue(snapshot()),
    };
    const gateway = createGateway({
      repository: repository as never,
      resolveActor: async () => 'host-uid',
      ai,
    });
    return { gateway, repository };
  }

  it('reads the snapshot with the trusted actor and returns validated suggestions', async () => {
    const ai = createSuggestCandidatesService({ provider: providerReturning(VALID_OUTPUT) });
    const { gateway, repository } = fixture(ai);

    const response = await gateway.handle({ action: 'suggestCandidates', input: { roomId: 'room-1' } }, {});

    expect(repository.getSnapshot).toHaveBeenCalledWith('host-uid', 'room-1');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
  });

  it('does not call the model when the repository denies room access', async () => {
    const provider = providerReturning(VALID_OUTPUT);
    const ai = createSuggestCandidatesService({ provider });
    const { gateway, repository } = fixture(ai);
    repository.getSnapshot.mockRejectedValue(new PgV2CommandError('ROOM_NOT_FOUND'));

    const response = await gateway.handle({ action: 'suggestCandidates', input: { roomId: 'room-1' } }, {});

    expect(response).toEqual({ status: 200, body: { ok: false, error: { code: 'ROOM_NOT_FOUND' } } });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('rejects actor or unknown fields in the input envelope', async () => {
    const ai = createSuggestCandidatesService({ provider: providerReturning(VALID_OUTPUT) });
    const { gateway, repository } = fixture(ai);

    const response = await gateway.handle({
      action: 'suggestCandidates',
      input: { roomId: 'room-1', actorUid: 'attacker' },
    }, {});

    expect(response.status).toBe(400);
    expect(repository.getSnapshot).not.toHaveBeenCalled();
  });
});
