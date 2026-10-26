import { z } from 'zod';
import { GoldenSetError } from './golden.js';

/**
 * Time-split backtest. Window `T`: replay every observation that happened up to `replayUntil`, then ask the
 * golden queries whose `asOf` lies after T (and at or before `queryUntil`, when set). Nothing after T is
 * ever written, so a profile cannot look into the future, and expectations that rest on later
 * observations are not held against it.
 */
export interface BacktestWindow {
  name: string;
  /** The split time T (UTC ISO 8601). Observations with occurredAt <= T are replayed. */
  replayUntil: string;
  /** Queries with asOf <= queryUntil are asked (null: no upper bound). */
  queryUntil: string | null;
}

const instant = z.string().refine((v) => Number.isFinite(Date.parse(v)) && /(Z|[+-]\d{2}:?\d{2})$/.test(v), 'a UTC ISO 8601 timestamp with a timezone');

export const windowSchema = z
  .object({ name: z.string().min(1).optional(), replayUntil: instant, queryUntil: instant.nullable().optional() })
  .strict();

export const rollingSchema = z
  .object({
    /** First split time. */
    from: instant,
    /** Last split time (inclusive). */
    to: instant,
    stepDays: z.number().positive(),
    /** How far after each split queries are asked. Default: one step. */
    horizonDays: z.number().positive().optional(),
  })
  .strict();

export type RollingInput = z.input<typeof rollingSchema>;

const DAY_MS = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const dateOf = (ms: number): string => iso(ms).slice(0, 10);

export function makeWindow(input: z.input<typeof windowSchema>): BacktestWindow {
  const parsed = windowSchema.parse(input);
  const replayUntil = iso(Date.parse(parsed.replayUntil));
  const queryUntil = parsed.queryUntil ? iso(Date.parse(parsed.queryUntil)) : null;
  if (queryUntil !== null && Date.parse(queryUntil) <= Date.parse(replayUntil)) {
    throw new GoldenSetError(`window ${replayUntil}: queryUntil must be after replayUntil`);
  }
  return { name: parsed.name ?? `T${dateOf(Date.parse(replayUntil))}`, replayUntil, queryUntil };
}

/** One window per split time, each asking queries up to `horizonDays` later (default: until the end). */
export function windowsFromSplits(splits: string[], horizonDays?: number): BacktestWindow[] {
  return splits.map((s) => {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) throw new GoldenSetError(`split "${s}" is not a UTC ISO 8601 timestamp`);
    return makeWindow({ replayUntil: s, ...(horizonDays ? { queryUntil: iso(ms + horizonDays * DAY_MS) } : {}) });
  });
}

/** Windows every `stepDays` from `from` to `to`; each asks queries for `horizonDays` (default one step) after its split. */
export function rollingWindows(input: RollingInput): BacktestWindow[] {
  const r = rollingSchema.parse(input);
  const from = Date.parse(r.from);
  const to = Date.parse(r.to);
  if (to < from) throw new GoldenSetError('rolling: `to` must not be before `from`');
  const horizon = (r.horizonDays ?? r.stepDays) * DAY_MS;
  const out: BacktestWindow[] = [];
  for (let t = from; t <= to + 1; t += r.stepDays * DAY_MS) {
    out.push(makeWindow({ replayUntil: iso(t), queryUntil: iso(t + horizon) }));
    if (out.length > 500) throw new GoldenSetError('rolling: more than 500 windows; use a larger step');
  }
  return out;
}

/** Fail on duplicate names so a report can address every window. */
export function assertUniqueWindows(windows: BacktestWindow[]): BacktestWindow[] {
  const seen = new Set<string>();
  for (const w of windows) {
    if (seen.has(w.name)) throw new GoldenSetError(`two windows are named "${w.name}"; give them distinct names`);
    seen.add(w.name);
  }
  return windows;
}
