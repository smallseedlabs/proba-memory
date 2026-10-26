/**
 * OutboxStore port: the transactional-outbox pattern for audit events.
 *
 * A service enqueue()s events in the SAME database transaction as its business
 * change (pass the transaction handle as `tx`), so an event exists if and only
 * if the change committed. An OutboxRelay later claim()s rows and publishes them
 * to the EventBus, then markPublished(). Publishing is at-least-once; the
 * audit consumer dedupes by eventId.
 *
 * `Tx` is whatever the adapter's database client uses as a transaction handle
 * (a pg PoolClient for the Postgres adapter). The in-memory adapter ignores it.
 */

import type { AuditEvent } from '../domain/audit.js';

export interface OutboxEntry {
  /** Adapter-assigned id, ascending in enqueue order. A decimal string. */
  id: string;
  event: AuditEvent;
  /** UTC ISO 8601 with trailing Z. */
  createdAt: string;
  /** How many times this row has been claimed (1 on the first claim). */
  attempts: number;
}

export interface OutboxStore<Tx = unknown> {
  /**
   * Insert events (dedupe by eventId: an eventId already in the outbox is ignored).
   * With `tx` the insert runs inside that transaction and becomes visible on commit.
   * Returns how many rows were newly inserted.
   */
  enqueue(events: AuditEvent[], tx?: Tx): Promise<number>;
  /**
   * Claim up to `limit` unpublished rows, oldest first. Claimed rows are leased
   * for `leaseMs`: other claimers skip them until the lease expires, so several
   * relays can run side by side (FOR UPDATE SKIP LOCKED in Postgres).
   */
  claim(limit: number, leaseMs: number): Promise<OutboxEntry[]>;
  /** Mark rows as published; they are never claimed again. */
  markPublished(ids: string[]): Promise<void>;
  /** Record a failed publish. The row becomes claimable again when its lease expires. */
  markFailed(ids: string[], error: string): Promise<void>;
  /** Rows not yet published. */
  pendingCount(): Promise<number>;
  /** Delete published rows published before `cutoff` (UTC ISO). Returns the number deleted. */
  prunePublished(cutoff: string): Promise<number>;
  /** Throws if the backing database is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
