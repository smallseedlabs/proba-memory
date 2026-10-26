import { JobRunner, type Job } from '@smallseedlabs/proba-memory-core';
import type { Runtime } from '@smallseedlabs/proba-memory-adapters';

/** The job runner wired from the runtime (needs `jobs`). */
export function createJobRunner(runtime: Runtime): JobRunner {
  return new JobRunner({
    store: runtime.store,
    jobRuns: runtime.jobRuns,
    emitter: runtime.emitter,
    lifecycleEmitter: runtime.lifecycleEmitter,
    clock: runtime.clock,
    ids: runtime.ids,
    logger: runtime.logger,
    service: runtime.service,
    leaseMs: runtime.config.jobs.leaseMs,
  });
}

export type { Job };
