import { describe, expect, it } from 'vitest';
import {
  canTransitionPhase,
  closeEvaluationByHost,
  guardEvaluationSubmission,
  majorityThreshold,
  resolveEvaluationRound,
  retractRoundCloseVote,
  setRoundDeadline,
  type RoundCloseVote,
} from '@gongqi/domain/v2';
import { makeRound, t1, t2, t3, t4 } from './fixtures';

const endVote = (roundId: string, uid: string): RoundCloseVote => ({ roundId, uid, choice: 'END' });

describe('v2 evaluation round majority and deadline rules', () => {
  it('requires more than half of the full roster, never just votes already cast', () => {
    const two = makeRound({ id: 'two' });
    const sixUids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const six = makeRound({ id: 'six', rosterUids: sixUids });
    expect(majorityThreshold(two.rosterUids)).toBe(2);
    expect(majorityThreshold(six.rosterUids)).toBe(4);
    expect(resolveEvaluationRound(two, [endVote(two.id, 'alice')], t1).status).toBe('OPEN');
    expect(resolveEvaluationRound(two, [endVote(two.id, 'alice'), endVote(two.id, 'bob')], t1)).toMatchObject({
      status: 'CLOSED',
      closeReason: 'MAJORITY_END',
    });
    expect(resolveEvaluationRound(six, sixUids.slice(0, 3).map(uid => endVote(six.id, uid)), t1).status).toBe('OPEN');
    expect(resolveEvaluationRound(six, sixUids.slice(0, 4).map(uid => endVote(six.id, uid)), t1).status).toBe('CLOSED');
  });

  it('counts one vote per frozen member and honors retraction', () => {
    const round = makeRound({ id: 'round' });
    const duplicate = [endVote(round.id, 'alice'), endVote(round.id, 'alice')];
    expect(resolveEvaluationRound(round, duplicate, t1).status).toBe('OPEN');
    const both = [endVote(round.id, 'alice'), endVote(round.id, 'bob')];
    const remaining = retractRoundCloseVote(both, round.id, 'bob');
    expect(remaining).toEqual([endVote(round.id, 'alice')]);
    expect(resolveEvaluationRound(round, remaining, t1).status).toBe('OPEN');
  });

  it('settles timeout before majority or host close and never revives an expired round', () => {
    const round = makeRound({ id: 'deadline', deadlineAt: t2 });
    const votes = [endVote(round.id, 'alice'), endVote(round.id, 'bob')];
    expect(resolveEvaluationRound(round, votes, t2)).toMatchObject({ status: 'CLOSED', closeReason: 'TIMEOUT' });
    expect(closeEvaluationByHost(round, 'host', 'host', t2)).toMatchObject({ ok: true, value: { closeReason: 'TIMEOUT' } });
    expect(setRoundDeadline(round, 'host', 'host', t3, '延期说明', t2)).toEqual({ ok: false, code: 'ROUND_CLOSED' });
    expect(guardEvaluationSubmission(round, 'alice', 'a-r1', t2)).toEqual({ ok: false, code: 'ROUND_CLOSED' });
  });

  it('allows only a host to set a future deadline with a reason before expiry', () => {
    const round = makeRound({ id: 'deadline', deadlineAt: t3 });
    expect(setRoundDeadline(round, 'member', 'host', t4, '延期说明', t1)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(setRoundDeadline(round, 'host', 'host', t2, '延期说明', t1)).toEqual({ ok: false, code: 'INVALID_DEADLINE' });
    expect(setRoundDeadline(round, 'host', 'host', t4, ' ', t1)).toEqual({ ok: false, code: 'INVALID_REASON' });
    const result = setRoundDeadline(round, 'host', 'host', t4, '需要更多讨论', t1);
    if (!result.ok) throw new Error('Expected a valid deadline update');
    expect(result.value.deadlineAt).toBe(t4);
  });

  it('rejects writes to closed rounds and non-target or non-roster submissions', () => {
    const closed = makeRound({ id: 'closed', status: 'CLOSED', closedAt: t1, revealAt: t1, closeReason: 'HOST_END' });
    const open = makeRound({ id: 'open' });
    expect(guardEvaluationSubmission(closed, 'alice', 'a-r1', t2)).toEqual({ ok: false, code: 'ROUND_CLOSED' });
    expect(guardEvaluationSubmission(open, 'outsider', 'a-r1', t1)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(guardEvaluationSubmission(open, 'alice', 'other-revision', t1)).toEqual({ ok: false, code: 'CANDIDATE_REVISION_MISMATCH' });
    expect(guardEvaluationSubmission(open, 'alice', 'a-r1', t1)).toEqual({ ok: true });
  });

  it('checks host authority for manual close without treating it as final agreement', () => {
    const round = makeRound({ id: 'host-close' });
    expect(closeEvaluationByHost(round, 'alice', 'host', t1)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(closeEvaluationByHost(round, 'host', 'host', t1)).toMatchObject({
      ok: true,
      value: { status: 'CLOSED', closeReason: 'HOST_END' },
    });
  });
});

describe('v2 room phase transitions', () => {
  it('allows the declared flow and an explicit next cycle only', () => {
    expect(canTransitionPhase('COLLECTING', 'CANDIDATE_REVIEW')).toBe(true);
    expect(canTransitionPhase('EVALUATING', 'DISCUSSING')).toBe(true);
    expect(canTransitionPhase('COMPLETED', 'COLLECTING')).toBe(true);
    expect(canTransitionPhase('DISCUSSING', 'EVALUATING')).toBe(true);
    expect(canTransitionPhase('CONFIRMING', 'DISCUSSING')).toBe(true);
    expect(canTransitionPhase('EVALUATING', 'CANDIDATE_REVIEW')).toBe(true);
    expect(canTransitionPhase('CONFIRMING', 'COLLECTING')).toBe(true);
    expect(canTransitionPhase('COLLECTING', 'EVALUATING')).toBe(false);
    expect(canTransitionPhase('EVALUATING', 'CONFIRMING')).toBe(false);
    expect(canTransitionPhase('COMPLETED', 'CONFIRMING')).toBe(false);
  });
});
