/**
 * Proba's bootstrap self memory on the in-memory store: seeding is idempotent and keyed by version, a new version supersedes the old
 * one (never edits it in place), entries dropped from the seed are tombstoned, and nothing lands outside the system workspace.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryLogger,
  SELF_MEMORY_CREATED_BY,
  SYSTEM_WORKSPACE_ID,
  SelfSeedError,
  isReservedWorkspaceId,
  listSelfMemories,
  parseSelfSeed,
  seedSelfMemory,
  selfMemoryId,
  type SelfSeed,
} from '@smallseedlabs/proba-memory-core';
import { ManualClock } from './clock-ids.js';
import { InMemoryMemoryStore } from './memory-store.js';

const seed = (version: string, entries: Array<[string, string]>): SelfSeed =>
  parseSelfSeed({
    schema: 'proba.self-memory/v1',
    version,
    entries: entries.map(([key, content]) => ({ key, title: `title ${key}`, category: 'semantic', content })),
  });

const all = async (store: InMemoryMemoryStore) =>
  (await store.listMemories({ workspaceId: SYSTEM_WORKSPACE_ID, filter: { statuses: ['active', 'superseded', 'tombstoned'] }, limit: 200 })).memories;

describe('bootstrap self memory: seeding', () => {
  it('inserts every entry once into the system workspace, system-owned and readable by the whole workspace', async () => {
    const store = new InMemoryMemoryStore();
    const clock = new ManualClock('2026-11-14T00:00:00.000Z');
    const r = await seedSelfMemory(store, seed('v1', [['01-identity', 'I am Proba.'], ['02-rules', 'Always propose.']]), { clock });
    expect(r).toMatchObject({ version: 'v1', inserted: 2, superseded: 0, tombstoned: 0, unchanged: 0, conflicts: [] });
    const active = await listSelfMemories(store);
    expect(active.map((m) => m.content)).toEqual(['I am Proba.', 'Always propose.']);
    for (const m of active) {
      expect(m).toMatchObject({ workspaceId: SYSTEM_WORKSPACE_ID, ownerActorId: null, visibility: 'workspace', status: 'active', importance: 1, confidence: 1 });
      expect(m.provenance.createdBy).toBe(SELF_MEMORY_CREATED_BY);
    }
    expect(active[0].id).toBe(selfMemoryId('v1', '01-identity'));
    expect(await store.listWorkspaceIds()).toEqual([SYSTEM_WORKSPACE_ID]);
  });

  it('is idempotent: the same version again changes nothing', async () => {
    const store = new InMemoryMemoryStore();
    const clock = new ManualClock('2026-11-14T00:00:00.000Z');
    const s = seed('v1', [['01-identity', 'I am Proba.']]);
    await seedSelfMemory(store, s, { clock });
    const before = await all(store);
    clock.advance(60_000);
    const again = await seedSelfMemory(store, s, { clock });
    expect(again).toMatchObject({ inserted: 0, superseded: 0, tombstoned: 0, unchanged: 1, conflicts: [] });
    expect(await all(store)).toEqual(before);
  });

  it('a new version supersedes the previous entries and tombstones dropped ones, never editing in place', async () => {
    const store = new InMemoryMemoryStore();
    const clock = new ManualClock('2026-11-14T00:00:00.000Z');
    await seedSelfMemory(store, seed('v1', [['01-identity', 'Old identity.'], ['02-old', 'Dropped later.']]), { clock });
    clock.advance(60_000);
    const r = await seedSelfMemory(store, seed('v2', [['01-identity', 'New identity.'], ['03-new', 'Added.']]), { clock });
    expect(r).toMatchObject({ inserted: 2, superseded: 1, tombstoned: 1 });
    expect((await listSelfMemories(store)).map((m) => m.content)).toEqual(['New identity.', 'Added.']);
    const byId = new Map((await all(store)).map((m) => [m.id, m]));
    expect(byId.get(selfMemoryId('v1', '01-identity'))).toMatchObject({ status: 'superseded', content: 'Old identity.' });
    expect(byId.get(selfMemoryId('v1', '02-old'))).toMatchObject({ status: 'tombstoned' });
    expect(byId.get(selfMemoryId('v2', '01-identity'))).toMatchObject({ status: 'active', supersedesId: selfMemoryId('v1', '01-identity') });
  });

  it('reports (and does not apply) a changed text under the same version', async () => {
    const store = new InMemoryMemoryStore();
    const clock = new ManualClock('2026-11-14T00:00:00.000Z');
    const logger = new MemoryLogger();
    await seedSelfMemory(store, seed('v1', [['01-identity', 'Original.']]), { clock });
    const r = await seedSelfMemory(store, seed('v1', [['01-identity', 'Edited without a bump.']]), { clock, logger });
    expect(r.conflicts).toEqual(['01-identity']);
    expect((await listSelfMemories(store))[0].content).toBe('Original.');
    expect(logger.records.some((rec) => rec.fields.lifecycle === 'self_memory_conflict')).toBe(true);
  });

  it('refuses an invalid seed', () => {
    expect(() => parseSelfSeed({ schema: 'proba.self-memory/v1', version: 'v1', entries: [] })).toThrow(SelfSeedError);
    expect(() => seed('v1', [['01-a', 'x'], ['01-a', 'y']])).toThrow(/unique/);
    expect(() => seed('v1', [['Identity', 'x']])).toThrow(SelfSeedError);
    expect(() => parseSelfSeed({ schema: 'proba.self-memory/v1', version: 'v1', entries: [{ key: '01-a', title: 't', category: 'semantic', content: 'x', extra: 1 }] })).toThrow(SelfSeedError);
  });

  it('names the reserved workspace', () => {
    expect(isReservedWorkspaceId(SYSTEM_WORKSPACE_ID)).toBe(true);
    expect(isReservedWorkspaceId(' __PROBA_SYSTEM__ ')).toBe(true);
    expect(isReservedWorkspaceId('seedbed')).toBe(false);
  });
});
