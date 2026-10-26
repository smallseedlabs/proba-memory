import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildAuditEvent, type AuditEvent } from '@smallseedlabs/proba-protocol/audit';
import type { OutboxStore } from '../ports/outbox-store.js';
import { sleep, uniqueName } from './fixtures.js';

export interface OutboxStoreHarness {
  store: OutboxStore;
  cleanup?: () => Promise<void>;
}

function makeEvent(workspaceId: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return buildAuditEvent({
    traceId: randomUUID(),
    workspaceId,
    actor: { type: 'service', id: 'hub' },
    service: 'hub',
    action: 'command.received',
    category: 'command',
    outcome: 'success',
    ...overrides,
  });
}

/**
 * Contract any OutboxStore adapter must satisfy. The factory must return a store
 * that starts EMPTY (a fresh table or a fresh in-memory instance): the tests count rows.
 */
export function runOutboxStoreContract(name: string, factory: () => Promise<OutboxStoreHarness>): void {
  describe(`OutboxStore contract: ${name}`, () => {
    const harnesses: OutboxStoreHarness[] = [];
    async function create(): Promise<OutboxStore> {
      const h = await factory();
      harnesses.push(h);
      return h.store;
    }
    afterEach(async () => {
      while (harnesses.length) {
        const h = harnesses.pop()!;
        await h.store.close();
        await h.cleanup?.();
      }
    });

    it('enqueues events and claims them oldest first, with the event intact', async () => {
      const store = await create();
      const ws = uniqueName('ws');
      const events = [makeEvent(ws, { details: { n: 1 } }), makeEvent(ws, { details: { n: 2 } }), makeEvent(ws, { details: { n: 3 } })];
      expect(await store.enqueue(events)).toBe(3);
      expect(await store.pendingCount()).toBe(3);
      const claimed = await store.claim(10, 5000);
      expect(claimed.map((c) => c.event)).toEqual(events);
      expect(claimed.every((c) => c.attempts === 1)).toBe(true);
      expect(claimed.every((c) => /^\d+$/.test(c.id))).toBe(true);
      expect(claimed.every((c) => /^\d{4}-\d{2}-\d{2}T.*Z$/.test(c.createdAt))).toBe(true);
    });

    it('ignores an eventId that is already in the outbox', async () => {
      const store = await create();
      const e = makeEvent(uniqueName('ws'));
      expect(await store.enqueue([e, e])).toBe(1);
      expect(await store.enqueue([e])).toBe(0);
      expect(await store.pendingCount()).toBe(1);
    });

    it('enqueues an empty list as a no-op', async () => {
      const store = await create();
      expect(await store.enqueue([])).toBe(0);
      expect(await store.claim(10, 1000)).toEqual([]);
    });

    it('honours the claim limit and leases claimed rows', async () => {
      const store = await create();
      const ws = uniqueName('ws');
      await store.enqueue([makeEvent(ws), makeEvent(ws), makeEvent(ws)]);
      const first = await store.claim(2, 5000);
      expect(first).toHaveLength(2);
      const second = await store.claim(10, 5000);
      expect(second).toHaveLength(1); // the leased rows are skipped
      expect(new Set([...first, ...second].map((c) => c.id)).size).toBe(3);
      expect(await store.claim(10, 5000)).toEqual([]);
    });

    it('makes a row claimable again after its lease expires, counting attempts', async () => {
      const store = await create();
      await store.enqueue([makeEvent(uniqueName('ws'))]);
      const [first] = await store.claim(1, 50);
      expect(first?.attempts).toBe(1);
      expect(await store.claim(1, 50)).toEqual([]);
      await sleep(120);
      const [again] = await store.claim(1, 5000);
      expect(again?.id).toBe(first?.id);
      expect(again?.attempts).toBe(2);
    });

    it('never claims published rows again', async () => {
      const store = await create();
      await store.enqueue([makeEvent(uniqueName('ws')), makeEvent(uniqueName('ws'))]);
      const claimed = await store.claim(10, 30);
      await store.markPublished([claimed[0]!.id]);
      expect(await store.pendingCount()).toBe(1);
      await sleep(80);
      const again = await store.claim(10, 5000);
      expect(again.map((c) => c.id)).toEqual([claimed[1]!.id]);
    });

    it('records failures and retries after the lease', async () => {
      const store = await create();
      await store.enqueue([makeEvent(uniqueName('ws'))]);
      const [row] = await store.claim(1, 40);
      await store.markFailed([row!.id], 'bus down');
      expect(await store.pendingCount()).toBe(1);
      await sleep(100);
      const [retry] = await store.claim(1, 5000);
      expect(retry?.id).toBe(row?.id);
      expect(retry?.attempts).toBe(2);
    });

    it('prunes only published rows older than the cutoff', async () => {
      const store = await create();
      await store.enqueue([makeEvent(uniqueName('ws')), makeEvent(uniqueName('ws'))]);
      const claimed = await store.claim(10, 5000);
      await store.markPublished([claimed[0]!.id]);
      expect(await store.prunePublished('2000-01-01T00:00:00.000Z')).toBe(0);
      expect(await store.prunePublished(new Date(Date.now() + 60_000).toISOString())).toBe(1);
      expect(await store.pendingCount()).toBe(1);
    });

    it('pings', async () => {
      await expect((await create()).ping()).resolves.toBeUndefined();
    });
  });
}
