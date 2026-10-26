import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddingMigrationStore } from '../ports/embedding-migration-store.js';
import type { MemoryStore } from '../ports/memory-store.js';
import { makeMemoryInsert, seededVector, uniqueName } from './fixtures.js';

export interface EmbeddingMigrationStoreHarness {
  migration: EmbeddingMigrationStore;
  /** The memory store over the same data (the in-memory store is both). */
  store: MemoryStore;
  dimension: number;
  cleanup?: () => Promise<void>;
}

const OLD = { model: 'old-model', version: '1' };
const NEW = { model: 'new-model', version: '2' };

/** Contract any EmbeddingMigrationStore adapter must satisfy. */
export function runEmbeddingMigrationStoreContract(name: string, factory: () => Promise<EmbeddingMigrationStoreHarness>): void {
  describe(`EmbeddingMigrationStore contract: ${name}`, () => {
    const open: EmbeddingMigrationStoreHarness[] = [];
    const make = async (): Promise<EmbeddingMigrationStoreHarness> => {
      const h = await factory();
      open.push(h);
      return h;
    };
    afterEach(async () => {
      for (const h of open.splice(0)) {
        await h.cleanup?.();
        await h.migration.close();
        if (h.store !== (h.migration as unknown)) await h.store.close();
      }
    });

    async function put(h: EmbeddingMigrationStoreHarness, ws: string, seed: number, overrides: Parameters<typeof makeMemoryInsert>[1] = {}): Promise<string> {
      const m = makeMemoryInsert(ws, { content: `memory ${seed}`, embedding: seededVector(h.dimension, seed), embeddingModel: OLD.model, embeddingVersion: OLD.version, ...overrides });
      await h.store.transaction((tx) => tx.insertMemory(m));
      return m.id;
    }

    it('lists active memories that are not at the target, in id order, up to the limit', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const ids = [await put(h, ws, 1), await put(h, ws, 2), await put(h, ws, 3)];
      await put(h, ws, 4, { embeddingModel: NEW.model, embeddingVersion: NEW.version }); // already at target
      await put(h, ws, 5, { status: 'superseded' });
      await put(h, ws, 6, { status: 'tombstoned' });
      const all = await h.migration.listPending(ws, NEW, 100);
      expect(all.map((p) => p.id)).toEqual([...ids].sort());
      expect(all.every((p) => p.text.startsWith('memory '))).toBe(true);
      expect(await h.migration.listPending(ws, NEW, 2)).toHaveLength(2);
    });

    it('treats memories without a vector as pending, and a version change under the same model name too', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const none = await put(h, ws, 1, { embedding: null, embeddingModel: null, embeddingVersion: null });
      const stale = await put(h, ws, 2, { embeddingModel: NEW.model, embeddingVersion: '1' });
      expect((await h.migration.listPending(ws, NEW, 10)).map((p) => p.id).sort()).toEqual([none, stale].sort());
    });

    it('stages vectors without changing what is served, and stats reflect the progress', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const [a, b, c] = [await put(h, ws, 1), await put(h, ws, 2), await put(h, ws, 3)];
      await put(h, ws, 4, { embeddingModel: NEW.model, embeddingVersion: NEW.version });
      expect(await h.migration.stats(ws, NEW)).toEqual({ active: 4, atTarget: 1, staged: 0, pending: 3 });
      expect(await h.migration.writeStaged(ws, NEW, [{ id: a, vector: seededVector(h.dimension, 11) }, { id: b, vector: seededVector(h.dimension, 12) }])).toBe(2);
      expect(await h.migration.stats(ws, NEW)).toEqual({ active: 4, atTarget: 1, staged: 2, pending: 1 });
      expect((await h.migration.listPending(ws, NEW, 10)).map((p) => p.id)).toEqual([c]);
      expect(await h.store.getMemory(ws, a)).toMatchObject({ embeddingModel: OLD.model, embeddingVersion: OLD.version });
      // writing the same vectors again is harmless
      expect(await h.migration.writeStaged(ws, NEW, [{ id: a, vector: seededVector(h.dimension, 11) }])).toBe(1);
      expect(await h.migration.stats(ws, NEW)).toEqual({ active: 4, atTarget: 1, staged: 2, pending: 1 });
    });

    it('does not cut over while anything is pending, then swaps everything at once', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const [a, b] = [await put(h, ws, 1), await put(h, ws, 2)];
      await h.migration.writeStaged(ws, NEW, [{ id: a, vector: seededVector(h.dimension, 11) }]);
      expect(await h.migration.cutover(ws, NEW)).toEqual({ swapped: 0, pending: 1 });
      expect(await h.store.getMemory(ws, a)).toMatchObject({ embeddingModel: OLD.model });
      await h.migration.writeStaged(ws, NEW, [{ id: b, vector: seededVector(h.dimension, 12) }]);
      expect(await h.migration.cutover(ws, NEW)).toEqual({ swapped: 2, pending: 0 });
      for (const id of [a, b]) expect(await h.store.getMemory(ws, id)).toMatchObject({ embeddingModel: NEW.model, embeddingVersion: NEW.version });
      expect(await h.migration.stats(ws, NEW)).toEqual({ active: 2, atTarget: 2, staged: 0, pending: 0 });
      expect(await h.migration.cutover(ws, NEW)).toEqual({ swapped: 0, pending: 0 }); // nothing left to swap
    });

    it('ignores other workspaces\' ids and memories that are not active', async () => {
      const h = await make();
      const a = uniqueName('wsA');
      const b = uniqueName('wsB');
      const mine = await put(h, a, 1);
      const theirs = await put(h, b, 2);
      const retired = await put(h, a, 3, { status: 'superseded' });
      const written = await h.migration.writeStaged(a, NEW, [
        { id: mine, vector: seededVector(h.dimension, 11) },
        { id: theirs, vector: seededVector(h.dimension, 12) },
        { id: retired, vector: seededVector(h.dimension, 13) },
      ]);
      expect(written).toBe(1);
      expect(await h.migration.stats(b, NEW)).toEqual({ active: 1, atTarget: 0, staged: 0, pending: 1 });
      expect(await h.migration.cutover(b, NEW)).toEqual({ swapped: 0, pending: 1 });
      expect(await h.store.getMemory(b, theirs)).toMatchObject({ embeddingModel: OLD.model });
      expect(await h.migration.cutover(a, NEW)).toEqual({ swapped: 1, pending: 0 });
      expect(await h.store.getMemory(a, retired)).toMatchObject({ embeddingModel: OLD.model });
    });

    it('answers ping', async () => {
      const { migration } = await make();
      await expect(migration.ping()).resolves.toBeUndefined();
    });
  });
}
