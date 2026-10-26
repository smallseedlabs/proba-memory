import type pg from 'pg';
import { isUuid, type VectorEntry, type VectorHit, type VectorIndex, type VectorSearchQuery } from '@smallseedlabs/proba-memory-core';
import { appendFilterSql } from './memory-store.js';
import { parseVectorLiteral, toVectorLiteral, withTransaction } from './pool.js';

export interface PostgresVectorIndexOptions {
  pool: pg.Pool;
  dimension: number;
}

/** pgvector HNSW index on `memories.embedding` (cosine distance). It shares the database with the memory store. */
export class PostgresVectorIndex implements VectorIndex {
  readonly name = 'pgvector';
  readonly dimension: number;
  private readonly pool: pg.Pool;
  private iterativeScan: boolean | null = null;

  constructor(options: PostgresVectorIndexOptions) {
    this.pool = options.pool;
    this.dimension = options.dimension;
  }

  private check(vector: number[]): void {
    if (vector.length !== this.dimension) throw new Error(`vector has ${vector.length} dimensions, the index uses ${this.dimension}`);
  }

  async upsert(entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;
    for (const e of entries) this.check(e.vector);
    const valid = entries.filter((e) => isUuid(e.id));
    if (valid.length === 0) return;
    await this.pool.query(
      `UPDATE memories m SET embedding = u.vec::vector, embedding_model = u.model, embedding_version = u.version
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]) AS u(id, ws, vec, model, version)
       WHERE m.id = u.id AND m.workspace_id = u.ws`,
      [valid.map((e) => e.id), valid.map((e) => e.workspaceId), valid.map((e) => toVectorLiteral(e.vector)), valid.map((e) => e.model), valid.map((e) => e.version)]
    );
  }

  /** pgvector 0.8+ can keep scanning the graph until enough rows pass the filters; older versions cannot. */
  private async supportsIterativeScan(client: pg.PoolClient): Promise<boolean> {
    if (this.iterativeScan === null) {
      const r = await client.query("SELECT 1 FROM pg_settings WHERE name = 'hnsw.iterative_scan'");
      this.iterativeScan = (r.rowCount ?? 0) > 0;
    }
    return this.iterativeScan;
  }

  async search(q: VectorSearchQuery): Promise<VectorHit[]> {
    this.check(q.vector);
    if (q.limit <= 0) return [];
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT set_config('hnsw.ef_search', $1, true)", [String(Math.min(1000, Math.max(100, q.limit * 2)))]);
      if (await this.supportsIterativeScan(client)) await client.query("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)");
      const params: unknown[] = [q.workspaceId, toVectorLiteral(q.vector), q.model, q.version];
      const where = ['workspace_id = $1', 'embedding IS NOT NULL', 'embedding_model = $3', 'embedding_version = $4'];
      appendFilterSql(q.filter, where, params);
      params.push(q.limit);
      const r = await client.query(
        `SELECT id, 1 - (embedding <=> $2::vector) AS similarity FROM memories
         WHERE ${where.join(' AND ')} ORDER BY embedding <=> $2::vector LIMIT $${params.length}`,
        params
      );
      return r.rows.map((row) => ({ id: String(row.id), similarity: Number(row.similarity) }));
    });
  }

  async getVectors(workspaceId: string, ids: string[]): Promise<Map<string, number[]>> {
    const wanted = [...new Set(ids)].filter(isUuid);
    const out = new Map<string, number[]>();
    if (wanted.length === 0) return out;
    const r = await this.pool.query('SELECT id, embedding::text AS embedding FROM memories WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND embedding IS NOT NULL', [
      workspaceId,
      wanted,
    ]);
    for (const row of r.rows) out.set(String(row.id), parseVectorLiteral(String(row.embedding)));
    return out;
  }

  async remove(workspaceId: string, ids: string[]): Promise<void> {
    const wanted = [...new Set(ids)].filter(isUuid);
    if (wanted.length === 0) return;
    await this.pool.query(
      'UPDATE memories SET embedding = NULL, embedding_model = NULL, embedding_version = NULL WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [workspaceId, wanted]
    );
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    // The pool belongs to the runtime that created it.
  }
}
