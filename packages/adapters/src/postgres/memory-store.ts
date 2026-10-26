import type pg from 'pg';
import {
  decodeCursor,
  defaultFilter,
  encodeCursor,
  isUuid,
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_MAX_LIMIT,
  type ClaimResult,
  type Memory,
  type MemoryFilter,
  type MemoryInsert,
  type MemoryLink,
  type MemoryListQuery,
  type MemoryPage,
  type MemoryPatch,
  type MemoryStore,
  type MemoryStoreTx,
  type Observation,
  type ObservationStatus,
  type StoredObservation,
  type TextHit,
  type TextSearchQuery,
} from '@smallseedlabs/proba-memory-core';
import { iso, isoOrNull, toVectorLiteral, withTransaction, type PgQueryable } from './pool.js';

// The vector and the generated full-text column are never read back with the row.
const MEMORY_COLUMNS = `id, workspace_id, category, content, summary, embedding_model, embedding_version, importance, confidence,
  usefulness, status, supersedes_id, valid_from, valid_to, last_accessed_at, access_count, last_reinforced_at, decayed_at,
  evidence_count, goal_id, thread_id, source_refs, provenance, created_at, updated_at`;

const OBSERVATION_COLUMNS = `id, workspace_id, source, source_ref, kind, occurred_at, trace_id, span_id, goal_id, thread_id, user_id,
  campaign_id, actor, target, text, facts, signal, significance, status, attempts, last_error, processed_at, created_at`;

type Row = Record<string, unknown>;

function toMemory(r: Row): Memory {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    category: r.category as Memory['category'],
    content: String(r.content),
    summary: (r.summary as string | null) ?? null,
    embeddingModel: (r.embedding_model as string | null) ?? null,
    embeddingVersion: (r.embedding_version as string | null) ?? null,
    importance: Number(r.importance),
    confidence: Number(r.confidence),
    usefulness: Number(r.usefulness),
    status: r.status as Memory['status'],
    supersedesId: (r.supersedes_id as string | null) ?? null,
    validFrom: iso(r.valid_from),
    validTo: isoOrNull(r.valid_to),
    lastAccessedAt: isoOrNull(r.last_accessed_at),
    accessCount: Number(r.access_count),
    lastReinforcedAt: iso(r.last_reinforced_at),
    decayedAt: isoOrNull(r.decayed_at),
    evidenceCount: Number(r.evidence_count),
    goalId: (r.goal_id as string | null) ?? null,
    threadId: (r.thread_id as string | null) ?? null,
    sourceRefs: (r.source_refs as Memory['sourceRefs']) ?? [],
    provenance: r.provenance as Memory['provenance'],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toObservation(r: Row): StoredObservation {
  const opt = <K extends string>(key: K, value: unknown): Partial<Record<K, string>> => (value === null || value === undefined ? {} : ({ [key]: String(value) } as Record<K, string>));
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    source: String(r.source),
    sourceRef: String(r.source_ref),
    kind: String(r.kind),
    occurredAt: iso(r.occurred_at),
    ...opt('traceId', r.trace_id),
    ...opt('spanId', r.span_id),
    ...opt('goalId', r.goal_id),
    ...opt('threadId', r.thread_id),
    ...opt('userId', r.user_id),
    ...opt('campaignId', r.campaign_id),
    ...(r.actor ? { actor: r.actor as { type: string; id: string } } : {}),
    ...(r.target ? { target: r.target as { type: string; id: string } } : {}),
    text: (r.text as string | null) ?? null,
    facts: (r.facts as StoredObservation['facts']) ?? {},
    signal: r.signal as StoredObservation['signal'],
    significance: r.significance as StoredObservation['significance'],
    status: r.status as ObservationStatus,
    attempts: Number(r.attempts),
    lastError: (r.last_error as string | null) ?? null,
    processedAt: isoOrNull(r.processed_at),
    createdAt: iso(r.created_at),
  };
}

/** Ids that are not uuids cannot exist; querying them would raise a cast error, so they are dropped first. */
const onlyUuids = (ids: string[]): string[] => [...new Set(ids)].filter(isUuid);

/**
 * Append the structured-filter conditions to `where`/`params`. The workspace condition is added by
 * the caller and always comes first. `alias` prefixes the column names.
 */
export function appendFilterSql(filter: MemoryFilter | undefined, where: string[], params: unknown[], alias = ''): void {
  const f = defaultFilter(filter);
  const col = (name: string): string => (alias ? `${alias}.${name}` : name);
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  where.push(`${col('status')} = ANY(${add(f.statuses)}::text[])`);
  if (f.categories?.length) where.push(`${col('category')} = ANY(${add(f.categories)}::text[])`);
  if (f.minConfidence !== undefined) where.push(`${col('confidence')} >= ${add(f.minConfidence)}`);
  if (f.minImportance !== undefined) where.push(`${col('importance')} >= ${add(f.minImportance)}`);
  if (f.goalId !== undefined) where.push(`${col('goal_id')} = ${add(f.goalId)}`);
  if (f.threadId !== undefined) where.push(`${col('thread_id')} = ${add(f.threadId)}`);
  if (f.sourceKind !== undefined) where.push(`${col('source_refs')} @> ${add(JSON.stringify([{ kind: f.sourceKind }]))}::jsonb`);
  if (f.createdFrom !== undefined) where.push(`${col('created_at')} >= ${add(f.createdFrom)}::timestamptz`);
  if (f.createdTo !== undefined) where.push(`${col('created_at')} < ${add(f.createdTo)}::timestamptz`);
}

/** A tsquery that matches any of the words: letters and digits only, so user text can never inject operators. */
export function buildTsQuery(text: string): string | null {
  const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((t) => t.length >= 2).slice(0, 32);
  return terms.length === 0 ? null : terms.join(' | ');
}

class PgReader {
  constructor(
    protected readonly db: PgQueryable,
    /** Lock rows read with getMemory (inside a transaction, so a read-modify-write cannot lose an update). */
    private readonly lockRows: boolean
  ) {}

  async getMemory(workspaceId: string, id: string): Promise<Memory | null> {
    if (!isUuid(id)) return null;
    const r = await this.db.query(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE workspace_id = $1 AND id = $2${this.lockRows ? ' FOR UPDATE' : ''}`,
      [workspaceId, id]
    );
    return r.rows[0] ? toMemory(r.rows[0]) : null;
  }

  async getMemories(workspaceId: string, ids: string[]): Promise<Memory[]> {
    const wanted = onlyUuids(ids);
    if (wanted.length === 0) return [];
    const r = await this.db.query(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, wanted]);
    return r.rows.map(toMemory);
  }

  async listMemories(q: MemoryListQuery): Promise<MemoryPage> {
    const limit = Math.min(q.limit ?? MEMORY_LIST_DEFAULT_LIMIT, MEMORY_LIST_MAX_LIMIT);
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) throw new Error('invalid cursor');
    if (cursor && !isUuid(cursor.id)) throw new Error('invalid cursor');
    const params: unknown[] = [q.workspaceId];
    const where = ['workspace_id = $1'];
    appendFilterSql(q.filter, where, params);
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const r = await this.db.query(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params
    );
    const memories = r.rows.map(toMemory);
    const page = memories.slice(0, limit);
    const last = page[page.length - 1];
    return { memories: page, nextCursor: memories.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  async searchText(q: TextSearchQuery): Promise<TextHit[]> {
    const tsQuery = buildTsQuery(q.query);
    if (!tsQuery) return [];
    const params: unknown[] = [q.workspaceId, tsQuery];
    const where = ['m.workspace_id = $1', 'm.content_tsv @@ query.q'];
    appendFilterSql(q.filter, where, params, 'm');
    params.push(q.limit);
    const r = await this.db.query(
      `SELECT m.id, ts_rank_cd(m.content_tsv, query.q) AS rank
       FROM memories m, to_tsquery('english'::regconfig, $2::text) AS query(q)
       WHERE ${where.join(' AND ')}
       ORDER BY rank DESC, m.id
       LIMIT $${params.length}`,
      params
    );
    return r.rows.map((row) => ({ id: String(row.id), rank: Number(row.rank) }));
  }

  async listLinks(workspaceId: string, memoryId: string): Promise<MemoryLink[]> {
    if (!isUuid(memoryId)) return [];
    const r = await this.db.query(
      `SELECT workspace_id, from_id, to_id, relation, weight, created_at FROM memory_links
       WHERE workspace_id = $1 AND (from_id = $2 OR to_id = $2) ORDER BY created_at, from_id, to_id, relation`,
      [workspaceId, memoryId]
    );
    return r.rows.map((row) => ({
      workspaceId: String(row.workspace_id),
      fromId: String(row.from_id),
      toId: String(row.to_id),
      relation: row.relation as MemoryLink['relation'],
      weight: Number(row.weight),
      createdAt: iso(row.created_at),
    }));
  }

  async getObservation(workspaceId: string, id: string): Promise<StoredObservation | null> {
    if (!isUuid(id)) return null;
    const r = await this.db.query(`SELECT ${OBSERVATION_COLUMNS} FROM observations WHERE workspace_id = $1 AND id = $2`, [workspaceId, id]);
    return r.rows[0] ? toObservation(r.rows[0]) : null;
  }

  async listObservationMemoryIds(workspaceId: string, observationId: string): Promise<string[]> {
    if (!isUuid(observationId)) return [];
    const r = await this.db.query(
      `SELECT DISTINCT ms.memory_id FROM memory_sources ms
       JOIN memories m ON m.id = ms.memory_id AND m.workspace_id = ms.workspace_id
       WHERE ms.workspace_id = $1 AND ms.observation_id = $2 ORDER BY ms.memory_id`,
      [workspaceId, observationId]
    );
    return r.rows.map((row) => String(row.memory_id));
  }

  async listWorkspaceIds(): Promise<string[]> {
    const r = await this.db.query('SELECT workspace_id FROM memories UNION SELECT workspace_id FROM observations ORDER BY 1');
    return r.rows.map((row) => String(row.workspace_id));
  }

  async countMemories(workspaceId: string, filter?: MemoryFilter): Promise<number> {
    const params: unknown[] = [workspaceId];
    const where = ['workspace_id = $1'];
    appendFilterSql(filter, where, params);
    const r = await this.db.query(`SELECT count(*)::int AS n FROM memories WHERE ${where.join(' AND ')}`, params);
    return Number(r.rows[0]?.n ?? 0);
  }
}

const PATCH_COLUMNS: Record<string, { column: string; cast?: string; json?: boolean }> = {
  content: { column: 'content' },
  summary: { column: 'summary' },
  importance: { column: 'importance' },
  confidence: { column: 'confidence' },
  usefulness: { column: 'usefulness' },
  status: { column: 'status' },
  validTo: { column: 'valid_to', cast: 'timestamptz' },
  lastReinforcedAt: { column: 'last_reinforced_at', cast: 'timestamptz' },
  decayedAt: { column: 'decayed_at', cast: 'timestamptz' },
  evidenceCount: { column: 'evidence_count' },
  sourceRefs: { column: 'source_refs', cast: 'jsonb', json: true },
  provenance: { column: 'provenance', cast: 'jsonb', json: true },
};

class PgTx extends PgReader implements MemoryStoreTx {
  constructor(readonly handle: pg.PoolClient) {
    super(handle, true);
  }

  async insertMemory(m: MemoryInsert): Promise<void> {
    const at = iso(m.createdAt ?? new Date().toISOString());
    await this.db.query(
      `INSERT INTO memories (id, workspace_id, category, content, summary, embedding, embedding_model, embedding_version, importance, confidence,
         usefulness, status, supersedes_id, valid_from, valid_to, last_accessed_at, access_count, last_reinforced_at, decayed_at, evidence_count,
         goal_id, thread_id, source_refs, provenance, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15::timestamptz, $16::timestamptz, $17,
         $18::timestamptz, $19::timestamptz, $20, $21, $22, $23::jsonb, $24::jsonb, $25::timestamptz, $25::timestamptz)`,
      [
        m.id, m.workspaceId, m.category, m.content, m.summary,
        m.embedding ? toVectorLiteral(m.embedding) : null,
        m.embedding ? m.embeddingModel : null,
        m.embedding ? m.embeddingVersion : null,
        m.importance, m.confidence, m.usefulness, m.status, m.supersedesId,
        iso(m.validFrom), m.validTo ? iso(m.validTo) : null, m.lastAccessedAt ? iso(m.lastAccessedAt) : null, m.accessCount,
        iso(m.lastReinforcedAt), m.decayedAt ? iso(m.decayedAt) : null, m.evidenceCount,
        m.goalId, m.threadId, JSON.stringify(m.sourceRefs), JSON.stringify(m.provenance), at,
      ]
    );
  }

  async updateMemory(workspaceId: string, id: string, patch: MemoryPatch, at: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const params: unknown[] = [workspaceId, id, iso(at)];
    const sets = ['updated_at = $3::timestamptz'];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || key === 'embedding') continue;
      const spec = PATCH_COLUMNS[key];
      if (!spec) throw new Error(`memory field ${key} cannot be changed`);
      params.push(spec.json ? JSON.stringify(value) : value instanceof Date ? value.toISOString() : value);
      sets.push(`${spec.column} = $${params.length}${spec.cast ? `::${spec.cast}` : ''}`);
    }
    if (patch.embedding) {
      params.push(toVectorLiteral(patch.embedding.vector), patch.embedding.model, patch.embedding.version);
      sets.push(`embedding = $${params.length - 2}::vector`, `embedding_model = $${params.length - 1}`, `embedding_version = $${params.length}`);
    }
    const r = await this.db.query(`UPDATE memories SET ${sets.join(', ')} WHERE workspace_id = $1 AND id = $2`, params);
    return (r.rowCount ?? 0) > 0;
  }

  async insertLink(link: MemoryLink): Promise<void> {
    // Joining both memories on the workspace means a link can never connect (or touch) another workspace's memories.
    await this.db.query(
      `INSERT INTO memory_links (workspace_id, from_id, to_id, relation, weight, created_at)
       SELECT $1, a.id, b.id, $4, $5, $6::timestamptz
       FROM memories a JOIN memories b ON b.workspace_id = a.workspace_id
       WHERE a.workspace_id = $1 AND a.id = $2::uuid AND b.id = $3::uuid
       ON CONFLICT DO NOTHING`,
      [link.workspaceId, link.fromId, link.toId, link.relation, link.weight, iso(link.createdAt)]
    );
  }

  async linkSource(workspaceId: string, memoryId: string, observationId: string, relation: 'created' | 'reinforced'): Promise<void> {
    await this.db.query(
      `INSERT INTO memory_sources (workspace_id, memory_id, observation_id, relation)
       SELECT $1, m.id, o.id, $4 FROM memories m JOIN observations o ON o.workspace_id = m.workspace_id
       WHERE m.workspace_id = $1 AND m.id = $2::uuid AND o.id = $3::uuid
       ON CONFLICT DO NOTHING`,
      [workspaceId, memoryId, observationId, relation]
    );
  }

  async recordAccess(workspaceId: string, ids: string[], at: string): Promise<void> {
    const wanted = onlyUuids(ids);
    if (wanted.length === 0) return;
    await this.db.query(
      'UPDATE memories SET access_count = access_count + 1, last_accessed_at = $3::timestamptz WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [workspaceId, wanted, iso(at)]
    );
  }

  async markObservation(workspaceId: string, id: string, status: Exclude<ObservationStatus, 'pending'>, at: string, error?: string): Promise<void> {
    const r = await this.db.query(
      'UPDATE observations SET status = $3, processed_at = $4::timestamptz, last_error = $5, updated_at = $4::timestamptz WHERE workspace_id = $1 AND id = $2',
      [workspaceId, id, status, iso(at), error ?? null]
    );
    if ((r.rowCount ?? 0) === 0) throw new Error(`observation ${id} was never claimed`);
  }
}

export interface PostgresMemoryStoreOptions {
  pool: pg.Pool;
}

/** MemoryStore on Postgres. Every statement is scoped by workspace_id. */
export class PostgresMemoryStore extends PgReader implements MemoryStore {
  private readonly pool: pg.Pool;

  constructor(options: PostgresMemoryStoreOptions) {
    super(options.pool, false);
    this.pool = options.pool;
  }

  async claimObservation(o: Observation, at: string): Promise<ClaimResult> {
    const inserted = await this.pool.query(
      `INSERT INTO observations (id, workspace_id, source, source_ref, kind, occurred_at, trace_id, span_id, goal_id, thread_id, user_id, campaign_id,
         actor, target, text, facts, signal, significance, status, attempts, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16::jsonb, $17::jsonb, $18, 'pending', 1,
         $19::timestamptz, $19::timestamptz)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [
        o.id, o.workspaceId, o.source, o.sourceRef, o.kind, iso(o.occurredAt),
        o.traceId ?? null, o.spanId ?? null, o.goalId ?? null, o.threadId ?? null, o.userId ?? null, o.campaignId ?? null,
        o.actor ? JSON.stringify(o.actor) : null, o.target ? JSON.stringify(o.target) : null,
        o.text, JSON.stringify(o.facts), JSON.stringify(o.signal), o.significance, iso(at),
      ]
    );
    if ((inserted.rowCount ?? 0) > 0) return 'new';
    const retry = await this.pool.query(
      `UPDATE observations SET attempts = attempts + 1, updated_at = $3::timestamptz
       WHERE id = $1 AND workspace_id = $2 AND status IN ('pending', 'failed') RETURNING id`,
      [o.id, o.workspaceId, iso(at)]
    );
    if ((retry.rowCount ?? 0) > 0) return 'reprocess';
    const existing = await this.pool.query('SELECT status FROM observations WHERE id = $1 AND workspace_id = $2', [o.id, o.workspaceId]);
    if (!existing.rows[0]) throw new Error(`observation id ${o.id} belongs to another workspace`);
    return 'done';
  }

  async recordObservationFailure(workspaceId: string, id: string, error: string, at: string): Promise<void> {
    if (!isUuid(id)) return;
    await this.pool.query('UPDATE observations SET last_error = $3, updated_at = $4::timestamptz WHERE workspace_id = $1 AND id = $2', [
      workspaceId,
      id,
      error.slice(0, 1000),
      iso(at),
    ]);
  }

  async transaction<T>(fn: (tx: MemoryStoreTx) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, (client) => fn(new PgTx(client)));
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    // The pool belongs to the runtime that created it.
  }
}
