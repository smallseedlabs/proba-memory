import type { AuditEmitter } from '../ports/audit-emitter.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { JobRunStore } from '../ports/job-run-store.js';
import type { Logger } from '../ports/logger.js';
import type { MemoryStore } from '../ports/memory-store.js';
import type { JobRun, JobTrigger } from '../domain/index.js';
import type { Job } from './job.js';

export interface JobRunnerDeps {
  store: MemoryStore;
  jobRuns: JobRunStore;
  /** For the job's own events: fails closed. */
  emitter: AuditEmitter;
  /** For the run's lifecycle events (system.job_run / system.job_failed): must never break a run. */
  lifecycleEmitter: AuditEmitter;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  service: string;
  /** A run still marked running after this long is treated as abandoned. */
  leaseMs: number;
}

/**
 * The job-run framework: for every workspace, take the (job, workspace) lease, run the job under its own
 * traceId, record the run (job_runs), log every step as JSON and emit system.job_run / system.job_failed.
 * A failing job never stops the others and never stops the scheduler.
 */
export class JobRunner {
  private readonly abort = new AbortController();

  constructor(private readonly deps: JobRunnerDeps) {}

  /** Tell running jobs to stop at the next batch boundary. */
  shutdown(): void {
    this.abort.abort();
  }

  async runJob(job: Job, trigger: JobTrigger): Promise<JobRun[]> {
    const { store, logger } = this.deps;
    const workspaceIds = await store.listWorkspaceIds();
    logger.info('job cycle started', { job: job.name, trigger, workspaces: workspaceIds.length });
    const runs: JobRun[] = [];
    for (const workspaceId of workspaceIds) {
      if (this.abort.signal.aborted) break;
      const run = await this.runForWorkspace(job, workspaceId, trigger);
      if (run) runs.push(run);
    }
    logger.info('job cycle finished', { job: job.name, trigger, runs: runs.length, failed: runs.filter((r) => r.status === 'failed').length });
    return runs;
  }

  private async runForWorkspace(job: Job, workspaceId: string, trigger: JobTrigger): Promise<JobRun | null> {
    const { deps } = this;
    const runId = deps.ids.uuid();
    const traceId = deps.ids.uuid();
    const log = deps.logger.child({ traceId, job: job.name, runId, workspaceId });
    const started = await deps.jobRuns.start({
      id: runId,
      jobName: job.name,
      workspaceId,
      traceId,
      trigger,
      startedAt: deps.clock.isoNow(),
      staleAfterMs: deps.leaseMs,
    });
    if (!started) {
      log.info('job run skipped: another run is in progress');
      return null;
    }
    log.info('job run started', { trigger });
    const t0 = Date.now();
    try {
      const result = await job.run({
        runId,
        traceId,
        workspaceId,
        trigger,
        logger: log,
        clock: deps.clock,
        store: deps.store,
        emitter: deps.emitter.forTrace(traceId),
        signal: this.abort.signal,
      });
      const finished = await deps.jobRuns.finishSuccess(runId, result, deps.clock.isoNow());
      log.info('job run finished', { processed: result.processed, changed: result.changed, durationMs: Date.now() - t0, ...(result.details ?? {}) });
      await deps.lifecycleEmitter.forTrace(traceId).emit({
        actor: { type: 'service', id: deps.service },
        workspaceId,
        action: 'system.job_run',
        category: 'system',
        outcome: 'success',
        target: { type: 'job', id: job.name },
        durationMs: Date.now() - t0,
        details: { job: job.name, runId, trigger, processed: result.processed, changed: result.changed },
      });
      return finished;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('job run failed', { err, durationMs: Date.now() - t0 });
      const finished = await deps.jobRuns.finishFailure(runId, message, deps.clock.isoNow());
      await deps.lifecycleEmitter.forTrace(traceId).emit({
        actor: { type: 'service', id: deps.service },
        workspaceId,
        action: 'system.job_failed',
        category: 'system',
        outcome: 'failure',
        target: { type: 'job', id: job.name },
        errorCode: 'job_failed',
        errorMessage: message.slice(0, 500),
        riskLevel: 'medium',
        durationMs: Date.now() - t0,
        details: { job: job.name, runId, trigger },
      });
      return finished;
    }
  }
}
