import { afterEach, describe, expect, it } from 'vitest';
import type { SourceAdapter } from '../ports/source-adapter.js';
import { sleep } from './fixtures.js';

export interface SourceAdapterHarness {
  adapter: SourceAdapter;
  /** Make `count` relevant records available to the adapter (publish to the stream, or no-op for a feed that already has data). */
  produce(count: number): Promise<void>;
  /** Make one record the adapter should ignore (acked silently). Optional. */
  produceIgnored?: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

/** Contract any SourceAdapter must satisfy. */
export function runSourceAdapterContract(name: string, factory: () => Promise<SourceAdapterHarness>): void {
  describe(`SourceAdapter contract: ${name}`, () => {
    const open: SourceAdapterHarness[] = [];
    const make = async (): Promise<SourceAdapterHarness> => {
      const h = await factory();
      open.push(h);
      return h;
    };
    afterEach(async () => {
      for (const h of open.splice(0)) {
        await h.cleanup?.();
        await h.adapter.close();
      }
    });

    it('delivers observations with stable, unique ids and the data the pipeline needs', async () => {
      const h = await make();
      await h.produce(3);
      const items = await h.adapter.poll({ max: 10, blockMs: 500 });
      expect(items.length).toBe(3);
      expect(new Set(items.map((i) => i.observation.id)).size).toBe(3);
      for (const item of items) {
        const o = item.observation;
        expect(o.workspaceId.length).toBeGreaterThan(0);
        expect(o.source).toBe(h.adapter.name);
        expect(o.sourceRef.length).toBeGreaterThan(0);
        expect(o.kind.length).toBeGreaterThan(0);
        expect(new Date(o.occurredAt).toISOString()).toBe(o.occurredAt);
        expect(o.signal.strength).toBeGreaterThanOrEqual(0);
        expect(o.signal.strength).toBeLessThanOrEqual(1);
        expect(item.deliveryCount).toBe(1);
        await item.ack();
      }
      expect(await h.adapter.poll({ max: 10 })).toEqual([]);
    });

    it('re-delivers an unacknowledged item through reclaim with a higher delivery count', async () => {
      const h = await make();
      await h.produce(1);
      const [item] = await h.adapter.poll({ max: 10, blockMs: 500 });
      expect(item).toBeDefined();
      await sleep(30);
      const again = await h.adapter.reclaim({ max: 10 });
      expect(again.map((i) => i.observation.id)).toContain(item.observation.id);
      expect(again[0].deliveryCount).toBeGreaterThanOrEqual(2);
      for (const i of again) await i.ack();
      expect(await h.adapter.reclaim({ max: 10 })).toEqual([]);
    });

    it('does not deliver a rejected item again', async () => {
      const h = await make();
      await h.produce(1);
      const [item] = await h.adapter.poll({ max: 10, blockMs: 500 });
      await item.reject('poison');
      await sleep(30);
      expect(await h.adapter.reclaim({ max: 10 })).toEqual([]);
      expect(await h.adapter.poll({ max: 10 })).toEqual([]);
    });

    it('acknowledges records it ignores without surfacing them', async () => {
      const h = await make();
      if (!h.produceIgnored) return;
      await h.produceIgnored();
      expect(await h.adapter.poll({ max: 10, blockMs: 200 })).toEqual([]);
      await sleep(30);
      expect(await h.adapter.reclaim({ max: 10 })).toEqual([]);
    });

    it('answers ping', async () => {
      const h = await make();
      await expect(h.adapter.ping()).resolves.toBeUndefined();
    });
  });
}
