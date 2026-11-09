import { z } from 'zod';
import { idSchema, schemaVersionSchema, timestampSchema, uidSchema } from './common';

export const suggestCandidatesInputSchema = z.object({
  roomId: idSchema,
}).strict();

export const candidateSuggestionSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4000),
  sourceIdeaIds: z.array(idSchema).min(1).max(10),
}).strict();

export const suggestCandidatesResultSchema = z.object({
  status: z.literal('suggested'),
  roomId: idSchema,
  snapshotVersion: z.number().int().nonnegative(),
  scope: z.literal('PUBLIC'),
  generatedAt: timestampSchema,
  suggestions: z.array(candidateSuggestionSchema).min(1).max(5),
}).strict();

export type SuggestCandidatesInput = z.infer<typeof suggestCandidatesInputSchema>;
export type CandidateSuggestion = z.infer<typeof candidateSuggestionSchema>;
export type SuggestCandidatesResult = z.infer<typeof suggestCandidatesResultSchema>;

export const roomAssistantActionSchema = z.enum([
  'SYNTHESIZE_DISAGREEMENT',
  'SUGGEST_ALTERNATIVES',
  'FIND_OPEN_QUESTIONS',
  'ASK',
]);

export const askRoomAssistantInputSchema = z.object({
  schemaVersion: schemaVersionSchema,
  roomId: idSchema,
  requestId: idSchema,
  action: roomAssistantActionSchema,
  question: z.string().trim().min(1).max(500).optional(),
  expectedSnapshotVersion: z.number().int().nonnegative(),
}).strict().superRefine((input, ctx) => {
  if (input.action === 'ASK' && input.question === undefined) {
    ctx.addIssue({ code: 'custom', message: 'A free-form question is required for ASK' });
  }
  if (input.action !== 'ASK' && input.question !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'Only ASK carries a free-form question' });
  }
});

export const roomAssistantMessageSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  roomId: idSchema,
  cycleId: idSchema,
  requestId: idSchema,
  actorUid: uidSchema,
  action: roomAssistantActionSchema,
  question: z.string().trim().min(1).max(500).optional(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'STALE']),
  scope: z.literal('PUBLIC'),
  contextVersion: z.number().int().nonnegative(),
  sourceIds: z.array(idSchema).max(50),
  answer: z.string().trim().min(1).max(4000).optional(),
  errorCode: z.string().regex(/^[A-Z0-9_]+$/).max(64).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  stale: z.boolean(),
}).strict().superRefine((message, ctx) => {
  if (message.status === 'SUCCEEDED' && message.answer === undefined) {
    ctx.addIssue({ code: 'custom', message: 'A successful answer requires text' });
  }
  if (message.status === 'FAILED' && message.answer !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'A failed request cannot expose an answer' });
  }
});

export const askRoomAssistantResultSchema = z.object({
  status: z.literal('applied'),
  message: roomAssistantMessageSchema,
}).strict();

export const roomAssistantMessagesInputSchema = z.object({
  roomId: idSchema,
}).strict();

export const roomAssistantMessagesResultSchema = z.object({
  status: z.literal('ok'),
  roomId: idSchema,
  messages: z.array(roomAssistantMessageSchema).max(50),
}).strict();

export type RoomAssistantAction = z.infer<typeof roomAssistantActionSchema>;
export type AskRoomAssistantInput = z.infer<typeof askRoomAssistantInputSchema>;
export type RoomAssistantMessage = z.infer<typeof roomAssistantMessageSchema>;
export type AskRoomAssistantResult = z.infer<typeof askRoomAssistantResultSchema>;
export type RoomAssistantMessagesResult = z.infer<typeof roomAssistantMessagesResultSchema>;
