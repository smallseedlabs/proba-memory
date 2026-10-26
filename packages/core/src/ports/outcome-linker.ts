/**
 * OutcomeLinker port (interface only in M1): links an action (an approved plan, a budget change, a
 * creative swap) to later metric outcomes. A link is a CORRELATION with its sample size, never a
 * causal claim; consumers must show `sampleSize` and `caveat` next to any effect.
 */

export interface ActionRef {
  kind: 'approval' | 'goal' | 'command' | 'other';
  id: string;
  /** Observation that recorded the action, when known. */
  observationId?: string;
}

export interface MetricRef {
  platform: string;
  accountId?: string;
  campaignId?: string;
  /** Metric name from the protocol, for example `conversions`, `spend`, `clicks`. */
  metric: string;
}

export interface ActionOutcomeLink {
  workspaceId: string;
  action: ActionRef;
  metric: MetricRef;
  /** Window before the action and window after it, UTC ISO 8601. */
  before: { from: string; to: string };
  after: { from: string; to: string };
  /** Mean of the metric in each window and the sample count behind each. */
  beforeMean: number;
  afterMean: number;
  sampleSize: { before: number; after: number };
  /** Relative change (after - before) / before, null when `before` is 0. */
  relativeChange: number | null;
  /** Correlation coefficient of the metric with the action indicator, -1..1, when computed. */
  correlation: number | null;
  method: string;
  caveat: 'correlation_not_causation';
}

export interface OutcomeLinker {
  readonly name: string;
  /** Record a computed link (idempotent by action + metric + windows). */
  record(link: ActionOutcomeLink): Promise<void>;
  list(workspaceId: string, action?: ActionRef): Promise<ActionOutcomeLink[]>;
}
