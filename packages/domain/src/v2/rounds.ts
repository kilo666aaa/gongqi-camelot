import type { EvaluationRound } from '@gongqi/contracts/v2';
import { guardHost, guardMember, type GuardResult, type RuleResult } from './authorization';

export interface RoundCloseVote {
  roundId: string;
  uid: string;
  choice: 'END' | 'KEEP_OPEN';
}

function isExpired(round: EvaluationRound, now: string): boolean {
  return round.deadlineAt !== undefined && Date.parse(now) >= Date.parse(round.deadlineAt);
}

function closeRound(
  round: EvaluationRound,
  now: string,
  closeReason: NonNullable<EvaluationRound['closeReason']>,
): EvaluationRound {
  return { ...round, status: 'CLOSED', closedAt: now, revealAt: now, closeReason };
}

export function majorityThreshold(rosterUids: readonly string[]): number {
  return Math.floor(rosterUids.length / 2) + 1;
}

export function resolveEvaluationRound(
  round: EvaluationRound,
  votes: readonly RoundCloseVote[],
  now: string,
): EvaluationRound {
  if (round.status !== 'OPEN') return round;
  if (isExpired(round, now)) return closeRound(round, now, 'TIMEOUT');
  if (round.deadlineAt !== undefined) return round;
  const endVoters = new Set(votes
    .filter(vote => vote.roundId === round.id && vote.choice === 'END' && round.rosterUids.includes(vote.uid))
    .map(vote => vote.uid));
  return endVoters.size >= majorityThreshold(round.rosterUids)
    ? closeRound(round, now, 'MAJORITY_END')
    : round;
}

export function guardEvaluationSubmission(
  round: EvaluationRound,
  actorUid: string,
  candidateRevisionId: string,
  now: string,
): GuardResult {
  if (round.status !== 'OPEN' || isExpired(round, now)) return { ok: false, code: 'ROUND_CLOSED' };
  const member = guardMember(actorUid, round.rosterUids);
  if (!member.ok) return member;
  if (!round.targetRevisionIds.includes(candidateRevisionId)) {
    return { ok: false, code: 'CANDIDATE_REVISION_MISMATCH' };
  }
  return { ok: true };
}

export function setRoundDeadline(
  round: EvaluationRound,
  actorUid: string,
  hostUid: string,
  deadlineAt: string,
  reason: string,
  now: string,
): RuleResult<EvaluationRound> {
  if (round.status !== 'OPEN' || isExpired(round, now)) return { ok: false, code: 'ROUND_CLOSED' };
  const host = guardHost(actorUid, hostUid);
  if (!host.ok) return host;
  if (!Number.isFinite(Date.parse(deadlineAt)) || Date.parse(deadlineAt) <= Date.parse(now)
    || (round.deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.parse(round.deadlineAt))) {
    return { ok: false, code: 'INVALID_DEADLINE' };
  }
  if (reason.trim().length === 0) return { ok: false, code: 'INVALID_REASON' };
  return { ok: true, value: { ...round, deadlineAt } };
}

export function retractRoundCloseVote(
  votes: readonly RoundCloseVote[],
  roundId: string,
  actorUid: string,
): RoundCloseVote[] {
  return votes.filter(vote => vote.roundId !== roundId || vote.uid !== actorUid);
}

export function cancelEvaluationForRosterChange(
  round: EvaluationRound,
  currentRosterRevision: number,
  currentRosterUids: readonly string[],
  now: string,
): EvaluationRound {
  if (round.status !== 'OPEN'
    || (currentRosterRevision === round.rosterRevision && round.rosterUids.every(uid => currentRosterUids.includes(uid))
      && currentRosterUids.length === round.rosterUids.length)) return round;
  if (isExpired(round, now)) return closeRound(round, now, 'TIMEOUT');
  const cancelled: EvaluationRound = { ...round, status: 'CANCELLED', closedAt: now };
  delete cancelled.revealAt;
  delete cancelled.closeReason;
  return cancelled;
}

export function closeEvaluationByHost(
  round: EvaluationRound,
  actorUid: string,
  hostUid: string,
  now: string,
): RuleResult<EvaluationRound> {
  if (round.status !== 'OPEN') return { ok: false, code: 'ROUND_CLOSED' };
  if (isExpired(round, now)) return { ok: true, value: closeRound(round, now, 'TIMEOUT') };
  const host = guardHost(actorUid, hostUid);
  if (!host.ok) return host;
  return { ok: true, value: closeRound(round, now, 'HOST_END') };
}
