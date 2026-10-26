import { deterministicUuid, truncate } from '@smallseedlabs/proba-memory-core';
import type { BacktestWindow } from './backtest.js';
import { GoldenSetError, type GoldenQuery, type GoldenSet, type Target } from './golden.js';
import { judgeQuery, queryMetrics, summarise, type MatchableResult, type MetricSummary, type QueryMetrics } from './metrics.js';
import type { ProfileSpec } from './profiles.js';
import { createEvalStack, type ReplayStats } from './stack.js';

export const REPORT_SCHEMA_VERSION = 1;

export interface ResultRow {
  rank: number;
  id: string;
  score: number;
  tokens: number;
  /** Label of the target this memory satisfied first, or null. */
  claimed: string | null;
  relevant: boolean;
  avoided: boolean;
  excerpt: string;
}

export interface QueryRow {
  id: string;
  /** Backtest window, or null in a static run. */
  window: string | null;
  asOf: string;
  tags: string[];
  /** Targets that counted (targets resting on observations after the split are left out in a backtest). */
  targets: number;
  leftOutTargets: string[];
  /** Whether an avoid list was enforced for this query (not while an expected observation is still unknown). */
  hasAvoid: boolean;
  metrics: QueryMetrics;
  results: ResultRow[];
  degraded: string[];
}

export interface WindowReport {
  name: string;
  replayUntil: string;
  queryUntil: string | null;
  replay: ReplayStats;
  askedQueries: number;
  /** Queries with nothing left to expect at this split. */
  skippedQueries: string[];
  summary: MetricSummary;
}

export interface ProfileReport {
  name: string;
  description: string;
  configDigest: string;
  summary: MetricSummary;
  windows?: WindowReport[];
  queries: QueryRow[];
}

export interface EvalRunReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  mode: 'static' | 'backtest';
  golden: { name: string; digest: string; workspace: string; observations: number; queries: number };
  /** Cut-offs of the @k metrics; the last is the headline k. */
  k: number[];
  environment: { embedder: string; llm: string };
  profiles: ProfileReport[];
}

export interface RunOptions {
  golden: GoldenSet;
  profiles: ProfileSpec[];
  /** Backtest windows. Without them every observation is replayed once and every query asked. */
  windows?: BacktestWindow[];
  /** Override the golden set's k. */
  k?: number[];
}

const label = (t: Target): string => `${t.kind}:${t.value}`;

function workspacesOf(golden: GoldenSet): string[] {
  return [...new Set([golden.workspace, ...golden.observations.map((o) => o.workspace), ...golden.queries.map((q) => q.workspace)])].sort();
}

/** Run every profile over the golden set and measure. Deterministic apart from latency. */
export async function runEvaluation(options: RunOptions): Promise<EvalRunReport> {
  const { golden, profiles } = options;
  if (profiles.length === 0) throw new GoldenSetError('no scoring profile to evaluate');
  const names = new Set<string>();
  for (const p of profiles) {
    if (names.has(p.name)) throw new GoldenSetError(`two profiles are named "${p.name}"`);
    names.add(p.name);
  }
  if (golden.observations.length === 0) throw new GoldenSetError(`golden set "${golden.name}" has no observations to replay`);
  const ks = [...new Set(options.k ?? golden.k)].sort((a, b) => a - b);
  const windows: (BacktestWindow | null)[] = options.windows && options.windows.length > 0 ? options.windows : [null];
  const workspaces = workspacesOf(golden);
  const observationRefs = new Map(golden.observations.map((o) => [o.key, o.ref]));
  const observationTime = new Map(golden.observations.map((o) => [o.key, o.occurredAt]));

  if (windows[0] === null) {
    const last = golden.lastObservationAt as string;
    for (const q of golden.queries) {
      if (q.asOfExplicit && q.asOf < last) {
        throw new GoldenSetError(`query "${q.id}" is asked at ${q.asOf}, before the last observation (${last}); a static run would leak the future. Use a time-split backtest.`);
      }
    }
  }

  const rows = new Map<string, QueryRow[]>(profiles.map((p) => [p.name, []]));
  const windowReports = new Map<string, WindowReport[]>(profiles.map((p) => [p.name, []]));
  const environment = { embedder: '', llm: '' };

  for (const window of windows) {
    const stack = createEvalStack(golden);
    environment.embedder = stack.embedderName;
    environment.llm = stack.llmName;
    const cutoff = window ? Date.parse(window.replayUntil) : Number.POSITIVE_INFINITY;
    const replay = await stack.replay(golden.observations.filter((o) => Date.parse(o.occurredAt) <= cutoff));
    for (const p of profiles) await stack.installProfile(workspaces, p.name, p, 'active');

    const askedAll: GoldenQuery[] = [];
    const skipped: string[] = [];
    const prepared: { query: GoldenQuery; targets: Target[]; leftOut: string[]; avoid: GoldenQuery['avoid'] }[] = [];
    for (const q of golden.queries) {
      if (window) {
        if (Date.parse(q.asOf) <= cutoff) continue;
        if (window.queryUntil !== null && Date.parse(q.asOf) > Date.parse(window.queryUntil)) continue;
      }
      askedAll.push(q);
      const usable: Target[] = [];
      const leftOut: string[] = [];
      for (const t of q.targets) {
        const at = t.kind === 'observation' ? observationTime.get(t.value) : undefined;
        if (window && at !== undefined && Date.parse(at) > cutoff) leftOut.push(label(t));
        else usable.push(t);
      }
      // "Avoid" names what the expected memories replaced; it only applies once the replacement is known.
      const avoid = leftOut.length > 0 ? { observations: [], facts: [] } : q.avoid;
      if (usable.length === 0 && avoid.observations.length === 0 && avoid.facts.length === 0) {
        skipped.push(q.id);
        continue;
      }
      prepared.push({ query: q, targets: usable, leftOut, avoid });
    }

    const perProfileRows = new Map<string, QueryRow[]>(profiles.map((p) => [p.name, []]));
    for (const { query, targets, leftOut, avoid } of prepared) {
      stack.clock.set(query.asOf);
      const limit = query.limit ?? Math.max(...ks);
      for (const p of profiles) {
        const traceId = deterministicUuid('eval-trace', `${window?.name ?? 'static'}:${query.id}`);
        const started = performance.now();
        const response = await stack.retrievalFor(p.name).search(
          { workspaceId: query.workspace, actor: { type: 'service', id: 'memory-eval' }, traceId },
          {
            query: query.query,
            limit,
            ...(query.tokenBudget ? { tokenBudget: query.tokenBudget } : {}),
            ...(query.categories ? { filter: { categories: query.categories as never } } : {}),
          }
        );
        const latencyMs = performance.now() - started;
        const results: MatchableResult[] = response.results.map((r) => ({ id: r.id, content: r.content, sourceRefs: r.sourceRefs.map((s) => s.ref), tokens: r.tokens }));
        const judged = judgeQuery({ avoid, targets }, results, observationRefs);
        const metrics = queryMetrics(targets, judged, ks, { returned: results.length, tokens: response.stats.tokensUsed, latencyMs });
        const row: QueryRow = {
          id: query.id,
          window: window?.name ?? null,
          asOf: query.asOf,
          tags: query.tags,
          targets: targets.length,
          leftOutTargets: leftOut,
          hasAvoid: avoid.observations.length > 0 || avoid.facts.length > 0,
          metrics,
          degraded: response.stats.degraded,
          results: response.results.map((r, i) => ({
            rank: i + 1,
            id: r.id,
            score: r.score,
            tokens: r.tokens,
            claimed: judged.claimed[i] === null || judged.claimed[i] === undefined ? null : label(targets[judged.claimed[i] as number] as Target),
            relevant: judged.relevant[i] === true,
            avoided: judged.avoided[i] === true,
            excerpt: truncate(r.content.replace(/\s+/g, ' '), 90),
          })),
        };
        (perProfileRows.get(p.name) as QueryRow[]).push(row);
      }
    }

    for (const p of profiles) {
      const profileRows = perProfileRows.get(p.name) as QueryRow[];
      rows.get(p.name)?.push(...profileRows);
      if (window) {
        windowReports.get(p.name)?.push({
          name: window.name,
          replayUntil: window.replayUntil,
          queryUntil: window.queryUntil,
          replay,
          askedQueries: askedAll.length,
          skippedQueries: skipped,
          summary: summariseRows(profileRows, ks),
        });
      }
    }
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: windows[0] === null ? 'static' : 'backtest',
    golden: { name: golden.name, digest: golden.digest, workspace: golden.workspace, observations: golden.observations.length, queries: golden.queries.length },
    k: ks,
    environment,
    profiles: profiles.map((p) => {
      const queryRows = rows.get(p.name) as QueryRow[];
      return {
        name: p.name,
        description: p.description,
        configDigest: p.digest,
        summary: summariseRows(queryRows, ks),
        ...(windows[0] === null ? {} : { windows: windowReports.get(p.name) as WindowReport[] }),
        queries: queryRows,
      };
    }),
  };
}

export function summariseRows(rows: QueryRow[], ks: number[]): MetricSummary {
  return summarise(
    rows.map((r) => ({ metrics: r.metrics, hasTargets: r.targets > 0, hasAvoid: r.hasAvoid })),
    ks
  );
}

export const headlineK = (report: { k: number[] }): number => report.k[report.k.length - 1] as number;
