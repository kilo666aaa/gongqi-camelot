import { z } from 'zod';

export const schemaVersionSchema = z.literal(2);
export const idSchema = z.string().trim().min(1).max(128);
export const uidSchema = idSchema;
export const timestampSchema = z.string().datetime({ offset: true });
export const revisionSchema = z.number().int().positive();
export const templateIdSchema = z.enum(['general', 'activity']);
export const visibilitySchema = z.enum(['PUBLIC', 'PRIVATE']);
