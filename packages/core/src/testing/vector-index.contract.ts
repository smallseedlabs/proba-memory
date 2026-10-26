import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryStore } from '../ports/memory-store.js';
import type { VectorIndex } from '../ports/vector-index.js';
import { makeMemoryInsert, nearVector, seededVector, uniqueName } from './fixtures.js';

export interface VectorIndexHarness {
  index: VectorIndex;
  /** The store the index sits next to (same database, or the one it looks memories up in). */
  store: MemoryStore;
  cleanup?: () => Promise<void>;
}

const MODEL = 'contract-model';
const VERSION = '1';

/** Contract any VectorIndex adapter must satisfy. Each test uses its own workspace ids. */
export function runVectorIndexContract(name: string, factory: () => Promise<VectorIndexHarness>): void {
  describe(`VectorIndex contract: ${name}`, () => {
    const open: VectorIndexHarness[] = [];
    const make = async (): Promise<VectorIndexHarness> => {
      const h = await factory();
      open.push(h);
      return h;
    };
    afterEach(async () => {
      for (const h of open.splice(0)) {
        await h.cleanup?.();
        await h.index.close();
        await h.store.close();
      }
    });

    /** Insert a memory (without a vector) and index `vector` for it. */
    async function put(h: VectorIndexHarness, ws: string, vector: number[], overrides: Parameters<typeof makeMemoryInsert>[1] = {}): Promise<string> {
      const m = makeMemoryInsert(ws, overrides);
      await h.store.transaction((tx) => tx.insertMemory(m));
      await h.index.upsert([{ id: m.id, workspaceId: ws, vector, model: MODEL, version: VERSION }]);
      return m.id;
    }

    it('returns nearest vectors first with cosine similarity', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const q = seededVector(h.index.dimension, 1);
      const near = await put(h, ws, nearVector(q, 0.1, 1));
      const far = await put(h, ws, seededVector(h.index.dimension, 99));
      const exact = await put(h, ws, q);
      const hits = await h.index.search({ workspaceId: ws, vector: q, limit: 10, model: MODEL, version: VERSION });
      expect(hits.map((x) => x.id)).toEqual([exact, near, far]);
      expect(hits[0].similarity).toBeCloseTo(1, 4);
      expect(hits[1].similarity).toBeGreaterThan(hits[2].similarity);
      expect(hits[1].similarity).toBeLessThanOrEqual(1);
      expect(await h.index.search({ workspaceId: ws, vector: q, limit: 2, model: MODEL, version: VERSION })).toHaveLength(2);
    });

    it('never returns vectors of another workspace (isolation)', async () => {
      const h = await make();
      const a = uniqueName('wsA');
      const b = uniqueName('wsB');
      const q = seededVector(h.index.dimension, 5);
      const id = await put(h, a, q);
      await put(h, b, seededVector(h.index.dimension, 6));
      const hits = await h.index.search({ workspaceId: b, vector: q, limit: 10, model: MODEL, version: VERSION });
      expect(hits.map((x) => x.id)).not.toContain(id);
      expect(hits).toHaveLength(1);
      expect((await h.index.getVectors(b, [id])).size).toBe(0);
    });

    it('only compares vectors written by the same model and version', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const q = seededVector(h.index.dimension, 2);
      await put(h, ws, q);
      expect(await h.index.search({ workspaceId: ws, vector: q, limit: 5, model: MODEL, version: '2' })).toEqual([]);
      expect(await h.index.search({ workspaceId: ws, vector: q, limit: 5, model: 'other', version: VERSION })).toEqual([]);
    });

    it('applies the structured filter and skips non-active memories by default', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const q = seededVector(h.index.dimension, 3);
      const semantic = await put(h, ws, nearVector(q, 0.02, 1), { category: 'semantic', confidence: 0.9 });
      const episodic = await put(h, ws, nearVector(q, 0.03, 2), { category: 'episodic', confidence: 0.3 });
      const old = await put(h, ws, nearVector(q, 0.01, 3), { status: 'superseded' });
      const base = { workspaceId: ws, vector: q, limit: 10, model: MODEL, version: VERSION };
      expect((await h.index.search(base)).map((x) => x.id).sort()).toEqual([semantic, episodic].sort());
      expect((await h.index.search({ ...base, filter: { categories: ['episodic'] } })).map((x) => x.id)).toEqual([episodic]);
      expect((await h.index.search({ ...base, filter: { minConfidence: 0.5 } })).map((x) => x.id)).toEqual([semantic]);
      expect((await h.index.search({ ...base, filter: { statuses: ['superseded'] } })).map((x) => x.id)).toEqual([old]);
    });

    it('fills the limit with matching memories even when closer ones are filtered out', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const q = seededVector(h.index.dimension, 4);
      for (let i = 0; i < 6; i += 1) await put(h, ws, nearVector(q, 0.01 * (i + 1), i), { category: 'episodic' });
      const target = await put(h, ws, nearVector(q, 0.5, 20), { category: 'procedural' });
      const hits = await h.index.search({ workspaceId: ws, vector: q, limit: 1, model: MODEL, version: VERSION, filter: { categories: ['procedural'] } });
      expect(hits.map((x) => x.id)).toEqual([target]);
    });

    it('upserts idempotently and replaces a vector', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const v1 = seededVector(h.index.dimension, 10);
      const v2 = seededVector(h.index.dimension, 11);
      const id = await put(h, ws, v1);
      await h.index.upsert([{ id, workspaceId: ws, vector: v1, model: MODEL, version: VERSION }]);
      expect((await h.index.search({ workspaceId: ws, vector: v1, limit: 5, model: MODEL, version: VERSION })).map((x) => x.id)).toEqual([id]);
      await h.index.upsert([{ id, workspaceId: ws, vector: v2, model: MODEL, version: VERSION }]);
      const hits = await h.index.search({ workspaceId: ws, vector: v2, limit: 5, model: MODEL, version: VERSION });
      expect(hits).toHaveLength(1);
      expect(hits[0].similarity).toBeCloseTo(1, 4);
      const stored = (await h.index.getVectors(ws, [id])).get(id);
      expect(stored).toHaveLength(h.index.dimension);
      expect(stored?.[0]).toBeCloseTo(v2[0], 4);
    });

    it('rejects a vector of the wrong length', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const m = makeMemoryInsert(ws);
      await h.store.transaction((tx) => tx.insertMemory(m));
      await expect(h.index.upsert([{ id: m.id, workspaceId: ws, vector: [1, 2, 3], model: MODEL, version: VERSION }])).rejects.toThrow();
      await expect(h.index.search({ workspaceId: ws, vector: [1, 2, 3], limit: 1, model: MODEL, version: VERSION })).rejects.toThrow();
    });

    it('removes vectors', async () => {
      const h = await make();
      const ws = uniqueName('ws');
      const q = seededVector(h.index.dimension, 12);
      const id = await put(h, ws, q);
      await h.index.remove(ws, [id]);
      expect(await h.index.search({ workspaceId: ws, vector: q, limit: 5, model: MODEL, version: VERSION })).toEqual([]);
      expect((await h.index.getVectors(ws, [id])).size).toBe(0);
    });

    it('answers ping and reports a dimension', async () => {
      const h = await make();
      await expect(h.index.ping()).resolves.toBeUndefined();
      expect(h.index.dimension).toBeGreaterThan(0);
    });
  });
}
