import { z } from 'zod';
import { candidateRevisionSchema } from './candidates';
import { idSchema, revisionSchema, schemaVersionSchema, timestampSchema, uidSchema } from './common';
import { rosterUidsSchema } from './room';

export const confirmationProposalSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  cycleId: idSchema,
  rosterUids: rosterUidsSchema,
  candidateRevisionSnapshot: candidateRevisionSchema,
  decisionRevision: revisionSchema,
  deadlineAt: timestampSchema,
  status: z.enum(['OPEN', 'AGREED', 'UNRESOLVED', 'INVALIDATED']),
}).strict();

export const finalResponseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  proposalId: idSchema,
  candidateRevisionId: idSchema,
  uid: uidSchema,
  choice: z.enum(['ACCEPT', 'DECLINE', 'ABSTAIN']),
  updatedAt: timestampSchema,
}).strict();

export const responseSummarySchema = z.object({
  accepted: z.number().int().nonnegative(),
  declined: z.number().int().nonnegative(),
  abstained: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
}).strict();

export const decisionRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  cycleId: idSchema,
  proposalId: idSchema.optional(),
  outcome: z.enum(['AGREED', 'UNRESOLVED']),
  candidateRevisionSnapshot: candidateRevisionSchema.optional(),
  rosterSnapshot: rosterUidsSchema,
  responseSummary: responseSummarySchema,
  unresolvedSummary: z.string().max(4000).optional(),
  createdAt: timestampSchema,
}).strict().superRefine((record, ctx) => {
  const total = record.responseSummary.accepted + record.responseSummary.declined
    + record.responseSummary.abstained + record.responseSummary.pending;
  if (total !== record.rosterSnapshot.length) {
    ctx.addIssue({ code: 'custom', message: 'Response summary must cover the frozen roster' });
  }
  if (record.outcome === 'AGREED' && (!record.proposalId || !record.candidateRevisionSnapshot)) {
    ctx.addIssue({ code: 'custom', message: 'AGREED requires its proposal and candidate revision' });
  }
  if (record.outcome === 'AGREED' && (record.responseSummary.accepted !== record.rosterSnapshot.length
    || record.responseSummary.declined !== 0 || record.responseSummary.abstained !== 0
    || record.responseSummary.pending !== 0)) {
    ctx.addIssue({ code: 'custom', message: 'AGREED requires every frozen member to ACCEPT' });
  }
});

export type ConfirmationProposal = z.infer<typeof confirmationProposalSchema>;
export type FinalResponse = z.infer<typeof finalResponseSchema>;
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

export function finalResponseForProposalSchema(proposal: ConfirmationProposal) {
  return finalResponseSchema.superRefine((response, ctx) => {
    if (response.proposalId !== proposal.id) {
      ctx.addIssue({ code: 'custom', message: 'Response belongs to a different proposal' });
    }
    if (response.candidateRevisionId !== proposal.candidateRevisionSnapshot.id) {
      ctx.addIssue({ code: 'custom', message: 'Response targets a different candidate revision' });
    }
    if (!proposal.rosterUids.includes(response.uid)) {
      ctx.addIssue({ code: 'custom', message: 'Responder is outside the frozen roster' });
    }
  });
}
