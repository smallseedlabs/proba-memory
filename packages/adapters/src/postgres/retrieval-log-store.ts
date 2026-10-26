import type pg from 'pg';
import { isUuid, type RetrievalLogEntry, type RetrievalLogStore } from '@smallseedlabs/proba-memory-core';
import { iso, type PgQueryable } from './pool.js';

const COLUMNS = `id, workspace_id, trace_id, actor_type, actor_id, query_text, query_hash, filter, profile_name, profile_version, profile_served,
  shadow_profile_version, candidates, shadow_results, results, stats, created_at`;

function toEntry(r: Record<string, unknown>): RetrievalLogEntry {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    traceId: String(r.trace_id),
    actorType: String(r.actor_type),
    actorId: String(r.actor_id),
    queryText: String(r.query_text),
    queryHash: String(r.query_hash),
    filter: (r.filter as RetrievalLogEntry['filter']) ?? {},
    profileName: String(r.profile_name),
    profileVersion: Number(r.profile_version),
    profileServed: r.profile_served as RetrievalLogEntry['profileServed'],
    shadowProfileVersion: r.shadow_profile_version === null ? null : Number(r.shadow_profile_version),
    candidates: r.candidates as RetrievalLogEntry['candidates'],
    shadowResults: (r.shadow_results as RetrievalLogEntry['shadowResults']) ?? null,
    results: r.results as RetrievalLogEntry['results'],
    stats: r.stats as RetrievalLogEntry['stats'],
    createdAt: iso(r.created_at),
  };
}

/** RetrievalLogStore on Postgres (`retrieval_log`). */
export class PostgresRetrievalLogStore implements RetrievalLogStore {
  constructor(private readonly pool: pg.Pool) {}

  async append(entry: RetrievalLogEntry, tx?: unknown): Promise<void> {
    const db: PgQueryable = (tx as PgQueryable | undefined) ?? this.pool;
    await db.query(
      `INSERT INTO retrieval_log (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::timestamptz)`,
      [
        entry.id, entry.workspaceId, entry.traceId, entry.actorType, entry.actorId, entry.queryText, entry.queryHash, JSON.stringify(entry.filter),
        entry.profileName, entry.profileVersion, entry.profileServed, entry.shadowProfileVersion,
        JSON.stringify(entry.candidates), entry.shadowResults ? JSON.stringify(entry.shadowResults) : null, JSON.stringify(entry.results), JSON.stringify(entry.stats),
        iso(entry.createdAt),
      ]
    );
  }

  async get(workspaceId: string, id: string): Promise<RetrievalLogEntry | null> {
    if (!isUuid(id)) return null;
    const r = await this.pool.query(`SELECT ${COLUMNS} FROM retrieval_log WHERE workspace_id = $1 AND id = $2`, [workspaceId, id]);
    return r.rows[0] ? toEntry(r.rows[0]) : null;
  }

  async list(workspaceId: string, options: { limit?: number } = {}): Promise<RetrievalLogEntry[]> {
    const r = await this.pool.query(`SELECT ${COLUMNS} FROM retrieval_log WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [
      workspaceId,
      Math.min(options.limit ?? 50, 500),
    ]);
    return r.rows.map(toEntry);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    // The pool belongs to the runtime that created it.
  }
}
