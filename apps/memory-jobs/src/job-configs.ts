/**
 * The rules and thresholds of the M2 jobs. They are DATA: every job reads them from the versioned `job_configs`
 * table (JobConfigStore), and a new version takes effect on the next run without a deploy. The schemas below
 * validate a version when it is published and again when a job loads it; the defaults are only the document that
 * seeds version 1 of the global config the first time a job runs (or `npm run job-config -- seed`).
 */

import { z } from 'zod';
import { M2_JOB_NAMES, MEMORY_CATEGORIES, type M2JobName } from '@smallseedlabs/proba-memory-core';

const unit = (def: number) => z.number().min(0).max(1).default(def);
const positive = (def: number) => z.number().positive().default(def);
const count = (def: number) => z.number().int().min(0).default(def);
const category = z.enum(MEMORY_CATEGORIES);
const categories = (def: (typeof MEMORY_CATEGORIES)[number][]) => z.array(category).min(1).default(def);

export const consolidateConfigSchema = z
  .object({
    /** Cosine similarity at or above which two episodic memories belong to the same cluster. */
    similarityThreshold: unit(0.8),
    /** Two memories are clustered only when they were created within this many hours of each other. */
    timeWindowHours: positive(72),
    minClusterSize: z.number().int().min(2).default(2),
    maxClusterSize: z.number().int().min(2).default(8),
    /** Memories younger than this are left alone: they may still be reinforced by the write path. */
    minAgeHours: z.number().min(0).default(1),
    maxClustersPerRun: z.number().int().min(1).default(20),
    sourceCategories: categories(['episodic']),
    summaryMaxChars: z.number().int().min(80).max(4000).default(600),
    /** The summary's confidence is the mean of the sources' plus this for each source beyond the first. */
    confidenceBonusPerExtraSource: unit(0.03),
    maxConfidence: unit(0.95),
  })
  .refine((c) => c.minClusterSize <= c.maxClusterSize, { message: 'minClusterSize must not exceed maxClusterSize', path: ['minClusterSize'] });
export type ConsolidateConfig = z.infer<typeof consolidateConfigSchema>;

const promotionRule = (def: { minEvidence: number; minConfidence: number; minAgeDays: number; minWeightedEvidence: number; minDecisiveSignals: number; minUsefulness: number }) =>
  z
    .object({
      /** Distinct observations behind the memory ("repeated"). */
      minEvidence: count(def.minEvidence),
      minConfidence: unit(def.minConfidence),
      /** Days since the memory's evidence began (its validFrom). */
      minAgeDays: z.number().min(0).default(def.minAgeDays),
      /** Evidence where approvals and rejections that agree with the memory count `decisiveWeight` times ("confirmed"). */
      minWeightedEvidence: z.number().min(0).default(def.minWeightedEvidence),
      /** Approval or rejection observations behind the memory. */
      minDecisiveSignals: count(def.minDecisiveSignals),
      minUsefulness: unit(def.minUsefulness),
    })
    .default(def);

export const promoteConfigSchema = z
  .object({
    toProcedural: promotionRule({ minEvidence: 3, minConfidence: 0.75, minAgeDays: 7, minWeightedEvidence: 4, minDecisiveSignals: 1, minUsefulness: 0 }),
    toSuper: promotionRule({ minEvidence: 6, minConfidence: 0.9, minAgeDays: 30, minWeightedEvidence: 12, minDecisiveSignals: 3, minUsefulness: 0.5 }),
    /** An approval or rejection that agrees with the memory is worth this many ordinary observations; one that disagrees subtracts as much. */
    decisiveWeight: z.number().min(1).max(20).default(3),
    /** Never promote a memory that still has an active memory contradicting it. */
    blockOnActiveContradiction: z.boolean().default(true),
    maxPromotionsPerRun: z.number().int().min(1).default(50),
  })
  .default({});
export type PromoteConfig = z.infer<typeof promoteConfigSchema>;

export const collapseConfigSchema = z.object({
  /** Cosine similarity at or above which two memories of the same category and stance say the same thing. */
  duplicateThreshold: unit(0.95),
  categories: categories(['episodic', 'semantic', 'procedural', 'super']),
  /** Each merged duplicate closes this fraction of the winner's gap to full confidence. */
  mergeConfidenceGain: unit(0.1),
  /** Each newly seen active `supports` link raises confidence by this much. */
  supportConfidenceGain: unit(0.03),
  /** Each newly seen active `contradicts` link lowers confidence by this much. */
  contradictionPenalty: unit(0.1),
  confidenceFloor: unit(0.05),
  confidenceCeiling: unit(0.97),
  neighbours: z.number().int().min(2).max(50).default(8),
  maxMergesPerRun: z.number().int().min(1).default(100),
  maxAdjustmentsPerRun: z.number().int().min(1).default(500),
});
export type CollapseConfig = z.infer<typeof collapseConfigSchema>;

export const contradictionsConfigSchema = z.object({
  /** Similarity at or above which two memories with opposite stance are about the same thing. */
  relatedThreshold: unit(0.75),
  neighbours: z.number().int().min(2).max(50).default(10),
  categories: categories(['episodic', 'semantic', 'procedural', 'super']),
  weights: z
    .object({ recency: unit(0.4), evidence: unit(0.4), source: unit(0.2) })
    .default({})
    .refine((w) => w.recency + w.evidence + w.source > 0, { message: 'at least one weight must be above zero' }),
  recencyHalfLifeDays: positive(30),
  /** Evidence strength is 1 - exp(-weightedEvidence / evidenceScale). */
  evidenceScale: positive(5),
  decisiveWeight: z.number().min(1).max(20).default(3),
  /** How much each kind of source is trusted, 0..1. Kinds not listed use `otherSourceTrust`. */
  sourceTrust: z
    .record(z.string(), unit(0))
    .default({ approval: 1, goal: 0.8, audit: 0.7, analytics: 0.7, thread: 0.6 }),
  otherSourceTrust: unit(0.4),
  /** The winner's score must beat the loser's by at least this; otherwise both stay and are linked `contradicts`. */
  decisiveMargin: unit(0.15),
  maxPairsPerRun: z.number().int().min(1).default(100),
});
export type ContradictionsConfig = z.infer<typeof contradictionsConfigSchema>;

export const reembedConfigSchema = z.object({
  /** Memories embedded per run at most (the next run continues). */
  maxPerRun: z.number().int().min(1).default(5000),
  /** Swap staged vectors to current as soon as every active memory has one. When false, an operator runs the cutover. */
  autoCutover: z.boolean().default(true),
});
export type ReembedConfig = z.infer<typeof reembedConfigSchema>;

export const usageFeedbackConfigSchema = z.object({
  /** A retrieval with no approval or rejection in its trace after this long is closed with outcome `none`. */
  outcomeWindowHours: positive(48),
  /** Usefulness moves toward the target by this fraction of the distance. */
  learningRate: unit(0.1),
  approvedTarget: unit(1),
  rejectedTarget: unit(0),
  /** A result at position p counts 1 / (1 + positionDiscount * (p - 1)). */
  positionDiscount: z.number().min(0).max(10).default(0.25),
  minChange: z.number().min(0).max(0.5).default(0.001),
  maxLogsPerRun: z.number().int().min(1).default(1000),
});
export type UsageFeedbackConfig = z.infer<typeof usageFeedbackConfigSchema>;

export const cleanupConfigSchema = z.object({
  /** Working memories not reinforced for this long expire. A memory whose validTo has passed expires at once. */
  workingTtlHours: positive(24),
  stale: z
    .object({
      categories: categories(['episodic', 'semantic']),
      maxImportance: unit(0.15),
      /** No reinforcement and no retrieval for this long. */
      minIdleDays: positive(60),
    })
    .default({}),
  maxPerRun: z.number().int().min(1).default(500),
});
export type CleanupConfig = z.infer<typeof cleanupConfigSchema>;

export interface JobConfigSpec {
  readonly name: M2JobName;
  readonly schema: z.ZodTypeAny;
}

export const JOB_CONFIG_SPECS: Record<M2JobName, JobConfigSpec> = {
  consolidate: { name: 'consolidate', schema: consolidateConfigSchema },
  promote: { name: 'promote', schema: promoteConfigSchema },
  collapse: { name: 'collapse', schema: collapseConfigSchema },
  contradictions: { name: 'contradictions', schema: contradictionsConfigSchema },
  reembed: { name: 'reembed', schema: reembedConfigSchema },
  'usage-feedback': { name: 'usage-feedback', schema: usageFeedbackConfigSchema },
  cleanup: { name: 'cleanup', schema: cleanupConfigSchema },
};

/** The documents that seed version 1 of each global config. */
export function defaultJobConfig(name: M2JobName): Record<string, unknown> {
  return JOB_CONFIG_SPECS[name].schema.parse({}) as Record<string, unknown>;
}

export const isM2JobName = (name: string): name is M2JobName => (M2_JOB_NAMES as readonly string[]).includes(name);
