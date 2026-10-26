import type { AuditEmitter } from '../ports/audit-emitter.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { MemoryStore } from '../ports/memory-store.js';
import type { JobResult, JobTrigger } from '../domain/index.js';

/** Everything a job run gets. One context per (job, workspace) run, with its own traceId. */
export interface JobContext {
  runId: string;
  traceId: string;
  workspaceId: string;
  trigger: JobTrigger;
  /** Carries the traceId and job name on every line. */
  logger: Logger;
  clock: Clock;
  store: MemoryStore;
  /**
   * Emits under this run's trace. Fails closed (throws) so a job can commit its audit events together
   * with its changes by passing `{ tx: tx.handle }`.
   */
  emitter: AuditEmitter;
  /** Aborted when the process is shutting down: long jobs should stop at the next batch boundary. */
  signal: AbortSignal;
}

/**
 * A background job. M1 ships `decay`; the interface is what the M2 jobs (consolidate, promote,
 * contradiction resolver, re-embed, usage feedback, cleanup) implement. A job must be idempotent and
 * must never hard-delete memories: retire them with status `superseded` or `tombstoned`.
 */
export interface Job {
  readonly name: string;
  readonly description: string;
  /** How often the scheduler runs it. */
  readonly intervalMs: number;
  run(ctx: JobContext): Promise<JobResult>;
}
