import type pg from 'pg';
import {
  isUuid,
  type EmbeddingMigrationStats,
  type EmbeddingMigrationStore,
  type EmbeddingTarget,
  type PendingEmbedding,
} from '@smallseedlabs/proba-memory-core';
import { toVectorLiteral, withTransaction } from './pool.js';

export interface PostgresEmbeddingMigrationStoreOptions {
  pool: pg.Pool;
  dimension: number;
}

/**
 * EmbeddingMigrationStore on Postgres: the staged vector lives in `memories.embedding_next` (+ model, version),
 * beside the served `embedding` column. The HNSW index covers `embedding` only, so staging never touches search.
 * The cutover is a single UPDATE inside a transaction that first checks nothing is still pending.
 */
export class PostgresEmbeddingMigrationStore implements EmbeddingMigrationStore {
  private readonly pool: pg.Pool;
  private readonly dimension: number;

  constructor(options: PostgresEmbeddingMigrationStoreOptions) {
    this.pool = options.pool;
    this.dimension = options.dimension;
  }

  async listPending(workspaceId: string, target: EmbeddingTarget, limit: number): Promise<PendingEmbedding[]> {
    const r = await this.pool.query(
      `SELECT id, content FROM memories
       WHERE workspace_id = $1 AND status = 'active'
         AND NOT (embedding IS NOT NULL AND embedding_model = $2 AND embedding_version = $3)
         AND NOT (embedding_next IS NOT NULL AND embedding_next_model = $2 AND embedding_next_version = $3)
       ORDER BY id LIMIT $4`,
      [workspaceId, target.model, target.version, limit]
    );
    return r.rows.map((row) => ({ id: String(row.id), text: String(row.content) }));
  }

  async stats(workspaceId: string, target: EmbeddingTarget): Promise<EmbeddingMigrationStats> {
    const r = await this.pool.query(
      `SELECT
         count(*)::int AS active,
         count(*) FILTER (WHERE embedding IS NOT NULL AND embedding_model = $2 AND embedding_version = $3)::int AS at_target,
         count(*) FILTER (WHERE NOT (embedding IS NOT NULL AND embedding_model = $2 AND embedding_version = $3)
                            AND embedding_next IS NOT NULL AND embedding_next_model = $2 AND embedding_next_version = $3)::int AS staged
       FROM memories WHERE workspace_id = $1 AND status = 'active'`,
      [workspaceId, target.model, target.version]
    );
    const row = r.rows[0] ?? {};
    const active = Number(row.active ?? 0);
    const atTarget = Number(row.at_target ?? 0);
    const staged = Number(row.staged ?? 0);
    return { active, atTarget, staged, pending: active - atTarget - staged };
  }

  async writeStaged(workspaceId: string, target: EmbeddingTarget, items: { id: string; vector: number[] }[]): Promise<number> {
    const valid = items.filter((i) => isUuid(i.id));
    if (valid.length === 0) return 0;
    for (const i of valid) {
      if (i.vector.length !== this.dimension) throw new Error(`vector has ${i.vector.length} dimensions, the column uses ${this.dimension}`);
    }
    const r = await this.pool.query(
      `UPDATE memories m SET embedding_next = u.vec::vector, embedding_next_model = $3, embedding_next_version = $4
       FROM unnest($1::uuid[], $2::text[]) AS u(id, vec)
       WHERE m.id = u.id AND m.workspace_id = $5 AND m.status = 'active'`,
      [valid.map((i) => i.id), valid.map((i) => toVectorLiteral(i.vector)), target.model, target.version, workspaceId]
    );
    return r.rowCount ?? 0;
  }

  async cutover(workspaceId: string, target: EmbeddingTarget): Promise<{ swapped: number; pending: number }> {
    return withTransaction(this.pool, async (client) => {
      // Serialise concurrent cutovers of the same workspace.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [`reembed:${workspaceId}`]);
      const stats = await client.query(
        `SELECT count(*)::int AS pending FROM memories
         WHERE workspace_id = $1 AND status = 'active'
           AND NOT (embedding IS NOT NULL AND embedding_model = $2 AND embedding_version = $3)
           AND NOT (embedding_next IS NOT NULL AND embedding_next_model = $2 AND embedding_next_version = $3)`,
        [workspaceId, target.model, target.version]
      );
      const pending = Number(stats.rows[0]?.pending ?? 0);
      if (pending > 0) return { swapped: 0, pending };
      const r = await client.query(
        `UPDATE memories SET embedding = embedding_next, embedding_model = embedding_next_model, embedding_version = embedding_next_version,
           embedding_next = NULL, embedding_next_model = NULL, embedding_next_version = NULL
         WHERE workspace_id = $1 AND status = 'active'
           AND embedding_next IS NOT NULL AND embedding_next_model = $2 AND embedding_next_version = $3
           AND NOT (embedding IS NOT NULL AND embedding_model = $2 AND embedding_version = $3)`,
        [workspaceId, target.model, target.version]
      );
      return { swapped: r.rowCount ?? 0, pending: 0 };
    });
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    // The pool belongs to the runtime that created it.
  }
}
