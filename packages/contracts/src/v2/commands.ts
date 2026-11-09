import { z } from 'zod';
import { idSchema, revisionSchema, schemaVersionSchema, templateIdSchema, timestampSchema, uidSchema, visibilitySchema } from './common';
import { activityTemplatePayloadSchema, generalTemplatePayloadSchema } from './candidates';
import { evaluationValueShape, validateEvaluationValue } from './evaluations';

const commandFields = {
  schemaVersion: schemaVersionSchema,
  operationId: idSchema,
  expectedDecisionRevision: revisionSchema,
};

const inviteTokenSchema = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/);

export const createRoomCommandSchema = z.object({
  schemaVersion: schemaVersionSchema,
  operationId: idSchema,
  templateId: templateIdSchema,
  title: z.string().trim().min(1).max(80),
  purpose: z.string().trim().min(1).max(500),
}).strict();

export const rotateInviteCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  inviteToken: inviteTokenSchema,
}).strict();

export const joinRoomCommandSchema = z.object({
  schemaVersion: schemaVersionSchema,
  operationId: idSchema,
  inviteToken: inviteTokenSchema,
}).strict();

export const submitIdeaCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  ideaId: idSchema,
  text: z.string().trim().min(1).max(4000),
  visibility: visibilitySchema,
}).strict();

export const submitIdeaSkipCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  ideaId: idSchema,
}).strict();

export const closeCollectionCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  expectedRosterRevision: revisionSchema,
  expectedUnsubmittedCount: z.number().int().min(0).max(6),
}).strict();

const targetRevisionIdsSchema = z.array(idSchema).min(1).max(10)
  .refine(ids => new Set(ids).size === ids.length, 'Duplicate target revision');

export const openEvaluationCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  roundId: idSchema,
  expectedRosterRevision: revisionSchema,
  targetRevisionIds: targetRevisionIdsSchema,
}).strict();

export const requestReopenCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  requestId: idSchema,
  roundId: idSchema,
  expectedRosterRevision: revisionSchema,
  targetRevisionIds: targetRevisionIdsSchema,
}).strict();

export const voteReopenCommandSchema = z.object({
  ...commandFields,
  requestId: idSchema,
  choice: z.enum(['REOPEN', 'KEEP_DISCUSSING']),
}).strict();

export const cancelReopenCommandSchema = z.object({
  ...commandFields,
  requestId: idSchema,
}).strict();

export const submitEvaluationCommandSchema = z.object({
  ...commandFields,
  roundId: idSchema,
  candidateRevisionId: idSchema,
  ...evaluationValueShape,
}).strict().superRefine(validateEvaluationValue);

export const closeEvaluationCommandSchema = z.object({
  ...commandFields,
  roundId: idSchema,
  expectedIncompleteCount: z.number().int().min(0).max(6),
}).strict();

export const voteRoundCloseCommandSchema = z.object({
  ...commandFields,
  roundId: idSchema,
}).strict();

export const retractRoundCloseVoteCommandSchema = z.object({
  ...commandFields,
  roundId: idSchema,
}).strict();

export const setRoundDeadlineCommandSchema = z.object({
  ...commandFields,
  roundId: idSchema,
  deadlineAt: timestampSchema,
  reason: z.string().trim().min(1).max(500),
}).strict();

export const addCommentCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  commentId: idSchema,
  candidateId: idSchema.optional(),
  candidateRevisionId: idSchema.optional(),
  body: z.string().trim().min(1).max(4000),
  visibility: visibilitySchema,
  publicationState: z.enum(['DRAFT', 'PUBLISHED']),
}).strict().superRefine((command, ctx) => {
  if (command.candidateRevisionId && !command.candidateId) {
    ctx.addIssue({ code: 'custom', message: 'A revision comment must identify its candidate' });
  }
});

export const proposeFinalCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  proposalId: idSchema,
  candidateRevisionId: idSchema,
  deadlineAt: timestampSchema,
}).strict();

export const respondFinalCommandSchema = z.object({
  ...commandFields,
  proposalId: idSchema,
  candidateRevisionId: idSchema,
  choice: z.enum(['ACCEPT', 'DECLINE', 'ABSTAIN']),
}).strict();

export const closeUnresolvedCommandSchema = z.object({
  ...commandFields,
  proposalId: idSchema,
}).strict();

const sourceIdeaIdsSchema = z.array(idSchema).max(50)
  .refine(ids => new Set(ids).size === ids.length, 'Duplicate source idea');
const createCandidateFields = {
  ...commandFields,
  roomId: idSchema,
  candidateId: idSchema,
  revisionId: idSchema,
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4000),
  sourceIdeaIds: sourceIdeaIdsSchema.optional().default([]),
};

export const createCandidateCommandSchema = z.discriminatedUnion('templateId', [
  z.object({
    ...createCandidateFields,
    templateId: z.literal('general'),
    templatePayload: generalTemplatePayloadSchema.default({}),
  }).strict(),
  z.object({
    ...createCandidateFields,
    templateId: z.literal('activity'),
    templatePayload: activityTemplatePayloadSchema.default({}),
  }).strict(),
]);

export const withdrawCandidateCommandSchema = z.object({
  ...commandFields,
  candidateId: idSchema,
}).strict();

const reviseCandidateFields = {
  ...commandFields,
  candidateId: idSchema,
  revisionId: idSchema,
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4000),
  sourceIdeaIds: sourceIdeaIdsSchema.optional(),
};

export const reviseCandidateCommandSchema = z.discriminatedUnion('templateId', [
  z.object({
    ...reviseCandidateFields,
    templateId: z.literal('general'),
    templatePayload: generalTemplatePayloadSchema.default({}),
  }).strict(),
  z.object({
    ...reviseCandidateFields,
    templateId: z.literal('activity'),
    templatePayload: activityTemplatePayloadSchema.default({}),
  }).strict(),
]);

export const changeRosterCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  targetUid: uidSchema,
  action: z.enum(['REMOVE', 'LEAVE']),
}).strict();

const roomLifecycleFields = {
  ...commandFields,
  roomId: idSchema,
};

export const archiveRoomCommandSchema = z.object({ ...roomLifecycleFields }).strict();
export const closeRoomCommandSchema = z.object({ ...roomLifecycleFields }).strict();
export const deleteRoomCommandSchema = z.object({ ...roomLifecycleFields }).strict();

export const startNextCycleCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  nextCycleId: idSchema,
}).strict();

export const transferHostCommandSchema = z.object({
  ...commandFields,
  roomId: idSchema,
  targetUid: uidSchema,
}).strict();

export type CreateRoomCommand = z.infer<typeof createRoomCommandSchema>;
export type RotateInviteCommand = z.infer<typeof rotateInviteCommandSchema>;
export type JoinRoomCommand = z.infer<typeof joinRoomCommandSchema>;
export type SubmitIdeaCommand = z.infer<typeof submitIdeaCommandSchema>;
export type SubmitIdeaSkipCommand = z.infer<typeof submitIdeaSkipCommandSchema>;
export type CloseCollectionCommand = z.infer<typeof closeCollectionCommandSchema>;
export type CreateCandidateCommand = z.infer<typeof createCandidateCommandSchema>;
export type WithdrawCandidateCommand = z.infer<typeof withdrawCandidateCommandSchema>;
export type OpenEvaluationCommand = z.infer<typeof openEvaluationCommandSchema>;
export type RequestReopenCommand = z.infer<typeof requestReopenCommandSchema>;
export type VoteReopenCommand = z.infer<typeof voteReopenCommandSchema>;
export type CancelReopenCommand = z.infer<typeof cancelReopenCommandSchema>;
export type SubmitEvaluationCommand = z.infer<typeof submitEvaluationCommandSchema>;
export type CloseEvaluationCommand = z.infer<typeof closeEvaluationCommandSchema>;
export type VoteRoundCloseCommand = z.infer<typeof voteRoundCloseCommandSchema>;
export type RetractRoundCloseVoteCommand = z.infer<typeof retractRoundCloseVoteCommandSchema>;
export type SetRoundDeadlineCommand = z.infer<typeof setRoundDeadlineCommandSchema>;
export type AddCommentCommand = z.infer<typeof addCommentCommandSchema>;
export type ProposeFinalCommand = z.infer<typeof proposeFinalCommandSchema>;
export type RespondFinalCommand = z.infer<typeof respondFinalCommandSchema>;
export type CloseUnresolvedCommand = z.infer<typeof closeUnresolvedCommandSchema>;
export type ReviseCandidateCommand = z.infer<typeof reviseCandidateCommandSchema>;
export type ChangeRosterCommand = z.infer<typeof changeRosterCommandSchema>;
export type ArchiveRoomCommand = z.infer<typeof archiveRoomCommandSchema>;
export type CloseRoomCommand = z.infer<typeof closeRoomCommandSchema>;
export type DeleteRoomCommand = z.infer<typeof deleteRoomCommandSchema>;
export type StartNextCycleCommand = z.infer<typeof startNextCycleCommandSchema>;
export type TransferHostCommand = z.infer<typeof transferHostCommandSchema>;
