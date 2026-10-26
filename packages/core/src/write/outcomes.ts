import type { ActionOutcomeLink, ActionRef, MetricRef } from '../ports/outcome-linker.js';

export interface OutcomeSample {
  /** UTC ISO 8601 time of the observation. */
  at: string;
  value: number;
}

/**
 * Compare a metric before and after an action: window means, relative change and the sample size behind
 * each window. This is a correlation, never proof of cause: the result always carries the caveat, and
 * `correlation` stays null until the outcome-learning milestone computes it.
 */
export function buildOutcomeLink(args: {
  workspaceId: string;
  action: ActionRef;
  metric: MetricRef;
  actionAt: string;
  windowMs: number;
  samples: OutcomeSample[];
}): ActionOutcomeLink {
  const at = new Date(args.actionAt).getTime();
  const beforeFrom = at - args.windowMs;
  const afterTo = at + args.windowMs;
  const before: number[] = [];
  const after: number[] = [];
  for (const s of args.samples) {
    const t = new Date(s.at).getTime();
    if (!Number.isFinite(s.value) || Number.isNaN(t)) continue;
    if (t >= beforeFrom && t < at) before.push(s.value);
    else if (t >= at && t < afterTo) after.push(s.value);
  }
  const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const beforeMean = mean(before);
  const afterMean = mean(after);
  return {
    workspaceId: args.workspaceId,
    action: args.action,
    metric: args.metric,
    before: { from: new Date(beforeFrom).toISOString(), to: new Date(at).toISOString() },
    after: { from: new Date(at).toISOString(), to: new Date(afterTo).toISOString() },
    beforeMean,
    afterMean,
    sampleSize: { before: before.length, after: after.length },
    relativeChange: before.length > 0 && beforeMean !== 0 ? (afterMean - beforeMean) / Math.abs(beforeMean) : null,
    correlation: null,
    method: 'window-means',
    caveat: 'correlation_not_causation',
  };
}
