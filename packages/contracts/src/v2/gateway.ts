import { z } from 'zod';
import { idSchema, revisionSchema, timestampSchema, uidSchema, visibilitySchema } from './common';
import { roomPhaseSchema, rosterUidsSchema } from './room';
import { roomSnapshotSchema, type RoomSnapshot } from './snapshot';
import {
  askRoomAssistantResultSchema,
  roomAssistantMessagesResultSchema,
  suggestCandidatesResultSchema,
  type AskRoomAssistantInput,
  type AskRoomAssistantResult,
  type RoomAssistantMessagesResult,
  type SuggestCandidatesInput,
  type SuggestCandidatesResult,
} from './ai';
import {
  rotateInviteCommandSchema,
  type AddCommentCommand,
  type ArchiveRoomCommand,
  type CancelReopenCommand,
  type ChangeRosterCommand,
  type CloseRoomCommand,
  type DeleteRoomCommand,
  type CloseCollectionCommand,
  type CloseEvaluationCommand,
  type CloseUnresolvedCommand,
  type CreateCandidateCommand,
  type CreateRoomCommand,
  type JoinRoomCommand,
  type OpenEvaluationCommand,
  type ProposeFinalCommand,
  type RequestReopenCommand,
  type RespondFinalCommand,
  type RetractRoundCloseVoteCommand,
  type ReviseCandidateCommand,
  type RotateInviteCommand,
  type SetRoundDeadlineCommand,
  type StartNextCycleCommand,
  type SubmitEvaluationCommand,
  type SubmitIdeaCommand,
  type SubmitIdeaSkipCommand,
  type TransferHostCommand,
  type VoteReopenCommand,
  type VoteRoundCloseCommand,
  type WithdrawCandidateCommand,
} from './commands';

export const createRoomResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  cycleId: idSchema,
  hostUid: uidSchema,
  phase: z.literal('COLLECTING'),
  roomStatus: z.literal('ACTIVE'),
  snapshotVersion: z.number().int().nonnegative(),
  decisionRevision: revisionSchema,
  rosterRevision: revisionSchema,
  createdAt: timestampSchema,
}).strict();

export const rotateInviteResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  inviteId: idSchema,
  expiresAt: timestampSchema,
  rotatedAt: timestampSchema,
}).strict();

export const joinRoomResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  cycleId: idSchema,
  uid: uidSchema,
  memberStatus: z.literal('JOINED'),
  phase: roomPhaseSchema,
  decisionRevision: revisionSchema,
  rosterRevision: revisionSchema,
  joinedAt: timestampSchema,
}).strict();

export const ideaSubmissionResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  ideaId: idSchema,
  cycleId: idSchema,
  visibility: visibilitySchema,
  skipped: z.boolean(),
  submittedAt: timestampSchema,
  snapshotVersion: z.number().int().nonnegative(),
}).strict();

export const closeCollectionResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  cycleId: idSchema,
  phase: z.literal('CANDIDATE_REVIEW'),
  submittedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  unsubmittedCount: z.number().int().nonnegative(),
  snapshotVersion: z.number().int().nonnegative(),
  decisionRevision: revisionSchema,
  rosterRevision: revisionSchema,
  closedAt: timestampSchema,
}).strict();

export const openEvaluationResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  roundId: idSchema,
  phase: z.literal('EVALUATING'),
  rosterRevision: revisionSchema,
  targetRevisionIds: z.array(idSchema).min(1).max(10),
  snapshotVersion: z.number().int().nonnegative(),
  openedAt: timestampSchema,
}).strict();

export const submitEvaluationResultSchema = z.object({
  status: z.literal('applied'),
  roundId: idSchema,
  candidateRevisionId: idSchema,
  submissionState: z.enum(['EVALUATED', 'SKIPPED']),
  updatedAt: timestampSchema,
}).strict();

export const closeEvaluationResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  roundId: idSchema,
  phase: z.literal('DISCUSSING'),
  closeReason: z.literal('HOST_END'),
  snapshotVersion: z.number().int().nonnegative(),
  closedAt: timestampSchema,
  revealAt: timestampSchema,
}).strict();

export const voteRoundCloseResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  roundId: idSchema,
  endVoteCount: z.number().int().nonnegative().max(6),
  majorityThreshold: z.number().int().positive().max(4),
  roundStatus: z.enum(['OPEN', 'CLOSED']),
  closeReason: z.literal('MAJORITY_END').optional(),
  snapshotVersion: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
}).strict();

export const retractRoundCloseVoteResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  roundId: idSchema,
  endVoteCount: z.number().int().nonnegative().max(6),
  majorityThreshold: z.number().int().positive().max(4),
  snapshotVersion: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
}).strict();

export const setRoundDeadlineResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  roundId: idSchema,
  deadlineAt: timestampSchema,
  reason: z.string().trim().min(1).max(500),
  snapshotVersion: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
}).strict();

export const addCommentResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  commentId: idSchema,
  publicationState: z.enum(['DRAFT', 'PUBLISHED']),
  snapshotVersion: z.number().int().nonnegative(),
  decisionRevision: revisionSchema,
  createdAt: timestampSchema,
  publishedAt: timestampSchema.optional(),
  updatedAt: timestampSchema,
}).strict();

export const reviseCandidateResultSchema = z.object({
  status: z.literal('applied'),
  candidateId: idSchema,
  revisionId: idSchema,
  revision: z.number().int().positive(),
  substantive: z.boolean(),
  proposalInvalidated: z.boolean(),
  phase: roomPhaseSchema,
  decisionRevision: revisionSchema,
  updatedAt: timestampSchema,
}).strict();

export const requestReopenResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  requestId: idSchema,
  roundId: idSchema,
  phase: z.literal('DISCUSSING'),
  requestStatus: z.literal('OPEN'),
  reopenVoteCount: z.literal(1),
  majorityThreshold: z.number().int().positive().max(4),
  snapshotVersion: z.number().int().nonnegative(),
  createdAt: timestampSchema,
}).strict();

export const voteReopenResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  requestId: idSchema,
  choice: z.enum(['REOPEN', 'KEEP_DISCUSSING']),
  requestStatus: z.enum(['OPEN', 'APPROVED']),
  phase: z.enum(['DISCUSSING', 'EVALUATING']),
  roundId: idSchema.optional(),
  reopenVoteCount: z.number().int().nonnegative().max(6),
  majorityThreshold: z.number().int().positive().max(4),
  snapshotVersion: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
}).strict();

export const cancelReopenResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  requestId: idSchema,
  requestStatus: z.literal('CANCELLED'),
  phase: z.literal('DISCUSSING'),
  snapshotVersion: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
}).strict();

export const proposeFinalResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  proposalId: idSchema,
  candidateRevisionId: idSchema,
  phase: z.literal('CONFIRMING'),
  rosterUids: rosterUidsSchema,
  deadlineAt: timestampSchema,
  snapshotVersion: z.number().int().nonnegative(),
  createdAt: timestampSchema,
}).strict();

export const respondFinalResultSchema = z.object({
  status: z.literal('applied'),
  proposalId: idSchema,
  candidateRevisionId: idSchema,
  choice: z.enum(['ACCEPT', 'DECLINE', 'ABSTAIN']),
  updatedAt: timestampSchema,
  proposalStatus: z.enum(['OPEN', 'AGREED']),
}).strict();

export const closeUnresolvedResultSchema = z.object({
  status: z.literal('applied'),
  proposalId: idSchema,
  outcome: z.literal('UNRESOLVED'),
  phase: z.literal('COMPLETED'),
  responseSummary: z.object({
    accepted: z.number().int().nonnegative(),
    declined: z.number().int().nonnegative(),
    abstained: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }).strict(),
  snapshotVersion: z.number().int().nonnegative(),
  resolvedAt: timestampSchema,
}).strict();

export const createCandidateResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  candidateId: idSchema,
  revisionId: idSchema,
  revision: z.literal(1),
  phase: z.enum(['CANDIDATE_REVIEW', 'DISCUSSING']),
  snapshotVersion: z.number().int().nonnegative(),
  decisionRevision: revisionSchema,
  createdAt: timestampSchema,
}).strict();

export const withdrawCandidateResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  candidateId: idSchema,
  revisionId: idSchema,
  proposalInvalidated: z.boolean(),
  phase: roomPhaseSchema,
  snapshotVersion: z.number().int().nonnegative(),
  decisionRevision: revisionSchema,
  withdrawnAt: timestampSchema,
}).strict();

export const changeRosterResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  uid: uidSchema,
  action: z.enum(['REMOVE', 'LEAVE']),
  memberStatus: z.enum(['LEFT', 'REMOVED']),
  phase: roomPhaseSchema,
  decisionRevision: revisionSchema,
  rosterRevision: revisionSchema,
  cancelledRoundId: idSchema.optional(),
  invalidatedProposalId: idSchema.optional(),
  updatedAt: timestampSchema,
}).strict();

export const roomLifecycleResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  action: z.enum(['ARCHIVE', 'CLOSE', 'DELETE']),
  roomStatus: z.enum(['ARCHIVED', 'CLOSED', 'DELETING']),
  phase: roomPhaseSchema,
  decisionRevision: revisionSchema,
  rosterRevision: revisionSchema,
  snapshotVersion: z.number().int().nonnegative(),
  revokedMemberCount: z.number().int().nonnegative().max(5),
  cancelledRoundId: idSchema.optional(),
  invalidatedProposalId: idSchema.optional(),
  updatedAt: timestampSchema,
}).strict();

export const startNextCycleResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  previousCycleId: idSchema,
  cycleId: idSchema,
  cycleNumber: z.number().int().positive(),
  phase: z.literal('COLLECTING'),
  decisionRevision: revisionSchema,
  rosterRevision: revisionSchema,
  snapshotVersion: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
}).strict();

export const transferHostResultSchema = z.object({
  status: z.literal('applied'),
  roomId: idSchema,
  hostUid: uidSchema,
  previousHostUid: uidSchema,
  phase: roomPhaseSchema,
  decisionRevision: revisionSchema,
  rosterRevision: revisionSchema,
  snapshotVersion: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
}).strict().refine(result => result.hostUid !== result.previousHostUid, {
  message: 'Host transfer must change the host',
  path: ['hostUid'],
});

const rotateInviteTransportResultSchema = rotateInviteResultSchema.extend({
  inviteToken: rotateInviteCommandSchema.shape.inviteToken,
}).strict();

export type CreateRoomResult = z.infer<typeof createRoomResultSchema>;
export type RotateInviteResult = z.infer<typeof rotateInviteTransportResultSchema>;
export type JoinRoomResult = z.infer<typeof joinRoomResultSchema>;
export type IdeaSubmissionResult = z.infer<typeof ideaSubmissionResultSchema>;
export type CloseCollectionResult = z.infer<typeof closeCollectionResultSchema>;
export type OpenEvaluationResult = z.infer<typeof openEvaluationResultSchema>;
export type SubmitEvaluationResult = z.infer<typeof submitEvaluationResultSchema>;
export type CloseEvaluationResult = z.infer<typeof closeEvaluationResultSchema>;
export type VoteRoundCloseResult = z.infer<typeof voteRoundCloseResultSchema>;
export type RetractRoundCloseVoteResult = z.infer<typeof retractRoundCloseVoteResultSchema>;
export type SetRoundDeadlineResult = z.infer<typeof setRoundDeadlineResultSchema>;
export type AddCommentResult = z.infer<typeof addCommentResultSchema>;
export type ReviseCandidateResult = z.infer<typeof reviseCandidateResultSchema>;
export type RequestReopenResult = z.infer<typeof requestReopenResultSchema>;
export type VoteReopenResult = z.infer<typeof voteReopenResultSchema>;
export type CancelReopenResult = z.infer<typeof cancelReopenResultSchema>;
export type ProposeFinalResult = z.infer<typeof proposeFinalResultSchema>;
export type RespondFinalResult = z.infer<typeof respondFinalResultSchema>;
export type CloseUnresolvedResult = z.infer<typeof closeUnresolvedResultSchema>;
export type CreateCandidateResult = z.infer<typeof createCandidateResultSchema>;
export type WithdrawCandidateResult = z.infer<typeof withdrawCandidateResultSchema>;
export type ChangeRosterResult = z.infer<typeof changeRosterResultSchema>;
export type RoomLifecycleResult = z.infer<typeof roomLifecycleResultSchema>;
export type StartNextCycleResult = z.infer<typeof startNextCycleResultSchema>;
export type TransferHostResult = z.infer<typeof transferHostResultSchema>;

export interface GatewayInputMap {
  createRoom: CreateRoomCommand;
  rotateInvite: RotateInviteCommand;
  joinRoom: JoinRoomCommand;
  submitIdea: SubmitIdeaCommand;
  submitIdeaSkip: SubmitIdeaSkipCommand;
  closeCollection: CloseCollectionCommand;
  openEvaluation: OpenEvaluationCommand;
  submitEvaluation: SubmitEvaluationCommand;
  closeEvaluation: CloseEvaluationCommand;
  voteRoundClose: VoteRoundCloseCommand;
  retractRoundCloseVote: RetractRoundCloseVoteCommand;
  setRoundDeadline: SetRoundDeadlineCommand;
  addComment: AddCommentCommand;
  reviseCandidate: ReviseCandidateCommand;
  requestReopen: RequestReopenCommand;
  voteReopen: VoteReopenCommand;
  cancelReopen: CancelReopenCommand;
  proposeFinal: ProposeFinalCommand;
  respondFinal: RespondFinalCommand;
  closeUnresolved: CloseUnresolvedCommand;
  createCandidate: CreateCandidateCommand;
  withdrawCandidate: WithdrawCandidateCommand;
  changeRoster: ChangeRosterCommand;
  archiveRoom: ArchiveRoomCommand;
  closeRoom: CloseRoomCommand;
  deleteRoom: DeleteRoomCommand;
  startNextCycle: StartNextCycleCommand;
  transferHost: TransferHostCommand;
  getSnapshot: { roomId: string };
  suggestCandidates: SuggestCandidatesInput;
  askRoomAssistant: AskRoomAssistantInput;
  getRoomAssistantMessages: { roomId: string };
}

export interface GatewayResultMap {
  createRoom: CreateRoomResult;
  rotateInvite: RotateInviteResult;
  joinRoom: JoinRoomResult;
  submitIdea: IdeaSubmissionResult;
  submitIdeaSkip: IdeaSubmissionResult;
  closeCollection: CloseCollectionResult;
  openEvaluation: OpenEvaluationResult;
  submitEvaluation: SubmitEvaluationResult;
  closeEvaluation: CloseEvaluationResult;
  voteRoundClose: VoteRoundCloseResult;
  retractRoundCloseVote: RetractRoundCloseVoteResult;
  setRoundDeadline: SetRoundDeadlineResult;
  addComment: AddCommentResult;
  reviseCandidate: ReviseCandidateResult;
  requestReopen: RequestReopenResult;
  voteReopen: VoteReopenResult;
  cancelReopen: CancelReopenResult;
  proposeFinal: ProposeFinalResult;
  respondFinal: RespondFinalResult;
  closeUnresolved: CloseUnresolvedResult;
  createCandidate: CreateCandidateResult;
  withdrawCandidate: WithdrawCandidateResult;
  changeRoster: ChangeRosterResult;
  archiveRoom: RoomLifecycleResult;
  closeRoom: RoomLifecycleResult;
  deleteRoom: RoomLifecycleResult;
  startNextCycle: StartNextCycleResult;
  transferHost: TransferHostResult;
  getSnapshot: RoomSnapshot;
  suggestCandidates: SuggestCandidatesResult;
  askRoomAssistant: AskRoomAssistantResult;
  getRoomAssistantMessages: RoomAssistantMessagesResult;
}

export type GatewayAction = keyof GatewayInputMap & keyof GatewayResultMap;

const resultSchemas: Record<GatewayAction, z.ZodType<unknown>> = {
  createRoom: createRoomResultSchema,
  rotateInvite: rotateInviteTransportResultSchema,
  joinRoom: joinRoomResultSchema,
  submitIdea: ideaSubmissionResultSchema,
  submitIdeaSkip: ideaSubmissionResultSchema,
  closeCollection: closeCollectionResultSchema,
  openEvaluation: openEvaluationResultSchema,
  submitEvaluation: submitEvaluationResultSchema,
  closeEvaluation: closeEvaluationResultSchema,
  voteRoundClose: voteRoundCloseResultSchema,
  retractRoundCloseVote: retractRoundCloseVoteResultSchema,
  setRoundDeadline: setRoundDeadlineResultSchema,
  addComment: addCommentResultSchema,
  reviseCandidate: reviseCandidateResultSchema,
  requestReopen: requestReopenResultSchema,
  voteReopen: voteReopenResultSchema,
  cancelReopen: cancelReopenResultSchema,
  proposeFinal: proposeFinalResultSchema,
  respondFinal: respondFinalResultSchema,
  closeUnresolved: closeUnresolvedResultSchema,
  createCandidate: createCandidateResultSchema,
  withdrawCandidate: withdrawCandidateResultSchema,
  changeRoster: changeRosterResultSchema,
  archiveRoom: roomLifecycleResultSchema,
  closeRoom: roomLifecycleResultSchema,
  deleteRoom: roomLifecycleResultSchema,
  startNextCycle: startNextCycleResultSchema,
  transferHost: transferHostResultSchema,
  getSnapshot: roomSnapshotSchema,
  suggestCandidates: suggestCandidatesResultSchema,
  askRoomAssistant: askRoomAssistantResultSchema,
  getRoomAssistantMessages: roomAssistantMessagesResultSchema,
};

export function parseGatewayResult<Action extends GatewayAction>(
  action: Action,
  value: unknown,
): GatewayResultMap[Action] {
  return resultSchemas[action].parse(value) as GatewayResultMap[Action];
}

