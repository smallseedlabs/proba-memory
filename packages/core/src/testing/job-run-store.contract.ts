import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JobRunStore, StartJobRun } from '../ports/job-run-store.js';
import { uniqueName } from './fixtures.js';

export interface JobRunStoreHarness {
  store: JobRunStore;
  cleanup?: () => Promise<void>;
}

const start = (workspaceId: string, overrides: Partial<StartJobRun> = {}): StartJobRun => ({
  id: randomUUID(),
  jobName: 'decay',
  workspaceId,
  traceId: randomUUID(),
  trigger: 'schedule',
  startedAt: new Date().toISOString(),
  staleAfterMs: 60_000,
  ...overrides,
});

/** Contract any JobRunStore adapter must satisfy. */
export function runJobRunStoreContract(name: string, factory: () => Promise<JobRunStoreHarness>): void {
  describe(`JobRunStore contract: ${name}`, () => {
    const open: JobRunStoreHarness[] = [];
    const make = async (): Promise<JobRunStoreHarness> => {
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

    it('records a run from start to success', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const s = start(ws);
      const run = await store.start(s);
      expect(run).toMatchObject({ id: s.id, jobName: 'decay', workspaceId: ws, status: 'running', traceId: s.traceId, trigger: 'schedule', finishedAt: null });
      const done = await store.finishSuccess(s.id, { processed: 10, changed: 4, details: { batches: 1 } }, new Date(Date.parse(s.startedAt) + 250).toISOString());
      expect(done).toMatchObject({ status: 'succeeded', processed: 10, changed: 4, error: null, durationMs: 250, details: { batches: 1 } });
    });

    it('records a failure with its error', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const s = start(ws);
      await store.start(s);
      const failed = await store.finishFailure(s.id, 'database unreachable', new Date(Date.parse(s.startedAt) + 5).toISOString());
      expect(failed).toMatchObject({ status: 'failed', error: 'database unreachable' });
    });

    it('allows one running run per job and workspace', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const first = start(ws);
      expect(await store.start(first)).not.toBeNull();
      expect(await store.start(start(ws))).toBeNull();
      expect(await store.start(start(ws, { jobName: 'other' }))).not.toBeNull();
      expect(await store.start(start(uniqueName('ws')))).not.toBeNull();
      await store.finishSuccess(first.id, { processed: 0, changed: 0 }, new Date().toISOString());
      expect(await store.start(start(ws))).not.toBeNull();
    });

    it('closes an abandoned run (older than its lease) as failed and starts a new one', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const old = start(ws, { startedAt: new Date(Date.now() - 3_600_000).toISOString(), staleAfterMs: 1000 });
      await store.start(old);
      const next = await store.start(start(ws, { staleAfterMs: 1000 }));
      expect(next).not.toBeNull();
      const runs = await store.list({ workspaceId: ws });
      expect(runs.find((r) => r.id === old.id)).toMatchObject({ status: 'failed' });
      expect(runs.find((r) => r.id === old.id)?.error).toMatch(/abandoned/i);
    });

    it('lists newest first with filters', async () => {
      const { store } = await make();
      const ws = uniqueName('ws');
      const a = start(ws, { startedAt: '2026-10-26T08:00:00.000Z' });
      const b = start(ws, { jobName: 'other', startedAt: '2026-10-26T09:00:00.000Z' });
      await store.start(a);
      await store.start(b);
      expect((await store.list({ workspaceId: ws })).map((r) => r.id)).toEqual([b.id, a.id]);
      expect((await store.list({ workspaceId: ws, jobName: 'decay' })).map((r) => r.id)).toEqual([a.id]);
      expect(await store.list({ workspaceId: ws, limit: 1 })).toHaveLength(1);
    });

    it('answers ping', async () => {
      const { store } = await make();
      await expect(store.ping()).resolves.toBeUndefined();
    });
  });
}
