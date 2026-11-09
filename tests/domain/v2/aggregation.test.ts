import { describe, expect, it } from 'vitest';
import { candidateRevisionSchema } from '@gongqi/contracts/v2';
import {
  aggregateCandidateEvaluations,
  commentRequiresReevaluation,
  evaluateActivityRevision,
  hasSubstantiveRevisionChange,
  planReevaluation,
  rankCandidatesByScore,
  rankCandidatesBySupport,
} from '@gongqi/domain/v2';
import { makeEvaluation, makeRevision, makeRound, t1, t2 } from './fixtures';

describe('v2 candidate revision and activity adaptation', () => {
  it('targets only new or substantively changed candidates unless unchanged reevaluation is explicit', () => {
    const a1 = makeRevision('A');
    const b1 = makeRevision('B');
    const b2 = { ...makeRevision('B', 2, t1), body: 'B 的实质修改' };
    const c1 = makeRevision('C', 1, t1);
    expect(hasSubstantiveRevisionChange(a1, { ...a1, title: '  方案   A  ' })).toBe(false);
    expect(hasSubstantiveRevisionChange(b1, b2)).toBe(true);
    expect(planReevaluation([a1, b1], [a1, b2, c1])).toEqual({
      targetRevisionIds: [b2.id, c1.id],
      carriedRevisionIds: [a1.id],
    });
    expect(planReevaluation([a1, b1], [a1, b2], [a1.id]).targetRevisionIds).toEqual([a1.id, b2.id]);
    expect(commentRequiresReevaluation()).toBe(false);
  });

  it('keeps general independent and applies only explicit activity constraints through the legacy adapter', () => {
    const activity = candidateRevisionSchema.parse({
      ...makeRevision('ACT'),
      templateId: 'activity',
      templatePayload: {},
    });
    const members = [{ uid: 'alice', submitted: true }, { uid: 'bob', submitted: true }];
    const none = { kind: 'none' as const };
    const conditions = { budgetFen: none, available: none, travelMinutes: none, venue: none, preferredTypes: [] };
    const noLimits = { alice: conditions, bob: conditions };
    expect(evaluateActivityRevision(activity, members, noLimits, {}).status).toBe('PASS');
    const budget = { kind: 'value' as const, value: 5000, visibility: 'public' as const };
    const withBudget = { alice: { ...conditions, budgetFen: budget }, bob: conditions };
    expect(evaluateActivityRevision(activity, members, withBudget, {}).status).toBe('UNKNOWN');
    expect(activity.templateId).toBe('activity');
    expect(makeRevision('GENERAL').templatePayload).toEqual({});
  });
});

describe('v2 safe cross-round aggregation', () => {
  it('does not reveal OPEN evaluations or carry old-revision votes to a changed candidate', () => {
    const a1 = makeRevision('A');
    const b1 = makeRevision('B');
    const b2 = { ...makeRevision('B', 2, t1), body: 'B 已实质变化' };
    const revealed = makeRound({
      id: 'revealed', targetRevisionIds: [a1.id, b1.id], status: 'CLOSED', closedAt: t1, revealAt: t1, closeReason: 'HOST_END',
    });
    const open = makeRound({ id: 'open', targetRevisionIds: [b2.id], openedAt: t2 });
    const result = aggregateCandidateEvaluations({
      rounds: [revealed, open],
      evaluations: [
        makeEvaluation({ roundId: revealed.id, uid: 'alice', candidateRevisionId: a1.id, score: 5 }),
        makeEvaluation({ roundId: revealed.id, uid: 'alice', candidateRevisionId: b1.id, attitude: 'OPPOSE' }),
        makeEvaluation({ roundId: open.id, uid: 'alice', candidateRevisionId: b2.id, attitude: 'SUPPORT' }),
      ],
      currentRevisions: [a1, b2],
      currentRosterUids: ['alice', 'bob'],
      currentRoundId: open.id,
    });
    const a = result.find(item => item.candidateId === 'A');
    const b = result.find(item => item.candidateId === 'B');
    expect(a?.counts.support).toBe(1);
    expect(a?.evaluations[0]).toMatchObject({ sourceRoundId: revealed.id, sourceRevisionId: a1.id, origin: 'CARRIED' });
    expect(b?.counts).toEqual({ support: 0, oppose: 0, neutral: 0, skipped: 0, missing: 2 });
  });

  it('counts one current record per member and lets latest SKIPPED replace old SUPPORT', () => {
    const a1 = makeRevision('A');
    const first = makeRound({ id: 'first', status: 'CLOSED', closedAt: t1, revealAt: t1, closeReason: 'HOST_END' });
    const second = makeRound({ id: 'second', status: 'CLOSED', openedAt: t1, closedAt: t2, revealAt: t2, closeReason: 'HOST_END' });
    const result = aggregateCandidateEvaluations({
      rounds: [first, second],
      evaluations: [
        makeEvaluation({ roundId: first.id, uid: 'alice', candidateRevisionId: a1.id }),
        makeEvaluation({ roundId: second.id, uid: 'alice', candidateRevisionId: a1.id, submissionState: 'SKIPPED', updatedAt: t2 }),
      ],
      currentRevisions: [a1],
      currentRosterUids: ['alice', 'bob'],
      currentRoundId: second.id,
    });
    expect(result[0]?.counts).toEqual({ support: 0, oppose: 0, neutral: 0, skipped: 1, missing: 1 });
    expect(result[0]?.evaluations.find(item => item.uid === 'alice')).toMatchObject({
      submissionState: 'SKIPPED', sourceRoundId: second.id, origin: 'CURRENT',
    });
  });

  it('ranks support without net votes and keeps stable createdAt/ID tie order', () => {
    const revisions = [makeRevision('A'), makeRevision('B'), makeRevision('C')];
    const round = makeRound({
      id: 'support', targetRevisionIds: revisions.map(item => item.id), status: 'CLOSED', closedAt: t1, revealAt: t1, closeReason: 'HOST_END',
    });
    const evaluations = revisions.flatMap(revision => [
      makeEvaluation({ roundId: round.id, uid: 'alice', candidateRevisionId: revision.id }),
      makeEvaluation({ roundId: round.id, uid: 'bob', candidateRevisionId: revision.id, attitude: revision.id === 'a-r1' ? 'OPPOSE' : 'SUPPORT' }),
    ]);
    const aggregates = aggregateCandidateEvaluations({ rounds: [round], evaluations, currentRevisions: revisions, currentRosterUids: ['alice', 'bob'] });
    expect(aggregates.map(item => item.counts)).toEqual([
      { support: 1, oppose: 1, neutral: 0, skipped: 0, missing: 0 },
      { support: 2, oppose: 0, neutral: 0, skipped: 0, missing: 0 },
      { support: 2, oppose: 0, neutral: 0, skipped: 0, missing: 0 },
    ]);
    expect(rankCandidatesBySupport(aggregates).map(item => item.candidateId)).toEqual(['B', 'C', 'A']);
  });

  it('compares exact score averages and keeps missing scores out of zero-based ranking', () => {
    const roster = ['a', 'b', 'c', 'd', 'e', 'f'];
    const revisions = [makeRevision('A'), makeRevision('B'), makeRevision('C')];
    const round = makeRound({
      id: 'scores', rosterUids: roster, targetRevisionIds: revisions.map(item => item.id), status: 'CLOSED', closedAt: t1, revealAt: t1, closeReason: 'HOST_END',
    });
    const scores = new Map([
      ['A', [5, 5, 5, 5, 4, 1]],
      ['B', [5, 5, 5, 5, 1, null]],
      ['C', [null, null, null, null, null, null]],
    ]);
    const evaluations = revisions.flatMap(revision => roster.map((uid, index) => makeEvaluation({
      roundId: round.id,
      uid,
      candidateRevisionId: revision.id,
      score: scores.get(revision.candidateId)?.[index] ?? null,
    })));
    const aggregates = aggregateCandidateEvaluations({ rounds: [round], evaluations, currentRevisions: revisions, currentRosterUids: roster });
    const ranked = rankCandidatesByScore(aggregates);
    expect(ranked.ranked.map(item => item.candidateId)).toEqual(['B', 'A']);
    expect(ranked.withoutScores.map(item => item.candidateId)).toEqual(['C']);
    expect(aggregates.find(item => item.candidateId === 'A')).toMatchObject({ scoreSum: 25, scoreCount: 6 });
    expect(aggregates.find(item => item.candidateId === 'B')).toMatchObject({ scoreSum: 21, scoreCount: 5 });
    expect(aggregates.find(item => item.candidateId === 'C')).toMatchObject({ scoreSum: 0, scoreCount: 0 });
  });

  it('uses createdAt and candidate ID for equal exact score averages', () => {
    const revisions = [makeRevision('A'), makeRevision('B')];
    const round = makeRound({
      id: 'tie', targetRevisionIds: revisions.map(item => item.id), status: 'CLOSED', closedAt: t1, revealAt: t1, closeReason: 'HOST_END',
    });
    const aggregates = aggregateCandidateEvaluations({
      rounds: [round],
      evaluations: [
        makeEvaluation({ roundId: round.id, uid: 'alice', candidateRevisionId: 'a-r1', score: 5 }),
        makeEvaluation({ roundId: round.id, uid: 'alice', candidateRevisionId: 'b-r1', score: 5 }),
        makeEvaluation({ roundId: round.id, uid: 'bob', candidateRevisionId: 'b-r1', score: 5 }),
      ],
      currentRevisions: revisions,
      currentRosterUids: ['alice', 'bob'],
    });
    expect(rankCandidatesByScore(aggregates).ranked.map(item => item.candidateId)).toEqual(['A', 'B']);
  });
});
