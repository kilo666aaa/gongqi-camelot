import { z } from 'zod';
import { idSchema, revisionSchema, schemaVersionSchema, templateIdSchema, timestampSchema, uidSchema } from './common';

export const roomPhaseSchema = z.enum([
  'COLLECTING',
  'CANDIDATE_REVIEW',
  'EVALUATING',
  'DISCUSSING',
  'CONFIRMING',
  'COMPLETED',
]);
export const roomStatusSchema = z.enum(['ACTIVE', 'ARCHIVED', 'CLOSED', 'DELETING']);
export const currentMemberUidsSchema = z.array(uidSchema).min(1).max(6)
  .refine(uids => new Set(uids).size === uids.length, 'Duplicate current member');
export const rosterUidsSchema = z.array(uidSchema).min(2).max(6)
  .refine(uids => new Set(uids).size === uids.length, 'Duplicate roster member');

export const roomSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  title: z.string().trim().min(1).max(80),
  purpose: z.string().trim().min(1).max(500),
  templateId: templateIdSchema,
  phase: roomPhaseSchema,
  roomStatus: roomStatusSchema,
  hostUid: uidSchema,
  snapshotVersion: z.number().int().nonnegative(),
  decisionRevision: revisionSchema,
  rosterRevision: revisionSchema,
  currentCycleId: idSchema,
  currentEvaluationRoundId: idSchema.optional(),
  currentProposalId: idSchema.optional(),
}).strict();

export const roomMemberSchema = z.object({
  schemaVersion: schemaVersionSchema,
  roomId: idSchema,
  uid: uidSchema,
  role: z.enum(['HOST', 'MEMBER']),
  status: z.enum(['JOINED', 'LEFT', 'REMOVED']),
  joinedAt: timestampSchema,
  rosterRevision: revisionSchema,
}).strict();

export type RoomPhase = z.infer<typeof roomPhaseSchema>;
export type RoomStatus = z.infer<typeof roomStatusSchema>;
export type Room = z.infer<typeof roomSchema>;
export type RoomMember = z.infer<typeof roomMemberSchema>;

export function roomMemberForRoomSchema(room: Room) {
  return roomMemberSchema.superRefine((member, ctx) => {
    if (member.roomId !== room.id) {
      ctx.addIssue({ code: 'custom', message: 'Member belongs to a different room' });
    }
  });
}
