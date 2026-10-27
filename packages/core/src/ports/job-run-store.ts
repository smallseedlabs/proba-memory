import type { JobResult, JobRun, JobRunStatus, JobTrigger } from '../domain/index.js';

export interface StartJobRun {
  id: string;
  jobName: string;
  workspaceId: string;
  traceId: string;
  trigger: JobTrigger;
  startedAt: string;
  /** A run still `running` after this long is considered abandoned and is closed as failed before a new one starts. */
  staleAfterMs: number;
}

/** JobRunStore port: the record of every background job run, and the guard that keeps one run per (job, workspace) at a time. */
export interface JobRunStore {
  /** Returns the new run, or null when another run of the same job and workspace is still in progress. */
  start(run: StartJobRun): Promise<JobRun | null>;
  finishSuccess(id: string, result: JobResult, finishedAt: string): Promise<JobRun>;
  finishFailure(id: string, error: string, finishedAt: string): Promise<JobRun>;
  list(options?: { jobName?: string; workspaceId?: string; status?: JobRunStatus; limit?: number }): Promise<JobRun[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
