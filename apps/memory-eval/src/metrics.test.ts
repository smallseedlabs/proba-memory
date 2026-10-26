import { describe, expect, it } from 'vitest';
import type { Target } from './golden.js';
import { judgeQuery, mean, percentile, queryMetrics, summarise, flatten, type MatchableResult } from './metrics.js';

const refs = new Map([
  ['a', 'ref:a'],
  ['b', 'ref:b'],
]);
const result = (id: string, content: string, sourceRefs: string[] = []): MatchableResult => ({ id, content, sourceRefs, tokens: 10 });
const obs = (value: string, grade = 1): Target => ({ kind: 'observation', value, grade });
const noAvoid: { observations: { key: string; ref: string }[]; facts: string[] } = { observations: [], facts: [] };

describe('judgeQuery', () => {
  it('claims one target per memory, best grade first, and counts a repeated hit as relevant without gain', () => {
    const targets = [obs('a', 1), obs('b', 2)];
    const judged = judgeQuery({ avoid: noAvoid, targets }, [result('x', 'nothing'), result('m1', 'm1', ['ref:b']), result('m2', 'm2', ['ref:a']), result('m3', 'again b', ['ref:b'])], refs);
    expect(judged.claimed).toEqual([null, 1, 0, null]);
    expect(judged.gains).toEqual([0, 2, 1, 0]);
    expect(judged.relevant).toEqual([false, true, true, true]);
  });

  it('matches facts case-insensitively and by whitespace-normalised substring, and memory ids exactly', () => {
    const targets: Target[] = [
      { kind: 'fact', value: 'Short   Headlines', grade: 1 },
      { kind: 'memoryId', value: 'id-7', grade: 1 },
    ];
    const judged = judgeQuery({ avoid: noAvoid, targets }, [result('id-7', 'unrelated'), result('id-8', 'We like short headlines.')], refs);
    expect(judged.claimed).toEqual([1, 0]);
  });

  it('flags memories that match an avoid list by observation or by fact', () => {
    const judged = judgeQuery(
      { avoid: { observations: [{ key: 'a', ref: 'ref:a' }], facts: ['10000 dollars'] }, targets: [obs('b')] },
      [result('1', 'budget is 10000 dollars'), result('2', 'new', ['ref:b']), result('3', 'old', ['ref:a'])],
      refs
    );
    expect(judged.avoided).toEqual([true, false, true]);
  });
});

describe('queryMetrics', () => {
  it('computes recall, precision, nDCG and reciprocal rank by hand', () => {
    const targets = [obs('a', 1), obs('b', 2)];
    const judged = judgeQuery({ avoid: noAvoid, targets }, [result('x', 'nothing'), result('m1', 'm1', ['ref:b']), result('m2', 'm2', ['ref:a'])], refs);
    const m = queryMetrics(targets, judged, [1, 3], { returned: 3, tokens: 30, latencyMs: 1 });
    expect(m.byK[1]).toMatchObject({ recall: 0, precision: 0, ndcg: 0 });
    expect(m.byK[3]?.recall).toBe(1);
    expect(m.byK[3]?.precision).toBeCloseTo(2 / 3, 10);
    // DCG = 2/log2(3) + 1/log2(4); ideal = 2/log2(2) + 1/log2(3)
    const dcg = 2 / Math.log2(3) + 1 / 2;
    const idcg = 2 + 1 / Math.log2(3);
    expect(m.byK[3]?.ndcg).toBeCloseTo(dcg / idcg, 10);
    expect(m.reciprocalRank).toBe(0.5);
  });

  it('gives a perfect list nDCG 1 and an empty list 0, and never exceeds 1', () => {
    const targets = [obs('a', 3), obs('b', 1)];
    const perfect = judgeQuery({ avoid: noAvoid, targets }, [result('1', '1', ['ref:a']), result('2', '2', ['ref:b'])], refs);
    expect(queryMetrics(targets, perfect, [2], { returned: 2, tokens: 0, latencyMs: null }).byK[2]?.ndcg).toBeCloseTo(1, 10);
    const empty = judgeQuery({ avoid: noAvoid, targets }, [], refs);
    const m = queryMetrics(targets, empty, [2], { returned: 0, tokens: 0, latencyMs: null });
    expect(m.byK[2]).toMatchObject({ recall: 0, precision: 0, ndcg: 0 });
    expect(m.reciprocalRank).toBe(0);
  });

  it('has no reciprocal rank for a query with only an avoid list', () => {
    const judged = judgeQuery({ avoid: { observations: [], facts: ['x'] }, targets: [] }, [result('1', 'x marks')], refs);
    const m = queryMetrics([], judged, [1], { returned: 1, tokens: 5, latencyMs: null });
    expect(m.reciprocalRank).toBeNull();
    expect(m.byK[1]?.avoidViolation).toBe(1);
  });
});

describe('aggregation', () => {
  it('computes mean and nearest-rank percentiles', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });

  it('macro-averages over scored queries, counts avoid-only queries apart, and reports size and latency', () => {
    const t = [obs('a')];
    const row = (list: MatchableResult[], tokens: number, latencyMs: number | null, avoid = noAvoid, targets = t) => {
      const judged = judgeQuery({ avoid, targets }, list, refs);
      return { metrics: queryMetrics(targets, judged, [1], { returned: list.length, tokens, latencyMs }), hasTargets: targets.length > 0, hasAvoid: avoid.facts.length + avoid.observations.length > 0 };
    };
    const summary = summarise(
      [
        row([result('1', 'x', ['ref:a'])], 100, 2),
        row([result('2', 'x')], 200, 4),
        row([result('3', 'old fact')], 50, 6, { observations: [], facts: ['old fact'] }, []),
      ],
      [1]
    );
    expect(summary.scoredQueries).toBe(2);
    expect(summary.avoidOnlyQueries).toBe(1);
    expect(summary.ranking['recall@1']).toBe(0.5);
    expect(summary.ranking['mrr']).toBe(0.5);
    expect(summary.avoid['avoidRate@1']).toBe(1);
    expect(summary.tokens).toEqual({ mean: 116.67, p95: 200, max: 200 });
    expect(summary.latencyMs?.p50).toBe(4);
    expect(Object.keys(flatten(summary))).toEqual(expect.arrayContaining(['recall@1', 'mrr', 'avoidRate@1', 'tokens.mean', 'latencyMs.p95']));
  });

  it('has no latency when the source has none', () => {
    const judged = judgeQuery({ avoid: noAvoid, targets: [obs('a')] }, [], refs);
    const m = queryMetrics([obs('a')], judged, [1], { returned: 0, tokens: 0, latencyMs: null });
    expect(summarise([{ metrics: m, hasTargets: true, hasAvoid: false }], [1]).latencyMs).toBeNull();
  });
});
