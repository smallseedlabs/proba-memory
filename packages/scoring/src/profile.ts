import { z } from 'zod';
import { MEMORY_CATEGORIES, type MemoryCategory } from './categories.js';

/** Per-category half-life, in days, of the recency feature and of the decay job. */
export const DEFAULT_HALF_LIVES_DAYS: Record<MemoryCategory, number> = {
  working: 1,
  episodic: 14,
  semantic: 180,
  procedural: 365,
  super: 730,
};

const nonNegative = z.number().finite().min(0);
const unit = z.number().finite().min(0).max(1);

const halfLifeShape = Object.fromEntries(MEMORY_CATEGORIES.map((c) => [c, z.number().finite().positive()])) as Record<
  MemoryCategory,
  z.ZodNumber
>;

/**
 * The tunable part of a scoring profile. Everything that changes ranking lives here, so a profile
 * is data (stored, versioned, rolled out) and the scorer stays a pure function of (features, config).
 */
export const scoringConfigSchema = z
  .object({
    /** Relative weights of the five features. Normalised by their sum, so only ratios matter. */
    weights: z
      .object({
        relevance: nonNegative,
        recency: nonNegative,
        importance: nonNegative,
        confidence: nonNegative,
        usefulness: nonNegative,
      })
      .strict()
      .refine((w) => Object.values(w).some((v) => v > 0), { message: 'at least one weight must be greater than 0' }),
    halfLifeDays: z.object(halfLifeShape).strict(),
    fusion: z
      .object({
        /** Reciprocal rank fusion constant. */
        k: z.number().int().min(1).max(1000),
        vectorWeight: nonNegative,
        ftsWeight: nonNegative,
      })
      .strict()
      .refine((f) => f.vectorWeight + f.ftsWeight > 0, { message: 'a fusion weight must be greater than 0' }),
    candidates: z
      .object({
        vectorK: z.number().int().min(1).max(500),
        ftsK: z.number().int().min(1).max(500),
        /** Vector candidates below this cosine similarity are dropped before fusion. */
        minVectorSimilarity: z.number().finite().min(-1).max(1),
        /** How many top-scored candidates go into MMR / rerank. */
        poolSize: z.number().int().min(1).max(500),
      })
      .strict(),
    mmr: z.object({ enabled: z.boolean(), lambda: unit }).strict(),
    rerank: z.object({ enabled: z.boolean(), topN: z.number().int().min(1).max(100) }).strict(),
    packing: z
      .object({
        tokenBudget: z.number().int().min(1),
        maxItemTokens: z.number().int().min(1),
      })
      .strict(),
    /** Candidates scoring below this are not returned. */
    minScore: unit,
  })
  .strict();

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

export const PROFILE_STATUSES = ['draft', 'shadow', 'canary', 'active', 'retired'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

/** Workspace id of profiles that apply to every workspace without a profile of its own. */
export const GLOBAL_PROFILE_WORKSPACE = '*';

export interface ScoringProfile {
  /** Database id (uuid); empty for a profile that is not stored yet. */
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  status: ProfileStatus;
  /** Share of requests (0..100) served by this profile while its status is `canary`. */
  canaryPercent: number;
  config: ScoringConfig;
  description: string;
  createdBy: string;
  createdAt: string;
}

/** Default profile, stored in the database as version 1 of "default" (global workspace). */
export const DEFAULT_PROFILE_NAME = 'default';

export const DEFAULT_SCORING_CONFIG_V1: ScoringConfig = {
  weights: { relevance: 0.5, recency: 0.15, importance: 0.15, confidence: 0.1, usefulness: 0.1 },
  halfLifeDays: { ...DEFAULT_HALF_LIVES_DAYS },
  fusion: { k: 60, vectorWeight: 1, ftsWeight: 1 },
  candidates: { vectorK: 50, ftsK: 50, minVectorSimilarity: 0.05, poolSize: 30 },
  mmr: { enabled: true, lambda: 0.7 },
  rerank: { enabled: false, topN: 20 },
  packing: { tokenBudget: 1500, maxItemTokens: 400 },
  minScore: 0.05,
};

export function parseScoringConfig(value: unknown): ScoringConfig {
  return scoringConfigSchema.parse(value);
}
