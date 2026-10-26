import type { Job } from '@smallseedlabs/proba-memory-core';
import type { AppConfig } from '@smallseedlabs/proba-memory-core';
import { DecayJob } from './decay.js';

export { DecayJob, computeDecay, type DecayOptions, type DecayChange } from './decay.js';

/**
 * The jobs this process can run, by name (JOBS_ENABLED picks which). M1 ships `decay`.
 * Adding a job (M2: consolidate, promote, contradiction resolver, re-embed, usage feedback, cleanup)
 * means implementing core's `Job` and adding one line here; the runner, the schedule, the lease, the
 * audit events and the structured logs come with the framework.
 */
export function createJobs(config: AppConfig, service: string): Job[] {
  const factories: Record<string, () => Job> = {
    decay: () => new DecayJob({ ...config.jobs.decay, service }),
  };
  return config.jobs.enabled.map((name) => {
    const make = factories[name];
    if (!make) throw new Error(`JOBS_ENABLED names an unknown job "${name}" (available: ${Object.keys(factories).join(', ')})`);
    return make();
  });
}
