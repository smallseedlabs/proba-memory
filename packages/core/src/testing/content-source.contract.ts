import { afterEach, describe, expect, it } from 'vitest';
import type { HubContentSource } from '../ports/source-adapter.js';

export interface ContentSourceHarness {
  source: HubContentSource;
  cleanup?: () => Promise<void>;
}

/** Contract any HubContentSource must satisfy. */
export function runHubContentSourceContract(name: string, factory: () => Promise<ContentSourceHarness>): void {
  describe(`HubContentSource contract: ${name}`, () => {
    const open: ContentSourceHarness[] = [];
    const make = async (): Promise<ContentSourceHarness> => {
      const h = await factory();
      open.push(h);
      return h;
    };
    afterEach(async () => {
      for (const h of open.splice(0)) {
        await h.cleanup?.();
        await h.source.close();
      }
    });

    it('pages with a cursor: no item twice, nothing skipped, and the same page again gives the same items', async () => {
      const { source } = await make();
      const first = await source.fetch(null, 5);
      expect(first.items.length).toBeGreaterThan(0);
      expect(first.items.length).toBeLessThanOrEqual(5);
      expect(first.nextCursor).not.toBeNull();
      const again = await source.fetch(null, 5);
      expect(again.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
      const second = await source.fetch(first.nextCursor, 5);
      const ids = new Set(first.items.map((i) => `${i.kind}:${i.id}`));
      for (const item of second.items) expect(ids.has(`${item.kind}:${item.id}`)).toBe(false);
    });

    it('returns complete items: workspace, time, text, and a source reference', async () => {
      const { source } = await make();
      const { items } = await source.fetch(null, 10);
      for (const item of items) {
        expect(item.workspaceId.length).toBeGreaterThan(0);
        expect(new Date(item.occurredAt).toISOString()).toBe(item.occurredAt);
        expect(item.text.length).toBeGreaterThan(0);
        expect(item.sourceRef.length).toBeGreaterThan(0);
        expect(['goal', 'approval', 'thread_message']).toContain(item.kind);
        if (item.kind === 'approval') expect(item.decision).toBeDefined();
      }
    });

    it('answers ping', async () => {
      const { source } = await make();
      await expect(source.ping()).resolves.toBeUndefined();
    });
  });
}
