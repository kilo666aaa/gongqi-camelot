import type { ConfirmationProposal, FinalResponse, RespondFinalCommand } from '@gongqi/contracts/v2';
import { guardMember, sameRoster, type RuleResult } from './authorization';

export interface FinalConfirmationContext {
  decisionRevision: number;
  rosterRevision: number;
  rosterUids: readonly string[];
  candidateRevisionId: string;
}

export interface ConfirmationResolution {
  status: ConfirmationProposal['status'];
  responseSummary: { accepted: number; declined: number; abstained: number; pending: number };
}

export function respondFinal(
  command: RespondFinalCommand,
  actorUid: string,
  proposal: ConfirmationProposal,
  context: FinalConfirmationContext,
  now: string,
): RuleResult<FinalResponse> {
  if (proposal.status !== 'OPEN') return { ok: false, code: 'PROPOSAL_CLOSED' };
  if (Date.parse(now) >= Date.parse(proposal.deadlineAt)) return { ok: false, code: 'PROPOSAL_EXPIRED' };
  if (command.proposalId !== proposal.id) return { ok: false, code: 'PROPOSAL_MISMATCH' };
  if (command.candidateRevisionId !== proposal.candidateRevisionSnapshot.id
    || context.candidateRevisionId !== proposal.candidateRevisionSnapshot.id) {
    return { ok: false, code: 'CANDIDATE_REVISION_MISMATCH' };
  }
  if (command.expectedDecisionRevision !== proposal.decisionRevision
    || context.decisionRevision !== proposal.decisionRevision) {
    return { ok: false, code: 'VERSION_CONFLICT' };
  }
  if (!sameRoster(context.rosterUids, proposal.rosterUids)) return { ok: false, code: 'ROSTER_CHANGED' };
  const member = guardMember(actorUid, proposal.rosterUids);
  if (!member.ok) return member;
  return {
    ok: true,
    value: {
      schemaVersion: 2,
      proposalId: proposal.id,
      candidateRevisionId: proposal.candidateRevisionSnapshot.id,
      uid: actorUid,
      choice: command.choice,
      updatedAt: now,
    },
  };
}

function latestValidResponses(
  proposal: ConfirmationProposal,
  responses: readonly FinalResponse[],
): ReadonlyMap<string, FinalResponse> {
  const latest = new Map<string, FinalResponse>();
  const deadline = Date.parse(proposal.deadlineAt);
  for (const response of responses) {
    if (response.proposalId !== proposal.id
      || response.candidateRevisionId !== proposal.candidateRevisionSnapshot.id
      || !proposal.rosterUids.includes(response.uid)
      || Date.parse(response.updatedAt) >= deadline) continue;
    const previous = latest.get(response.uid);
    if (previous === undefined || Date.parse(response.updatedAt) >= Date.parse(previous.updatedAt)) {
      latest.set(response.uid, response);
    }
  }
  return latest;
}

export function resolveFinalConfirmation(
  proposal: ConfirmationProposal,
  responses: readonly FinalResponse[],
  context: FinalConfirmationContext,
  now: string,
): ConfirmationResolution {
  const latest = latestValidResponses(proposal, responses);
  const responseSummary = { accepted: 0, declined: 0, abstained: 0, pending: 0 };
  for (const uid of proposal.rosterUids) {
    const response = latest.get(uid);
    if (response === undefined) responseSummary.pending += 1;
    else if (response.choice === 'ACCEPT') responseSummary.accepted += 1;
    else if (response.choice === 'DECLINE') responseSummary.declined += 1;
    else responseSummary.abstained += 1;
  }
  if (proposal.status !== 'OPEN') return { status: proposal.status, responseSummary };
  if (context.decisionRevision !== proposal.decisionRevision
    || context.candidateRevisionId !== proposal.candidateRevisionSnapshot.id
    || !sameRoster(context.rosterUids, proposal.rosterUids)) {
    return { status: 'INVALIDATED', responseSummary };
  }
  if (responseSummary.accepted === proposal.rosterUids.length) return { status: 'AGREED', responseSummary };
  if (Date.parse(now) >= Date.parse(proposal.deadlineAt)) return { status: 'UNRESOLVED', responseSummary };
  return { status: 'OPEN', responseSummary };
}
