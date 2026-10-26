import { createLogger, loadConfigFromEnvironment } from '@smallseedlabs/proba-memory-core';
import { createRuntime } from '@smallseedlabs/proba-memory-adapters';
import { createJobs } from './jobs/index.js';
import { createJobRunner } from './runner.js';

/**
 * Run one job once, for every workspace, right now:
 *
 *   npm run job -- decay
 *
 * Takes the same lease as the scheduled run, so it never overlaps one in progress.
 */
async function main(): Promise<void> {
  const name = process.argv[2];
  const config = loadConfigFromEnvironment({ serviceName: 'memory-jobs-cli', defaultPort: 0 });
  // The job must be runnable even when JOBS_ENABLED does not list it.
  const job = createJobs({ ...config, jobs: { ...config.jobs, enabled: name ? [name] : [] } }, 'memory-jobs').at(0);
  if (!job) {
    console.error('usage: job <name>   (available: decay)');
    process.exit(2);
  }
  const logger = createLogger({ service: config.service.name, level: config.log.level, env: config.env, pretty: false });
  const runtime = await createRuntime(config, { service: 'memory-jobs', logger, needs: { jobs: true } });
  try {
    const relay = runtime.createRelay();
    const runs = await createJobRunner(runtime).runJob(job, 'manual');
    // Publish what the run recorded before exiting.
    if (relay) {
      relay.start();
      await new Promise((r) => setTimeout(r, Math.min(2000, config.audit.relay.pollIntervalMs * 2)));
      await relay.stop();
    }
    for (const run of runs) {
      console.log(JSON.stringify({ job: run.jobName, workspaceId: run.workspaceId, status: run.status, processed: run.processed, changed: run.changed, error: run.error ?? undefined }));
    }
    if (runs.some((r) => r.status === 'failed')) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

main().catch((err) => {
  console.error('fatal: job failed', err);
  process.exit(1);
});
