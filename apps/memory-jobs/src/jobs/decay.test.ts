import { afterEach, describe, expect, it } from 'vitest';
import { MemoryLogger, loadConfig, type AuditEvent, type Memory, type MemoryInsert } from '@smallseedlabs/proba-memory-core';
import { makeMemoryInsert } from '@smallseedlabs/proba-memory-core/testing';
import { ManualClock, createRuntime, type Runtime } from '@smallseedlabs/proba-memory-adapters';
import { DecayJob, computeDecay, createJobs, type DecayOptions } from './index.js';
import { createJobRunner } from '../runner.js';

const NOW = '2026-10-26T12:00:00.000Z';
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.parse(NOW) - n * DAY).toISOString();

const OPTIONS: DecayOptions = {
  intervalMs: 3_600_000,
  batchSize: 100,
  confidenceFloor: 0.1,
  importanceFloor: 0.05,
  importanceHalfLifeMultiplier: 2,
  minChange: 0.005,
  halfLifeDays: { working: 1, episodic: 14, semantic: 180, procedural: 365, super: 730 },
  service: 'memory-jobs',
};

const memory = (overrides: Partial<Memory> = {}): Memory => ({ ...(makeMemoryInsert('ws', {}) as unknown as Memory), updatedAt: NOW, ...overrides });

describe('computeDecay', () => {
  it('halves the distance to the floor after one half-life', () => {
    const m = memory({ category: 'semantic', confidence: 0.9, importance: 0.8, lastReinforcedAt: daysAgo(180), decayedAt: null });
    const change = computeDecay(m, NOW, OPTIONS)!;
    expect(change.confidence).toBeCloseTo(0.1 + (0.9 - 0.1) / 2, 6);
    // importance has twice the half-life, so it has lost a quarter of the distance... i.e. 0.5^(1/2) of it remains
    expect(change.importance).toBeCloseTo(0.05 + (0.8 - 0.05) * Math.sqrt(0.5), 6);
  });

  it('decays at the pace of the category: working memory fast, procedural and super slowly', () => {
    const base = { confidence: 0.9, importance: 0.9, lastReinforcedAt: daysAgo(14), decayedAt: null };
    const after = (category: Memory['category']) => computeDecay(memory({ ...base, category }), NOW, OPTIONS)!.confidence;
    const [working, episodic, semantic, procedural, sup] = (['working', 'episodic', 'semantic', 'procedural', 'super'] as const).map(after);
    expect(working).toBeLessThan(episodic);
    expect(episodic).toBeLessThan(semantic);
    expect(semantic).toBeLessThan(procedural);
    expect(procedural).toBeLessThan(sup);
    expect(episodic).toBeCloseTo(0.1 + 0.8 / 2, 6); // exactly one episodic half-life
    expect(working).toBeCloseTo(0.1, 3); // a fortnight of a one-day half-life
  });

  it('never goes below the floors, and never increases a value that is already below its floor', () => {
    const old = memory({ category: 'working', confidence: 0.9, importance: 0.9, lastReinforcedAt: daysAgo(3650), decayedAt: null });
    const change = computeDecay(old, NOW, OPTIONS)!;
    expect(change.confidence).toBeGreaterThanOrEqual(0.1);
    expect(change.importance).toBeGreaterThanOrEqual(0.05);
    const low = memory({ category: 'working', confidence: 0.02, importance: 0.01, lastReinforcedAt: daysAgo(3650), decayedAt: null });
    expect(computeDecay(low, NOW, OPTIONS)).toBeNull();
  });

  it('measures from the later of the last reinforcement and the last decay, so repeated runs do not compound', () => {
    const m = memory({ category: 'episodic', confidence: 0.8, importance: 0.8, lastReinforcedAt: daysAgo(100), decayedAt: daysAgo(14) });
    expect(computeDecay(m, NOW, OPTIONS)!.confidence).toBeCloseTo(0.1 + 0.7 / 2, 6);
    const reinforcedLater = memory({ category: 'episodic', confidence: 0.8, lastReinforcedAt: daysAgo(14), decayedAt: daysAgo(100) });
    expect(computeDecay(reinforcedLater, NOW, OPTIONS)!.confidence).toBeCloseTo(0.1 + 0.7 / 2, 6);
  });

  it('does nothing when no time has passed, the clock went backwards, or the change is below minChange', () => {
    expect(computeDecay(memory({ lastReinforcedAt: NOW, decayedAt: null }), NOW, OPTIONS)).toBeNull();
    expect(computeDecay(memory({ lastReinforcedAt: daysAgo(-5), decayedAt: null }), NOW, OPTIONS)).toBeNull();
    expect(computeDecay(memory({ category: 'super', lastReinforcedAt: daysAgo(0.1), decayedAt: null }), NOW, OPTIONS)).toBeNull();
    expect(computeDecay(memory({ lastReinforcedAt: 'not a date', decayedAt: null }), NOW, OPTIONS)).toBeNull();
  });

  it('only decays toward the floor: values at or below it stay put', () => {
    const m = memory({ category: 'episodic', confidence: 0.1, importance: 0.05, lastReinforcedAt: daysAgo(500), decayedAt: null });
    expect(computeDecay(m, NOW, OPTIONS)).toBeNull();
  });
});

const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MEMORY_STORE: 'memory',
  VECTOR_INDEX: 'memory',
  SCORING_PROFILE_STORE: 'memory',
  RETRIEVAL_LOG_STORE: 'memory',
  JOB_RUN_STORE: 'memory',
  OUTBOX_STORE: 'memory',
  EVENT_BUS: 'memory',
  AUDIT_TRANSPORT: 'bus',
  JOB_SCHEDULER: 'manual',
  EMBEDDING_DIMENSION: '64',
  JOBS_ENABLED: 'decay',
  DECAY_BATCH_SIZE: '3',
  DECAY_CONFIDENCE_FLOOR: '0.1',
  DECAY_IMPORTANCE_FLOOR: '0.05',
};

const open: Runtime[] = [];
async function setup(extra: Record<string, string> = {}) {
  const config = loadConfig({ ...ENV, ...extra }, { serviceName: 'memory-jobs' });
  const clock = new ManualClock(NOW);
  const logger = new MemoryLogger();
  const runtime = await createRuntime(config, { service: 'memory-jobs', logger, clock, needs: { jobs: true } });
  open.push(runtime);
  const job = createJobs(config, 'memory-jobs')[0];
  const runner = createJobRunner(runtime);
  const seed = async (workspaceId: string, items: Partial<MemoryInsert>[]): Promise<Memory[]> => {
    const out: Memory[] = [];
    for (const item of items) {
      const insert = makeMemoryInsert(workspaceId, item);
      await runtime.store.transaction((tx) => tx.insertMemory(insert));
      out.push((await runtime.store.getMemory(workspaceId, insert.id))!);
    }
    return out;
  };
  const events = async (): Promise<AuditEvent[]> => {
    const sub = await runtime.bus.subscribe({ topic: config.eventBus.auditTopic, group: 'test', consumer: 'c' });
    return (await sub.read<AuditEvent>({ max: 5000 })).map((m) => m.payload);
  };
  return { runtime, config, clock, logger, job, runner, seed, events };
}
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
});

describe('DecayJob', () => {
  it('is configured from JOBS_ENABLED and the DECAY_* settings', async () => {
    const { job, config } = await setup();
    expect(job).toBeInstanceOf(DecayJob);
    expect(job.intervalMs).toBe(config.jobs.decay.intervalMs);
    expect(() => createJobs(loadConfig({ ...ENV, JOBS_ENABLED: 'decay,bogus' }, { serviceName: 'x' }), 'x')).toThrow(/unknown job "bogus"/);
  });

  it('lowers confidence and importance of stale memories, leaves fresh ones, and never deletes or retires', async () => {
    const { runtime, job, runner, seed } = await setup();
    const [stale, fresh, old] = await seed('ws', [
      { category: 'episodic', confidence: 0.8, importance: 0.8, lastReinforcedAt: daysAgo(14), createdAt: daysAgo(30) },
      { category: 'episodic', confidence: 0.8, importance: 0.8, lastReinforcedAt: NOW, createdAt: daysAgo(29) },
      { category: 'working', confidence: 0.9, importance: 0.9, lastReinforcedAt: daysAgo(60), createdAt: daysAgo(28) },
    ]);
    const [run] = await runner.runJob(job, 'manual');
    expect(run).toMatchObject({ status: 'succeeded', processed: 3, changed: 2, workspaceId: 'ws' });

    const after = async (m: Memory) => (await runtime.store.getMemory('ws', m.id))!;
    const s = await after(stale);
    expect(s.confidence).toBeCloseTo(0.1 + 0.7 / 2, 6);
    expect(s.importance).toBeLessThan(0.8);
    expect(s.decayedAt).toBe(NOW);
    expect(s.status).toBe('active');
    expect(s.content).toBe(stale.content);
    expect(s.lastReinforcedAt).toBe(stale.lastReinforcedAt);
    expect((await after(fresh)).confidence).toBe(0.8);
    expect((await after(fresh)).decayedAt).toBeNull();
    const o = await after(old);
    expect(o.confidence).toBeCloseTo(0.1, 3);
    expect(o.status).toBe('active');
    expect(await runtime.store.countMemories('ws', { statuses: ['active', 'superseded', 'tombstoned'] })).toBe(3);
  });

  it('is idempotent: a second run right after changes nothing and emits nothing', async () => {
    const { runtime, job, runner, seed, events } = await setup();
    const [m] = await seed('ws', [{ category: 'episodic', confidence: 0.8, importance: 0.8, lastReinforcedAt: daysAgo(14) }]);
    await runner.runJob(job, 'manual');
    const once = (await runtime.store.getMemory('ws', m.id))!;
    const firstEvents = (await events()).filter((e) => e.action === 'memory.decayed');
    expect(firstEvents).toHaveLength(1);
    const [again] = await runner.runJob(job, 'manual');
    expect(again).toMatchObject({ processed: 1, changed: 0 });
    expect(await runtime.store.getMemory('ws', m.id)).toEqual(once);
    expect((await events()).filter((e) => e.action === 'memory.decayed')).toHaveLength(0);
  });

  it('applying decay in two steps equals one step (time passes between runs)', async () => {
    const { runtime, clock, job, runner, seed } = await setup();
    const [m] = await seed('ws', [{ category: 'episodic', confidence: 0.9, importance: 0.9, lastReinforcedAt: NOW }]);
    clock.advance(7 * DAY);
    await runner.runJob(job, 'manual');
    clock.advance(7 * DAY);
    await runner.runJob(job, 'manual');
    const stepped = (await runtime.store.getMemory('ws', m.id))!;
    expect(stepped.confidence).toBeCloseTo(0.1 + 0.8 / 2, 4); // 14 days = one episodic half-life
  });

  it('emits one memory.decayed event per batch with ids and counts, never memory text', async () => {
    const { job, runner, seed, events } = await setup();
    const items = Array.from({ length: 7 }, (_, i) => ({ category: 'episodic' as const, content: `Private plan number ${i} for the quarter`, confidence: 0.8, importance: 0.8, lastReinforcedAt: daysAgo(14), createdAt: daysAgo(40 - i) }));
    const created = await seed('ws', items);
    const [run] = await runner.runJob(job, 'manual');
    expect(run).toMatchObject({ processed: 7, changed: 7, details: { batches: 3 } });
    const decayed = (await events()).filter((e) => e.action === 'memory.decayed');
    expect(decayed).toHaveLength(3);
    for (const e of decayed) {
      expect(e).toMatchObject({ workspaceId: 'ws', category: 'memory', outcome: 'success', actor: { type: 'service', id: 'memory-jobs' }, target: { type: 'job', id: 'decay' } });
      expect(e.traceId).toBe(run.traceId);
      expect(e.details).toMatchObject({ job: 'decay', runId: run.id, byCategory: { episodic: expect.any(Number) } });
    }
    expect(decayed.flatMap((e) => (e.details as { memoryIds: string[] }).memoryIds).sort()).toEqual(created.map((m) => m.id).sort());
    expect(JSON.stringify(decayed)).not.toContain('Private plan');
  });

  it('touches only active memories, and only those of the workspace being run', async () => {
    const { runtime, job, runner, seed, events } = await setup();
    const [a, superseded, tombstoned] = await seed('ws-a', [
      { category: 'episodic', confidence: 0.8, lastReinforcedAt: daysAgo(14) },
      { category: 'episodic', confidence: 0.8, lastReinforcedAt: daysAgo(14), status: 'superseded' },
      { category: 'episodic', confidence: 0.8, lastReinforcedAt: daysAgo(14), status: 'tombstoned' },
    ]);
    const [b] = await seed('ws-b', [{ category: 'episodic', confidence: 0.8, lastReinforcedAt: daysAgo(28) }]);
    const runs = await runner.runJob(job, 'manual');
    expect(runs.map((r) => r.workspaceId).sort()).toEqual(['ws-a', 'ws-b']);
    expect((await runtime.store.getMemory('ws-a', superseded.id))!.confidence).toBe(0.8);
    expect((await runtime.store.getMemory('ws-a', tombstoned.id))!.confidence).toBe(0.8);
    expect((await runtime.store.getMemory('ws-a', a.id))!.confidence).toBeCloseTo(0.1 + 0.7 / 2, 6);
    expect((await runtime.store.getMemory('ws-b', b.id))!.confidence).toBeCloseTo(0.1 + 0.7 / 4, 6);
    const decayed = (await events()).filter((e) => e.action === 'memory.decayed');
    for (const e of decayed) {
      const ids = (e.details as { memoryIds: string[] }).memoryIds;
      expect(ids.every((id) => (e.workspaceId === 'ws-a' ? [a.id] : [b.id]).includes(id))).toBe(true);
    }
  });

  it('a memory reinforced after the run starts resets its decay clock (decayedAt is cleared by the write path)', async () => {
    const { runtime, clock, job, runner, seed } = await setup();
    const [m] = await seed('ws', [{ category: 'episodic', confidence: 0.8, importance: 0.8, lastReinforcedAt: daysAgo(14) }]);
    await runner.runJob(job, 'manual');
    clock.advance(14 * DAY);
    await runtime.store.transaction((tx) => tx.updateMemory('ws', m.id, { lastReinforcedAt: clock.isoNow(), decayedAt: null, confidence: 0.9 }, clock.isoNow()));
    await runner.runJob(job, 'manual');
    expect((await runtime.store.getMemory('ws', m.id))!.confidence).toBe(0.9);
  });

  it('records the run, emits system.job_run, and skips a run while another holds the lease', async () => {
    const { runtime, job, runner, seed, events } = await setup();
    await seed('ws', [{ category: 'episodic', confidence: 0.8, lastReinforcedAt: daysAgo(14) }]);
    const slow = new DecayJob({ ...OPTIONS, service: 'memory-jobs' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const original = slow.run.bind(slow);
    slow.run = async (ctx) => {
      await gate;
      return original(ctx);
    };
    const first = runner.runJob(slow, 'schedule');
    await new Promise((r) => setTimeout(r, 10));
    expect(await runner.runJob(job, 'manual')).toEqual([]); // lease held
    release();
    const [run] = await first;
    expect(run).toMatchObject({ status: 'succeeded', trigger: 'schedule' });
    const lifecycle = (await events()).filter((e) => e.action === 'system.job_run');
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].details).toMatchObject({ job: 'decay', changed: 1 });
    expect((await runtime.jobRuns.list?.({ jobName: 'decay' }))?.length ?? 1).toBeGreaterThan(0);
  });

  it('a failing run is recorded and audited, and does not stop the other workspaces', async () => {
    const { runtime, job, runner, seed, events } = await setup();
    await seed('ws-a', [{ category: 'episodic', confidence: 0.8, lastReinforcedAt: daysAgo(14) }]);
    await seed('ws-b', [{ category: 'episodic', confidence: 0.8, lastReinforcedAt: daysAgo(14) }]);
    const realList = runtime.store.listMemories.bind(runtime.store);
    runtime.store.listMemories = async (q) => {
      if (q.workspaceId === 'ws-a') throw new Error('database went away');
      return realList(q);
    };
    const runs = await runner.runJob(job, 'manual');
    expect(runs.map((r) => [r.workspaceId, r.status]).sort()).toEqual([['ws-a', 'failed'], ['ws-b', 'succeeded']]);
    const failed = (await events()).filter((e) => e.action === 'system.job_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ workspaceId: 'ws-a', outcome: 'failure' });
  });

  it('stops at the next batch boundary when the process is shutting down', async () => {
    const { runtime, job, runner, seed } = await setup();
    await seed('ws', Array.from({ length: 9 }, (_, i) => ({ category: 'episodic' as const, confidence: 0.8, lastReinforcedAt: daysAgo(14), createdAt: daysAgo(40 - i) })));
    runner.shutdown();
    expect(await runner.runJob(job, 'manual')).toEqual([]);
    expect(await runtime.store.countMemories('ws')).toBe(9);
  });
});
