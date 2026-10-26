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
  /**
   * Dry run: compute and return what would change, write nothing. A job must not write memories, links, vectors,
   * configs or audit events when this is true (and should not call a model either).
   */
  dryRun: boolean;
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
 * A background job (decay, consolidate, promote, collapse, contradictions, re-embed, usage feedback, cleanup).
 * A job must be idempotent (a second run right after the first changes nothing), must honour `ctx.dryRun`,
 * must read its rules from the versioned JobConfigStore rather than from code, and must never hard-delete
 * memories: retire them with status `superseded` or `tombstoned`.
 */
export interface Job {
  readonly name: string;
  readonly description: string;
  /** How often the scheduler runs it. */
  readonly intervalMs: number;
  run(ctx: JobContext): Promise<JobResult>;
}
