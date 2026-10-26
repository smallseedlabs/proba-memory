import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, M2_JOB_NAMES } from '@smallseedlabs/proba-memory-core';
import { createJobs, jobNeeds, JOB_NAMES } from './index.js';
import { parseArgs } from '../run-job-cli.js';
import { DAY, HOUR, ago, closeHarnesses, setup, BASE_ENV } from './harness.testing.js';

afterEach(closeHarnesses);

describe('job names', () => {
  it('lists decay and the seven M2 jobs', () => {
    expect(JOB_NAMES).toEqual(['decay', 'consolidate', 'promote', 'collapse', 'contradictions', 'reembed', 'usage-feedback', 'cleanup']);
    expect([...M2_JOB_NAMES]).toHaveLength(7);
  });

  it('createJobs rejects an unknown job, and an M2 job without its ports', () => {
    const config = loadConfig({ ...BASE_ENV, JOBS_ENABLED: 'nope' }, { serviceName: 'memory-jobs' });
    expect(() => createJobs(config, 'memory-jobs')).toThrow(/unknown job "nope"/);
    const m2 = loadConfig({ ...BASE_ENV, JOBS_ENABLED: 'cleanup' }, { serviceName: 'memory-jobs' });
    expect(() => createJobs(m2, 'memory-jobs')).toThrow(/needs the runtime ports/);
  });

  it('jobNeeds asks only for the ports the chosen jobs use', () => {
    expect(jobNeeds(['cleanup'])).toEqual({ jobs: true });
    expect(jobNeeds(['reembed'])).toMatchObject({ jobs: true, embedder: true });
    expect(jobNeeds(['consolidate'])).toMatchObject({ llm: true });
    expect(jobNeeds(['usage-feedback'])).toMatchObject({ retrieval: true });
  });
});

describe('every job: lease', () => {
  it.each(JOB_NAMES)('%s: a second runner skips while the first holds the lease, and the lease is released afterwards', async (name) => {
    const h = await setup();
    await h.seed('ws', [{ content: 'Prefer short headlines.' }]);
    const slow = h.job(name);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const original = slow.run.bind(slow);
    slow.run = async (ctx) => {
      await gate;
      return original(ctx);
    };
    const first = h.runner.runJob(slow, 'schedule', { workspaceId: 'ws' });
    await new Promise((r) => setTimeout(r, 10));
    expect(await h.runner.runJob(h.job(name), 'manual', { workspaceId: 'ws' })).toEqual([]); // lease held
    release();
    const [run] = await first;
    expect(run).toMatchObject({ status: 'succeeded', jobName: name, workspaceId: 'ws' });
    // released: the next run goes ahead
    expect(await h.runner.runJob(h.job(name), 'manual', { workspaceId: 'ws' })).toHaveLength(1);
  });

  it('leases are per workspace: a held lease on one workspace does not block another', async () => {
    const h = await setup();
    await h.seed('ws-a', [{ content: 'a' }]);
    await h.seed('ws-b', [{ content: 'b' }]);
    const slow = h.job('cleanup');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const original = slow.run.bind(slow);
    slow.run = async (ctx) => {
      if (ctx.workspaceId === 'ws-a') await gate;
      return original(ctx);
    };
    const first = h.runner.runJob(slow, 'schedule');
    await new Promise((r) => setTimeout(r, 10));
    const other = await h.runner.runJob(h.job('cleanup'), 'manual');
    expect(other.map((r) => r.workspaceId)).toEqual(['ws-b']);
    release();
    expect((await first).map((r) => r.workspaceId).sort()).toEqual(['ws-a', 'ws-b']);
  });
});

describe('every job: dry run', () => {
  it.each(JOB_NAMES)('%s: reports, writes nothing, and emits no lifecycle event', async (name) => {
    const h = await setup();
    const old = { embeddingModel: 'old-model', embeddingVersion: '0' };
    await h.seed('ws', [
      { content: 'The client prefers short headlines under forty characters.', category: 'episodic', createdAt: ago(10 * DAY), lastReinforcedAt: ago(200 * DAY), ...old },
      { content: 'The client prefers short headlines under forty characters in search ads.', category: 'episodic', createdAt: ago(9 * DAY), lastReinforcedAt: ago(200 * DAY), ...old },
      { content: 'Working: scratch.', category: 'working', lastReinforcedAt: ago(40 * HOUR) },
    ]);
    const before = await h.snapshot(['ws'], { global: true });
    const [run] = await h.runner.runJob(h.job(name), 'manual', { dryRun: true });
    expect(run).toMatchObject({ status: 'succeeded', changed: 0, details: { dryRun: true } });
    expect(await h.snapshot(['ws'], { global: true })).toEqual(before);
    expect((await h.events()).filter((e) => e.action === 'system.job_run')).toHaveLength(0);
  });

  it('the JOBS_DRY_RUN setting makes dry run the default; an explicit option still wins', async () => {
    const h = await setup({ env: { JOBS_DRY_RUN: 'true' } });
    await h.seed('ws', [{ content: 'Working: scratch.', category: 'working', lastReinforcedAt: ago(40 * HOUR) }]);
    expect((await h.runner.runJob(h.job('cleanup'), 'manual'))[0].details).toMatchObject({ dryRun: true });
    expect((await h.runner.runJob(h.job('cleanup'), 'manual', { dryRun: false }))[0]).toMatchObject({ changed: 1 });
  });
});

describe('run only the workspaces that exist', () => {
  it('a workspace option naming an unknown workspace runs nothing', async () => {
    const h = await setup();
    await h.seed('ws', [{ content: 'x' }]);
    expect(await h.runner.runJob(h.job('cleanup'), 'manual', { workspaceId: 'ghost' })).toEqual([]);
  });
});

describe('versioned config', () => {
  it('seeds the defaults once, versions every change, and keeps history', async () => {
    const h = await setup();
    await h.seed('ws', [{ content: 'x' }]);
    expect(await h.runtime.jobConfigs.resolve('ws', 'cleanup')).toBeNull();
    const [first] = await h.runner.runJob(h.job('cleanup'), 'manual');
    expect(first.details).toMatchObject({ configVersion: 1 });
    await h.runner.runJob(h.job('cleanup'), 'manual');
    expect(await h.runtime.jobConfigs.list('*', 'cleanup')).toHaveLength(1); // not re-seeded
    await h.publish('*', 'cleanup', { workingTtlHours: 6 });
    const history = await h.runtime.jobConfigs.list('*', 'cleanup');
    expect(history.map((r) => [r.version, r.status])).toEqual([[2, 'active'], [1, 'retired']]);
    expect((await h.runner.runJob(h.job('cleanup'), 'manual'))[0].details).toMatchObject({ configVersion: 2 });
  });

  it('a workspace version overrides the global one for that workspace only', async () => {
    const h = await setup();
    await h.seed('ws-a', [{ content: 'Working: a.', category: 'working', lastReinforcedAt: ago(10 * HOUR) }]);
    await h.seed('ws-b', [{ content: 'Working: b.', category: 'working', lastReinforcedAt: ago(10 * HOUR) }]);
    await h.publish('ws-a', 'cleanup', { workingTtlHours: 4 });
    await h.runner.runJob(h.job('cleanup'), 'manual');
    expect((await h.all('ws-a'))[0].status).toBe('tombstoned');
    expect((await h.all('ws-b'))[0].status).toBe('active');
  });

  it('a stored config that no longer validates fails the run loudly instead of falling back silently', async () => {
    const h = await setup();
    await h.seed('ws', [{ content: 'x' }]);
    await h.runtime.jobConfigs.publish({ workspaceId: '*', jobName: 'cleanup', config: { workingTtlHours: -5 }, createdBy: 'test', at: h.clock.isoNow() });
    const [run] = await h.runner.runJob(h.job('cleanup'), 'manual');
    expect(run.status).toBe('failed');
  });
});

describe('CLI arguments', () => {
  it('parses the job name, --dry-run and --workspace', () => {
    expect(parseArgs(['consolidate'])).toMatchObject({ name: 'consolidate', dryRun: false, workspaceId: undefined });
    expect(parseArgs(['cleanup', '--dry-run', '--workspace', 'ws-1'])).toMatchObject({ name: 'cleanup', dryRun: true, workspaceId: 'ws-1' });
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
  });

  it('reports bad arguments', () => {
    expect(parseArgs(['--workspace']).error).toMatch(/needs a workspace id/);
    expect(parseArgs(['--workspace', '--dry-run']).error).toMatch(/needs a workspace id/);
    expect(parseArgs(['cleanup', '--nope']).error).toMatch(/unknown option/);
    expect(parseArgs(['cleanup', 'promote']).error).toMatch(/unexpected argument/);
  });
});
