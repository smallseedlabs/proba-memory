import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { sha256Hex } from '@smallseedlabs/proba-memory-core';
import type { BacktestWindow } from './backtest.js';
import { GoldenSetError, parseDocument, stableStringify } from './golden.js';
import { flatten, round, type Direction } from './metrics.js';
import type { EvalRunReport } from './run.js';

export const BASELINE_SCHEMA_VERSION = 1;

export interface BaselineProfile {
  configDigest: string;
  /** Flat metric values (`recall@5`, `tokens.mean`, ...). */
  metrics: Record<string, number>;
}

/** The stored result the gate compares against. Commit it next to the golden set. */
export interface Baseline {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  golden: { name: string; digest: string };
  mode: 'static' | 'backtest';
  /** Digest of the backtest windows, null for a static run. */
  windowsDigest: string | null;
  k: number[];
  profiles: Record<string, BaselineProfile>;
}

export const windowsDigest = (windows: BacktestWindow[] | undefined): string | null =>
  windows && windows.length > 0 ? sha256Hex(stableStringify(windows)) : null;

/**
 * Latency is wall time and differs from machine to machine, so it is left out of the stored baseline unless
 * asked for (`includeLatency`); the gate only checks the metrics the baseline holds.
 */
export function makeBaseline(report: EvalRunReport, windows?: BacktestWindow[], options: { includeLatency?: boolean } = {}): Baseline {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    golden: { name: report.golden.name, digest: report.golden.digest },
    mode: report.mode,
    windowsDigest: windowsDigest(windows),
    k: report.k,
    profiles: Object.fromEntries(
      report.profiles.map((p) => [
        p.name,
        { configDigest: p.configDigest, metrics: Object.fromEntries(
            Object.entries(flatten(p.summary))
              .filter(([k]) => options.includeLatency || !k.startsWith('latencyMs'))
              .map(([k, v]) => [k, v.value])
          ),
        },
      ])
    ),
  };
}

const baselineSchema = z.object({
  schemaVersion: z.literal(BASELINE_SCHEMA_VERSION),
  golden: z.object({ name: z.string(), digest: z.string() }),
  mode: z.enum(['static', 'backtest']),
  windowsDigest: z.string().nullable(),
  k: z.array(z.number().int()),
  profiles: z.record(z.object({ configDigest: z.string(), metrics: z.record(z.number()) })),
});

export function loadBaseline(path: string): Baseline {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new GoldenSetError(`cannot read baseline ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = baselineSchema.safeParse(parseDocument(text, path));
  if (!parsed.success) {
    throw new GoldenSetError(`baseline ${path} is invalid:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return parsed.data;
}

export const gateConfigSchema = z
  .object({
    /** Largest allowed drop of a quality metric (recall, precision, nDCG, MRR), as an absolute value 0..1. */
    tolerance: z.number().min(0).max(1).default(0.02),
    /** Per-metric override of `tolerance`, for example `{ "recall@5": 0.05 }`. */
    metricTolerance: z.record(z.number().min(0).max(1)).default({}),
    /** Largest allowed rise of the avoid rate (outdated or unwanted memories in the top k), absolute. */
    avoidTolerance: z.number().min(0).max(1).default(0),
    /** Largest allowed relative rise of the token-pack size (0.25 = 25 %). */
    tokensMaxIncrease: z.number().min(0).default(0.25),
    /** Relative rise of retrieval latency that fails the gate; null: latency is reported, not gated (wall time is noisy). */
    latencyMaxIncrease: z.number().min(0).nullable().default(null),
    /** A latency rise below this many milliseconds never fails. */
    latencyMinDeltaMs: z.number().min(0).default(5),
  })
  .strict();

export type GateConfig = z.output<typeof gateConfigSchema>;
export const defaultGateConfig = (): GateConfig => gateConfigSchema.parse({});

export type CheckStatus = 'ok' | 'improved' | 'regressed' | 'missing';

export interface GateCheck {
  profile: string;
  metric: string;
  direction: Direction;
  baseline: number;
  current: number | null;
  delta: number | null;
  /** The limit used: absolute tolerance, or the relative rise for size and latency. */
  allowed: number;
  allowedKind: 'absolute' | 'relative';
  status: CheckStatus;
}

export type GateStatus = 'pass' | 'regression' | 'stale' | 'unknown_profile';

export interface GateResult {
  status: GateStatus;
  /** Why the baseline cannot be used (stale) or which profile has no baseline. */
  problems: string[];
  checks: GateCheck[];
  /** Process exit code of the CLI: 0 pass, 1 regression, 3 stale or incomplete baseline. */
  exitCode: 0 | 1 | 3;
}

const EPS = 1e-9;

export interface GateOptions {
  config?: GateConfig;
  windows?: BacktestWindow[];
  /** Compare even if the golden set, k or windows changed since the baseline was stored. */
  allowStale?: boolean;
}

/**
 * Compare a run with the stored baseline. A profile fails when a quality metric drops by more than the
 * tolerance, the avoid rate rises, or the token pack grows beyond the allowed ratio (latency optionally).
 */
export function evaluateGate(report: EvalRunReport, baseline: Baseline, options: GateOptions = {}): GateResult {
  const config = options.config ?? defaultGateConfig();
  const problems: string[] = [];
  if (baseline.golden.name !== report.golden.name) problems.push(`baseline is for golden set "${baseline.golden.name}", the run used "${report.golden.name}"`);
  else if (baseline.golden.digest !== report.golden.digest) problems.push('the golden set changed since the baseline was stored; review the change and run `baseline update`');
  if (baseline.mode !== report.mode) problems.push(`baseline mode is ${baseline.mode}, the run is ${report.mode}`);
  if (baseline.windowsDigest !== windowsDigest(options.windows)) problems.push('the backtest windows differ from the baseline');
  if (stableStringify(baseline.k) !== stableStringify(report.k)) problems.push(`baseline k is [${baseline.k.join(',')}], the run uses [${report.k.join(',')}]`);
  if (problems.length > 0 && !options.allowStale) return { status: 'stale', problems, checks: [], exitCode: 3 };

  const checks: GateCheck[] = [];
  const unknown: string[] = [];
  for (const profile of report.profiles) {
    const stored = baseline.profiles[profile.name];
    if (!stored) {
      unknown.push(`profile "${profile.name}" has no entry in the baseline`);
      continue;
    }
    const current = flatten(profile.summary);
    for (const [metric, baseValue] of Object.entries(stored.metrics)) {
      const isLatency = metric.startsWith('latencyMs');
      if (isLatency && config.latencyMaxIncrease === null) continue;
      const now = current[metric];
      const direction: Direction = now?.direction ?? (metric.startsWith('avoidRate') || metric.startsWith('tokens') || isLatency ? 'lower' : 'higher');
      const kind: GateCheck['allowedKind'] = metric.startsWith('tokens') || isLatency ? 'relative' : 'absolute';
      const allowed = isLatency
        ? (config.latencyMaxIncrease as number)
        : metric.startsWith('tokens')
          ? config.tokensMaxIncrease
          : metric.startsWith('avoidRate')
            ? (config.metricTolerance[metric] ?? config.avoidTolerance)
            : (config.metricTolerance[metric] ?? config.tolerance);
      const check: GateCheck = { profile: profile.name, metric, direction, baseline: baseValue, current: now ? now.value : null, delta: null, allowed, allowedKind: kind, status: 'ok' };
      if (!now) {
        check.status = 'missing';
      } else {
        const delta = round(now.value - baseValue);
        check.delta = delta;
        if (direction === 'higher') {
          if (-delta > allowed + EPS) check.status = 'regressed';
          else if (delta > EPS) check.status = 'improved';
        } else if (kind === 'absolute') {
          if (delta > allowed + EPS) check.status = 'regressed';
          else if (delta < -EPS) check.status = 'improved';
        } else {
          const limit = baseValue * (1 + allowed);
          const worse = now.value > limit + EPS && (!isLatency || delta > config.latencyMinDeltaMs);
          if (worse) check.status = 'regressed';
          else if (delta < -EPS) check.status = 'improved';
        }
      }
      checks.push(check);
    }
  }
  const stale = problems.length > 0 && options.allowStale;
  if (unknown.length > 0) return { status: 'unknown_profile', problems: [...problems, ...unknown], checks, exitCode: 3 };
  const failed = checks.some((c) => c.status === 'regressed' || c.status === 'missing');
  return { status: failed ? 'regression' : 'pass', problems: stale ? problems : [], checks, exitCode: failed ? 1 : 0 };
}

