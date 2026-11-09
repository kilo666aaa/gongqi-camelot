import type { Candidate } from '@gongqi/contracts';
import type { CandidateRevision } from '@gongqi/contracts/v2';
import { evaluateCandidate } from '../evaluate';
import type { ConditionsByUid, Evaluation, MemberInput, TravelByUid } from '../types';

export function evaluateActivityRevision(
  revision: CandidateRevision,
  members: readonly MemberInput[],
  conditionsByUid: ConditionsByUid,
  travelByUid: TravelByUid,
): Evaluation {
  if (revision.templateId !== 'activity') throw new Error('Activity adapter requires an activity revision');
  const payload = revision.templatePayload;
  const candidate: Candidate = {
    id: revision.candidateId,
    roomId: 'activity-adapter',
    roundId: revision.id,
    title: revision.title,
    time: payload.time ?? null,
    estimatedCostFen: payload.budgetFen ?? null,
    location: payload.location ?? null,
    venue: payload.venue ?? null,
    activityType: payload.activityType ?? null,
    note: revision.body,
    sourceUrl: null,
    createdBy: revision.createdBy,
    createdAt: revision.createdAt,
    updatedAt: revision.createdAt,
    contentRevision: revision.revision,
    destinationRevision: revision.revision,
    withdrawn: false,
  };
  const evaluation = evaluateCandidate(candidate, members, conditionsByUid, travelByUid);
  const requiredMissingFields = new Set<string>();
  if (members.some(member => conditionsByUid[member.uid]?.budgetFen.kind === 'value')) {
    requiredMissingFields.add('estimatedCostFen');
  }
  if (members.some(member => conditionsByUid[member.uid]?.available.kind === 'value')) {
    requiredMissingFields.add('time');
  }
  if (members.some(member => conditionsByUid[member.uid]?.venue.kind === 'value')) {
    requiredMissingFields.add('venue');
  }
  const missingFields = evaluation.missingFields.filter(field => requiredMissingFields.has(field));
  const status = evaluation.checks.some(check => check.status === 'FAIL') ? 'FAIL'
    : evaluation.provisional || missingFields.length > 0 || evaluation.checks.some(check => check.status === 'UNKNOWN')
      ? 'UNKNOWN'
      : 'PASS';
  return { ...evaluation, status, missingFields };
}
