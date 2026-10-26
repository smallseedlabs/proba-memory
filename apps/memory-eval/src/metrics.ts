import type { GoldenQuery, Target } from './golden.js';

/** What the harness needs to know about one returned memory. */
export interface MatchableResult {
  id: string;
  content: string;
  /** Source refs of the observations the memory was built from. */
  sourceRefs: string[];
  tokens: number;
}

const normaliseText = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Does this memory satisfy this target? */
export function covers(result: MatchableResult, target: Target, observationRefs: ReadonlyMap<string, string>): boolean {
  switch (target.kind) {
    case 'memoryId':
      return result.id === target.value;
    case 'observation': {
      const ref = observationRefs.get(target.value);
      return ref !== undefined && result.sourceRefs.includes(ref);
    }
    case 'fact':
      return normaliseText(result.content).includes(normaliseText(target.value));
  }
}

export interface QueryJudgement {
  /** One entry per returned memory: the target it claimed (index into `targets`), or null. */
  claimed: (number | null)[];
  /** One entry per returned memory: whether it satisfies any target (claimed or not). */
  relevant: boolean[];
  /** Gain of each returned memory (grade of the claimed target, 0 otherwise). */
  gains: number[];
  /** Top-k memories (or the whole list) that match something the query says to avoid. */
  avoided: boolean[];
}

/**
 * Walk the returned list from the top. A memory claims the best-graded target it satisfies that no earlier
 * memory claimed; a second memory about an already claimed target still counts for precision but earns no gain.
 * One memory answers one expectation: list one expectation per distinct fact.
 */
export function judgeQuery(
  query: Pick<GoldenQuery, 'avoid'> & { targets: Target[] },
  results: MatchableResult[],
  observationRefs: ReadonlyMap<string, string>
): QueryJudgement {
  const taken = new Set<number>();
  const claimed: (number | null)[] = [];
  const relevant: boolean[] = [];
  const gains: number[] = [];
  const avoided: boolean[] = [];
  const avoidRefs = new Set(query.avoid.observations.map((o) => o.ref));
  const avoidFacts = query.avoid.facts.map(normaliseText);
  for (const r of results) {
    let best: number | null = null;
    let any = false;
    query.targets.forEach((t, i) => {
      if (!covers(r, t, observationRefs)) return;
      any = true;
      if (taken.has(i)) return;
      const current = best === null ? null : (query.targets[best] as Target);
      if (current === null || t.grade > current.grade) best = i;
    });
    if (best !== null) taken.add(best);
    claimed.push(best);
    relevant.push(any);
    gains.push(best === null ? 0 : (query.targets[best] as Target).grade);
    const text = normaliseText(r.content);
    avoided.push(r.sourceRefs.some((ref) => avoidRefs.has(ref)) || avoidFacts.some((f) => text.includes(f)));
  }
  return { claimed, relevant, gains, avoided };
}

const discount = (position: number): number => 1 / Math.log2(position + 1);

/** Per-query metrics at one cut-off. */
export interface AtK {
  recall: number;
  precision: number;
  ndcg: number;
  /** 1 when anything the query wants to avoid is in the top k. */
  avoidViolation: number;
}

export interface QueryMetrics {
  /** null when the query has no targets (avoid-only queries have no ranking metrics). */
  byK: Record<number, AtK>;
  reciprocalRank: number | null;
  returned: number;
  tokens: number;
  latencyMs: number | null;
}

export function queryMetrics(
  targets: Target[],
  judgement: QueryJudgement,
  ks: number[],
  facts: { returned: number; tokens: number; latencyMs: number | null }
): QueryMetrics {
  const byK: Record<number, AtK> = {};
  const idealGrades = targets.map((t) => t.grade).sort((a, b) => b - a);
  for (const k of ks) {
    const claimedAtK = judgement.claimed.slice(0, k).filter((c) => c !== null).length;
    const relevantAtK = judgement.relevant.slice(0, k).filter(Boolean).length;
    const dcg = judgement.gains.slice(0, k).reduce((sum, g, i) => sum + g * discount(i + 1), 0);
    const idcg = idealGrades.slice(0, k).reduce((sum, g, i) => sum + g * discount(i + 1), 0);
    byK[k] = {
      recall: targets.length === 0 ? 0 : claimedAtK / targets.length,
      precision: relevantAtK / k,
      ndcg: idcg === 0 ? 0 : Math.min(1, dcg / idcg),
      avoidViolation: judgement.avoided.slice(0, k).some(Boolean) ? 1 : 0,
    };
  }
  const first = judgement.relevant.findIndex(Boolean);
  return {
    byK,
    reciprocalRank: targets.length === 0 ? null : first === -1 ? 0 : 1 / (first + 1),
    returned: facts.returned,
    tokens: facts.tokens,
    latencyMs: facts.latencyMs,
  };
}

export const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] as number;
}

export const round = (n: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Whether a larger number is better. */
export type Direction = 'higher' | 'lower';

/** The flat metrics of a profile over a set of queries: what reports, comparisons and the gate read. */
export interface MetricSummary {
  /** Queries that count in the ranking metrics (they have at least one target). */
  scoredQueries: number;
  /** Queries with only an avoid list. */
  avoidOnlyQueries: number;
  /** Macro average over the scored queries; keys like `recall@5`, `precision@5`, `ndcg@5`, `mrr`. */
  ranking: Record<string, number>;
  /** Share of queries with an avoided memory in the top k, keys like `avoidRate@5` (all queries that have an avoid list). */
  avoid: Record<string, number>;
  /** Tokens of the packed result per query. */
  tokens: { mean: number; p95: number; max: number };
  /** Retrieval wall time per query; null when the source has none (shadow logs). */
  latencyMs: { mean: number; p50: number; p95: number; max: number } | null;
  returned: { mean: number };
}

export function summarise(
  rows: { metrics: QueryMetrics; hasTargets: boolean; hasAvoid: boolean }[],
  ks: number[]
): MetricSummary {
  const scored = rows.filter((r) => r.hasTargets);
  const withAvoid = rows.filter((r) => r.hasAvoid);
  const ranking: Record<string, number> = {};
  const avoid: Record<string, number> = {};
  for (const k of ks) {
    ranking[`recall@${k}`] = round(mean(scored.map((r) => (r.metrics.byK[k] as AtK).recall)));
    ranking[`precision@${k}`] = round(mean(scored.map((r) => (r.metrics.byK[k] as AtK).precision)));
    ranking[`ndcg@${k}`] = round(mean(scored.map((r) => (r.metrics.byK[k] as AtK).ndcg)));
    if (withAvoid.length > 0) avoid[`avoidRate@${k}`] = round(mean(withAvoid.map((r) => (r.metrics.byK[k] as AtK).avoidViolation)));
  }
  ranking['mrr'] = round(mean(scored.map((r) => r.metrics.reciprocalRank ?? 0)));
  const tokens = rows.map((r) => r.metrics.tokens);
  const latencies = rows.map((r) => r.metrics.latencyMs).filter((l): l is number => l !== null);
  return {
    scoredQueries: scored.length,
    avoidOnlyQueries: rows.filter((r) => !r.hasTargets && r.hasAvoid).length,
    ranking,
    avoid,
    tokens: { mean: round(mean(tokens), 2), p95: percentile(tokens, 95), max: Math.max(0, ...tokens) },
    latencyMs:
      latencies.length === 0
        ? null
        : { mean: round(mean(latencies), 3), p50: round(percentile(latencies, 50), 3), p95: round(percentile(latencies, 95), 3), max: round(Math.max(...latencies), 3) },
    returned: { mean: round(mean(rows.map((r) => r.metrics.returned)), 2) },
  };
}

/** Flatten a summary to `name -> value` with the direction of each metric (used by comparison and the gate). */
export function flatten(summary: MetricSummary): Record<string, { value: number; direction: Direction }> {
  const out: Record<string, { value: number; direction: Direction }> = {};
  for (const [k, v] of Object.entries(summary.ranking)) out[k] = { value: v, direction: 'higher' };
  for (const [k, v] of Object.entries(summary.avoid)) out[k] = { value: v, direction: 'lower' };
  out['tokens.mean'] = { value: summary.tokens.mean, direction: 'lower' };
  out['tokens.p95'] = { value: summary.tokens.p95, direction: 'lower' };
  if (summary.latencyMs) {
    out['latencyMs.mean'] = { value: summary.latencyMs.mean, direction: 'lower' };
    out['latencyMs.p95'] = { value: summary.latencyMs.p95, direction: 'lower' };
  }
  return out;
}
