import { M2_JOB_NAMES, Redactor, type AppConfig, type Job, type M2JobName } from '@smallseedlabs/proba-memory-core';
import type { Runtime, RuntimeNeeds } from '@smallseedlabs/proba-memory-adapters';
import { CleanupJob } from './cleanup.js';
import { CollapseJob } from './collapse.js';
import { ConsolidateJob } from './consolidate.js';
import { ContradictionsJob } from './contradictions.js';
import { DecayJob } from './decay.js';
import { PromoteJob } from './promote.js';
import { ReembedJob } from './reembed.js';
import { UsageFeedbackJob } from './usage-feedback.js';
import type { JobDeps } from './shared.js';

export { DecayJob, computeDecay, type DecayOptions, type DecayChange } from './decay.js';
export { ConsolidateJob, consolidationReplySchema, buildConsolidationPrompt } from './consolidate.js';
export { PromoteJob } from './promote.js';
export { CollapseJob, adjustedConfidence, pickWinner, upgradedConfidence } from './collapse.js';
export { ContradictionsJob, decide, combineScore } from './contradictions.js';
export { ReembedJob } from './reembed.js';
export { UsageFeedbackJob, nextUsefulness } from './usage-feedback.js';
export { CleanupJob, cleanupReason } from './cleanup.js';
export type { JobDeps } from './shared.js';

const NEEDS: Record<M2JobName, RuntimeNeeds> = {
  consolidate: { embedder: true, llm: true },
  promote: {},
  collapse: {},
  contradictions: {},
  reembed: { embedder: true },
  'usage-feedback': { retrieval: true },
  cleanup: {},
};

/** The optional ports a set of jobs needs the runtime to create (every job needs `jobs`). */
export function jobNeeds(names: string[]): RuntimeNeeds {
  const needs: RuntimeNeeds = { jobs: true };
  for (const name of names) {
    const n = NEEDS[name as M2JobName];
    if (n?.embedder) needs.embedder = true;
    if (n?.llm) needs.llm = true;
    if (n?.retrieval) needs.retrieval = true;
  }
  return needs;
}

/** The M2 jobs' dependencies from a runtime created with `jobNeeds(...)`. Ports the runtime does not have are left out. */
export function createJobDeps(runtime: Runtime, names: string[]): JobDeps {
  const needs = jobNeeds(names);
  const { config } = runtime;
  return {
    service: runtime.service,
    configs: runtime.jobConfigs,
    index: runtime.index,
    redactor: new Redactor({ pii: config.write.redactPii }),
    batchSize: config.jobs.batchSize,
    llmMaxAttempts: config.jobs.llmMaxAttempts,
    intervalsMs: config.jobs.intervalsMs,
    migration: runtime.embeddingMigration,
    ...(needs.embedder ? { embedder: runtime.embedder } : {}),
    ...(needs.llm ? { llm: runtime.llm } : {}),
    ...(needs.retrieval ? { logStore: runtime.logStore } : {}),
  };
}

/**
 * The jobs this process can run, by name (JOBS_ENABLED picks which). `decay` is configured by env (DECAY_*); the
 * seven M2 jobs read their rules and thresholds from the versioned job_configs table and take their ports from `deps`.
 * Adding a job means implementing core's `Job` and adding one line here; the runner, the schedule, the lease, the
 * audit events and the structured logs come with the framework.
 */
export function createJobs(config: AppConfig, service: string, deps?: JobDeps): Job[] {
  const m2 = (make: (d: JobDeps) => Job) => (): Job => {
    if (!deps) throw new Error('this job needs the runtime ports: pass the deps from createJobDeps(runtime, names)');
    return make(deps);
  };
  const factories: Record<string, () => Job> = {
    decay: () => new DecayJob({ ...config.jobs.decay, service }),
    consolidate: m2((d) => new ConsolidateJob(d)),
    promote: m2((d) => new PromoteJob(d)),
    collapse: m2((d) => new CollapseJob(d)),
    contradictions: m2((d) => new ContradictionsJob(d)),
    reembed: m2((d) => new ReembedJob(d)),
    'usage-feedback': m2((d) => new UsageFeedbackJob(d)),
    cleanup: m2((d) => new CleanupJob(d)),
  };
  return config.jobs.enabled.map((name) => {
    const make = factories[name];
    if (!make) throw new Error(`JOBS_ENABLED names an unknown job "${name}" (available: ${Object.keys(factories).join(', ')})`);
    return make();
  });
}

export const JOB_NAMES: string[] = ['decay', ...M2_JOB_NAMES];
