import { z } from 'zod';
import { idSchema, revisionSchema, schemaVersionSchema, timestampSchema, uidSchema } from './common';

export const generalTemplatePayloadSchema = z.object({}).strict();
export const activityTimeRangeSchema = z.object({
  startAt: timestampSchema,
  endAt: timestampSchema,
}).strict().refine(range => Date.parse(range.startAt) < Date.parse(range.endAt), 'Start must precede end');

export const activityTemplatePayloadSchema = z.object({
  budgetFen: z.number().int().min(0).max(100_000_000).optional(),
  time: activityTimeRangeSchema.optional(),
  travelMinutes: z.number().int().min(0).max(1440).optional(),
  location: z.string().trim().min(1).max(120).optional(),
  venue: z.enum(['indoor', 'outdoor']).optional(),
  activityType: z.enum(['exhibition', 'boardgame', 'outdoor', 'dining', 'other']).optional(),
}).strict();

const sourceIdeaIdsSchema = z.array(idSchema).max(50)
  .refine(ids => new Set(ids).size === ids.length, 'Duplicate source idea');
const revisionFields = {
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  candidateId: idSchema,
  revision: revisionSchema,
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4000),
  sourceIdeaIds: sourceIdeaIdsSchema,
  createdBy: uidSchema,
  createdAt: timestampSchema,
};

export const candidateRevisionSchema = z.discriminatedUnion('templateId', [
  z.object({
    ...revisionFields,
    templateId: z.literal('general'),
    templatePayload: generalTemplatePayloadSchema,
  }).strict(),
  z.object({
    ...revisionFields,
    templateId: z.literal('activity'),
    templatePayload: activityTemplatePayloadSchema,
  }).strict(),
]);

export const candidateSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  roomId: idSchema,
  currentRevisionId: idSchema,
  withdrawnAt: timestampSchema.nullable(),
  createdBy: uidSchema,
}).strict();

export type GeneralTemplatePayload = z.infer<typeof generalTemplatePayloadSchema>;
export type ActivityTemplatePayload = z.infer<typeof activityTemplatePayloadSchema>;
export type CandidateRevision = z.infer<typeof candidateRevisionSchema>;
export type Candidate = z.infer<typeof candidateSchema>;

export function candidateRevisionForCandidateSchema(candidate: Candidate) {
  return candidateRevisionSchema.superRefine((revision, ctx) => {
    if (revision.candidateId !== candidate.id || revision.id !== candidate.currentRevisionId) {
      ctx.addIssue({ code: 'custom', message: 'Revision is not the candidate current revision' });
    }
  });
}
