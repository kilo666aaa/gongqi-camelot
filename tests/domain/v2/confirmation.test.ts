import { describe, expect, it } from 'vitest';
import {
  respondFinal,
  resolveFinalConfirmation,
  type FinalConfirmationContext,
} from '@gongqi/domain/v2';
import { makeProposal, makeResponse, makeResponseCommand, t1, t2, t3, t4 } from './fixtures';

function contextFor(
  proposal: ReturnType<typeof makeProposal>,
  overrides: Partial<FinalConfirmationContext> = {},
): FinalConfirmationContext {
  return {
    decisionRevision: proposal.decisionRevision,
    rosterRevision: 1,
    rosterUids: proposal.rosterUids,
    candidateRevisionId: proposal.candidateRevisionSnapshot.id,
    ...overrides,
  };
}

describe('v2 final response authorization and revision binding', () => {
  it('binds the persisted response to the trusted proposal, candidate revision and actor UID', () => {
    const proposal = makeProposal();
    const command = { ...makeResponseCommand(proposal), uid: 'bob' };
    const result = respondFinal(command, 'alice', proposal, contextFor(proposal), t2);
    expect(result).toMatchObject({
      ok: true,
      value: {
        proposalId: proposal.id,
        candidateRevisionId: proposal.candidateRevisionSnapshot.id,
        uid: 'alice',
        choice: 'ACCEPT',
        updatedAt: t2,
      },
    });
  });

  it('rejects missing current bindings, stale decisions and a different proposal', () => {
    const proposal = makeProposal();
    expect(respondFinal(
      makeResponseCommand(proposal, 'a-r0'), 'alice', proposal, contextFor(proposal), t1,
    )).toEqual({ ok: false, code: 'CANDIDATE_REVISION_MISMATCH' });
    const versioned = makeProposal({ decisionRevision: 2 });
    expect(respondFinal(
      makeResponseCommand(versioned, versioned.candidateRevisionSnapshot.id, 1),
      'alice', versioned, contextFor(versioned), t1,
    )).toEqual({ ok: false, code: 'VERSION_CONFLICT' });
    expect(respondFinal(
      { ...makeResponseCommand(proposal), proposalId: 'other-proposal' },
      'alice', proposal, contextFor(proposal), t1,
    )).toEqual({ ok: false, code: 'PROPOSAL_MISMATCH' });
    expect(respondFinal(
      makeResponseCommand(proposal), 'alice', proposal,
      contextFor(proposal, { candidateRevisionId: 'a-r2' }), t1,
    )).toEqual({ ok: false, code: 'CANDIDATE_REVISION_MISMATCH' });
  });

  it('rejects outsiders, roster changes, closed proposals and expiry at the exact deadline', () => {
    const proposal = makeProposal();
    expect(respondFinal(
      makeResponseCommand(proposal), 'outsider', proposal, contextFor(proposal), t1,
    )).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(respondFinal(
      makeResponseCommand(proposal), 'alice', proposal,
      contextFor(proposal, { rosterUids: ['alice', 'charlie'] }), t1,
    )).toEqual({ ok: false, code: 'ROSTER_CHANGED' });
    const closed = makeProposal({ status: 'UNRESOLVED' });
    expect(respondFinal(
      makeResponseCommand(closed), 'alice', closed, contextFor(closed), t1,
    )).toEqual({ ok: false, code: 'PROPOSAL_CLOSED' });
    expect(respondFinal(
      makeResponseCommand(proposal), 'alice', proposal, contextFor(proposal), t4,
    )).toEqual({ ok: false, code: 'PROPOSAL_EXPIRED' });
  });
});

describe('v2 final confirmation resolution', () => {
  it('requires every frozen member to ACCEPT the same current candidate revision', () => {
    const proposal = makeProposal();
    const responses = [
      makeResponse(proposal, 'alice', 'ACCEPT', t1),
      makeResponse(proposal, 'bob', 'ACCEPT', t2),
    ];
    expect(resolveFinalConfirmation(proposal, responses, contextFor(proposal), t3)).toEqual({
      status: 'AGREED',
      responseSummary: { accepted: 2, declined: 0, abstained: 0, pending: 0 },
    });
  });

  it('does not turn missing, declined, abstained or stale responses into agreement', () => {
    const proposal = makeProposal({ rosterUids: ['alice', 'bob', 'carol'] });
    const responses = [
      makeResponse(proposal, 'alice', 'ACCEPT', t1),
      makeResponse(proposal, 'bob', 'ABSTAIN', t1),
      makeResponse(proposal, 'carol', 'ACCEPT', t1, 'other-revision'),
    ];
    expect(resolveFinalConfirmation(proposal, responses, contextFor(proposal), t3)).toEqual({
      status: 'OPEN',
      responseSummary: { accepted: 1, declined: 0, abstained: 1, pending: 1 },
    });
    const declined = makeProposal();
    expect(resolveFinalConfirmation(declined, [
      makeResponse(declined, 'alice', 'ACCEPT', t1),
      makeResponse(declined, 'bob', 'DECLINE', t1),
    ], contextFor(declined), t3)).toMatchObject({
      status: 'OPEN',
      responseSummary: { accepted: 1, declined: 1, abstained: 0, pending: 0 },
    });
  });

  it('uses each member latest response without counting duplicate accepts twice', () => {
    const proposal = makeProposal();
    const responses = [
      makeResponse(proposal, 'alice', 'ACCEPT', t1),
      makeResponse(proposal, 'alice', 'ACCEPT', t2),
      makeResponse(proposal, 'bob', 'ABSTAIN', t2),
    ];
    expect(resolveFinalConfirmation(proposal, responses, contextFor(proposal), t3)).toEqual({
      status: 'OPEN',
      responseSummary: { accepted: 1, declined: 0, abstained: 1, pending: 0 },
    });
  });

  it('settles expiry before a response at the deadline but preserves earlier full agreement', () => {
    const atDeadline = makeProposal();
    expect(resolveFinalConfirmation(atDeadline, [
      makeResponse(atDeadline, 'alice', 'ACCEPT', t3),
      makeResponse(atDeadline, 'bob', 'ACCEPT', t4),
    ], contextFor(atDeadline), t4)).toEqual({
      status: 'UNRESOLVED',
      responseSummary: { accepted: 1, declined: 0, abstained: 0, pending: 1 },
    });
    const alreadyAccepted = makeProposal();
    const accepted = [
      makeResponse(alreadyAccepted, 'alice', 'ACCEPT', t1),
      makeResponse(alreadyAccepted, 'bob', 'ACCEPT', t2),
    ];
    expect(resolveFinalConfirmation(alreadyAccepted, accepted, contextFor(alreadyAccepted), t4).status).toBe('AGREED');
    expect(resolveFinalConfirmation(
      { ...alreadyAccepted, status: 'AGREED' }, accepted, contextFor(alreadyAccepted), t4,
    ).status).toBe('AGREED');
  });

  it('invalidates an open proposal when current roster, candidate or decision changes', () => {
    const proposal = makeProposal();
    for (const context of [
      contextFor(proposal, { rosterUids: ['alice', 'charlie'] }),
      contextFor(proposal, { candidateRevisionId: 'a-r2' }),
      contextFor(proposal, { decisionRevision: 2 }),
    ]) {
      expect(resolveFinalConfirmation(proposal, [], context, t1).status).toBe('INVALIDATED');
    }
  });
});
