import { z } from 'zod';
import { idSchema, schemaVersionSchema, timestampSchema, uidSchema, visibilitySchema } from './common';

export const ideaSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  cycleId: idSchema,
  authorUid: uidSchema,
  text: z.string().max(4000),
  visibility: visibilitySchema,
  submittedAt: timestampSchema,
  skipped: z.boolean(),
}).strict().superRefine((idea, ctx) => {
  if (idea.skipped && idea.text !== '') {
    ctx.addIssue({ code: 'custom', message: 'Skipped ideas cannot contain text' });
  }
  if (!idea.skipped && idea.text.trim().length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Submitted ideas require non-blank text' });
  }
});

export type Idea = z.infer<typeof ideaSchema>;
