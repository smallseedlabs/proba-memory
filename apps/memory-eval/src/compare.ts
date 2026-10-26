import { flatten, round, type AtK, type Direction, type MetricSummary } from './metrics.js';
import { GoldenSetError } from './golden.js';
import { headlineK, type EvalRunReport, type ProfileReport, type QueryRow } from './run.js';

export type Verdict = 'better' | 'worse' | 'same' | 'info';

export interface MetricDelta {
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  /** delta / baseline, null when the baseline is 0. */
  relative: number | null;
  direction: Direction;
  verdict: Verdict;
}

export interface QueryDelta {
  id: string;
  window: string | null;
  change: 'improved' | 'regressed';
  baseline: { firstRelevantRank: number | null; recall: number; ndcg: number };
  candidate: { firstRelevantRank: number | null; recall: number; ndcg: number };
}

export interface ProfileComparison {
  baseline: string;
  candidate: string;
  /** Quality metrics first, then size and latency. */
  metrics: MetricDelta[];
  /** Queries whose headline ndcg or reciprocal rank moved (unchanged queries are left out). */
  queries: QueryDelta[];
  counts: { improved: number; regressed: number; unchanged: number };
}

const EPS = 1e-9;
/** Latency is wall time and varies between runs: shown, never judged. */
const isInfoOnly = (metric: string): boolean => metric.startsWith('latencyMs');

function verdictOf(metric: string, delta: number, direction: Direction): Verdict {
  if (isInfoOnly(metric)) return 'info';
  if (Math.abs(delta) < EPS) return 'same';
  return (direction === 'higher') === delta > 0 ? 'better' : 'worse';
}

const firstRelevantRank = (row: QueryRow): number | null => row.results.find((r) => r.relevant)?.rank ?? null;

function queryKey(row: QueryRow): string {
  return `${row.window ?? ''}\u0000${row.id}`;
}

function describe(row: QueryRow, k: number): QueryDelta['baseline'] {
  const at = row.metrics.byK[k] as AtK;
  return { firstRelevantRank: firstRelevantRank(row), recall: round(at.recall), ndcg: round(at.ndcg) };
}

/** Compare every other profile with the baseline profile (the first, or the one named). */
export function compareProfiles(report: EvalRunReport, baselineName?: string): ProfileComparison[] {
  const baseline = baselineName ? report.profiles.find((p) => p.name === baselineName) : report.profiles[0];
  if (!baseline) throw new GoldenSetError(`baseline profile "${baselineName ?? ''}" is not in the report`);
  return report.profiles.filter((p) => p !== baseline).map((candidate) => compareTwo(report, baseline, candidate));
}

/** Metric by metric: baseline, candidate, delta and whether it is better or worse. */
export function metricDeltas(base: MetricSummary, other: MetricSummary): MetricDelta[] {
  const a = flatten(base);
  const b = flatten(other);
  const metrics: MetricDelta[] = [];
  for (const [metric, from] of Object.entries(a)) {
    const to = b[metric];
    if (!to) continue;
    const delta = round(to.value - from.value);
    metrics.push({
      metric,
      baseline: from.value,
      candidate: to.value,
      delta,
      relative: from.value === 0 ? null : round(delta / from.value),
      direction: from.direction,
      verdict: verdictOf(metric, delta, from.direction),
    });
  }
  return metrics;
}

function compareTwo(report: EvalRunReport, baseline: ProfileReport, candidate: ProfileReport): ProfileComparison {
  const k = headlineK(report);
  const metrics = metricDeltas(baseline.summary, candidate.summary);
  const before = new Map(baseline.queries.map((r) => [queryKey(r), r]));
  const queries: QueryDelta[] = [];
  let unchanged = 0;
  for (const row of candidate.queries) {
    const other = before.get(queryKey(row));
    if (!other || row.targets === 0) continue;
    const x = other.metrics.byK[k] as AtK;
    const y = row.metrics.byK[k] as AtK;
    const dNdcg = y.ndcg - x.ndcg;
    const dRr = (row.metrics.reciprocalRank ?? 0) - (other.metrics.reciprocalRank ?? 0);
    const move = Math.abs(dNdcg) >= EPS ? dNdcg : dRr;
    if (Math.abs(move) < EPS) {
      unchanged += 1;
      continue;
    }
    queries.push({ id: row.id, window: row.window, change: move > 0 ? 'improved' : 'regressed', baseline: describe(other, k), candidate: describe(row, k) });
  }
  return {
    baseline: baseline.name,
    candidate: candidate.name,
    metrics,
    queries,
    counts: { improved: queries.filter((q) => q.change === 'improved').length, regressed: queries.filter((q) => q.change === 'regressed').length, unchanged },
  };
}
