import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HALF_LIVES_DAYS,
  DEFAULT_PROFILE_NAME,
  DEFAULT_SCORING_CONFIG_V1,
  MEMORY_CATEGORIES,
  ageInDays,
  cosineSimilarity,
  decayValue,
  halfLifeFactor,
  isMemoryCategory,
  jaccardSimilarity,
  maxFusedScore,
  mmrSelect,
  packByTokenBudget,
  parseScoringConfig,
  reciprocalRankFusion,
  relevanceFromFused,
  rolloutBucket,
  scoreCandidate,
  selectProfiles,
  type ScoringConfig,
  type ScoringProfile,
} from './index.js';

const NOW = '2026-10-26T12:00:00.000Z';
const daysAgo = (n: number): string => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const config = (patch: Partial<ScoringConfig> = {}): ScoringConfig => ({ ...structuredClone(DEFAULT_SCORING_CONFIG_V1), ...patch });
const best = { fusedScore: maxFusedScore(DEFAULT_SCORING_CONFIG_V1.fusion), category: 'semantic' as const, referenceTime: NOW, importance: 1, confidence: 1, usefulness: 1 };

describe('categories and defaults', () => {
  it('lists the five categories and recognises them', () => {
    expect([...MEMORY_CATEGORIES]).toEqual(['working', 'episodic', 'semantic', 'procedural', 'super']);
    expect(isMemoryCategory('semantic')).toBe(true);
    expect(isMemoryCategory('Semantic')).toBe(false);
    expect(isMemoryCategory(7)).toBe(false);
  });

  it('has one half-life per category, growing from working to super', () => {
    expect(DEFAULT_HALF_LIVES_DAYS).toEqual({ working: 1, episodic: 14, semantic: 180, procedural: 365, super: 730 });
    expect(DEFAULT_PROFILE_NAME).toBe('default');
  });

  it('the default configuration is valid', () => {
    expect(parseScoringConfig(DEFAULT_SCORING_CONFIG_V1)).toEqual(DEFAULT_SCORING_CONFIG_V1);
  });
});

describe('parseScoringConfig', () => {
  const bad = (mutate: (c: any) => void): unknown => {
    const c = structuredClone(DEFAULT_SCORING_CONFIG_V1) as any;
    mutate(c);
    return c;
  };
  it.each([
    ['negative weight', (c: any) => (c.weights.recency = -1)],
    ['all weights zero', (c: any) => (c.weights = { relevance: 0, recency: 0, importance: 0, confidence: 0, usefulness: 0 })],
    ['non-positive half-life', (c: any) => (c.halfLifeDays.working = 0)],
    ['missing category half-life', (c: any) => delete c.halfLifeDays.super],
    ['unknown field', (c: any) => (c.extra = 1)],
    ['unknown weight', (c: any) => (c.weights.novelty = 1)],
    ['fusion k below 1', (c: any) => (c.fusion.k = 0)],
    ['both fusion weights zero', (c: any) => (c.fusion = { k: 60, vectorWeight: 0, ftsWeight: 0 })],
    ['mmr lambda above 1', (c: any) => (c.mmr.lambda = 1.5)],
    ['minScore above 1', (c: any) => (c.minScore = 2)],
    ['non-finite weight', (c: any) => (c.weights.relevance = Infinity)],
    ['pool size zero', (c: any) => (c.candidates.poolSize = 0)],
    ['token budget zero', (c: any) => (c.packing.tokenBudget = 0)],
  ])('rejects %s', (_name, mutate) => {
    expect(() => parseScoringConfig(bad(mutate))).toThrow();
  });
});

describe('half-life and age', () => {
  it('halves every half-life', () => {
    expect(halfLifeFactor(0, 14)).toBe(1);
    expect(halfLifeFactor(14, 14)).toBeCloseTo(0.5, 12);
    expect(halfLifeFactor(28, 14)).toBeCloseTo(0.25, 12);
    expect(halfLifeFactor(7, 14)).toBeCloseTo(Math.SQRT1_2, 12);
  });
  it('counts negative, missing or non-finite ages as brand new, and refuses a bad half-life', () => {
    expect(halfLifeFactor(-3, 14)).toBe(1);
    expect(halfLifeFactor(Number.NaN, 14)).toBe(1);
    for (const h of [0, -1, Number.NaN, Infinity]) expect(() => halfLifeFactor(1, h)).toThrow(RangeError);
  });
  it('measures age in days, never negative, and refuses invalid dates', () => {
    expect(ageInDays(daysAgo(3), NOW)).toBeCloseTo(3, 9);
    expect(ageInDays(new Date(Date.parse(NOW) + 1000), NOW)).toBe(0);
    expect(() => ageInDays('nope', NOW)).toThrow(RangeError);
  });
});

describe('scoreCandidate', () => {
  it('scores 1 for a perfect, brand-new candidate and stays within 0..1', () => {
    const r = scoreCandidate(best, DEFAULT_SCORING_CONFIG_V1, NOW);
    expect(r.score).toBeCloseTo(1, 12);
    const worst = scoreCandidate({ ...best, fusedScore: 0, importance: 0, confidence: 0, usefulness: 0, referenceTime: daysAgo(100_000) }, DEFAULT_SCORING_CONFIG_V1, NOW);
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThan(0.001);
  });

  it('the components add up to the score and follow the weights', () => {
    const r = scoreCandidate({ ...best, fusedScore: best.fusedScore / 2, importance: 0.4, confidence: 0.6, usefulness: 0.2, referenceTime: daysAgo(180) }, DEFAULT_SCORING_CONFIG_V1, NOW);
    expect(Object.values(r.components).reduce((a, b) => a + b, 0)).toBeCloseTo(r.score, 12);
    expect(r.features).toMatchObject({ relevance: 0.5, importance: 0.4, confidence: 0.6, usefulness: 0.2, halfLifeDays: 180 });
    expect(r.features.recency).toBeCloseTo(0.5, 9);
    expect(r.components.relevance).toBeCloseTo(0.5 * 0.5, 12);
  });

  it('only the ratio of the weights matters', () => {
    const a = config({ weights: { relevance: 1, recency: 1, importance: 1, confidence: 1, usefulness: 1 } });
    const b = config({ weights: { relevance: 10, recency: 10, importance: 10, confidence: 10, usefulness: 10 } });
    const input = { ...best, fusedScore: best.fusedScore / 3, importance: 0.3 };
    expect(scoreCandidate(input, a, NOW).score).toBeCloseTo(scoreCandidate(input, b, NOW).score, 12);
  });

  it('a zero weight switches a feature off', () => {
    const onlyRelevance = config({ weights: { relevance: 1, recency: 0, importance: 0, confidence: 0, usefulness: 0 } });
    const low = scoreCandidate({ ...best, importance: 0, confidence: 0, referenceTime: daysAgo(5000) }, onlyRelevance, NOW);
    expect(low.score).toBeCloseTo(1, 12);
  });

  it('older memories of the same category score lower; slower categories age slower', () => {
    const at = (category: 'working' | 'semantic', age: number) => scoreCandidate({ ...best, category, referenceTime: daysAgo(age) }, DEFAULT_SCORING_CONFIG_V1, NOW).features.recency;
    expect(at('semantic', 10)).toBeGreaterThan(at('semantic', 100));
    expect(at('working', 10)).toBeLessThan(at('semantic', 10));
  });

  it('clamps out-of-range and non-finite inputs instead of propagating them', () => {
    const r = scoreCandidate({ ...best, importance: 5, confidence: -2, usefulness: Number.NaN }, DEFAULT_SCORING_CONFIG_V1, NOW);
    expect(r.features).toMatchObject({ importance: 1, confidence: 0, usefulness: 0 });
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it('is deterministic', () => {
    const input = { ...best, fusedScore: 0.01, referenceTime: daysAgo(12) };
    expect(scoreCandidate(input, DEFAULT_SCORING_CONFIG_V1, NOW)).toEqual(scoreCandidate(input, DEFAULT_SCORING_CONFIG_V1, NOW));
  });

  it('relevance is the fused score scaled by the best possible one', () => {
    const f = DEFAULT_SCORING_CONFIG_V1.fusion;
    expect(maxFusedScore(f)).toBeCloseTo(2 / 61, 12);
    expect(relevanceFromFused(maxFusedScore(f), f)).toBeCloseTo(1, 12);
    expect(relevanceFromFused(0, f)).toBe(0);
    expect(relevanceFromFused(1, f)).toBe(1);
  });
});

describe('decayValue', () => {
  it('moves toward the floor by half each half-life and never past it', () => {
    expect(decayValue(0.9, 0, 10, 0.1)).toBeCloseTo(0.9, 12);
    expect(decayValue(0.9, 10, 10, 0.1)).toBeCloseTo(0.5, 12);
    expect(decayValue(0.9, 1e6, 10, 0.1)).toBeCloseTo(0.1, 9);
  });
  it('never raises a value, including one below the floor', () => {
    expect(decayValue(0.05, 10, 10, 0.1)).toBeCloseTo(0.05, 12);
    expect(decayValue(0.5, -5, 10, 0)).toBeCloseTo(0.5, 12);
  });
});

describe('reciprocalRankFusion', () => {
  it('sums weight/(k+rank) over the lists an id appears in', () => {
    const fused = reciprocalRankFusion(
      [
        { name: 'vector', weight: 1, ids: ['a', 'b', 'c'] },
        { name: 'fts', weight: 1, ids: ['b', 'a'] },
      ],
      60
    );
    expect(fused.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused[0].ranks).toEqual({ vector: 1, fts: 2 });
    expect(fused[2].ranks).toEqual({ vector: 3 });
  });
  it('honours list weights', () => {
    const fused = reciprocalRankFusion(
      [
        { name: 'vector', weight: 1, ids: ['a'] },
        { name: 'fts', weight: 3, ids: ['b'] },
      ],
      60
    );
    expect(fused.map((f) => f.id)).toEqual(['b', 'a']);
  });
  it('counts duplicates once, skips empty lists, and breaks ties deterministically', () => {
    const fused = reciprocalRankFusion(
      [
        { name: 'x', weight: 1, ids: ['b', 'b', 'a'] },
        { name: 'empty', weight: 1, ids: [] },
      ],
      60
    );
    expect(fused.map((f) => [f.id, f.ranks.x])).toEqual([['b', 1], ['a', 2]]);
    const tied = reciprocalRankFusion([{ name: 'x', weight: 1, ids: ['z'] }, { name: 'y', weight: 1, ids: ['a'] }], 60);
    expect(tied.map((f) => f.id)).toEqual(['a', 'z']);
  });
  it('rejects a bad k or a negative weight, and handles no lists', () => {
    expect(() => reciprocalRankFusion([], 0)).toThrow(RangeError);
    expect(() => reciprocalRankFusion([{ name: 'x', weight: -1, ids: ['a'] }], 60)).toThrow(RangeError);
    expect(reciprocalRankFusion([], 60)).toEqual([]);
  });
});

describe('mmrSelect', () => {
  const items = [
    { id: 'a', score: 0.9 },
    { id: 'a2', score: 0.88 },
    { id: 'b', score: 0.6 },
    { id: 'c', score: 0.5 },
  ];
  const sim = (x: { id: string }, y: { id: string }): number => (x.id.startsWith('a') && y.id.startsWith('a') ? 0.95 : 0.1);

  it('lambda 1 keeps the score order', () => {
    expect(mmrSelect(items, { lambda: 1, limit: 4, similarity: sim }).map((p) => p.item.id)).toEqual(['a', 'a2', 'b', 'c']);
  });
  it('a lower lambda pushes a near-duplicate down behind a different item', () => {
    const picks = mmrSelect(items, { lambda: 0.5, limit: 3, similarity: sim });
    expect(picks.map((p) => p.item.id)).toEqual(['a', 'b', 'c']);
    expect(picks[0].maxSimilarity).toBe(0);
    expect(picks[1].maxSimilarity).toBeCloseTo(0.1, 12);
  });
  it('respects the limit, handles empty input, is deterministic on ties, and rejects a bad lambda', () => {
    expect(mmrSelect(items, { lambda: 0.7, limit: 2, similarity: sim })).toHaveLength(2);
    expect(mmrSelect([], { lambda: 0.7, limit: 5, similarity: sim })).toEqual([]);
    const tied = [{ id: 'x', score: 0.5 }, { id: 'y', score: 0.5 }];
    expect(mmrSelect(tied, { lambda: 1, limit: 2, similarity: () => 0 }).map((p) => p.item.id)).toEqual(['x', 'y']);
    expect(() => mmrSelect(items, { lambda: 1.2, limit: 2, similarity: sim })).toThrow(RangeError);
  });
  it('clamps a misbehaving similarity function into 0..1', () => {
    const picks = mmrSelect(items, { lambda: 0.5, limit: 2, similarity: () => 7 });
    expect(picks[1].maxSimilarity).toBe(1);
  });
});

describe('similarity helpers', () => {
  it('cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 12);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it('jaccard similarity over words, case-insensitive, unicode aware', () => {
    expect(jaccardSimilarity('Short headlines work', 'short HEADLINES')).toBeCloseTo(2 / 3, 12);
    expect(jaccardSimilarity('', '')).toBe(0);
    expect(jaccardSimilarity('même idée', 'Même idée')).toBe(1);
    expect(jaccardSimilarity('a b', 'c d')).toBe(0);
  });
});

describe('packByTokenBudget', () => {
  it('takes items in order while they fit, and skips ones that do not (smaller ones further down still fit)', () => {
    const r = packByTokenBudget([{ id: 'a', tokens: 60 }, { id: 'b', tokens: 50 }, { id: 'c', tokens: 30 }], 100);
    expect(r.packed.map((p) => p.id)).toEqual(['a', 'c']);
    expect(r.dropped).toEqual([{ id: 'b', reason: 'over_budget' }]);
    const r2 = packByTokenBudget([{ id: 'a', tokens: 60 }, { id: 'b', tokens: 50 }, { id: 'c', tokens: 40 }], 100);
    expect(r2.packed.map((p) => p.id)).toEqual(['a', 'c']);
    expect(r2.usedTokens).toBe(100);
  });
  it('charges oversize items the per-item cap and flags them truncated', () => {
    const r = packByTokenBudget([{ id: 'big', tokens: 900 }, { id: 'small', tokens: 10 }], 500, 400);
    expect(r.packed).toEqual([{ id: 'big', tokens: 400, truncated: true }, { id: 'small', tokens: 10, truncated: false }]);
  });
  it('rounds fractional tokens up, copes with zero budget and rejects a negative one', () => {
    expect(packByTokenBudget([{ id: 'a', tokens: 1.2 }], 2).usedTokens).toBe(2);
    expect(packByTokenBudget([{ id: 'a', tokens: 1 }], 0).packed).toEqual([]);
    expect(() => packByTokenBudget([], -1)).toThrow(RangeError);
  });
});

describe('profile rollout', () => {
  const profile = (version: number, status: ScoringProfile['status'], canaryPercent = 0): ScoringProfile => ({
    id: `p${version}`,
    workspaceId: '*',
    name: 'default',
    version,
    status,
    canaryPercent,
    config: DEFAULT_SCORING_CONFIG_V1,
    description: '',
    createdBy: 'test',
    createdAt: NOW,
  });

  it('buckets a routing key stably into 0..99, spread across the range', () => {
    expect(rolloutBucket('trace-1')).toBe(rolloutBucket('trace-1'));
    const buckets = Array.from({ length: 2000 }, (_, i) => rolloutBucket(`trace-${i}`));
    expect(Math.min(...buckets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...buckets)).toBeLessThan(100);
    const below20 = buckets.filter((b) => b < 20).length / buckets.length;
    expect(below20).toBeGreaterThan(0.15);
    expect(below20).toBeLessThan(0.25);
  });

  it('serves the active profile when nothing else is rolling out', () => {
    const sel = selectProfiles([profile(1, 'active'), profile(2, 'retired')], 'k');
    expect(sel).toMatchObject({ reason: 'active', served: { version: 1 } });
    expect(sel.shadow).toBeUndefined();
  });

  it('runs a shadow next to the active profile without serving it', () => {
    const sel = selectProfiles([profile(1, 'active'), profile(2, 'shadow')], 'k');
    expect(sel.served.version).toBe(1);
    expect(sel.shadow?.version).toBe(2);
  });

  it('serves the canary to roughly its percentage of requests', () => {
    const profiles = [profile(1, 'active'), profile(2, 'canary', 25)];
    let canary = 0;
    for (let i = 0; i < 2000; i += 1) if (selectProfiles(profiles, `t${i}`).served.version === 2) canary += 1;
    expect(canary / 2000).toBeGreaterThan(0.2);
    expect(canary / 2000).toBeLessThan(0.3);
    expect(selectProfiles(profiles, 'same').served.version).toBe(selectProfiles(profiles, 'same').served.version);
  });

  it('0% canary serves nobody, 100% serves everybody; the newest version of a status wins', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(selectProfiles([profile(1, 'active'), profile(2, 'canary', 0)], `t${i}`).served.version).toBe(1);
      expect(selectProfiles([profile(1, 'active'), profile(2, 'canary', 100)], `t${i}`).served.version).toBe(2);
    }
    expect(selectProfiles([profile(1, 'active'), profile(3, 'active')], 'k').served.version).toBe(3);
  });

  it('fails clearly without an active profile', () => {
    expect(() => selectProfiles([profile(1, 'draft'), profile(2, 'shadow')], 'k')).toThrow(/no active scoring profile/);
  });
});
