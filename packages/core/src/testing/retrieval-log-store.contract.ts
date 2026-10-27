import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RetrievalLogEntry } from '../domain/index.js';
import type { RetrievalLogStore } from '../ports/retrieval-log-store.js';
import { uniqueName } from './fixtures.js';

export interface RetrievalLogStoreHarness {
  store: RetrievalLogStore;
  cleanup?: () => Promise<void>;
}

export function makeLogEntry(workspaceId: string, overrides: Partial<RetrievalLogEntry> = {}): RetrievalLogEntry {
  return {
    id: randomUUID(),
    workspaceId,
    traceId: randomUUID(),
    actorType: 'user',
    actorId: 'uid-1',
    queryText: 'what does the user think about discount banners',
    queryHash: 'abc123',
    filter: { categories: ['semantic'] },
    profileName: 'default',
    profileVersion: 1,
    profileServed: 'active',
    shadowProfileVersion: null,
    candidates: [
      {
        id: randomUUID(),
        category: 'semantic',
        vectorRank: 1,
        vectorSimilarity: 0.91,
        ftsRank: 2,
        ftsScore: 0.4,
        fusedScore: 0.03,
        score: 0.77,
        features: { relevance: 0.9, recency: 0.8, importance: 0.7, confidence: 0.6, usefulness: 0.5, ageDays: 3, halfLifeDays: 180 },
        components: { relevance: 0.45, recency: 0.12, importance: 0.1, confidence: 0.06, usefulness: 0.05 },
        selected: true,
        position: 1,
      },
    ],
    shadowResults: null,
    results: [{ id: randomUUID(), score: 0.77, position: 1 }],
    stats: { vectorCandidates: 1, textCandidates: 1, fused: 1, scored: 1, returned: 1, tokensUsed: 20, tokenBudget: 1500, degraded: [], durationMs: 12 },
    createdAt: '2026-10-26T09:00:00.000Z',
    ...overrides,
  };
}

/** Contract any RetrievalLogStore adapter must satisfy. */
export function runRetrievalLogStoreContract(name: string, factory: () => Promise<RetrievalLogStoreHarness>): void {
  describe(`RetrievalLogStore contract: ${name}`, () => {
    const open: RetrievalLogStoreHarness[] = [];
    const make = async (): Promise<RetrievalLogStoreHarness> => {
      const h = await factory();
      open.push(h);
      return h;
    };
    afterEach(async () => {
      for (const h of open.splice(0)) {
        await h.cleanup?.();
        await h.store.close();
      }
    });

    it('stores features and the profile version, and reads them back unchanged', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const entry = makeLogEntry(ws, { shadowProfileVersion: 2, shadowResults: [{ id: randomUUID(), score: 0.5 }] });
      await store.append(entry);
      const got = await store.get(ws, entry.id);
      expect(got).toEqual(entry);
      expect(got?.profileVersion).toBe(1);
      expect(got?.candidates[0].features.halfLifeDays).toBe(180);
    });

    it('lists newest first and keeps workspaces apart', async () => {
      const { store } = await make();
      const a = uniqueName('wsA');
      const b = uniqueName('wsB');
      const e1 = makeLogEntry(a, { createdAt: '2026-10-26T09:00:00.000Z' });
      const e2 = makeLogEntry(a, { createdAt: '2026-10-26T09:05:00.000Z' });
      const eb = makeLogEntry(b);
      for (const e of [e1, e2, eb]) await store.append(e);
      expect((await store.list(a)).map((e) => e.id)).toEqual([e2.id, e1.id]);
      expect((await store.list(a, { limit: 1 })).map((e) => e.id)).toEqual([e2.id]);
      expect(await store.get(a, eb.id)).toBeNull();
      expect((await store.list(b)).map((e) => e.id)).toEqual([eb.id]);
    });

    it('lists retrievals that returned a memory, newest first, per workspace', async () => {
      const { store } = await make();
      const a = uniqueName('wsA');
      const b = uniqueName('wsB');
      const memoryId = randomUUID();
      const otherId = randomUUID();
      const hitOld = makeLogEntry(a, {
        createdAt: '2026-10-26T09:00:00.000Z',
        results: [{ id: memoryId, score: 0.5, position: 1 }],
      });
      const hitNew = makeLogEntry(a, {
        createdAt: '2026-10-26T10:00:00.000Z',
        results: [
          { id: otherId, score: 0.9, position: 1 },
          { id: memoryId, score: 0.4, position: 2 },
        ],
      });
      const miss = makeLogEntry(a, {
        createdAt: '2026-10-26T11:00:00.000Z',
        results: [{ id: otherId, score: 0.8, position: 1 }],
      });
      const elsewhere = makeLogEntry(b, {
        createdAt: '2026-10-26T12:00:00.000Z',
        results: [{ id: memoryId, score: 0.7, position: 1 }],
      });
      for (const e of [hitOld, hitNew, miss, elsewhere]) await store.append(e);
      expect((await store.listByMemoryId(a, memoryId)).map((e) => e.id)).toEqual([hitNew.id, hitOld.id]);
      expect((await store.listByMemoryId(a, memoryId, { limit: 1 })).map((e) => e.id)).toEqual([hitNew.id]);
      expect(await store.listByMemoryId(a, randomUUID())).toEqual([]);
      expect((await store.listByMemoryId(b, memoryId)).map((e) => e.id)).toEqual([elsewhere.id]);
    });

    it('lists unresolved entries oldest first, by cut-off, and per workspace', async () => {
      const { store } = await make();
      const a = uniqueName('wsA');
      const b = uniqueName('wsB');
      const old = makeLogEntry(a, { createdAt: '2026-10-24T09:00:00.000Z' });
      const older = makeLogEntry(a, { createdAt: '2026-10-23T09:00:00.000Z' });
      const recent = makeLogEntry(a, { createdAt: '2026-10-26T09:00:00.000Z' });
      const elsewhere = makeLogEntry(b, { createdAt: '2026-10-23T09:00:00.000Z' });
      for (const e of [old, older, recent, elsewhere]) await store.append(e);
      const unresolved = await store.listUnresolved(a, { createdBefore: '2026-10-25T00:00:00.000Z', limit: 10 });
      expect(unresolved.map((e) => e.id)).toEqual([older.id, old.id]);
      expect((await store.listUnresolved(a, { createdBefore: '2026-10-25T00:00:00.000Z', limit: 1 })).map((e) => e.id)).toEqual([older.id]);
      await store.recordOutcome(a, older.id, { verdict: 'none', resolvedAt: '2026-10-26T09:00:00.000Z' });
      expect((await store.listUnresolved(a, { createdBefore: '2026-10-25T00:00:00.000Z', limit: 10 })).map((e) => e.id)).toEqual([old.id]);
    });

    it('records an outcome once (the first wins) and reads it back', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const other = uniqueName('wsOther');
      const entry = makeLogEntry(ws);
      await store.append(entry);
      const observationId = randomUUID();
      expect(await store.recordOutcome(ws, entry.id, { verdict: 'approved', observationId, resolvedAt: '2026-10-26T10:00:00.000Z' })).toBe(true);
      expect(await store.recordOutcome(ws, entry.id, { verdict: 'rejected', resolvedAt: '2026-10-26T11:00:00.000Z' })).toBe(false);
      expect((await store.get(ws, entry.id))?.outcome).toEqual({ verdict: 'approved', observationId, resolvedAt: '2026-10-26T10:00:00.000Z' });
      expect(await store.recordOutcome(ws, randomUUID(), { verdict: 'none', resolvedAt: '2026-10-26T10:00:00.000Z' })).toBe(false);
      expect(await store.recordOutcome(other, entry.id, { verdict: 'none', resolvedAt: '2026-10-26T10:00:00.000Z' })).toBe(false); // another workspace's id
    });

    it('lets an outcome be applied exactly once', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const entry = makeLogEntry(ws, { createdAt: '2026-10-24T09:00:00.000Z' });
      const waiting = makeLogEntry(ws, { createdAt: '2026-10-25T09:00:00.000Z' });
      await store.append(entry);
      await store.append(waiting);
      expect(await store.markOutcomeApplied(ws, entry.id, '2026-10-26T12:00:00.000Z')).toBe(false); // no outcome yet
      await store.recordOutcome(ws, entry.id, { verdict: 'rejected', resolvedAt: '2026-10-26T10:00:00.000Z' });
      expect((await store.listUnapplied(ws, { limit: 10 })).map((e) => e.id)).toEqual([entry.id]);
      const claims = await Promise.all([1, 2, 3].map(() => store.markOutcomeApplied(ws, entry.id, '2026-10-26T12:00:00.000Z')));
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await store.listUnapplied(ws, { limit: 10 })).toEqual([]);
      expect((await store.get(ws, entry.id))?.outcomeAppliedAt).toBe('2026-10-26T12:00:00.000Z');
    });

    it('answers ping', async () => {
      const { store } = await make();
      await expect(store.ping()).resolves.toBeUndefined();
    });
  });
}
