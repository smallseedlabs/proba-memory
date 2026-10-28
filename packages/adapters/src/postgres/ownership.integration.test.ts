/**
 * Memory ownership on Postgres: the reader scope is part of the SQL of every candidate generator (vector, full text, structured and
 * by id), and migration 0008 adds the columns, backfills them from the evidence, and can be rolled back.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { makeMemoryInsert, makeObservation, seededVector, uniqueName } from '@smallseedlabs/proba-memory-core/testing';
import { DEFAULT_MIGRATIONS_DIR, migrate, readMigrations } from './migrate.js';
import { PostgresMemoryStore } from './memory-store.js';
import { createPgPool } from './pool.js';
import { getTestPool, testDatabaseUrl, TEST_DIMENSION } from './test-db.js';
import { PostgresVectorIndex } from './vector-index.js';

const pool = await getTestPool();
afterAll(async () => {
  await pool.end();
});

const MODEL = 'm';
const VERSION = '1';
const TOPIC = 'autumn banner countdown timer';

interface Captured {
  sql: string;
  params: unknown[];
}

/** A pool that records every statement it runs. */
function spyOn(real: pg.Pool): { pool: pg.Pool; statements: Captured[] } {
  const statements: Captured[] = [];
  const wrapQuery = (target: { query: (...args: any[]) => any }) => (sql: unknown, params?: unknown[]) => {
    const text = typeof sql === 'string' ? sql : String((sql as { text?: string }).text ?? '');
    statements.push({ sql: text, params: params ?? [] });
    return target.query(sql, params);
  };
  const spy = {
    query: wrapQuery(real),
    async connect() {
      const client = await real.connect();
      const query = wrapQuery(client);
      return new Proxy(client, { get: (target, prop) => (prop === 'query' ? query : (target as any)[prop]) });
    },
    end: () => real.end(),
  };
  return { pool: spy as unknown as pg.Pool, statements };
}

describe('the reader scope is part of every candidate query', () => {
  const store = new PostgresMemoryStore({ pool });
  const index = new PostgresVectorIndex({ pool, dimension: TEST_DIMENSION });

  async function seed(ws: string) {
    const q = seededVector(TEST_DIMENSION, 3);
    const specs = [
      ['mine', 'user-a', 'owner', 0.3],
      ['shared', null, 'workspace', 0.1],
      ['sharedByOther', 'user-b', 'workspace', 0.2],
      ['theirs', 'user-b', 'owner', 0.0],
      ['orphan', null, 'owner', 0.05],
    ] as const;
    const out: Record<string, string> = {};
    for (const [name, owner, visibility, spread] of specs) {
      const vector = spread === 0 ? q : seededVector(TEST_DIMENSION, 3).map((x, i) => x + spread * Math.sin(i + name.length));
      const m = makeMemoryInsert(ws, { content: `${TOPIC} ${name}`, summary: null, ownerActorId: owner, visibility, embedding: vector, embeddingModel: MODEL, embeddingVersion: VERSION });
      await store.transaction((tx) => tx.insertMemory(m));
      out[name] = m.id;
    }
    return { q, ids: out };
  }

  it('vector search, full-text search, listing and lookups return only what the user may read', async () => {
    const ws = uniqueName('ws');
    const { q, ids } = await seed(ws);
    const readable = [ids.mine, ids.shared, ids.sharedByOther].sort();
    const vector = await index.search({ workspaceId: ws, vector: q, limit: 10, model: MODEL, version: VERSION, filter: { visibleTo: 'user-a' } });
    expect(vector.map((h) => h.id).sort()).toEqual(readable);
    const text = await store.searchText({ workspaceId: ws, query: TOPIC, limit: 10, filter: { visibleTo: 'user-a' } });
    expect(text.map((h) => h.id).sort()).toEqual(readable);
    const listed = await store.listMemories({ workspaceId: ws, limit: 10, filter: { visibleTo: 'user-a' } });
    expect(listed.memories.map((m) => m.id).sort()).toEqual(readable);
    expect((await store.getMemories(ws, Object.values(ids), 'user-a')).map((m) => m.id).sort()).toEqual(readable);
    expect(await store.getMemory(ws, ids.theirs, 'user-a')).toBeNull();
    expect(await store.getMemory(ws, ids.orphan, 'user-a')).toBeNull();
    expect(await store.getMemory(ws, ids.theirs)).not.toBeNull();
    // Another workspace holds the same user's memory and sees none of these.
    const other = uniqueName('ws');
    expect((await index.search({ workspaceId: other, vector: q, limit: 10, model: MODEL, version: VERSION, filter: { visibleTo: 'user-a' } })).map((h) => h.id)).toEqual([]);
  });

  it('the best match of somebody else never takes the place of a readable one (the limit is applied after the scope)', async () => {
    const ws = uniqueName('ws');
    const { q, ids } = await seed(ws);
    // `theirs` is the exact vector, the nearest by far: with limit 1 a post-filter would return nothing.
    const unscoped = await index.search({ workspaceId: ws, vector: q, limit: 1, model: MODEL, version: VERSION });
    expect(unscoped.map((h) => h.id)).toEqual([ids.theirs]);
    const scoped = await index.search({ workspaceId: ws, vector: q, limit: 1, model: MODEL, version: VERSION, filter: { visibleTo: 'user-a' } });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].id).not.toBe(ids.theirs);
    expect([ids.mine, ids.shared, ids.sharedByOther]).toContain(scoped[0].id);
  });

  it('the statement of each candidate generator filters on the workspace and the owner or visibility, with the user as a parameter', async () => {
    const ws = uniqueName('ws');
    const { q, ids } = await seed(ws);
    const { pool: spied, statements } = spyOn(pool);
    const spiedStore = new PostgresMemoryStore({ pool: spied });
    const spiedIndex = new PostgresVectorIndex({ pool: spied, dimension: TEST_DIMENSION });
    const user = `user-${randomUUID()}`;
    const filter = { visibleTo: user };
    await spiedIndex.search({ workspaceId: ws, vector: q, limit: 5, model: MODEL, version: VERSION, filter });
    await spiedStore.searchText({ workspaceId: ws, query: TOPIC, limit: 5, filter });
    await spiedStore.listMemories({ workspaceId: ws, limit: 5, filter });
    await spiedStore.getMemory(ws, ids.mine, user);
    await spiedStore.getMemories(ws, [ids.mine], user);
    const reads = statements.filter((s) => /\bFROM memories\b/i.test(s.sql) && /\bSELECT\b/i.test(s.sql) && s.params.includes(user));
    expect(reads.length).toBeGreaterThanOrEqual(5);
    const generators = new Set<string>();
    for (const s of reads) {
      expect(s.sql, s.sql).toMatch(/workspace_id\s*=\s*\$1\b/);
      expect(s.sql, s.sql).toMatch(/\(\s*(?:\w+\.)?owner_actor_id\s*=\s*\$\d+\s+OR\s+(?:\w+\.)?visibility\s*=\s*'workspace'\s*\)/);
      expect(s.params[0], s.sql).toBe(ws);
      generators.add(/<=>/.test(s.sql) ? 'vector' : /tsquery|@@/.test(s.sql) ? 'text' : /ORDER BY/i.test(s.sql) ? 'structured' : 'lookup');
    }
    expect([...generators].sort()).toEqual(['lookup', 'structured', 'text', 'vector']);
  });

  it('a blank user is not a scope: it is treated as a user who owns nothing', async () => {
    const ws = uniqueName('ws');
    const { ids } = await seed(ws);
    const listed = await store.listMemories({ workspaceId: ws, limit: 10, filter: { visibleTo: '' } });
    expect(listed.memories.map((m) => m.id).sort()).toEqual([ids.shared, ids.sharedByOther].sort());
  });

  it('uses the (workspace_id, owner_actor_id) index for an owner lookup', async () => {
    const indexes = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'memories' AND indexname = 'memories_workspace_owner_idx'");
    expect(String(indexes.rows[0]?.indexdef)).toMatch(/\(workspace_id, owner_actor_id\)/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query("EXPLAIN SELECT id FROM memories WHERE workspace_id = 'w' AND owner_actor_id = 'u'");
      expect(plan.rows.map((r) => String(r['QUERY PLAN'])).join('\n')).toContain('memories_workspace_owner_idx');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('migration 0008: memory ownership', () => {
  const columns = async (p: pg.Pool): Promise<string[]> =>
    (await p.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'memories' AND column_name IN ('owner_actor_id', 'visibility') ORDER BY 1")).rows.map(
      (r) => String(r.column_name)
    );

  it('is the next version, creates the columns, the check and the index, and is documented as reversible', async () => {
    const files = readMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(files.at(-1)?.name).toMatch(/^\d{4}_/);
    const file = files.find((f) => f.name === '0008_memory_ownership.sql');
    expect(file).toBeDefined();
    expect(await columns(pool)).toEqual(['owner_actor_id', 'visibility']);
    const defaults = await pool.query("SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'memories' AND column_name IN ('owner_actor_id', 'visibility')");
    const byName = Object.fromEntries(defaults.rows.map((r) => [r.column_name, r]));
    expect(byName.owner_actor_id.is_nullable).toBe('YES');
    expect(byName.visibility.is_nullable).toBe('NO');
    expect(String(byName.visibility.column_default)).toContain("'owner'");
    const m = makeMemoryInsert(uniqueName('ws'));
    await new PostgresMemoryStore({ pool }).transaction((tx) => tx.insertMemory(m));
    await expect(pool.query("UPDATE memories SET visibility = 'everyone' WHERE id = $1", [m.id])).rejects.toThrow(/memories_visibility_check/);
    // The rollback is a documented, hand-run script the migrator never picks up.
    expect((await readdir(join(DEFAULT_MIGRATIONS_DIR, 'rollback'))).sort()).toContain('0008_memory_ownership.down.sql');
    expect(files.map((f) => f.name)).not.toContain('0008_memory_ownership.down.sql');
  });

  it('backfills the owner from the evidence on a database that already holds memories, and rolls back cleanly', async () => {
    const admin = createPgPool(testDatabaseUrl().replace(/\/[^/]+$/, '/postgres'), 1);
    const name = `proba_memory_own_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const fresh = createPgPool(testDatabaseUrl().replace(/\/[^/]+$/, `/${name}`), 4);
    try {
      // The database as it was before this change: every migration but 0008.
      const before = await mkdtemp(join(tmpdir(), 'proba-migrations-'));
      for (const f of readMigrations(DEFAULT_MIGRATIONS_DIR)) if (f.version !== '0008') await cp(join(DEFAULT_MIGRATIONS_DIR, f.name), join(before, f.name));
      const first = await migrate({ pool: fresh, embeddingDimension: 16, dir: before });
      expect(first.applied.at(-1)).toMatch(/^0007_/);
      expect(await columns(fresh)).toEqual([]);

      // Memories as they were written then (no ownership columns), with the observations they came from.
      const ws = 'ws-backfill';
      const at = '2026-10-26T09:00:00.000Z';
      const insertMemory = async (content: string): Promise<string> => {
        const id = randomUUID();
        await fresh.query(
          `INSERT INTO memories (id, workspace_id, category, content, embedding_model, embedding_version, importance, confidence, created_at, updated_at, valid_from, last_reinforced_at)
           VALUES ($1, $2, 'semantic', $3, 'm', '1', 0.5, 0.5, $4, $4, $4, $4)`,
          [id, ws, content, at]
        );
        return id;
      };
      const observe = async (overrides: Parameters<typeof makeObservation>[1]): Promise<string> => {
        const o = makeObservation(ws, overrides);
        await fresh.query(
          `INSERT INTO observations (id, workspace_id, source, source_ref, kind, occurred_at, user_id, actor, text, facts, signal, significance, status, attempts, created_at, updated_at)
           VALUES ($1, $2, 'audit', $3, 'x', $4, $5, $6::jsonb, NULL, '{}'::jsonb, '{"polarity":"neutral","strength":0.1}'::jsonb, 'normal', 'processed', 1, $4, $4)`,
          [o.id, ws, o.sourceRef, at, o.userId ?? null, o.actor ? JSON.stringify(o.actor) : null]
        );
        return o.id;
      };
      const link = (memoryId: string, observationId: string, relation: 'created' | 'reinforced' = 'created') =>
        fresh.query('INSERT INTO memory_sources (workspace_id, memory_id, observation_id, relation) VALUES ($1, $2, $3, $4)', [ws, memoryId, observationId, relation]);

      const byActor = await insertMemory('learned from a user action');
      await link(byActor, await observe({ actor: { type: 'user', id: 'user-a' } }));
      const byUserId = await insertMemory('learned from an event about a user');
      await link(byUserId, await observe({ actor: { type: 'system', id: 'brain' }, userId: 'user-b' }));
      const bySystem = await insertMemory('learned from a system event');
      await link(bySystem, await observe({ actor: { type: 'system', id: 'brain' } }));
      const mixed = await insertMemory('learned from two users');
      await link(mixed, await observe({ actor: { type: 'user', id: 'user-a' } }));
      await link(mixed, await observe({ actor: { type: 'user', id: 'user-b' } }));
      const same = await insertMemory('learned twice from one user');
      await link(same, await observe({ actor: { type: 'user', id: 'user-a' } }));
      await link(same, await observe({ actor: { type: 'user', id: 'user-a' } }));
      const reinforced = await insertMemory('created by one user, reinforced by another');
      await link(reinforced, await observe({ actor: { type: 'user', id: 'user-a' } }));
      await link(reinforced, await observe({ actor: { type: 'user', id: 'user-b' } }), 'reinforced');
      const noEvidence = await insertMemory('with no source at all');
      const longId = await insertMemory('from an actor id that is not a user id');
      await link(longId, await observe({ actor: { type: 'user', id: 'x'.repeat(200) } }));

      const second = await migrate({ pool: fresh, embeddingDimension: 16 });
      expect(second.applied).toEqual(['0008_memory_ownership.sql']);
      expect(await columns(fresh)).toEqual(['owner_actor_id', 'visibility']);
      const owners = async (): Promise<Record<string, string | null>> =>
        Object.fromEntries((await fresh.query('SELECT id, owner_actor_id FROM memories')).rows.map((r) => [r.id, r.owner_actor_id]));
      const expected = {
        [byActor]: 'user-a',
        [byUserId]: 'user-b',
        [bySystem]: null,
        [mixed]: null,
        [same]: 'user-a',
        [reinforced]: 'user-a',
        [noEvidence]: null,
        [longId]: null,
      };
      expect(await owners()).toEqual(expected);
      // Nothing is shared by the backfill: everything starts as visible to its owner only.
      expect((await fresh.query("SELECT count(*)::int AS n FROM memories WHERE visibility <> 'owner'")).rows[0].n).toBe(0);

      // Running the file again (as a retry would) changes nothing and does not fail.
      const file = readMigrations(DEFAULT_MIGRATIONS_DIR).find((f) => f.version === '0008')!;
      await fresh.query(file.sql);
      expect(await owners()).toEqual(expected);
      // Applying through the migrator twice is a no-op.
      expect((await migrate({ pool: fresh, embeddingDimension: 16 })).applied).toEqual([]);

      // The documented rollback removes both columns, the check and the index, and keeps the memories.
      await fresh.query(await readFile(join(DEFAULT_MIGRATIONS_DIR, 'rollback', '0008_memory_ownership.down.sql'), 'utf8'));
      await fresh.query("DELETE FROM schema_migrations WHERE version = '0008'");
      expect(await columns(fresh)).toEqual([]);
      expect((await fresh.query("SELECT 1 FROM pg_indexes WHERE indexname = 'memories_workspace_owner_idx'")).rowCount).toBe(0);
      expect((await fresh.query('SELECT count(*)::int AS n FROM memories')).rows[0].n).toBe(Object.keys(expected).length);
      // ...and it can be applied again afterwards, with the same backfill.
      expect((await migrate({ pool: fresh, embeddingDimension: 16 })).applied).toEqual(['0008_memory_ownership.sql']);
      expect(await owners()).toEqual(expected);
    } finally {
      await fresh.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  });
});
