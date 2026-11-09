import {
  candidateRevisionSchema,
  confirmationProposalSchema,
  evaluationRoundSchema,
  evaluationSchema,
  finalResponseSchema,
  respondFinalCommandSchema,
  type CandidateRevision,
  type ConfirmationProposal,
  type Evaluation,
  type EvaluationRound,
  type FinalResponse,
  type RespondFinalCommand,
} from '@gongqi/contracts/v2';

export const t0 = '2026-11-03T00:00:00Z';
export const t1 = '2026-11-03T01:00:00Z';
export const t2 = '2026-11-03T02:00:00Z';
export const t3 = '2026-11-03T03:00:00Z';
export const t4 = '2026-11-03T04:00:00Z';

export function makeRevision(candidateId = 'A', revision = 1, createdAt = t0): CandidateRevision {
  return candidateRevisionSchema.parse({
    schemaVersion: 2,
    id: `${candidateId.toLowerCase()}-r${revision}`,
    candidateId,
    revision,
    title: `方案 ${candidateId}`,
    body: `方案 ${candidateId} 的完整内容`,
    templateId: 'general',
    templatePayload: {},
    sourceIdeaIds: [],
    createdBy: 'alice',
    createdAt,
  });
}

interface RoundOptions {
  id: string;
  rosterUids?: readonly string[];
  targetRevisionIds?: readonly string[];
  status?: EvaluationRound['status'];
  openedAt?: string;
  deadlineAt?: string;
  closedAt?: string;
  revealAt?: string;
  closeReason?: EvaluationRound['closeReason'];
}

export function makeRound(options: RoundOptions): EvaluationRound {
  return evaluationRoundSchema.parse({
    schemaVersion: 2,
    id: options.id,
    cycleId: 'cycle-1',
    rosterUids: options.rosterUids ?? ['alice', 'bob'],
    rosterRevision: 1,
    targetRevisionIds: options.targetRevisionIds ?? ['a-r1'],
    status: options.status ?? 'OPEN',
    openedAt: options.openedAt ?? t0,
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
    ...(options.closedAt === undefined ? {} : { closedAt: options.closedAt }),
    ...(options.revealAt === undefined ? {} : { revealAt: options.revealAt }),
    ...(options.closeReason === undefined ? {} : { closeReason: options.closeReason }),
  });
}

interface EvaluationOptions {
  roundId: string;
  uid: string;
  candidateRevisionId: string;
  attitude?: 'SUPPORT' | 'OPPOSE' | 'NEUTRAL';
  score?: number | null;
  submissionState?: 'EVALUATED' | 'SKIPPED';
  updatedAt?: string;
}

export function makeEvaluation(options: EvaluationOptions): Evaluation {
  const submissionState = options.submissionState ?? 'EVALUATED';
  return evaluationSchema.parse({
    schemaVersion: 2,
    roundId: options.roundId,
    uid: options.uid,
    candidateRevisionId: options.candidateRevisionId,
    submissionState,
    ...(submissionState === 'EVALUATED' ? { attitude: options.attitude ?? 'SUPPORT' } : {}),
    ...(submissionState === 'EVALUATED' ? { score: options.score ?? null } : {}),
    updatedAt: options.updatedAt ?? t1,
  });
}

interface ProposalOptions {
  id?: string;
  rosterUids?: readonly string[];
  revision?: CandidateRevision;
  decisionRevision?: number;
  deadlineAt?: string;
  status?: ConfirmationProposal['status'];
}

export function makeProposal(options: ProposalOptions = {}): ConfirmationProposal {
  return confirmationProposalSchema.parse({
    schemaVersion: 2,
    id: options.id ?? 'proposal-1',
    cycleId: 'cycle-1',
    rosterUids: options.rosterUids ?? ['alice', 'bob'],
    candidateRevisionSnapshot: options.revision ?? makeRevision(),
    decisionRevision: options.decisionRevision ?? 1,
    deadlineAt: options.deadlineAt ?? t4,
    status: options.status ?? 'OPEN',
  });
}

export function makeResponse(
  proposal: ConfirmationProposal,
  uid: string,
  choice: FinalResponse['choice'] = 'ACCEPT',
  updatedAt = t1,
  candidateRevisionId = proposal.candidateRevisionSnapshot.id,
): FinalResponse {
  return finalResponseSchema.parse({
    schemaVersion: 2,
    proposalId: proposal.id,
    candidateRevisionId,
    uid,
    choice,
    updatedAt,
  });
}

export function makeResponseCommand(
  proposal: ConfirmationProposal,
  candidateRevisionId = proposal.candidateRevisionSnapshot.id,
  expectedDecisionRevision = proposal.decisionRevision,
): RespondFinalCommand {
  return respondFinalCommandSchema.parse({
    schemaVersion: 2,
    operationId: 'operation-1',
    expectedDecisionRevision,
    proposalId: proposal.id,
    candidateRevisionId,
    choice: 'ACCEPT',
  });
}
