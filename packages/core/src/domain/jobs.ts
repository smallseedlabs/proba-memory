export type JobRunStatus = 'running' | 'succeeded' | 'failed';
export type JobTrigger = 'schedule' | 'manual';

export interface JobRun {
  id: string;
  jobName: string;
  workspaceId: string;
  traceId: string;
  trigger: JobTrigger;
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** Rows looked at. */
  processed: number;
  /** Rows changed. */
  changed: number;
  error: string | null;
  details: Record<string, unknown>;
}

export interface JobResult {
  processed: number;
  changed: number;
  details?: Record<string, unknown>;
}
