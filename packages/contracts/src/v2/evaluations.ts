import { z } from 'zod';
import { idSchema, revisionSchema, schemaVersionSchema, timestampSchema, uidSchema } from './common';
import { rosterUidsSchema } from './room';

export const evaluationRoundSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  cycleId: idSchema,
  rosterUids: rosterUidsSchema,
  rosterRevision: revisionSchema,
  targetRevisionIds: z.array(idSchema).min(1).max(10)
    .refine(ids => new Set(ids).size === ids.length, 'Duplicate target revision'),
  status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']),
  openedAt: timestampSchema,
  deadlineAt: timestampSchema.optional(),
  closedAt: timestampSchema.optional(),
  revealAt: timestampSchema.optional(),
  closeReason: z.enum(['HOST_END', 'TIMEOUT', 'MAJORITY_END']).optional(),
}).strict();

export const evaluationValueShape = {
  attitude: z.enum(['SUPPORT', 'OPPOSE', 'NEUTRAL']).optional(),
  score: z.number().int().min(1).max(5).nullable().optional(),
  reason: z.string().max(500).optional(),
  submissionState: z.enum(['EVALUATED', 'SKIPPED']),
};
const evaluationValueSchema = z.object(evaluationValueShape).strict();
type EvaluationValue = z.infer<typeof evaluationValueSchema>;

export function validateEvaluationValue(value: EvaluationValue, ctx: z.RefinementCtx): void {
  if (value.submissionState === 'SKIPPED') {
    if (value.attitude !== undefined || value.score !== undefined || value.reason !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'SKIPPED cannot contain evaluation values' });
    }
    return;
  }
  if (value.attitude === undefined && typeof value.score !== 'number') {
    ctx.addIssue({ code: 'custom', message: 'EVALUATED requires an attitude or score' });
  }
}

export const evaluationInputSchema = evaluationValueSchema.superRefine(validateEvaluationValue);
export const evaluationSchema = z.object({
  schemaVersion: schemaVersionSchema,
  roundId: idSchema,
  uid: uidSchema,
  candidateRevisionId: idSchema,
  ...evaluationValueShape,
  updatedAt: timestampSchema,
}).strict().superRefine(validateEvaluationValue);

export type EvaluationRound = z.infer<typeof evaluationRoundSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;

export function evaluationForRoundSchema(round: EvaluationRound) {
  return evaluationSchema.superRefine((evaluation, ctx) => {
    if (evaluation.roundId !== round.id) {
      ctx.addIssue({ code: 'custom', message: 'Evaluation belongs to a different round' });
    }
    if (!round.targetRevisionIds.includes(evaluation.candidateRevisionId)) {
      ctx.addIssue({ code: 'custom', message: 'Candidate revision is outside this round' });
    }
    if (!round.rosterUids.includes(evaluation.uid)) {
      ctx.addIssue({ code: 'custom', message: 'Evaluator is outside the frozen roster' });
    }
  });
}
