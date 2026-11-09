import type { CandidateRevision, Evaluation, EvaluationRound } from '@gongqi/contracts/v2';

export interface EffectiveEvaluation {
  uid: string;
  candidateRevisionId: string;
  submissionState: 'EVALUATED' | 'SKIPPED' | 'MISSING';
  attitude?: 'SUPPORT' | 'OPPOSE' | 'NEUTRAL';
  score?: number | null;
  sourceRoundId?: string;
  sourceRevisionId?: string;
  origin: 'CURRENT' | 'CARRIED' | 'NONE';
}

export interface CandidateAggregate {
  candidateId: string;
  candidateRevisionId: string;
  createdAt: string;
  evaluations: EffectiveEvaluation[];
  counts: { support: number; oppose: number; neutral: number; skipped: number; missing: number };
  scoreSum: number;
  scoreCount: number;
  scoreDistribution: { 1: number; 2: number; 3: number; 4: number; 5: number };
}

export interface AggregationInput {
  rounds: readonly EvaluationRound[];
  evaluations: readonly Evaluation[];
  currentRevisions: readonly CandidateRevision[];
  currentRosterUids: readonly string[];
  currentRoundId?: string;
}

interface SourcedEvaluation {
  evaluation: Evaluation;
  round: EvaluationRound;
}

function isLater(candidate: SourcedEvaluation, previous: SourcedEvaluation): boolean {
  const candidateClosedAt = Date.parse(candidate.round.closedAt ?? candidate.round.revealAt ?? candidate.round.openedAt);
  const previousClosedAt = Date.parse(previous.round.closedAt ?? previous.round.revealAt ?? previous.round.openedAt);
  if (candidateClosedAt !== previousClosedAt) return candidateClosedAt > previousClosedAt;
  const candidateUpdatedAt = Date.parse(candidate.evaluation.updatedAt);
  const previousUpdatedAt = Date.parse(previous.evaluation.updatedAt);
  if (candidateUpdatedAt !== previousUpdatedAt) return candidateUpdatedAt > previousUpdatedAt;
  return candidate.round.id > previous.round.id;
}

function compareStable(left: CandidateAggregate, right: CandidateAggregate): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.candidateId.localeCompare(right.candidateId);
}

export function aggregateCandidateEvaluations(input: AggregationInput): CandidateAggregate[] {
  const revealedRounds = new Map(input.rounds
    .filter(round => round.status === 'CLOSED' && round.revealAt !== undefined)
    .map(round => [round.id, round]));
  return input.currentRevisions.map(revision => {
    const latestByUid = new Map<string, SourcedEvaluation>();
    for (const evaluation of input.evaluations) {
      if (evaluation.candidateRevisionId !== revision.id || !input.currentRosterUids.includes(evaluation.uid)) continue;
      const round = revealedRounds.get(evaluation.roundId);
      if (round === undefined || !round.targetRevisionIds.includes(revision.id)
        || !round.rosterUids.includes(evaluation.uid)) continue;
      const sourced = { evaluation, round };
      const previous = latestByUid.get(evaluation.uid);
      if (previous === undefined || isLater(sourced, previous)) latestByUid.set(evaluation.uid, sourced);
    }
    const evaluations = input.currentRosterUids.map((uid): EffectiveEvaluation => {
      const sourced = latestByUid.get(uid);
      if (sourced === undefined) {
        return { uid, candidateRevisionId: revision.id, submissionState: 'MISSING', origin: 'NONE' };
      }
      const base: EffectiveEvaluation = {
        uid,
        candidateRevisionId: revision.id,
        submissionState: sourced.evaluation.submissionState,
        sourceRoundId: sourced.round.id,
        sourceRevisionId: sourced.evaluation.candidateRevisionId,
        origin: sourced.round.id === input.currentRoundId ? 'CURRENT' : 'CARRIED',
      };
      if (sourced.evaluation.submissionState === 'SKIPPED') return base;
      return {
        ...base,
        ...(sourced.evaluation.attitude === undefined ? {} : { attitude: sourced.evaluation.attitude }),
        ...(sourced.evaluation.score === undefined ? {} : { score: sourced.evaluation.score }),
      };
    });
    const counts = { support: 0, oppose: 0, neutral: 0, skipped: 0, missing: 0 };
    const scoreDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let scoreSum = 0;
    let scoreCount = 0;
    for (const evaluation of evaluations) {
      if (evaluation.submissionState === 'MISSING') counts.missing += 1;
      else if (evaluation.submissionState === 'SKIPPED') counts.skipped += 1;
      else {
        if (evaluation.attitude === 'SUPPORT') counts.support += 1;
        else if (evaluation.attitude === 'OPPOSE') counts.oppose += 1;
        else if (evaluation.attitude === 'NEUTRAL') counts.neutral += 1;
        if (typeof evaluation.score === 'number') {
          scoreSum += evaluation.score;
          scoreCount += 1;
          scoreDistribution[evaluation.score as keyof typeof scoreDistribution] += 1;
        }
      }
    }
    return {
      candidateId: revision.candidateId,
      candidateRevisionId: revision.id,
      createdAt: revision.createdAt,
      evaluations,
      counts,
      scoreSum,
      scoreCount,
      scoreDistribution,
    };
  });
}

export function rankCandidatesBySupport(aggregates: readonly CandidateAggregate[]): CandidateAggregate[] {
  return [...aggregates].sort((left, right) => right.counts.support - left.counts.support
    || compareStable(left, right));
}

export function rankCandidatesByScore(aggregates: readonly CandidateAggregate[]): {
  ranked: CandidateAggregate[];
  withoutScores: CandidateAggregate[];
} {
  const ranked = aggregates.filter(aggregate => aggregate.scoreCount > 0).sort((left, right) =>
    right.scoreSum * left.scoreCount - left.scoreSum * right.scoreCount || compareStable(left, right));
  const withoutScores = aggregates.filter(aggregate => aggregate.scoreCount === 0).sort(compareStable);
  return { ranked, withoutScores };
}
