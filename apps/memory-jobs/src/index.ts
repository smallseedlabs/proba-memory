import { runService } from '@smallseedlabs/proba-memory-core';
import { createRuntime, type Runtime } from '@smallseedlabs/proba-memory-adapters';
import { createJobDeps, createJobs, jobNeeds } from './jobs/index.js';
import { createJobRunner } from './runner.js';

/**
 * memory-jobs: runs the background jobs on a schedule (decay and the M2 jobs: consolidate, promote, collapse, contradictions, reembed, usage-feedback, cleanup) and keeps the audit outbox flowing.
 * Serves /health only. To run one job once from the command line: `npm run job -- decay`.
 */
let runtime: Runtime | undefined;
let relay: ReturnType<Runtime['createRelay']> = null;
let runner: ReturnType<typeof createJobRunner> | undefined;

runService({
  name: 'memory-jobs',
  defaultPort: 3202,
  async onStart({ config, logger }) {
    const rt = await createRuntime(config, { service: config.service.name, logger, needs: jobNeeds(config.jobs.enabled) });
    runtime = rt;
    await rt.store.ping();
    const jobs = createJobs(config, config.service.name, createJobDeps(rt, config.jobs.enabled));
    if (jobs.length === 0) throw new Error('JOBS_ENABLED is empty: name at least one job (see JOBS_ENABLED in .env.example)');
    runner = createJobRunner(rt);
    for (const job of jobs) {
      rt.scheduler.register({ name: job.name, intervalMs: job.intervalMs, run: async (trigger) => void (await runner!.runJob(job, trigger)) });
    }
    relay = rt.createRelay();
    relay?.start();
    rt.scheduler.start();
    logger.info('jobs scheduled', { lifecycle: 'jobs_scheduled', jobs: jobs.map((j) => ({ name: j.name, intervalMs: j.intervalMs })) });
    await rt.lifecycleEmitter.emit({
      actor: { type: 'service', id: config.service.name },
      action: 'system.started',
      category: 'system',
      outcome: 'success',
      details: { jobs: jobs.map((j) => j.name), scheduler: config.adapters.jobScheduler },
    });
  },
  async onStop({ config }) {
    runner?.shutdown();
    await runtime?.scheduler.stop();
    await runtime?.lifecycleEmitter.emit({
      actor: { type: 'service', id: config.service.name },
      action: 'system.stopped',
      category: 'system',
      outcome: 'success',
      details: {},
    });
    await relay?.stop();
    await runtime?.close();
  },
}).catch((err) => {
  console.error('fatal: memory-jobs failed to start', err);
  process.exit(1);
});
