import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PgQueryable } from './pool.js';
import type { AuditEvent, OutboxEntry, OutboxStore } from '@smallseedlabs/proba-memory-core';

export interface PostgresOutboxStoreOptions {
  /** Connection string. Ignored when `pool` is given. */
  connectionString?: string;
  /** Reuse the service's own pool (recommended: then the store never closes it). */
  pool?: pg.Pool;
  /** Table name. Default 'audit_outbox'. Must be a plain identifier. */
  table?: string;
}

/**
 * OutboxStore on Postgres, meant to live in the emitting service's own database.
 *
 *   const client = await pool.connect();
 *   await client.query('BEGIN');
 *   ... business changes ...
 *   await emitter.emit({ ... }, { tx: client });   // or outbox.enqueue([event], client)
 *   await client.query('COMMIT');
 *
 * The relay claims rows with FOR UPDATE SKIP LOCKED plus a lease, so any number
 * of relays can run. The schema is migrations/postgres/0005_audit_outbox.sql.
 */
export class PostgresOutboxStore implements OutboxStore<PgQueryable> {
  private readonly pool: pg.Pool;
  private readonly ownsPool: boolean;
  private readonly table: string;

  constructor(options: PostgresOutboxStoreOptions) {
    if (!options.pool && !options.connectionString) throw new Error('PostgresOutboxStore needs a pool or a connectionString');
    this.pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
    this.ownsPool = !options.pool;
    this.table = options.table ?? 'audit_outbox';
    if (!/^[a-z_][a-z0-9_]*$/i.test(this.table)) throw new Error(`invalid outbox table name: ${this.table}`);
  }

  /** Create the table if missing (the bundled migration). For tests and local runs; services should use their own migrations. */
  async ensureSchema(): Promise<void> {
    const sql = readFileSync(
      fileURLToPath(new URL('../../../../migrations/postgres/0005_audit_outbox.sql', import.meta.url)),
      'utf8'
    );
    await this.pool.query(this.table === 'audit_outbox' ? sql : sql.replaceAll('audit_outbox', this.table));
  }

  async enqueue(events: AuditEvent[], tx?: PgQueryable): Promise<number> {
    if (events.length === 0) return 0;
    const values: unknown[] = [];
    const tuples = events.map((e, i) => {
      values.push(e.eventId, JSON.stringify(e));
      return `($${i * 2 + 1}, $${i * 2 + 2}::jsonb)`;
    });
    const runner: PgQueryable = tx ?? this.pool;
    const result = await runner.query(
      `INSERT INTO ${this.table} (event_id, payload) VALUES ${tuples.join(', ')} ON CONFLICT (event_id) DO NOTHING`,
      values
    );
    return result.rowCount ?? 0;
  }

  async claim(limit: number, leaseMs: number): Promise<OutboxEntry[]> {
    const result = await this.pool.query(
      `UPDATE ${this.table} SET locked_until = now() + ($2::int * interval '1 millisecond'), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM ${this.table}
         WHERE published_at IS NULL AND (locked_until IS NULL OR locked_until < now())
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, payload, created_at, attempts`,
      [limit, leaseMs]
    );
    return result.rows
      .map((r) => ({
        id: String(r.id),
        event: r.payload as AuditEvent,
        createdAt: (r.created_at as Date).toISOString(),
        attempts: Number(r.attempts),
      }))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(`UPDATE ${this.table} SET published_at = now(), last_error = NULL WHERE id = ANY($1::bigint[])`, [ids]);
  }

  async markFailed(ids: string[], error: string): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(`UPDATE ${this.table} SET last_error = $2 WHERE id = ANY($1::bigint[])`, [ids, error.slice(0, 1000)]);
  }

  async pendingCount(): Promise<number> {
    const result = await this.pool.query(`SELECT count(*)::int AS n FROM ${this.table} WHERE published_at IS NULL`);
    return Number(result.rows[0]?.n ?? 0);
  }

  async prunePublished(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ${this.table} WHERE published_at IS NOT NULL AND published_at < $1::timestamptz`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
