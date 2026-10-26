import { afterEach, describe, expect, it } from 'vitest';
import type { Embedder } from '../ports/embedder.js';

export interface EmbedderHarness {
  embedder: Embedder;
  /** True when the same text always gives the same vector (hash embedders). */
  deterministic: boolean;
  cleanup?: () => Promise<void>;
}

/** Contract any Embedder adapter must satisfy. */
export function runEmbedderContract(name: string, factory: () => Promise<EmbedderHarness>): void {
  describe(`Embedder contract: ${name}`, () => {
    const open: EmbedderHarness[] = [];
    const make = async (): Promise<EmbedderHarness> => {
      const h = await factory();
      open.push(h);
      return h;
    };
    afterEach(async () => {
      for (const h of open.splice(0)) {
        await h.cleanup?.();
        await h.embedder.close();
      }
    });

    it('identifies itself with a model, a version and a dimension', async () => {
      const { embedder } = await make();
      expect(embedder.name.length).toBeGreaterThan(0);
      expect(embedder.model.length).toBeGreaterThan(0);
      expect(embedder.version.length).toBeGreaterThan(0);
      expect(Number.isInteger(embedder.dimension) && embedder.dimension > 0).toBe(true);
    });

    it('returns one finite vector of the declared dimension per text, in order', async () => {
      const { embedder } = await make();
      const vectors = await embedder.embed(['launch the spring campaign', 'budget pacing', 'a third text']);
      expect(vectors).toHaveLength(3);
      for (const v of vectors) {
        expect(v).toHaveLength(embedder.dimension);
        expect(v.every((x) => Number.isFinite(x))).toBe(true);
      }
    });

    it('returns an empty list for no texts', async () => {
      const { embedder } = await make();
      expect(await embedder.embed([])).toEqual([]);
    });

    it('is deterministic when it says so, and gives different texts different vectors', async () => {
      const { embedder, deterministic } = await make();
      const [a1, b] = await embedder.embed(['the quick brown fox', 'completely different words about budgets']);
      const [a2] = await embedder.embed(['the quick brown fox']);
      if (deterministic) expect(a2).toEqual(a1);
      expect(b).not.toEqual(a1);
    });

    it('accepts both purposes and many texts at once', async () => {
      const { embedder } = await make();
      const many = Array.from({ length: 70 }, (_, i) => `text number ${i}`);
      const out = await embedder.embed(many, { purpose: 'document' });
      expect(out).toHaveLength(70);
      expect(await embedder.embed(['query text'], { purpose: 'query' })).toHaveLength(1);
    });

    it('answers ping', async () => {
      const { embedder } = await make();
      await expect(embedder.ping()).resolves.toBeUndefined();
    });
  });
}
