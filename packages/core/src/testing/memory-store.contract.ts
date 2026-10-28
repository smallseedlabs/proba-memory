import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MemoryStore } from '../ports/memory-store.js';
import { makeMemoryInsert, makeObservation, seededVector, uniqueName } from './fixtures.js';

export interface MemoryStoreHarness {
  store: MemoryStore;
  /** Vector length the store accepts. */
  dimension: number;
  cleanup?: () => Promise<void>;
}

const NOW = '2026-10-26T09:00:00.000Z';

/**
 * Contract any MemoryStore adapter must satisfy. Every test works in its own workspace id, so the
 * store may be shared (and need not start empty).
 */
export function runMemoryStoreContract(name: string, factory: () => Promise<MemoryStoreHarness>): void {
  describe(`MemoryStore contract: ${name}`, () => {
    const open: MemoryStoreHarness[] = [];
    const make = async (): Promise<MemoryStoreHarness> => {
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

    it('stores a memory and reads it back without its vector', async () => {
      const { store, dimension } = await make();
      const ws = uniqueName('ws');
      const m = makeMemoryInsert(ws, {
        embedding: seededVector(dimension, 1),
        embeddingModel: 'm',
        embeddingVersion: '1',
        goalId: randomUUID(),
        sourceRefs: [{ kind: 'approval', id: 'a', ref: 'audit:a' }],
      });
      await store.transaction((tx) => tx.insertMemory(m));
      const got = await store.getMemory(ws, m.id);
      expect(got).toMatchObject({
        id: m.id,
        workspaceId: ws,
        category: 'semantic',
        content: m.content,
        embeddingModel: 'm',
        embeddingVersion: '1',
        importance: 0.6,
        status: 'active',
        goalId: m.goalId,
        evidenceCount: 1,
        accessCount: 0,
      });
      expect(got?.sourceRefs).toEqual(m.sourceRefs);
      expect(got?.provenance.createdBy).toBe('test');
      expect(got).not.toHaveProperty('embedding');
      expect(new Date(got?.createdAt ?? '').toISOString()).toBe('2026-10-20T10:00:00.000Z');
    });

    it('rejects inserting an existing id', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const m = makeMemoryInsert(ws);
      await store.transaction((tx) => tx.insertMemory(m));
      await expect(store.transaction((tx) => tx.insertMemory(m))).rejects.toThrow();
    });

    it('never reads or changes another workspace (isolation)', async () => {
      const { store, dimension } = await make();
      const a = uniqueName('wsA');
      const b = uniqueName('wsB');
      const secret = makeMemoryInsert(a, { content: 'Quarterly pricing strategy for the launch of the zebra product', embedding: seededVector(dimension, 7), embeddingModel: 'm', embeddingVersion: '1' });
      await store.transaction(async (tx) => {
        await tx.insertMemory(secret);
        await tx.insertMemory(makeMemoryInsert(b, { content: 'Unrelated note about blue buttons' }));
      });
      expect(await store.getMemory(b, secret.id)).toBeNull();
      expect(await store.getMemories(b, [secret.id])).toEqual([]);
      expect((await store.listMemories({ workspaceId: b })).memories.map((m) => m.id)).not.toContain(secret.id);
      expect(await store.searchText({ workspaceId: b, query: 'zebra pricing strategy', limit: 10 })).toEqual([]);
      expect(await store.countMemories(b)).toBe(1);
      const changed = await store.transaction((tx) => tx.updateMemory(b, secret.id, { importance: 0.01, status: 'tombstoned' }, NOW));
      expect(changed).toBe(false);
      await store.transaction((tx) => tx.recordAccess(b, [secret.id], NOW));
      expect(await store.getMemory(a, secret.id)).toMatchObject({ importance: 0.6, status: 'active', accessCount: 0 });
      await store.transaction((tx) => tx.insertLink({ workspaceId: b, fromId: secret.id, toId: secret.id, relation: 'supports', weight: 1, createdAt: NOW }));
      expect(await store.listLinks(a, secret.id)).toEqual([]);
    });

    it('updates the fields of a memory', async () => {
      const { store, dimension } = await make();
      const ws = uniqueName('ws');
      const m = makeMemoryInsert(ws);
      await store.transaction((tx) => tx.insertMemory(m));
      const ok = await store.transaction((tx) =>
        tx.updateMemory(
          ws,
          m.id,
          {
            importance: 0.2,
            confidence: 0.3,
            usefulness: 0.9,
            status: 'superseded',
            validTo: NOW,
            evidenceCount: 3,
            lastReinforcedAt: NOW,
            decayedAt: NOW,
            summary: 'short',
            embedding: { vector: seededVector(dimension, 3), model: 'm2', version: '2' },
          },
          NOW
        )
      );
      expect(ok).toBe(true);
      const got = await store.getMemory(ws, m.id);
      expect(got).toMatchObject({ importance: 0.2, confidence: 0.3, usefulness: 0.9, status: 'superseded', evidenceCount: 3, summary: 'short', embeddingModel: 'm2', embeddingVersion: '2' });
      expect(got?.validTo && new Date(got.validTo).toISOString()).toBe(NOW);
      expect(got?.decayedAt && new Date(got.decayedAt).toISOString()).toBe(NOW);
      expect(new Date(got?.updatedAt ?? '').getTime()).toBeGreaterThanOrEqual(new Date(got?.createdAt ?? '').getTime());
      expect(await store.transaction((tx) => tx.updateMemory(ws, randomUUID(), { importance: 0.1 }, NOW))).toBe(false);
    });

    it('lists newest first with keyset pagination and filters (active only by default)', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const goal = randomUUID();
      const ids: string[] = [];
      await store.transaction(async (tx) => {
        for (let i = 0; i < 5; i += 1) {
          const m = makeMemoryInsert(ws, {
            createdAt: `2026-10-2${i}T10:00:00.000Z`,
            category: i % 2 === 0 ? 'episodic' : 'semantic',
            confidence: 0.2 + i * 0.2,
            goalId: i === 4 ? goal : null,
            sourceRefs: [{ kind: i === 3 ? 'thread' : 'goal', id: `s${i}`, ref: `dev:s${i}` }],
          });
          ids.push(m.id);
          await tx.insertMemory(m);
        }
        await tx.insertMemory(makeMemoryInsert(ws, { status: 'superseded', createdAt: '2026-10-29T10:00:00.000Z' }));
      });
      const page1 = await store.listMemories({ workspaceId: ws, limit: 2 });
      expect(page1.memories.map((m) => m.id)).toEqual([ids[4], ids[3]]);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await store.listMemories({ workspaceId: ws, limit: 2, cursor: page1.nextCursor as string });
      expect(page2.memories.map((m) => m.id)).toEqual([ids[2], ids[1]]);
      const page3 = await store.listMemories({ workspaceId: ws, limit: 2, cursor: page2.nextCursor as string });
      expect(page3.memories.map((m) => m.id)).toEqual([ids[0]]);
      expect(page3.nextCursor).toBeNull();

      const ofIds = async (filter: Parameters<MemoryStore['listMemories']>[0]['filter']) => (await store.listMemories({ workspaceId: ws, filter })).memories.map((m) => m.id);
      expect(await ofIds({ categories: ['semantic'] })).toEqual([ids[3], ids[1]]);
      expect(await ofIds({ minConfidence: 0.7 })).toEqual([ids[4], ids[3]]);
      expect(await ofIds({ goalId: goal })).toEqual([ids[4]]);
      expect(await ofIds({ sourceKind: 'thread' })).toEqual([ids[3]]);
      expect(await ofIds({ createdFrom: '2026-10-22T00:00:00.000Z', createdTo: '2026-10-24T00:00:00.000Z' })).toEqual([ids[3], ids[2]]);
      expect((await ofIds({ statuses: ['superseded'] })).length).toBe(1);
      expect(await store.countMemories(ws)).toBe(5);
      expect(await store.countMemories(ws, { statuses: ['active', 'superseded'] })).toBe(6);
    });

    it('breaks createdAt ties by id so pages never repeat or skip', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      await store.transaction(async (tx) => {
        for (let i = 0; i < 5; i += 1) await tx.insertMemory(makeMemoryInsert(ws, { createdAt: '2026-10-20T10:00:00.000Z' }));
      });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await store.listMemories({ workspaceId: ws, limit: 2, cursor });
        seen.push(...page.memories.map((m) => m.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('full-text search ranks matches, honours filters and ignores empty queries', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const best = makeMemoryInsert(ws, { content: 'Customers rejected the discount banner because discount banners feel cheap' });
      const weak = makeMemoryInsert(ws, { content: 'The banner colour was changed once', category: 'episodic' });
      const none = makeMemoryInsert(ws, { content: 'Weekly budget pacing review' });
      const old = makeMemoryInsert(ws, { content: 'Discount banner experiment from last year', status: 'superseded' });
      await store.transaction(async (tx) => {
        for (const m of [best, weak, none, old]) await tx.insertMemory(m);
      });
      const hits = await store.searchText({ workspaceId: ws, query: 'discount banner', limit: 10 });
      expect(hits.map((h) => h.id)[0]).toBe(best.id);
      expect(hits.map((h) => h.id)).toContain(weak.id);
      expect(hits.map((h) => h.id)).not.toContain(none.id);
      expect(hits.map((h) => h.id)).not.toContain(old.id);
      expect(hits[0].rank).toBeGreaterThan(hits[hits.length - 1].rank - 1e-9);
      const filtered = await store.searchText({ workspaceId: ws, query: 'discount banner', limit: 10, filter: { categories: ['episodic'] } });
      expect(filtered.map((h) => h.id)).toEqual([weak.id]);
      expect((await store.searchText({ workspaceId: ws, query: 'discount', limit: 10, filter: { statuses: ['superseded'] } })).map((h) => h.id)).toEqual([old.id]);
      expect(await store.searchText({ workspaceId: ws, query: '   ', limit: 10 })).toEqual([]);
      expect(await store.searchText({ workspaceId: ws, query: "'; DROP TABLE memories; -- & | ! ( )", limit: 10 })).toBeDefined();
      expect(await store.searchText({ workspaceId: ws, query: 'banner', limit: 1 })).toHaveLength(1);
    });

    it('stores links once and lists them from both ends', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const a = makeMemoryInsert(ws);
      const b = makeMemoryInsert(ws);
      await store.transaction(async (tx) => {
        await tx.insertMemory(a);
        await tx.insertMemory(b);
        await tx.insertLink({ workspaceId: ws, fromId: a.id, toId: b.id, relation: 'contradicts', weight: 0.8, createdAt: NOW });
        await tx.insertLink({ workspaceId: ws, fromId: a.id, toId: b.id, relation: 'contradicts', weight: 0.8, createdAt: NOW });
        await tx.insertLink({ workspaceId: ws, fromId: a.id, toId: b.id, relation: 'supersedes', weight: 0.8, createdAt: NOW });
      });
      expect(await store.listLinks(ws, a.id)).toHaveLength(2);
      const fromB = await store.listLinks(ws, b.id);
      expect(fromB.map((l) => l.relation).sort()).toEqual(['contradicts', 'supersedes']);
      expect(fromB[0]).toMatchObject({ workspaceId: ws, fromId: a.id, toId: b.id });
    });

    it('counts access', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const m = makeMemoryInsert(ws);
      await store.transaction((tx) => tx.insertMemory(m));
      await store.transaction((tx) => tx.recordAccess(ws, [m.id], NOW));
      await store.transaction((tx) => tx.recordAccess(ws, [m.id], '2026-10-26T10:00:00.000Z'));
      const got = await store.getMemory(ws, m.id);
      expect(got?.accessCount).toBe(2);
      expect(got?.lastAccessedAt && new Date(got.lastAccessedAt).toISOString()).toBe('2026-10-26T10:00:00.000Z');
    });

    it('claims observations idempotently: new, reprocess while pending, done once processed', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const o = makeObservation(ws);
      expect(await store.claimObservation(o, NOW)).toBe('new');
      expect(await store.claimObservation(o, NOW)).toBe('reprocess');
      expect(await store.getObservation(ws, o.id)).toMatchObject({ id: o.id, status: 'pending', attempts: 2, kind: 'approval.rejected', source: 'audit' });
      const m = makeMemoryInsert(ws);
      await store.transaction(async (tx) => {
        await tx.insertMemory(m);
        await tx.linkSource(ws, m.id, o.id, 'created');
        await tx.linkSource(ws, m.id, o.id, 'created');
        await tx.markObservation(ws, o.id, 'processed', NOW);
      });
      expect(await store.claimObservation(o, NOW)).toBe('done');
      expect((await store.getObservation(ws, o.id))?.status).toBe('processed');
      expect(await store.listObservationMemoryIds(ws, o.id)).toEqual([m.id]);
      const skipped = makeObservation(ws);
      await store.claimObservation(skipped, NOW);
      await store.transaction((tx) => tx.markObservation(ws, skipped.id, 'skipped', NOW));
      expect(await store.claimObservation(skipped, NOW)).toBe('done');
    });

    it('keeps the observation of a workspace private', async () => {
      const { store } = await make();
      const a = uniqueName('wsA');
      const b = uniqueName('wsB');
      const o = makeObservation(a);
      await store.claimObservation(o, NOW);
      expect(await store.getObservation(b, o.id)).toBeNull();
    });

    it('lists the observations of a workspace by trace id, oldest first, and never across workspaces', async () => {
      const { store } = await make();
      const a = uniqueName('wsA');
      const b = uniqueName('wsB');
      const t1 = randomUUID();
      const t2 = randomUUID();
      const late = makeObservation(a, { traceId: t1, occurredAt: '2026-10-25T12:00:00.000Z' });
      const early = makeObservation(a, { traceId: t1, occurredAt: '2026-10-25T10:00:00.000Z' });
      const other = makeObservation(a, { traceId: t2 });
      const elsewhere = makeObservation(b, { traceId: t1 });
      for (const o of [late, early, other, elsewhere]) await store.claimObservation(o, NOW);
      expect((await store.listObservationsByTrace(a, [t1])).map((o) => o.id)).toEqual([early.id, late.id]);
      expect((await store.listObservationsByTrace(a, [t1, t2])).map((o) => o.id).sort()).toEqual([early.id, late.id, other.id].sort());
      expect((await store.listObservationsByTrace(b, [t1])).map((o) => o.id)).toEqual([elsewhere.id]);
      expect(await store.listObservationsByTrace(a, [])).toEqual([]);
      expect(await store.listObservationsByTrace(a, [randomUUID()])).toEqual([]);
    });

    it('records processing failures and keeps the observation pending', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const o = makeObservation(ws);
      await store.claimObservation(o, NOW);
      await store.recordObservationFailure(ws, o.id, 'llm timed out', NOW);
      expect(await store.getObservation(ws, o.id)).toMatchObject({ status: 'pending', lastError: 'llm timed out' });
      expect(await store.claimObservation(o, NOW)).toBe('reprocess');
    });

    it('commits a transaction atomically: a throw rolls everything back', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const kept = makeMemoryInsert(ws);
      const lost = makeMemoryInsert(ws);
      const o = makeObservation(ws);
      await store.claimObservation(o, NOW);
      await store.transaction((tx) => tx.insertMemory(kept));
      await expect(
        store.transaction(async (tx) => {
          await tx.insertMemory(lost);
          await tx.updateMemory(ws, kept.id, { importance: 0.01 }, NOW);
          await tx.markObservation(ws, o.id, 'processed', NOW);
          // The transaction sees its own writes.
          expect(await tx.getMemory(ws, lost.id)).not.toBeNull();
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      expect(await store.getMemory(ws, lost.id)).toBeNull();
      expect((await store.getMemory(ws, kept.id))?.importance).toBe(0.6);
      expect((await store.getObservation(ws, o.id))?.status).toBe('pending');
    });

    it('lists the workspaces that have data', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      await store.transaction((tx) => tx.insertMemory(makeMemoryInsert(ws)));
      expect(await store.listWorkspaceIds()).toContain(ws);
    });

    describe('ownership and reader scope', () => {
      const text = 'discount banner countdown timer for the autumn launch';

      async function seedOwners(store: MemoryStore, ws: string) {
        const mine = makeMemoryInsert(ws, { content: `${text} (mine)`, ownerActorId: 'user-a', visibility: 'owner', createdAt: '2026-10-20T10:00:00.000Z' });
        const shared = makeMemoryInsert(ws, { content: `${text} (shared)`, ownerActorId: null, visibility: 'workspace', createdAt: '2026-10-21T10:00:00.000Z' });
        const sharedByOther = makeMemoryInsert(ws, { content: `${text} (shared by other)`, ownerActorId: 'user-b', visibility: 'workspace', createdAt: '2026-10-22T10:00:00.000Z' });
        const theirs = makeMemoryInsert(ws, { content: `${text} (theirs)`, ownerActorId: 'user-b', visibility: 'owner', createdAt: '2026-10-23T10:00:00.000Z' });
        const orphan = makeMemoryInsert(ws, { content: `${text} (orphan)`, ownerActorId: null, visibility: 'owner', createdAt: '2026-10-24T10:00:00.000Z' });
        await store.transaction(async (tx) => {
          for (const m of [mine, shared, sharedByOther, theirs, orphan]) await tx.insertMemory(m);
        });
        return { mine, shared, sharedByOther, theirs, orphan };
      }

      it('stores the owner and the visibility, and defaults to no owner and visibility owner', async () => {
        const { store } = await make();
        const ws = uniqueName('ws');
        const owned = makeMemoryInsert(ws, { ownerActorId: 'user-a', visibility: 'workspace' });
        const plain = makeMemoryInsert(ws);
        await store.transaction(async (tx) => {
          await tx.insertMemory(owned);
          await tx.insertMemory(plain);
        });
        expect(await store.getMemory(ws, owned.id)).toMatchObject({ ownerActorId: 'user-a', visibility: 'workspace' });
        expect(await store.getMemory(ws, plain.id)).toMatchObject({ ownerActorId: null, visibility: 'owner' });
      });

      it('list, full-text search, get and get-many return only what the user may read', async () => {
        const { store } = await make();
        const ws = uniqueName('ws');
        const { mine, shared, sharedByOther, theirs, orphan } = await seedOwners(store, ws);
        const readable = [mine.id, shared.id, sharedByOther.id].sort();

        const listed = await store.listMemories({ workspaceId: ws, filter: { visibleTo: 'user-a' }, limit: 50 });
        expect(listed.memories.map((m) => m.id).sort()).toEqual(readable);
        const found = await store.searchText({ workspaceId: ws, query: 'discount banner', limit: 50, filter: { visibleTo: 'user-a' } });
        expect(found.map((h) => h.id).sort()).toEqual(readable);
        expect((await store.getMemories(ws, [mine.id, shared.id, sharedByOther.id, theirs.id, orphan.id], 'user-a')).map((m) => m.id).sort()).toEqual(readable);
        expect(await store.getMemory(ws, mine.id, 'user-a')).not.toBeNull();
        expect(await store.getMemory(ws, shared.id, 'user-a')).not.toBeNull();
        for (const hidden of [theirs, orphan]) expect(await store.getMemory(ws, hidden.id, 'user-a')).toBeNull();
        // Without a user the reads stay workspace-wide (administrators and viewers).
        expect(await store.getMemory(ws, theirs.id)).not.toBeNull();
        expect((await store.listMemories({ workspaceId: ws, limit: 50 })).memories).toHaveLength(5);
        expect(await store.countMemories(ws, { visibleTo: 'user-a' })).toBe(3);
        // An empty user id reads nothing of anybody's, only what is shared.
        expect((await store.listMemories({ workspaceId: ws, filter: { visibleTo: '' }, limit: 50 })).memories.map((m) => m.id).sort()).toEqual([shared.id, sharedByOther.id].sort());
      });

      it('the scope is applied by the query: a better match of another user never uses up the limit', async () => {
        const { store } = await make();
        const ws = uniqueName('ws');
        const strong = makeMemoryInsert(ws, { content: 'discount banner countdown timer discount banner countdown timer', ownerActorId: 'user-b', visibility: 'owner' });
        const weak = makeMemoryInsert(ws, { content: 'a banner somewhere', ownerActorId: 'user-a', visibility: 'owner' });
        await store.transaction(async (tx) => {
          await tx.insertMemory(strong);
          await tx.insertMemory(weak);
        });
        const hits = await store.searchText({ workspaceId: ws, query: 'discount banner countdown timer', limit: 1, filter: { visibleTo: 'user-a' } });
        expect(hits.map((h) => h.id)).toEqual([weak.id]);
        const page = await store.listMemories({ workspaceId: ws, filter: { visibleTo: 'user-a' }, limit: 1 });
        expect(page.memories.map((m) => m.id)).toEqual([weak.id]);
        expect(page.nextCursor).toBeNull();
      });

      it('ownedBy matches the exact owner, and null the memories that have none', async () => {
        const { store } = await make();
        const ws = uniqueName('ws');
        const { mine, shared, orphan } = await seedOwners(store, ws);
        const ids = async (ownedBy: string | null) => (await store.listMemories({ workspaceId: ws, filter: { ownedBy }, limit: 50 })).memories.map((m) => m.id).sort();
        expect(await ids('user-a')).toEqual([mine.id]);
        expect(await ids(null)).toEqual([shared.id, orphan.id].sort());
      });

      it('tags match memories learned from at least one of the signals', async () => {
        const { store } = await make();
        const ws = uniqueName('ws');
        const rejected = makeMemoryInsert(ws, { provenance: { extractor: null, observationIds: [], stance: 'negative', signals: ['approval.rejected'], createdBy: 'test' } });
        const granted = makeMemoryInsert(ws, { provenance: { extractor: null, observationIds: [], stance: 'positive', signals: ['approval.granted', 'goal.created'], createdBy: 'test' } });
        const plain = makeMemoryInsert(ws);
        await store.transaction(async (tx) => {
          for (const m of [rejected, granted, plain]) await tx.insertMemory(m);
        });
        const ids = async (tags: string[]) => (await store.listMemories({ workspaceId: ws, filter: { tags }, limit: 50 })).memories.map((m) => m.id).sort();
        expect(await ids(['approval.rejected'])).toEqual([rejected.id]);
        expect(await ids(['goal.created', 'approval.rejected'])).toEqual([rejected.id, granted.id].sort());
        expect(await ids(['unknown.signal'])).toEqual([]);
      });
    });

    it('answers ping', async () => {
      const { store } = await make();
      await expect(store.ping()).resolves.toBeUndefined();
    });
  });
}
