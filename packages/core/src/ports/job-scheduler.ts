/** A unit of work the scheduler calls repeatedly. */
export interface ScheduledJob {
  name: string;
  intervalMs: number;
  /** Delay before the first run. Default: one interval. */
  initialDelayMs?: number;
  run(trigger: 'schedule' | 'manual'): Promise<void>;
}

/**
 * JobScheduler port: decides WHEN jobs run. It never overlaps two runs of the same job inside one
 * process (a run that is still going makes the next tick skip). A failing run never stops the schedule.
 */
export interface JobScheduler {
  readonly name: string;
  register(job: ScheduledJob): void;
  names(): string[];
  start(): void;
  /** Stop scheduling and wait for runs in progress. */
  stop(): Promise<void>;
  /** Run a registered job now (rejects for an unknown name or when the job is already running). */
  trigger(name: string): Promise<void>;
}
