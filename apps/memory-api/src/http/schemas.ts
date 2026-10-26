/**
 * Request schemas of the memory API. Every route parses its query or body through one of these:
 * unknown fields are rejected (so nobody can pass a workspaceId or any other scope), every string is
 * bounded, every list is capped. The workspace never appears here: it comes from the authenticated session.
 */

import { z } from 'zod';
import { MEMORY_CATEGORIES, MEMORY_LIST_DEFAULT_LIMIT, MEMORY_LIST_MAX_LIMIT, MEMORY_STATUSES, type MemoryFilter } from '@smallseedlabs/proba-memory-core';
import { ApiError } from './errors.js';

/** Caps of the API. Exported so docs, the portal and tests agree with the code. */
export const API_LIMITS = {
  search: { maxQueryChars: 2000, defaultLimit: 10, maxLimit: 50, maxTokenBudget: 8000 },
  list: { defaultLimit: MEMORY_LIST_DEFAULT_LIMIT, maxLimit: MEMORY_LIST_MAX_LIMIT },
  idMaxLength: 128,
  cursorMaxLength: 512,
  bodyMaxBytes: 32 * 1024,
} as const;

export const SOURCE_KINDS = ['audit', 'goal', 'approval', 'thread', 'analytics', 'other'] as const;

const isoUtc = z
  .string()
  .datetime({ message: 'must be an ISO 8601 UTC timestamp ending in Z, for example 2026-10-25T10:00:00Z' })
  .transform((v) => new Date(v).toISOString());
const idToken = z
  .string()
  .min(1)
  .max(API_LIMITS.idMaxLength)
  .regex(/^[A-Za-z0-9_.:@/-]+$/, 'letters, digits and _ . : @ / - only');
const unit = z.number().min(0, 'between 0 and 1').max(1, 'between 0 and 1');

/** Query lists are written `a,b` or by repeating the parameter. */
const listOf = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => {
    if (v === undefined) return undefined;
    const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === 'string' ? x.split(',') : [x]));
    return parts.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== '');
  }, z.array(item).min(1).max(8));

const categorySchema = z.enum(MEMORY_CATEGORIES);
const statusSchema = z.enum(MEMORY_STATUSES);
const sourceKindSchema = z.enum(SOURCE_KINDS);

/** The filter object of a search request. */
export const filterBodySchema = z
  .object({
    categories: z.array(categorySchema).min(1).max(MEMORY_CATEGORIES.length).optional(),
    /** Administrators only: viewers always get active memories. */
    statuses: z.array(statusSchema).min(1).max(MEMORY_STATUSES.length).optional(),
    minConfidence: unit.optional(),
    minImportance: unit.optional(),
    goalId: idToken.optional(),
    threadId: idToken.optional(),
    sourceKind: sourceKindSchema.optional(),
    createdFrom: isoUtc.optional(),
    createdTo: isoUtc.optional(),
  })
  .strict();

export const searchBodySchema = z
  .object({
    query: z.string().trim().min(1, 'must not be empty').max(API_LIMITS.search.maxQueryChars),
    filter: filterBodySchema.optional(),
    limit: z.number().int().min(1).max(API_LIMITS.search.maxLimit).optional(),
    tokenBudget: z.number().int().min(1).max(API_LIMITS.search.maxTokenBudget).optional(),
    rerank: z.boolean().optional(),
    /** Administrators only: return every candidate with its features. */
    includeCandidates: z.boolean().optional(),
  })
  .strict();
export type SearchBody = z.output<typeof searchBodySchema>;

const limitParam = z.coerce.number().int().min(1, 'must be at least 1').max(API_LIMITS.list.maxLimit, `at most ${API_LIMITS.list.maxLimit}`).default(API_LIMITS.list.defaultLimit);

export const listQuerySchema = z
  .object({
    category: listOf(categorySchema).optional(),
    status: listOf(statusSchema).optional(),
    minConfidence: z.coerce.number().min(0).max(1).optional(),
    minImportance: z.coerce.number().min(0).max(1).optional(),
    goalId: idToken.optional(),
    threadId: idToken.optional(),
    sourceKind: sourceKindSchema.optional(),
    createdFrom: isoUtc.optional(),
    createdTo: isoUtc.optional(),
    limit: limitParam,
    cursor: z.string().min(1).max(API_LIMITS.cursorMaxLength).optional(),
  })
  .strict();
export type ListQuery = z.output<typeof listQuerySchema>;

export const memoryParamsSchema = z.object({ id: z.string().uuid().transform((v) => v.toLowerCase()) }).strict();

export const noQuerySchema = z.object({}).strict();

/** Turn the validated filter fields into the store's MemoryFilter (dropping what is not set). */
export function toMemoryFilter(f: {
  categories?: readonly string[];
  statuses?: readonly string[];
  minConfidence?: number;
  minImportance?: number;
  goalId?: string;
  threadId?: string;
  sourceKind?: string;
  createdFrom?: string;
  createdTo?: string;
}): MemoryFilter {
  const out: MemoryFilter = {};
  if (f.categories?.length) out.categories = [...new Set(f.categories)] as MemoryFilter['categories'];
  if (f.statuses?.length) out.statuses = [...new Set(f.statuses)] as MemoryFilter['statuses'];
  if (f.minConfidence !== undefined) out.minConfidence = f.minConfidence;
  if (f.minImportance !== undefined) out.minImportance = f.minImportance;
  if (f.goalId !== undefined) out.goalId = f.goalId;
  if (f.threadId !== undefined) out.threadId = f.threadId;
  if (f.sourceKind !== undefined) out.sourceKind = f.sourceKind as MemoryFilter['sourceKind'];
  if (f.createdFrom !== undefined) out.createdFrom = f.createdFrom;
  if (f.createdTo !== undefined) out.createdTo = f.createdTo;
  return out;
}

/** Parse `input` or throw a 400 naming every problem (parameter path and message, never the value). */
export function parseWith<S extends z.ZodTypeAny>(schema: S, input: unknown, what: 'query' | 'path' | 'body' = 'query'): z.output<S> {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const label = what === 'query' ? 'query parameters' : what === 'path' ? 'path parameters' : 'request body fields';
  throw new ApiError(
    400,
    what === 'query' ? 'invalid_query' : what === 'path' ? 'invalid_path' : 'invalid_body',
    `Some ${label} are not valid.`,
    parsed.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.code === 'unrecognized_keys' ? `unknown field: ${i.keys.join(', ')}` : i.message,
    }))
  );
}
