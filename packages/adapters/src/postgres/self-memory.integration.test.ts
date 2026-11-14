/**
 * Proba's bootstrap self memory on Postgres: the seeder's rows (no vector, system-owned) fit the schema, re-seeding is a no-op and
 * a new version supersedes the old rows in one transaction.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { SYSTEM_WORKSPACE_ID, parseSelfSeed, seedSelfMemory, selfMemoryId } from '@smallseedlabs/proba-memory-core';
import { ManualClock } from '../memory/clock-ids.js';
import { PostgresMemoryStore } from './memory-store.js';
import { getTestPool } from './test-db.js';

const pool = await getTestPool();
afterAll(async () => {
  await pool.end();
});

describe('bootstrap self memory on Postgres', () => {
  it('seeds idempotently and supersedes on a new version', async () => {
    const store = new PostgresMemoryStore({ pool });
    const clock = new ManualClock('2026-11-14T00:00:00.000Z');
    const run = randomUUID().slice(0, 8);
    const key = `01-it-${run}`;
    const make = (version: string, content: string) =>
      parseSelfSeed({ schema: 'proba.self-memory/v1', version, entries: [{ key, title: 'Identity', category: 'semantic', content }] });

    const v1 = `it-${run}-1`;
    expect((await seedSelfMemory(store, make(v1, 'Old identity.'), { clock })).inserted).toBe(1);
    expect(await seedSelfMemory(store, make(v1, 'Old identity.'), { clock })).toMatchObject({ inserted: 0, unchanged: 1, conflicts: [] });
    const stored = await store.getMemory(SYSTEM_WORKSPACE_ID, selfMemoryId(v1, key));
    expect(stored).toMatchObject({ status: 'active', ownerActorId: null, visibility: 'workspace', embeddingModel: null, content: 'Old identity.' });

    clock.advance(60_000);
    const v2 = `it-${run}-2`;
    expect(await seedSelfMemory(store, make(v2, 'New identity.'), { clock })).toMatchObject({ inserted: 1, superseded: 1 });
    expect(await store.getMemory(SYSTEM_WORKSPACE_ID, selfMemoryId(v1, key))).toMatchObject({ status: 'superseded' });
    expect(await store.getMemory(SYSTEM_WORKSPACE_ID, selfMemoryId(v2, key))).toMatchObject({ status: 'active', supersedesId: selfMemoryId(v1, key) });
  });
});
