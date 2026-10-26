import { afterEach, describe, expect, it } from 'vitest';
import { GLOBAL_WORKSPACE, type JobConfigStore } from '../ports/job-config-store.js';
import { uniqueName } from './fixtures.js';

export interface JobConfigStoreHarness {
  store: JobConfigStore;
  cleanup?: () => Promise<void>;
}

const AT = '2026-10-26T09:00:00.000Z';

/** Contract any JobConfigStore adapter must satisfy. Each test uses its own job names and workspace ids. */
export function runJobConfigStoreContract(name: string, factory: () => Promise<JobConfigStoreHarness>): void {
  describe(`JobConfigStore contract: ${name}`, () => {
    const open: JobConfigStoreHarness[] = [];
    const make = async (): Promise<JobConfigStoreHarness> => {
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

    const input = (workspaceId: string, jobName: string, config: Record<string, unknown>) => ({ workspaceId, jobName, config, createdBy: 'test', at: AT, note: 'n' });

    it('returns null when nothing is published', async () => {
      const { store } = await make();
      expect(await store.resolve(uniqueName('ws'), uniqueName('job'))).toBeNull();
      expect(await store.list(uniqueName('ws'), uniqueName('job'))).toEqual([]);
    });

    it('publishes versions 1, 2, 3 and retires the previous one', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const job = uniqueName('job');
      const v1 = await store.publish(input(ws, job, { threshold: 0.8 }));
      const v2 = await store.publish(input(ws, job, { threshold: 0.7 }));
      const v3 = await store.publish(input(ws, job, { threshold: 0.6, nested: { a: [1, 2] } }));
      expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
      expect(v1).toMatchObject({ workspaceId: ws, jobName: job, status: 'active', createdBy: 'test', createdAt: AT, note: 'n', config: { threshold: 0.8 } });
      const active = await store.resolve(ws, job);
      expect(active).toMatchObject({ version: 3, status: 'active', config: { threshold: 0.6, nested: { a: [1, 2] } } });
      const history = await store.list(ws, job);
      expect(history.map((r) => [r.version, r.status])).toEqual([[3, 'active'], [2, 'retired'], [1, 'retired']]);
      expect(history[2].config).toEqual({ threshold: 0.8 }); // old versions are immutable
    });

    it('falls back to the global version, and a workspace version wins for that workspace only', async () => {
      const { store } = await make();
      const a = uniqueName('wsA');
      const b = uniqueName('wsB');
      const job = uniqueName('job');
      await store.publish(input(GLOBAL_WORKSPACE, job, { scope: 'global' }));
      expect((await store.resolve(a, job))?.config).toEqual({ scope: 'global' });
      await store.publish(input(a, job, { scope: 'a' }));
      expect((await store.resolve(a, job))?.config).toEqual({ scope: 'a' });
      expect((await store.resolve(b, job))?.config).toEqual({ scope: 'global' });
      expect(await store.list(a, job)).toHaveLength(1); // list does not mix in the global versions
      expect(await store.list(GLOBAL_WORKSPACE, job)).toHaveLength(1);
    });

    it('keeps jobs apart', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const one = uniqueName('job');
      const two = uniqueName('job');
      await store.publish(input(ws, one, { x: 1 }));
      expect(await store.resolve(ws, two)).toBeNull();
      expect((await store.publish(input(ws, two, { x: 2 }))).version).toBe(1);
    });

    it('onlyIfAbsent seeds once and returns the active version afterwards', async () => {
      const { store } = await make();
      const job = uniqueName('job');
      const first = await store.publish({ ...input(GLOBAL_WORKSPACE, job, { seed: 1 }), onlyIfAbsent: true });
      const second = await store.publish({ ...input(GLOBAL_WORKSPACE, job, { seed: 2 }), onlyIfAbsent: true });
      expect(first.version).toBe(1);
      expect(second).toMatchObject({ id: first.id, version: 1, config: { seed: 1 } });
      expect(await store.list(GLOBAL_WORKSPACE, job)).toHaveLength(1);
    });

    it('gives concurrent publishers distinct versions and leaves exactly one active', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const job = uniqueName('job');
      const published = await Promise.all([1, 2, 3, 4, 5].map((n) => store.publish(input(ws, job, { n }))));
      expect(published.map((r) => r.version).sort()).toEqual([1, 2, 3, 4, 5]);
      const history = await store.list(ws, job);
      expect(history.filter((r) => r.status === 'active')).toHaveLength(1);
      expect(history[0].version).toBe(5);
    });

    it('answers ping', async () => {
      const { store } = await make();
      await expect(store.ping()).resolves.toBeUndefined();
    });
  });
}
