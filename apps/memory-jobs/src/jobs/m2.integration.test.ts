/** The M2 jobs on Postgres: real transactions, the pgvector index, the staged-vector migration, the lease and the audit outbox. */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryLogger, M2_JOB_NAMES, loadConfig, type AuditEvent, type Memory, type Job } from '@smallseedlabs/proba-memory-core';
import { makeMemoryInsert, makeObservation, makeLogEntry, uniqueName } from '@smallseedlabs/proba-memory-core/testing';
import { ScriptedLlmProvider, createRuntime, type Runtime } from '@smallseedlabs/proba-memory-adapters';
import { TEST_DIMENSION, getTestPool, testDatabaseUrl, testRedisUrl } from '@smallseedlabs/proba-memory-adapters/testing';
import { createJobDeps, createJobs, jobNeeds, type JobDeps } from './index.js';
import { joiningResponder } from './harness.testing.js';
import { createJobRunner } from '../runner.js';

await getTestPool();
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const runtimes: Runtime[] = [];

const A = 'The client prefers short headlines under forty characters.';
const B = 'The client prefers short headlines under forty characters in search ads.';
const C = 'The client likes short headlines under forty characters.';

async function setup() {
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: testDatabaseUrl(),
      REDIS_URL: testRedisUrl(),
      EMBEDDING_DIMENSION: String(TEST_DIMENSION),
      EMBEDDER: 'hash',
      ALLOW_LOCAL_EMBEDDER: 'true',
      LLM_PROVIDER: 'scripted',
      ALLOW_SCRIPTED_LLM: 'true',
      JOB_SCHEDULER: 'manual',
      JOBS_BATCH_SIZE: '2',
      AUDIT_TOPIC: uniqueName('audit'),
    },
    { serviceName: 'memory-jobs' }
  );
  const runtime = await createRuntime(config, { service: 'memory-jobs', logger: new MemoryLogger(), needs: jobNeeds([...M2_JOB_NAMES]) });
  runtimes.push(runtime);
  const llm = new ScriptedLlmProvider({ responder: joiningResponder, nodeEnv: 'test', allowScripted: false });
  const deps: JobDeps = { ...createJobDeps(runtime, [...M2_JOB_NAMES]), llm };
  const job = (name: string): Job => createJobs({ ...config, jobs: { ...config.jobs, enabled: [name] } }, 'memory-jobs', deps)[0];
  const runner = createJobRunner(runtime);
  const seed = async (ws: string, items: Partial<ReturnType<typeof makeMemoryInsert>>[]): Promise<Memory[]> => {
    const out: Memory[] = [];
    for (const item of items) {
      const [vector] = await runtime.embedder.embed([item.content ?? '']);
      const insert = makeMemoryInsert(ws, { embedding: vector, embeddingModel: runtime.embedder.model, embeddingVersion: runtime.embedder.version, ...item });
      await runtime.store.transaction((tx) => tx.insertMemory(insert));
      out.push((await runtime.store.getMemory(ws, insert.id))!);
    }
    return out;
  };
  const all = async (ws: string): Promise<Memory[]> =>
    (await runtime.store.listMemories({ workspaceId: ws, filter: { statuses: ['active', 'superseded', 'tombstoned'] }, limit: 200 })).memories;
  /** Drain this process's outbox and return the audit events of one workspace. */
  const audit = async (ws: string): Promise<AuditEvent[]> => {
    const claimed = await runtime.outbox.claim(Math.max(1000, (await runtime.outbox.pendingCount()) + 10), 1000);
    await runtime.outbox.markPublished(claimed.map((e) => e.id));
    return claimed.map((e) => e.event as AuditEvent).filter((e) => e.workspaceId === ws);
  };
  return { runtime, config, job, runner, seed, all, audit };
}
afterAll(async () => {
  for (const r of runtimes) await r.close();
});

describe('M2 jobs on Postgres', () => {
  it('consolidate: one semantic memory from the cluster, sources superseded, links written, idempotent, no text in the audit', async () => {
    const { runtime, job, runner, seed, all, audit } = await setup();
    const ws = uniqueName('m2-consolidate');
    const sources = await seed(ws, [
      { content: A, category: 'episodic', createdAt: ago(5 * HOUR) },
      { content: B, category: 'episodic', createdAt: ago(4 * HOUR) },
      { content: C, category: 'episodic', createdAt: ago(3 * HOUR) },
    ]);
    await audit(ws);
    const [run] = await runner.runJob(job('consolidate'), 'manual', { workspaceId: ws });
    expect(run).toMatchObject({ status: 'succeeded', details: { consolidated: 1, sourcesSuperseded: 3 } });
    const memories = await all(ws);
    const [summary] = memories.filter((m) => m.category === 'semantic');
    expect(memories.filter((m) => m.status === 'superseded')).toHaveLength(3);
    expect(await runtime.index.getVectors(ws, [summary.id])).toHaveProperty('size', 1);
    for (const s of sources) expect((await runtime.store.listLinks(ws, s.id))[0]).toMatchObject({ fromId: summary.id, relation: 'supersedes' });
    const events = (await audit(ws)).filter((e) => e.action === 'memory.consolidated');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('headlines');
    const [again] = await runner.runJob(job('consolidate'), 'manual', { workspaceId: ws });
    expect(again).toMatchObject({ status: 'succeeded', changed: 0 });
    expect(await all(ws)).toHaveLength(4);
  });

  it('reembed: stages beside the served vector, retrieval keeps working, cutover is atomic', async () => {
    const { runtime, job, runner, seed, all, audit } = await setup();
    const ws = uniqueName('m2-reembed');
    const old = { embeddingModel: 'old-model', embeddingVersion: '0' };
    await seed(ws, ['one', 'two', 'three', 'four', 'five'].map((w) => ({ content: `Memory about ${w} headlines.`, ...old })));
    const target = { model: runtime.embedder.model, version: runtime.embedder.version };
    const probe = (await runtime.embedder.embed(['Memory about one headlines.']))[0];
    await runtime.jobConfigs.publish({ workspaceId: ws, jobName: 'reembed', config: { maxPerRun: 2, autoCutover: true }, createdBy: 'test', at: new Date().toISOString() });
    const [partial] = await runner.runJob(job('reembed'), 'manual', { workspaceId: ws });
    expect(partial).toMatchObject({ details: { staged: 2, swapped: 0 } });
    expect(await runtime.index.search({ workspaceId: ws, vector: probe, limit: 10, model: 'old-model', version: '0' })).toHaveLength(5); // no downtime
    expect(await runtime.index.search({ workspaceId: ws, vector: probe, limit: 10, ...target })).toHaveLength(0);
    await runtime.jobConfigs.publish({ workspaceId: ws, jobName: 'reembed', config: { maxPerRun: 100, autoCutover: true }, createdBy: 'test', at: new Date().toISOString() });
    const [done] = await runner.runJob(job('reembed'), 'manual', { workspaceId: ws });
    expect(done).toMatchObject({ details: { staged: 3, swapped: 5 } });
    expect(await runtime.index.search({ workspaceId: ws, vector: probe, limit: 10, ...target })).toHaveLength(5);
    expect(await runtime.index.search({ workspaceId: ws, vector: probe, limit: 10, model: 'old-model', version: '0' })).toHaveLength(0);
    expect((await all(ws)).every((m) => m.embeddingModel === target.model)).toBe(true);
    const [again] = await runner.runJob(job('reembed'), 'manual', { workspaceId: ws });
    expect(again).toMatchObject({ changed: 0, details: { staged: 0, swapped: 0 } });
    expect((await audit(ws)).filter((e) => e.action === 'memory.reembedded').length).toBeGreaterThan(1);
  });

  it('cleanup: tombstones, never deletes, idempotent', async () => {
    const { runtime, job, runner, seed, all } = await setup();
    const ws = uniqueName('m2-cleanup');
    const [expired, fresh] = await seed(ws, [
      { content: 'Working: scratch.', category: 'working', lastReinforcedAt: ago(40 * HOUR) },
      { content: 'Working: new scratch.', category: 'working', lastReinforcedAt: ago(HOUR) },
    ]);
    const [run] = await runner.runJob(job('cleanup'), 'manual', { workspaceId: ws });
    expect(run).toMatchObject({ status: 'succeeded', changed: 1 });
    expect((await runtime.store.getMemory(ws, expired.id))!.status).toBe('tombstoned');
    expect((await runtime.store.getMemory(ws, fresh.id))!.status).toBe('active');
    expect(await all(ws)).toHaveLength(2);
    expect((await runner.runJob(job('cleanup'), 'manual', { workspaceId: ws }))[0]).toMatchObject({ changed: 0 });
  });

  it('usage-feedback: applies an outcome exactly once', async () => {
    const { runtime, job, runner, seed } = await setup();
    const ws = uniqueName('m2-usage');
    const [m] = await seed(ws, [{ content: A, usefulness: 0.5 }]);
    const traceId = randomUUID();
    const entry = makeLogEntry(ws, { traceId, createdAt: ago(2 * HOUR), results: [{ id: m.id, score: 0.9, position: 1 }] });
    await runtime.logStore.append(entry);
    await runtime.store.claimObservation(makeObservation(ws, { kind: 'approval.granted', traceId, occurredAt: ago(HOUR) }), new Date().toISOString());
    const [run] = await runner.runJob(job('usage-feedback'), 'manual', { workspaceId: ws });
    expect(run).toMatchObject({ status: 'succeeded', details: { resolved: { approved: 1 }, memoriesUpdated: 1 } });
    const once = (await runtime.store.getMemory(ws, m.id))!.usefulness;
    expect(once).toBeGreaterThan(0.5);
    await Promise.all([runner.runJob(job('usage-feedback'), 'manual', { workspaceId: ws }), createJobRunner(runtime).runJob(job('usage-feedback'), 'manual', { workspaceId: ws })]);
    expect((await runtime.store.getMemory(ws, m.id))!.usefulness).toBe(once);
  });

  it('lease: a second runner is skipped while the first holds the lease', async () => {
    const { runtime, job, runner, seed } = await setup();
    const ws = uniqueName('m2-lease');
    await seed(ws, [{ content: A }]);
    const slow = job('cleanup');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const original = slow.run.bind(slow);
    slow.run = async (ctx) => {
      await gate;
      return original(ctx);
    };
    const first = runner.runJob(slow, 'schedule', { workspaceId: ws });
    await new Promise((r) => setTimeout(r, 100));
    expect(await createJobRunner(runtime).runJob(job('cleanup'), 'manual', { workspaceId: ws })).toEqual([]);
    release();
    expect((await first)[0]).toMatchObject({ status: 'succeeded' });
  });

  it('every job: dry run on Postgres succeeds and changes nothing', async () => {
    const { runtime, job, runner, seed, all, audit } = await setup();
    const ws = uniqueName('m2-dry');
    await seed(ws, [
      { content: A, category: 'episodic', createdAt: ago(5 * HOUR), embeddingModel: 'old-model', embeddingVersion: '0' },
      { content: B, category: 'episodic', createdAt: ago(4 * HOUR), embeddingModel: 'old-model', embeddingVersion: '0' },
      { content: 'Working: scratch.', category: 'working', lastReinforcedAt: ago(40 * HOUR) },
    ]);
    await audit(ws);
    const before = JSON.stringify(await all(ws));
    for (const name of ['decay', ...M2_JOB_NAMES]) {
      const [run] = await runner.runJob(job(name), 'manual', { workspaceId: ws, dryRun: true });
      expect(run, name).toMatchObject({ status: 'succeeded', changed: 0, details: { dryRun: true } });
    }
    expect(JSON.stringify(await all(ws))).toBe(before);
    expect(await audit(ws)).toEqual([]);
    expect(await runtime.jobConfigs.list(ws, 'cleanup')).toEqual([]); // a dry run writes no config for the workspace
  });
});
