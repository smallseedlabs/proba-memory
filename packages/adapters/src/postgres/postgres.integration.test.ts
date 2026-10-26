import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  makeMemoryInsert,
  makeObservation,
  runJobRunStoreContract,
  runMemoryStoreContract,
  runOutboxStoreContract,
  runRetrievalLogStoreContract,
  runScoringProfileStoreContract,
  runVectorIndexContract,
  seededVector,
  uniqueName,
} from '@smallseedlabs/proba-memory-core/testing';
import { migrate, readEmbeddingColumnDimension, readMigrations, DEFAULT_MIGRATIONS_DIR, renderMigration } from './migrate.js';
import { PostgresJobRunStore } from './job-run-store.js';
import { PostgresMemoryStore, buildTsQuery } from './memory-store.js';
import { PostgresOutboxStore } from './outbox-store.js';
import { PostgresScoringProfileStore } from './profile-store.js';
import { PostgresRetrievalLogStore } from './retrieval-log-store.js';
import { createPgPool } from './pool.js';
import { getTestPool, testDatabaseUrl, truncateOutbox, TEST_DIMENSION } from './test-db.js';
import { PostgresVectorIndex } from './vector-index.js';

const pool = await getTestPool();
afterAll(async () => {
  await pool.end();
});

runMemoryStoreContract('postgres', async () => ({ store: new PostgresMemoryStore({ pool }), dimension: TEST_DIMENSION }));
runVectorIndexContract('postgres (pgvector HNSW, cosine)', async () => ({
  store: new PostgresMemoryStore({ pool }),
  index: new PostgresVectorIndex({ pool, dimension: TEST_DIMENSION }),
}));
runScoringProfileStoreContract('postgres', async () => ({ store: new PostgresScoringProfileStore(pool) }));
runRetrievalLogStoreContract('postgres', async () => ({ store: new PostgresRetrievalLogStore(pool) }));
runJobRunStoreContract('postgres', async () => ({ store: new PostgresJobRunStore(pool) }));
runOutboxStoreContract('postgres', async () => {
  await truncateOutbox(pool);
  return { store: new PostgresOutboxStore({ pool }) };
});

describe('migrations', () => {
  it('are idempotent: a second run applies nothing', async () => {
    const result = await migrate({ pool, embeddingDimension: TEST_DIMENSION });
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied.length).toBe(readMigrations(DEFAULT_MIGRATIONS_DIR).length);
  });

  it('are numbered without gaps and render the embedding dimension', () => {
    const files = readMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(files.map((f) => f.version)).toEqual(files.map((_, i) => String(i + 1).padStart(4, '0')));
    expect(renderMigration('vector({{EMBEDDING_DIMENSION}})', 384)).toBe('vector(384)');
    expect(() => renderMigration('x', 5000)).toThrow(/between 1 and 2000/);
  });

  it('create the vector column with the configured dimension and an HNSW cosine index', async () => {
    expect(await readEmbeddingColumnDimension(pool)).toBe(TEST_DIMENSION);
    const idx = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'memories' AND indexname = 'memories_embedding_hnsw_idx'");
    expect(String(idx.rows[0]?.indexdef)).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
    const gin = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'memories' AND indexname = 'memories_content_tsv_idx'");
    expect(String(gin.rows[0]?.indexdef)).toMatch(/USING gin \(content_tsv\)/);
  });

  it('fail fast when the configured dimension differs from the stored one', async () => {
    await expect(migrate({ pool, embeddingDimension: 384 })).rejects.toThrow(/1024-dimension vectors but EMBEDDING_DIMENSION=384/);
  });

  it('refuse a migration whose file changed after it was applied', async () => {
    await pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '0003'");
    try {
      await expect(migrate({ pool, embeddingDimension: TEST_DIMENSION })).rejects.toThrow(/changed after it was applied/);
    } finally {
      const real = readMigrations(DEFAULT_MIGRATIONS_DIR).find((f) => f.version === '0003')!;
      await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [real.checksum, '0003']);
    }
  });

  it('serialise concurrent runners on a fresh database', async () => {
    const admin = createPgPool(testDatabaseUrl().replace(/\/[^/]+$/, '/postgres'), 1);
    const name = `proba_memory_mig_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const fresh = createPgPool(testDatabaseUrl().replace(/\/[^/]+$/, `/${name}`), 4);
    try {
      const runs = await Promise.all([1, 2, 3].map(() => migrate({ pool: fresh, embeddingDimension: 16 })));
      const total = runs.reduce((n, r) => n + r.applied.length, 0);
      expect(total).toBe(readMigrations(DEFAULT_MIGRATIONS_DIR).length);
      expect(await readEmbeddingColumnDimension(fresh)).toBe(16);
    } finally {
      await fresh.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  });
});

describe('PostgresMemoryStore specifics', () => {
  const store = new PostgresMemoryStore({ pool });

  it('builds a tsquery from words only, so user text cannot inject operators', () => {
    expect(buildTsQuery("Countdown timer! & (pushy) | 'x' <-> y:*")).toBe('countdown | timer | pushy');
    expect(buildTsQuery('   ')).toBeNull();
    expect(buildTsQuery('a b')).toBeNull();
  });

  it('full-text search matches any word, ranks by relevance, honours filters and never crosses workspaces', async () => {
    const ws = uniqueName('ws');
    const other = uniqueName('ws');
    const a = makeMemoryInsert(ws, { content: 'The user rejected the countdown timer banner as pushy', summary: null, category: 'semantic' });
    const b = makeMemoryInsert(ws, { content: 'Weekly spend reports are sent on Monday', summary: null, category: 'procedural' });
    const c = makeMemoryInsert(other, { content: 'Countdown timer banners are great', summary: null });
    await store.transaction(async (tx) => {
      for (const m of [a, b, c]) await tx.insertMemory(m);
    });
    const hits = await store.searchText({ workspaceId: ws, query: 'countdown timers!', limit: 10 });
    expect(hits.map((h) => h.id)).toEqual([a.id]);
    expect(await store.searchText({ workspaceId: ws, query: 'countdown spend', limit: 10, filter: { categories: ['procedural'] } })).toEqual([
      expect.objectContaining({ id: b.id }),
    ]);
    expect(await store.searchText({ workspaceId: ws, query: ';DROP TABLE memories;', limit: 10 })).toEqual([]);
  });

  it('claims an observation once, re-offers an unfinished one, and never lets another workspace take its id', async () => {
    const ws = uniqueName('ws');
    const o = makeObservation(ws);
    expect(await store.claimObservation(o, '2026-10-26T09:00:00.000Z')).toBe('new');
    expect(await store.claimObservation(o, '2026-10-26T09:00:01.000Z')).toBe('reprocess');
    await store.transaction((tx) => tx.markObservation(ws, o.id, 'processed', '2026-10-26T09:00:02.000Z'));
    expect(await store.claimObservation(o, '2026-10-26T09:00:03.000Z')).toBe('done');
    const stored = await store.getObservation(ws, o.id);
    expect(stored).toMatchObject({ status: 'processed', attempts: 2 });
    await expect(store.claimObservation({ ...o, workspaceId: uniqueName('ws') }, '2026-10-26T09:00:04.000Z')).rejects.toThrow(/another workspace/);
    expect(await store.getObservation(uniqueName('ws'), o.id)).toBeNull();
  });

  it('locks a memory read inside a transaction so concurrent read-modify-write cannot lose an update', async () => {
    const ws = uniqueName('ws');
    const m = makeMemoryInsert(ws, { evidenceCount: 0 });
    await store.transaction((tx) => tx.insertMemory(m));
    const bump = (): Promise<void> =>
      store.transaction(async (tx) => {
        const current = await tx.getMemory(ws, m.id);
        await new Promise((r) => setTimeout(r, 20));
        await tx.updateMemory(ws, m.id, { evidenceCount: current!.evidenceCount + 1 }, new Date().toISOString());
      });
    await Promise.all([bump(), bump(), bump()]);
    expect((await store.getMemory(ws, m.id))!.evidenceCount).toBe(3);
  });

  it('rolls back everything, including the observation state, when the transaction fails', async () => {
    const ws = uniqueName('ws');
    const o = makeObservation(ws);
    await store.claimObservation(o, '2026-10-26T09:00:00.000Z');
    const m = makeMemoryInsert(ws);
    await expect(
      store.transaction(async (tx) => {
        await tx.insertMemory(m);
        await tx.linkSource(ws, m.id, o.id, 'created');
        await tx.markObservation(ws, o.id, 'processed', '2026-10-26T09:00:01.000Z');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(await store.getMemory(ws, m.id)).toBeNull();
    expect((await store.getObservation(ws, o.id))!.status).toBe('pending');
    expect(await store.listObservationMemoryIds(ws, o.id)).toEqual([]);
  });

  it('refuses to link memories across workspaces', async () => {
    const wsA = uniqueName('ws');
    const wsB = uniqueName('ws');
    const a = makeMemoryInsert(wsA);
    const b = makeMemoryInsert(wsB);
    await store.transaction(async (tx) => {
      await tx.insertMemory(a);
      await tx.insertMemory(b);
      await tx.insertLink({ workspaceId: wsA, fromId: a.id, toId: b.id, relation: 'supports', weight: 0.9, createdAt: '2026-10-26T09:00:00.000Z' });
    });
    expect(await store.listLinks(wsA, a.id)).toEqual([]);
    expect(await store.listLinks(wsB, b.id)).toEqual([]);
  });

  it('treats ids that are not uuids as absent instead of failing', async () => {
    const ws = uniqueName('ws');
    expect(await store.getMemory(ws, 'not-a-uuid')).toBeNull();
    expect(await store.getMemories(ws, ['x', randomUUID()])).toEqual([]);
    expect(await store.transaction((tx) => tx.updateMemory(ws, 'nope', { importance: 0.1 }, new Date().toISOString()))).toBe(false);
    await expect(store.listMemories({ workspaceId: ws, cursor: Buffer.from('2026-10-26T09:00:00.000Z|zzz').toString('base64url') })).rejects.toThrow(/invalid cursor/);
  });

  it('filters by the kind of source behind a memory', async () => {
    const ws = uniqueName('ws');
    const approval = makeMemoryInsert(ws, { sourceRefs: [{ kind: 'approval', id: randomUUID(), ref: 'dev:approval/1' }] });
    const audit = makeMemoryInsert(ws, { sourceRefs: [{ kind: 'audit', id: randomUUID(), ref: 'audit:1' }] });
    await store.transaction(async (tx) => {
      await tx.insertMemory(approval);
      await tx.insertMemory(audit);
    });
    const page = await store.listMemories({ workspaceId: ws, filter: { sourceKind: 'approval' } });
    expect(page.memories.map((m) => m.id)).toEqual([approval.id]);
  });
});

describe('PostgresVectorIndex specifics', () => {
  const store = new PostgresMemoryStore({ pool });
  const index = new PostgresVectorIndex({ pool, dimension: TEST_DIMENSION });

  it('answers a nearest-neighbour query through the HNSW index when the planner prefers it', async () => {
    const ws = uniqueName('ws');
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const m = makeMemoryInsert(ws, { embedding: seededVector(TEST_DIMENSION, i + 1), embeddingModel: 'm', embeddingVersion: '1' });
      await store.transaction((tx) => tx.insertMemory(m));
      ids.push(m.id);
    }
    const hits = await index.search({ workspaceId: ws, vector: seededVector(TEST_DIMENSION, 7), limit: 3, model: 'm', version: '1' });
    expect(hits[0].id).toBe(ids[6]);
    expect(hits[0].similarity).toBeCloseTo(1, 5);
    // Force the index and check the plan actually uses it (proves the operator class matches the query).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query('EXPLAIN SELECT id FROM memories WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 3', [
        `[${seededVector(TEST_DIMENSION, 7).join(',')}]`,
      ]);
      expect(plan.rows.map((r) => String(r['QUERY PLAN'])).join('\n')).toContain('memories_embedding_hnsw_idx');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('rejects a vector of the wrong length before touching the database', async () => {
    await expect(index.search({ workspaceId: 'w', vector: [1, 2, 3], limit: 1, model: 'm', version: '1' })).rejects.toThrow(/dimensions/);
    await expect(index.upsert([{ id: randomUUID(), workspaceId: 'w', vector: [1], model: 'm', version: '1' }])).rejects.toThrow(/dimensions/);
  });
});
