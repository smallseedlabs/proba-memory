/** The decay job on Postgres: the same behaviour as in memory, with real transactions, the job-run lease and the audit outbox. */
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryLogger, loadConfig, type AuditEvent } from '@smallseedlabs/proba-memory-core';
import { makeMemoryInsert, uniqueName } from '@smallseedlabs/proba-memory-core/testing';
import { createRuntime, type Runtime } from '@smallseedlabs/proba-memory-adapters';
import { TEST_DIMENSION, getTestPool, testDatabaseUrl, testRedisUrl } from '@smallseedlabs/proba-memory-adapters/testing';
import { createJobs } from './index.js';
import { createJobRunner } from '../runner.js';

await getTestPool();
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY).toISOString();
const runtimes: Runtime[] = [];

async function setup() {
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: testDatabaseUrl(),
      REDIS_URL: testRedisUrl(),
      EMBEDDING_DIMENSION: String(TEST_DIMENSION),
      JOB_SCHEDULER: 'manual',
      JOBS_ENABLED: 'decay',
      DECAY_BATCH_SIZE: '3',
      DECAY_CONFIDENCE_FLOOR: '0.1',
      AUDIT_TOPIC: uniqueName('audit'),
    },
    { serviceName: 'memory-jobs' }
  );
  const runtime = await createRuntime(config, { service: 'memory-jobs', logger: new MemoryLogger(), needs: { jobs: true } });
  runtimes.push(runtime);
  return { runtime, job: createJobs(config, 'memory-jobs')[0], runner: createJobRunner(runtime) };
}
afterAll(async () => {
  for (const r of runtimes) await r.close();
});

describe('decay on Postgres', () => {
  it('decays stale memories of every workspace in batches, once, with one outbox event per batch and no text', async () => {
    const { runtime, job, runner } = await setup();
    const ws = uniqueName('decay-ws');
    const other = uniqueName('decay-other');
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const insert = makeMemoryInsert(ws, { category: 'episodic', content: `Private plan ${i} for the quarter`, confidence: 0.8, importance: 0.8, lastReinforcedAt: daysAgo(14), createdAt: daysAgo(40 - i) });
      await runtime.store.transaction((tx) => tx.insertMemory(insert));
      ids.push(insert.id);
    }
    const fresh = makeMemoryInsert(other, { category: 'episodic', confidence: 0.8, importance: 0.8, lastReinforcedAt: new Date().toISOString() });
    await runtime.store.transaction((tx) => tx.insertMemory(fresh));

    const runs = await runner.runJob(job, 'manual');
    const run = runs.find((r) => r.workspaceId === ws)!;
    expect(run).toMatchObject({ status: 'succeeded', processed: 7, changed: 7, details: { batches: 3 } });
    for (const id of ids) {
      const m = (await runtime.store.getMemory(ws, id))!;
      expect(m.confidence).toBeCloseTo(0.1 + 0.7 / 2, 3);
      expect(m.status).toBe('active');
      expect(m.decayedAt).not.toBeNull();
    }
    expect((await runtime.store.getMemory(other, fresh.id))!.confidence).toBe(0.8);

    const claimed = await runtime.outbox.claim(Math.max(1000, (await runtime.outbox.pendingCount()) + 10), 1000);
    const decayed = claimed.map((e) => e.event as AuditEvent).filter((e) => e.action === 'memory.decayed' && e.workspaceId === ws);
    expect(decayed).toHaveLength(3);
    expect(JSON.stringify(decayed)).not.toContain('Private plan');
    await runtime.outbox.markPublished(claimed.map((e) => e.id));

    // A second run changes nothing.
    const again = (await runner.runJob(job, 'manual')).find((r) => r.workspaceId === ws)!;
    expect(again).toMatchObject({ processed: 7, changed: 0 });
  });

  it('lets only one run per workspace and job go at a time (lease), the other is skipped', async () => {
    const { runtime, job, runner } = await setup();
    const ws = uniqueName('decay-lease');
    for (let i = 0; i < 4; i += 1) {
      await runtime.store.transaction((tx) => tx.insertMemory(makeMemoryInsert(ws, { category: 'episodic', confidence: 0.8, lastReinforcedAt: daysAgo(14) })));
    }
    const [a, b] = await Promise.all([runner.runJob(job, 'manual'), createJobRunner(runtime).runJob(job, 'manual')]);
    const mine = [...a, ...b].filter((r) => r.workspaceId === ws);
    expect(mine.filter((r) => r.status === 'succeeded').length).toBeGreaterThanOrEqual(1);
    expect(mine.every((r) => ['succeeded', 'skipped'].includes(r.status))).toBe(true);
  });
});
