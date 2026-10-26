import {
  Redactor,
  deterministicUuid,
  sha256Hex,
  type RetrievalLogEntry,
} from '@smallseedlabs/proba-memory-core';
import { metricDeltas, type MetricDelta } from './compare.js';
import { GoldenSetError, type GoldenQuery, type GoldenSet } from './golden.js';
import { judgeQuery, mean, queryMetrics, round, summarise, type MatchableResult, type MetricSummary } from './metrics.js';
import type { ProfileSpec } from './profiles.js';
import { createEvalStack } from './stack.js';

/**
 * Shadow and canary evaluation.
 *
 * A scoring profile version in status `shadow` is scored over the same candidates as the served one on every
 * retrieval and written to the retrieval log (`shadowResults`), but never returned. This module reads
 * those logs back, matches the logged queries to golden queries by query hash, and scores the served list and
 * the shadow list side by side with the same metrics. Nothing is read from or written to the serving path.
 */

/** Hash the retrieval log stores for a query: sha256 of the redacted, whitespace-normalised, lower-cased text. */
export function queryHashOf(query: string, redactor = new Redactor({ pii: true })): string {
  const redacted = redactor.redact(query.replace(/\s+/g, ' ').trim()).text;
  return sha256Hex(redacted.toLowerCase()).slice(0, 32);
}

export type HydrateFn = (workspaceId: string, ids: string[]) => Promise<MatchableResult[]>;

export interface ShadowAgreement {
  /** Mean share of the served top-k that the shadow list also has in its top k. */
  overlap: Record<string, number>;
  /** Share of queries where both lists start with the same memory. */
  topOneSame: number;
}

export interface ShadowQueryRow {
  id: string;
  retrievalId: string;
  servedVersion: number;
  shadowVersion: number;
  servedIds: string[];
  shadowIds: string[];
  /** Headline-k ndcg of each list (null for a query without expectations). */
  servedNdcg: number | null;
  shadowNdcg: number | null;
}

export interface ShadowReport {
  schemaVersion: 1;
  golden: { name: string; digest: string };
  k: number[];
  /** Where the logs came from, for the reader of the report. */
  source: string;
  entries: {
    /** Log entries read. */
    read: number;
    /** Entries whose query matches a golden query. */
    matched: number;
    /** Matched entries that carry a shadow list. */
    withShadow: number;
    /** Golden queries with no logged retrieval carrying a shadow list. */
    unmatchedQueries: string[];
  };
  /** Profile versions seen in the matched entries, for example `default v3 (active) vs v4 (shadow)`. */
  versions: string[];
  served: MetricSummary;
  shadow: MetricSummary;
  comparison: MetricDelta[];
  agreement: ShadowAgreement;
  queries: ShadowQueryRow[];
}

export interface AnalyseShadowOptions {
  entries: RetrievalLogEntry[];
  golden: GoldenSet;
  hydrate: HydrateFn;
  source: string;
  k?: number[];
}

/** Score the served and the shadow lists of logged retrievals against the golden set. The newest entry of each query counts. */
export async function analyseShadowLog(options: AnalyseShadowOptions): Promise<ShadowReport> {
  const { golden, entries, hydrate } = options;
  const ks = [...new Set(options.k ?? golden.k)].sort((a, b) => a - b);
  const headline = ks[ks.length - 1] as number;
  const redactor = new Redactor({ pii: true });
  const byHash = new Map<string, GoldenQuery>(golden.queries.map((q) => [`${q.workspace}\u0000${queryHashOf(q.query, redactor)}`, q]));
  const observationRefs = new Map(golden.observations.map((o) => [o.key, o.ref]));

  // Newest first in the store; keep the first entry per query that has a shadow list.
  const newest = new Map<string, RetrievalLogEntry>();
  let matched = 0;
  for (const e of entries) {
    const q = byHash.get(`${e.workspaceId}\u0000${e.queryHash}`);
    if (!q) continue;
    matched += 1;
    if (e.shadowResults !== null && !newest.has(q.id)) newest.set(q.id, e);
  }

  const servedRows: Parameters<typeof summarise>[0] = [];
  const shadowRows: Parameters<typeof summarise>[0] = [];
  const queries: ShadowQueryRow[] = [];
  const overlaps: Record<string, number[]> = Object.fromEntries(ks.map((k) => [String(k), []]));
  const topOne: number[] = [];
  const versions = new Set<string>();

  for (const q of golden.queries) {
    const e = newest.get(q.id);
    if (!e || e.shadowResults === null) continue;
    const servedIds = [...e.results].sort((a, b) => a.position - b.position).map((r) => r.id);
    const shadowIds = e.shadowResults.map((r) => r.id);
    versions.add(`${e.profileName} v${e.profileVersion} (${e.profileServed}) vs v${e.shadowProfileVersion ?? '?'} (shadow)`);
    const [served, shadow] = await Promise.all([hydrate(e.workspaceId, servedIds), hydrate(e.workspaceId, shadowIds)]);
    const hasAvoid = q.avoid.observations.length > 0 || q.avoid.facts.length > 0;
    const row = (list: MatchableResult[]) => {
      const judged = judgeQuery({ avoid: q.avoid, targets: q.targets }, list, observationRefs);
      const metrics = queryMetrics(q.targets, judged, ks, { returned: list.length, tokens: list.reduce((n, r) => n + r.tokens, 0), latencyMs: null });
      return { metrics, hasTargets: q.targets.length > 0, hasAvoid };
    };
    const servedRow = row(served);
    const shadowRow = row(shadow);
    servedRows.push(servedRow);
    shadowRows.push(shadowRow);
    for (const k of ks) {
      const top = new Set(shadowIds.slice(0, k));
      const base = servedIds.slice(0, k);
      overlaps[String(k)]?.push(base.length === 0 ? (shadowIds.length === 0 ? 1 : 0) : base.filter((id) => top.has(id)).length / base.length);
    }
    topOne.push(servedIds[0] === shadowIds[0] ? 1 : 0);
    queries.push({
      id: q.id,
      retrievalId: e.id,
      servedVersion: e.profileVersion,
      shadowVersion: e.shadowProfileVersion ?? 0,
      servedIds,
      shadowIds,
      servedNdcg: q.targets.length > 0 ? round(servedRow.metrics.byK[headline]?.ndcg ?? 0) : null,
      shadowNdcg: q.targets.length > 0 ? round(shadowRow.metrics.byK[headline]?.ndcg ?? 0) : null,
    });
  }

  const served = summarise(servedRows, ks);
  const shadow = summarise(shadowRows, ks);
  return {
    schemaVersion: 1,
    golden: { name: golden.name, digest: golden.digest },
    k: ks,
    source: options.source,
    entries: { read: entries.length, matched, withShadow: newest.size, unmatchedQueries: golden.queries.filter((q) => !newest.has(q.id)).map((q) => q.id) },
    versions: [...versions].sort(),
    served,
    shadow,
    comparison: metricDeltas(served, shadow),
    agreement: { overlap: Object.fromEntries(ks.map((k) => [`overlap@${k}`, round(mean(overlaps[String(k)] ?? []))])), topOneSame: round(mean(topOne)) },
    queries,
  };
}

export interface RunShadowOptions {
  golden: GoldenSet;
  /** Serves every request. */
  baseline: ProfileSpec;
  /** Runs in shadow: scored and logged, never returned. */
  candidate: ProfileSpec;
  k?: number[];
}

export interface ShadowRun {
  report: ShadowReport;
  /** The ids actually returned to callers per query: they come from the baseline only. */
  servedIds: Record<string, string[]>;
}

/**
 * Hermetic shadow run: serve the golden queries with `baseline` while `candidate` is a shadow version of the
 * same profile, then read the retrieval log back exactly as the report command reads a production log.
 */
export async function runShadowEvaluation(options: RunShadowOptions): Promise<ShadowRun> {
  const { golden, baseline, candidate } = options;
  if (golden.observations.length === 0) throw new GoldenSetError(`golden set "${golden.name}" has no observations to replay`);
  const family = 'eval-rollout';
  const workspaces = [...new Set([golden.workspace, ...golden.observations.map((o) => o.workspace), ...golden.queries.map((q) => q.workspace)])].sort();
  const stack = createEvalStack(golden);
  await stack.replay(golden.observations);
  await stack.installProfile(workspaces, family, baseline, 'active');
  await stack.installProfile(workspaces, family, candidate, 'shadow');
  const service = stack.retrievalFor(family);
  const ks = [...new Set(options.k ?? golden.k)].sort((a, b) => a - b);
  const servedIds: Record<string, string[]> = {};
  for (const q of golden.queries) {
    stack.clock.set(q.asOf);
    const response = await service.search(
      { workspaceId: q.workspace, actor: { type: 'service', id: 'memory-eval' }, traceId: deterministicUuid('eval-trace', `shadow:${q.id}`) },
      { query: q.query, limit: q.limit ?? Math.max(...ks) }
    );
    servedIds[q.id] = response.results.map((r) => r.id);
  }
  const entries = (await Promise.all(workspaces.map((w) => stack.logStore.list(w, { limit: 10_000 })))).flat();
  const report = await analyseShadowLog({ entries, golden, hydrate: stack.hydrate, source: `in-process run (${baseline.name} served, ${candidate.name} shadow)`, k: ks });
  return { report, servedIds };
}
