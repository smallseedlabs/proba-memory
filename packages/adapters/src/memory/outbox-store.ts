import type { AuditEvent, Clock, OutboxEntry, OutboxStore } from '@smallseedlabs/proba-memory-core';

interface Row {
  id: number;
  event: AuditEvent;
  createdAt: string;
  lockedUntil: number;
  attempts: number;
  lastError?: string;
  publishedAt?: number;
}

/**
 * In-process OutboxStore following the port's semantics. The `tx` argument is
 * ignored: there is no database transaction to join. For tests and local runs.
 */
export class InMemoryOutboxStore implements OutboxStore {
  private readonly rows: Row[] = [];
  private readonly ids = new Set<string>();
  private nextId = 1;

  constructor(
    private readonly clock: Clock = { now: () => new Date(), isoNow: () => new Date().toISOString() }
  ) {}

  async enqueue(events: AuditEvent[]): Promise<number> {
    let inserted = 0;
    for (const event of events) {
      if (this.ids.has(event.eventId)) continue;
      this.ids.add(event.eventId);
      this.rows.push({
        id: this.nextId++,
        event: structuredClone(event),
        createdAt: this.clock.isoNow(),
        lockedUntil: 0,
        attempts: 0,
      });
      inserted += 1;
    }
    return inserted;
  }

  async claim(limit: number, leaseMs: number): Promise<OutboxEntry[]> {
    const now = this.clock.now().getTime();
    const claimed: OutboxEntry[] = [];
    for (const row of this.rows) {
      if (claimed.length >= limit) break;
      if (row.publishedAt !== undefined || row.lockedUntil > now) continue;
      row.lockedUntil = now + leaseMs;
      row.attempts += 1;
      claimed.push({ id: String(row.id), event: structuredClone(row.event), createdAt: row.createdAt, attempts: row.attempts });
    }
    return claimed;
  }

  async markPublished(ids: string[]): Promise<void> {
    const now = this.clock.now().getTime();
    for (const row of this.rows) if (ids.includes(String(row.id))) row.publishedAt = now;
  }

  async markFailed(ids: string[], error: string): Promise<void> {
    for (const row of this.rows) if (ids.includes(String(row.id))) row.lastError = error;
  }

  async pendingCount(): Promise<number> {
    return this.rows.filter((r) => r.publishedAt === undefined).length;
  }

  async prunePublished(cutoff: string): Promise<number> {
    const limit = Date.parse(cutoff);
    const keep = this.rows.filter((r) => r.publishedAt === undefined || r.publishedAt >= limit);
    const pruned = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return pruned;
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
