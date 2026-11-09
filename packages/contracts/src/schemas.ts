import { z } from 'zod';

export const activityTypeSchema = z.enum(['exhibition','boardgame','outdoor','dining','other']);
export const visibilitySchema = z.enum(['public','computeOnly']);
export const timestampSchema = z.string().datetime({offset:true});
export const timeRangeSchema = z.object({startAt:timestampSchema,endAt:timestampSchema}).strict()
  .refine(range => Date.parse(range.startAt) < Date.parse(range.endAt), 'Start must precede end');
const fenSchema = z.number().int().min(0).max(100_000_000);
const minutesSchema = z.number().int().min(0).max(1440);

function limitSchema<T extends z.ZodType>(value: T) {
  return z.union([
    z.object({kind:z.literal('none')}).strict(),
    z.object({kind:z.literal('value'),value,visibility:visibilitySchema}).strict(),
  ]);
}

export const conditionsSchema = z.object({
  budgetFen:limitSchema(fenSchema),
  available:limitSchema(z.array(timeRangeSchema).min(1).max(10)),
  travelMinutes:limitSchema(minutesSchema),
  venue:limitSchema(z.enum(['indoor','outdoor'])),
  preferredTypes:z.array(activityTypeSchema).max(5)
    .refine(types => new Set(types).size === types.length, 'Duplicate preferences'),
}).strict();

const idSchema = z.string().min(1).max(128);
export const candidateSchema = z.object({
  id:idSchema,roomId:idSchema,roundId:idSchema,
  title:z.string().trim().min(1).max(40),
  time:timeRangeSchema.nullable(),estimatedCostFen:fenSchema.nullable(),
  location:z.string().trim().min(1).max(120).nullable(),
  venue:z.enum(['indoor','outdoor']).nullable(),activityType:activityTypeSchema.nullable(),
  note:z.string().max(500),
  sourceUrl:z.string().max(500).url().refine(url => /^https?:\/\//i.test(url), 'Only HTTP(S) URLs').nullable(),
  createdBy:idSchema,createdAt:timestampSchema,updatedAt:timestampSchema,
  contentRevision:z.number().int().positive(),destinationRevision:z.number().int().positive(),
  withdrawn:z.boolean(),
}).strict();

export const travelEstimateSchema = z.object({
  uid:idSchema,candidateId:idSchema,destinationRevision:z.number().int().positive(),
  minutes:minutesSchema,updatedAt:timestampSchema,
}).strict();

export type Conditions = z.infer<typeof conditionsSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type TravelEstimate = z.infer<typeof travelEstimateSchema>;
export type TimeRange = z.infer<typeof timeRangeSchema>;
export type Visibility = z.infer<typeof visibilitySchema>;
export type RuleResult = 'PASS'|'FAIL'|'UNKNOWN';
export type RoomStatus = 'ACTIVE'|'ARCHIVED'|'CLOSED'|'DELETING';
export type Phase = 'OPEN'|'CONFIRMING'|'AGREED';
