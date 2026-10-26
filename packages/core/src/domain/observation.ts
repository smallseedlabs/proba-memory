/**
 * An Observation is something that happened, normalised by a SourceAdapter: a goal was created,
 * an approval was rejected, a message was written. Observations feed extraction; they are stored
 * (redacted) so that processing is idempotent and auditable.
 */

import type { Stance } from './memory.js';

export type FactValue = string | number | boolean | null | (string | number | boolean)[];

export interface ObservationSignal {
  polarity: Stance;
  /** 0..1. Approvals and rejections are the strongest preference signal. */
  strength: number;
  reason?: string;
}

export interface Observation {
  /** Deterministic from (source, external id): the idempotency key of the write path. */
  id: string;
  workspaceId: string;
  /** Adapter that produced it: `audit`, `hub-content`, ... */
  source: string;
  /** Namespaced reference of the original record, for example `audit:<eventId>` or `dev:goal-3`. */
  sourceRef: string;
  /** What happened, for example `approval.rejected` or `goal.created` or `thread.message`. */
  kind: string;
  /** UTC ISO 8601. */
  occurredAt: string;
  traceId?: string;
  spanId?: string;
  goalId?: string;
  threadId?: string;
  userId?: string;
  campaignId?: string;
  actor?: { type: string; id: string };
  target?: { type: string; id: string };
  /**
   * Text content, only when the source has it (the Hub content feed). Audit events never carry
   * message text, so for them this is null and `facts` holds ids, outcomes and lengths.
   */
  text: string | null;
  facts: Record<string, FactValue>;
  signal: ObservationSignal;
  /** `low`: recorded for completeness but not worth an LLM call. */
  significance: 'high' | 'normal' | 'low';
}

export type ObservationStatus = 'pending' | 'processed' | 'skipped' | 'failed';

export interface StoredObservation extends Observation {
  status: ObservationStatus;
  attempts: number;
  lastError: string | null;
  processedAt: string | null;
  createdAt: string;
}

export type ClaimResult = 'new' | 'reprocess' | 'done';
