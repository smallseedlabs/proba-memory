import type { MemoryCategory } from './categories.js';
import type { ScoringConfig } from './profile.js';

export const MS_PER_DAY = 86_400_000;

/** Raw inputs of the scorer for one candidate. All of it is logged with the retrieval. */
export interface ScoringInput {
  /** Reciprocal-rank-fusion score of the candidate (sum over the fused lists). */
  fusedScore: number;
  category: MemoryCategory;
  /** When the memory was last created or reinforced by new evidence (not when it was read). */
  referenceTime: string | Date;
  importance: number;
  confidence: number;
  usefulness: number;
}

export interface ScoringFeatures {
  relevance: number;
  recency: number;
  importance: number;
  confidence: number;
  usefulness: number;
  /** Age in days used for recency (never negative). */
  ageDays: number;
  halfLifeDays: number;
}

export interface ScoreResult {
  score: number;
  features: ScoringFeatures;
  /** Weighted contribution of each feature; they add up to `score`. */
  components: Record<'relevance' | 'recency' | 'importance' | 'confidence' | 'usefulness', number>;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Exponential decay with a half-life: 1 at age 0, 0.5 after one half-life, 0.25 after two.
 * A negative age (clock skew, future-dated memory) counts as 0.
 */
export function halfLifeFactor(ageDays: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0) || !Number.isFinite(halfLifeDays)) throw new RangeError('halfLifeDays must be a positive number');
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export function ageInDays(referenceTime: string | Date, now: string | Date): number {
  const ref = new Date(referenceTime).getTime();
  const at = new Date(now).getTime();
  if (Number.isNaN(ref) || Number.isNaN(at)) throw new RangeError('invalid time passed to ageInDays');
  return Math.max(0, (at - ref) / MS_PER_DAY);
}

/** Largest fused score a candidate can reach: rank 1 in every list. Used to scale relevance to 0..1. */
export function maxFusedScore(fusion: ScoringConfig['fusion']): number {
  return (fusion.vectorWeight + fusion.ftsWeight) / (fusion.k + 1);
}

/** Relevance feature: the fused rank score scaled to 0..1 (1 = first in every list). */
export function relevanceFromFused(fusedScore: number, fusion: ScoringConfig['fusion']): number {
  return clamp01(fusedScore / maxFusedScore(fusion));
}

/**
 * The scorer. A pure function of its arguments: no clock, no I/O, no randomness.
 * score = sum(weight_i * feature_i) / sum(weight_i), every feature in 0..1, so the score is in 0..1.
 */
export function scoreCandidate(input: ScoringInput, config: ScoringConfig, now: string | Date): ScoreResult {
  const halfLifeDays = config.halfLifeDays[input.category];
  const ageDays = ageInDays(input.referenceTime, now);
  const features: ScoringFeatures = {
    relevance: relevanceFromFused(input.fusedScore, config.fusion),
    recency: halfLifeFactor(ageDays, halfLifeDays),
    importance: clamp01(input.importance),
    confidence: clamp01(input.confidence),
    usefulness: clamp01(input.usefulness),
    ageDays,
    halfLifeDays,
  };
  const w = config.weights;
  const total = w.relevance + w.recency + w.importance + w.confidence + w.usefulness;
  if (!(total > 0)) throw new RangeError('scoring weights must not all be zero');
  const components = {
    relevance: (w.relevance * features.relevance) / total,
    recency: (w.recency * features.recency) / total,
    importance: (w.importance * features.importance) / total,
    confidence: (w.confidence * features.confidence) / total,
    usefulness: (w.usefulness * features.usefulness) / total,
  };
  const score = clamp01(components.relevance + components.recency + components.importance + components.confidence + components.usefulness);
  return { score, features, components };
}

/**
 * Value after `elapsedDays` of decay toward `floor`: floor + (value - floor) * 0.5^(elapsed / halfLife).
 * Never goes below the floor and never increases the value. Used by the decay job.
 */
export function decayValue(value: number, elapsedDays: number, halfLifeDays: number, floor = 0): number {
  const v = clamp01(value);
  const f = Math.min(clamp01(floor), v);
  return f + (v - f) * halfLifeFactor(elapsedDays, halfLifeDays);
}
