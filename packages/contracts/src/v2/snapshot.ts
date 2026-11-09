import { z } from 'zod';
import { candidateRevisionSchema, candidateSchema } from './candidates';
import { idSchema, revisionSchema, schemaVersionSchema, templateIdSchema, timestampSchema, uidSchema } from './common';
import { confirmationProposalSchema, decisionRecordSchema, finalResponseSchema, responseSummarySchema } from './confirmation';
import { evaluationRoundSchema, evaluationSchema } from './evaluations';
import { ideaSchema } from './ideas';
import { currentMemberUidsSchema, roomPhaseSchema, roomStatusSchema } from './room';

export const commentSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  cycleId: idSchema,
  candidateId: idSchema.optional(),
  candidateRevisionId: idSchema.optional(),
  authorUid: uidSchema,
  body: z.string().trim().min(1).max(4000),
  visibility: z.enum(['PUBLIC', 'PRIVATE']),
  publicationState: z.enum(['DRAFT', 'PUBLISHED']),
  createdAt: timestampSchema,
  publishedAt: timestampSchema.optional(),
}).strict().superRefine((comment, ctx) => {
  if (comment.candidateRevisionId && !comment.candidateId) {
    ctx.addIssue({ code: 'custom', message: 'A revision comment must identify its candidate' });
  }
  if (comment.publicationState === 'DRAFT' && comment.publishedAt) {
    ctx.addIssue({ code: 'custom', message: 'Draft comments cannot have a publication time' });
  }
  if (comment.publicationState === 'PUBLISHED' && !comment.publishedAt) {
    ctx.addIssue({ code: 'custom', message: 'Published comments require a publication time' });
  }
});

// Shared allows phase/roster/public candidates/safe events/counts/revealed round IDs only.
// It forbids raw rows, tokens, PRIVATE/computeOnly values and unrevealed evaluations.
// Mine allows only the authenticated member's drafts, ideas, evaluations and final responses.
export const phasePermissionsSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('COLLECTING'), canSubmitIdea: z.boolean(), canManageRoom: z.boolean() }).strict(),
  z.object({ phase: z.literal('CANDIDATE_REVIEW'), canEditCandidates: z.boolean(), canOpenEvaluation: z.boolean() }).strict(),
  z.object({ phase: z.literal('EVALUATING'), canEvaluate: z.boolean(), canVoteRoundClose: z.boolean() }).strict(),
  z.object({ phase: z.literal('DISCUSSING'), canEditCandidates: z.boolean(), canProposeFinal: z.boolean() }).strict(),
  z.object({ phase: z.literal('CONFIRMING'), canRespondFinal: z.boolean(), canManageRoom: z.boolean() }).strict(),
  z.object({ phase: z.literal('COMPLETED'), canStartNextCycle: z.boolean() }).strict(),
]);

export const activeReopenSchema = z.object({
  requestId: idSchema,
  roundId: idSchema,
  requestedBy: uidSchema,
  targetRevisionIds: z.array(idSchema).min(1).max(10),
  reopenVoteCount: z.number().int().nonnegative().max(6),
  majorityThreshold: z.number().int().positive().max(4),
}).strict();

export const sharedRoomSnapshotSchema = z.object({
  roomId: idSchema,
  title: z.string().trim().min(1).max(80),
  purpose: z.string().trim().min(1).max(500),
  templateId: templateIdSchema,
  hostUid: uidSchema,
  currentCycleId: idSchema,
  decisionRevision: revisionSchema,
  rosterRevision: revisionSchema,
  phase: roomPhaseSchema,
  roomStatus: roomStatusSchema,
  memberUids: currentMemberUidsSchema,
  candidates: z.array(candidateSchema),
  currentRevisions: z.array(candidateRevisionSchema),
  publicIdeas: z.array(ideaSchema),
  comments: z.array(commentSchema),
  activeEvaluationRound: evaluationRoundSchema.nullable().optional(),
  activeRoundClose: z.object({
    roundId: idSchema,
    endVoteCount: z.number().int().nonnegative().max(6),
    majorityThreshold: z.number().int().positive().max(4),
  }).strict().nullable().optional(),
  activeReopen: activeReopenSchema.nullable().optional(),
  revealedEvaluationRoundIds: z.array(idSchema),
  revealedEvaluations: z.array(evaluationSchema),
  finalResponseSummary: responseSummarySchema.nullable().optional(),
  decisionRecords: z.array(decisionRecordSchema).default([]),
  progress: z.object({
    ideaSubmittedCount: z.number().int().nonnegative(),
    ideaSkippedCount: z.number().int().nonnegative(),
    evaluationSubmittedCount: z.number().int().nonnegative(),
    evaluationCompletedCount: z.number().int().nonnegative(),
  }).strict(),
  events: z.array(z.object({
    id: idSchema,
    type: z.enum([
      'ROUND_CLOSED',
      'ROUND_DEADLINE_CHANGED',
      'CANDIDATE_REVISION_CREATED',
      'CANDIDATE_WITHDRAWN',
      'PROPOSAL_INVALIDATED',
      'MEMBER_CHANGED',
      'INVITE_ROTATED',
      'REOPEN_REQUESTED',
      'REOPEN_OPENED',
      'REOPEN_CANCELLED',
      'ROOM_ARCHIVED',
      'ROOM_CLOSED',
      'ROOM_DELETE_REQUESTED',
      'CYCLE_STARTED',
      'HOST_TRANSFERRED',
    ]),
    createdAt: timestampSchema,
    roundId: idSchema.optional(),
    requestId: idSchema.optional(),
    closeReason: z.enum(['HOST_END', 'TIMEOUT', 'MAJORITY_END']).optional(),
    deadlineAt: timestampSchema.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  }).strict()),
}).strict().superRefine((shared, ctx) => {
  if (shared.phase === 'COLLECTING' && shared.publicIdeas.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'Public ideas remain hidden during collection' });
  }
  if (shared.publicIdeas.some(idea => idea.visibility !== 'PUBLIC' || idea.skipped)) {
    ctx.addIssue({ code: 'custom', message: 'Shared ideas must be public and non-skipped' });
  }
  if (shared.comments.some(comment => comment.visibility !== 'PUBLIC' || comment.publicationState !== 'PUBLISHED' || !comment.publishedAt)) {
    ctx.addIssue({ code: 'custom', message: 'Shared comments must be published public comments' });
  }
  if (shared.revealedEvaluations.some(evaluation => !shared.revealedEvaluationRoundIds.includes(evaluation.roundId))) {
    ctx.addIssue({ code: 'custom', message: 'Shared evaluations must belong to revealed rounds' });
  }
  if (shared.phase === 'EVALUATING' && shared.activeEvaluationRound?.status !== 'OPEN') {
    ctx.addIssue({ code: 'custom', message: 'Evaluating rooms require an open active round' });
  }
  if (shared.phase !== 'EVALUATING' && shared.activeEvaluationRound != null) {
    ctx.addIssue({ code: 'custom', message: 'Only evaluating rooms expose an active round' });
  }
  if (shared.activeReopen != null && shared.phase !== 'DISCUSSING') {
    ctx.addIssue({ code: 'custom', message: 'Only discussing rooms expose an active reopen request' });
  }
  if (shared.activeReopen != null && shared.activeReopen.reopenVoteCount > shared.memberUids.length) {
    ctx.addIssue({ code: 'custom', message: 'Reopen votes exceed the current roster' });
  }
});

export const mineRoomSnapshotSchema = z.object({
  uid: uidSchema,
  draftIdea: z.string().max(4000).optional(),
  ideas: z.array(ideaSchema),
  comments: z.array(commentSchema),
  evaluations: z.array(evaluationSchema),
  roundCloseVote: z.object({
    roundId: idSchema,
    choice: z.literal('END'),
  }).strict().optional(),
  reopenVote: z.object({
    requestId: idSchema,
    choice: z.enum(['REOPEN', 'KEEP_DISCUSSING']),
  }).strict().optional(),
  finalResponses: z.array(finalResponseSchema),
  activeProposal: confirmationProposalSchema.optional(),
  permissions: phasePermissionsSchema,
}).strict();

export const roomSnapshotSchema = z.object({
  schemaVersion: schemaVersionSchema,
  version: z.number().int().nonnegative(),
  snapshotAt: timestampSchema,
  shared: sharedRoomSnapshotSchema,
  mine: mineRoomSnapshotSchema,
}).strict();

export type SharedRoomSnapshot = z.infer<typeof sharedRoomSnapshotSchema>;
export type MineRoomSnapshot = z.infer<typeof mineRoomSnapshotSchema>;
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;

export function roomSnapshotForMemberSchema(uid: string) {
  return roomSnapshotSchema.superRefine((snapshot, ctx) => {
    if (snapshot.mine.uid !== uid) {
      ctx.addIssue({ code: 'custom', message: 'Snapshot belongs to a different member' });
    }
    if (snapshot.mine.ideas.some(idea => idea.authorUid !== uid)) {
      ctx.addIssue({ code: 'custom', message: 'Mine contains another member idea' });
    }
    if (snapshot.mine.comments.some(comment => comment.authorUid !== uid)) {
      ctx.addIssue({ code: 'custom', message: 'Mine contains another member comment' });
    }
    if (snapshot.mine.evaluations.some(evaluation => evaluation.uid !== uid)) {
      ctx.addIssue({ code: 'custom', message: 'Mine contains another member evaluation' });
    }
    if (snapshot.mine.finalResponses.some(response => response.uid !== uid)) {
      ctx.addIssue({ code: 'custom', message: 'Mine contains another member final response' });
    }
    if (snapshot.shared.phase !== snapshot.mine.permissions.phase) {
      ctx.addIssue({ code: 'custom', message: 'Permissions do not match the shared phase' });
    }
  });
}
