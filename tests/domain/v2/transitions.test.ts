import { describe, expect, it } from 'vitest';
import {
  cancelEvaluationForRosterChange,
  cancelReopenForRosterChange,
  guardApprovedReopen,
  guardReopenVote,
  phaseAfterRosterChange,
  resolveReopenRequest,
  type ReopenContext,
  type ReopenRequest,
  type ReopenVote,
} from '@gongqi/domain/v2';
import { makeRound, t1, t2 } from './fixtures';

const request: ReopenRequest = {
  id: 'reopen-1',
  cycleId: 'cycle-1',
  rosterUids: ['alice', 'bob'],
  rosterRevision: 1,
  targetRevisionIds: ['a-r1'],
  status: 'OPEN',
};
const context: ReopenContext = {
  phase: 'DISCUSSING',
  rosterRevision: 1,
  rosterUids: ['alice', 'bob'],
  targetRevisionIds: ['a-r1'],
};
const reopenVote = (uid: string): ReopenVote => ({ requestId: request.id, uid, choice: 'REOPEN' });

describe('v2 approved targeted reopening', () => {
  it('requires a majority of the full frozen roster and counts each member once', () => {
    expect(resolveReopenRequest(request, [reopenVote('alice'), reopenVote('alice')]).status).toBe('OPEN');
    expect(resolveReopenRequest(request, [reopenVote('alice'), reopenVote('outsider')]).status).toBe('OPEN');
    expect(resolveReopenRequest(request, [reopenVote('alice'), reopenVote('bob')])).toMatchObject({
      status: 'APPROVED',
    });
  });

  it('separates structural phase edges from member, roster and revision authorization', () => {
    expect(guardReopenVote(request, 'alice', context)).toEqual({ ok: true });
    expect(guardReopenVote(request, 'outsider', context)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(guardReopenVote(request, 'alice', { ...context, phase: 'EVALUATING' }))
      .toEqual({ ok: false, code: 'INVALID_STATE' });
    expect(guardReopenVote(request, 'alice', { ...context, rosterRevision: 2 }))
      .toEqual({ ok: false, code: 'ROSTER_CHANGED' });
    expect(guardReopenVote(request, 'alice', { ...context, targetRevisionIds: ['a-r2'] }))
      .toEqual({ ok: false, code: 'CANDIDATE_REVISION_MISMATCH' });
  });

  it('does not open a new evaluation without approval or with stale state', () => {
    expect(guardApprovedReopen(request, context)).toEqual({ ok: false, code: 'REOPEN_NOT_APPROVED' });
    const approved = { ...request, status: 'APPROVED' } as const;
    expect(guardApprovedReopen(approved, context)).toEqual({ ok: true });
    expect(guardApprovedReopen(approved, { ...context, rosterUids: ['alice', 'charlie'] }))
      .toEqual({ ok: false, code: 'ROSTER_CHANGED' });
    expect(guardApprovedReopen(approved, { ...context, targetRevisionIds: ['a-r2'] }))
      .toEqual({ ok: false, code: 'CANDIDATE_REVISION_MISMATCH' });
  });
});

describe('v2 roster-change cancellation and return paths', () => {
  it('cancels active evaluation and reopening without revealing cancelled blind input', () => {
    const round = makeRound({ id: 'round-cancel' });
    const cancelled = cancelEvaluationForRosterChange(round, 2, ['alice', 'charlie'], t2);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', closedAt: t2 });
    expect(cancelled.revealAt).toBeUndefined();
    expect(cancelReopenForRosterChange(request, 2, ['alice', 'charlie']).status).toBe('CANCELLED');
  });

  it('settles expiry before roster cancellation and preserves closed history', () => {
    const expired = makeRound({ id: 'expired', deadlineAt: t2 });
    expect(cancelEvaluationForRosterChange(expired, 2, ['alice', 'charlie'], t2)).toMatchObject({
      status: 'CLOSED',
      closeReason: 'TIMEOUT',
    });
    const closed = makeRound({ id: 'closed', status: 'CLOSED', closedAt: t1, revealAt: t1 });
    expect(cancelEvaluationForRosterChange(closed, 2, ['alice', 'charlie'], t2)).toBe(closed);
    expect(cancelReopenForRosterChange({ ...request, status: 'APPROVED' }, 2, ['alice']).status)
      .toBe('APPROVED');
  });

  it('returns to candidate review only when public candidates exist', () => {
    expect(phaseAfterRosterChange(true)).toBe('CANDIDATE_REVIEW');
    expect(phaseAfterRosterChange(false)).toBe('COLLECTING');
  });
});
