import type { JobScheduler, Logger, ScheduledJob } from '@smallseedlabs/proba-memory-core';

interface Entry {
  job: ScheduledJob;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
}

/**
 * JobScheduler on timers: each job runs `intervalMs` after the previous run FINISHED (so runs never
 * overlap), the first run after `initialDelayMs`. A failing run is logged and the schedule goes on.
 * Several replicas are safe because the job-run lease (JobRunStore.start) admits one run at a time.
 */
export class IntervalJobScheduler implements JobScheduler {
  readonly name: string = 'interval';
  private readonly entries = new Map<string, Entry>();
  private started = false;

  constructor(protected readonly logger?: Logger) {}

  register(job: ScheduledJob): void {
    if (this.entries.has(job.name)) throw new Error(`job "${job.name}" is already registered`);
    this.entries.set(job.name, { job, timer: null, running: null });
    if (this.started) this.arm(this.entries.get(job.name) as Entry, job.initialDelayMs ?? job.intervalMs);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const e of this.entries.values()) this.arm(e, e.job.initialDelayMs ?? e.job.intervalMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const e of this.entries.values()) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
    }
    await Promise.allSettled([...this.entries.values()].map((e) => e.running));
  }

  async trigger(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`unknown job "${name}"`);
    if (e.running) throw new Error(`job "${name}" is already running`);
    await this.execute(e, 'manual', true);
  }

  private arm(e: Entry, delayMs: number): void {
    if (!this.started) return;
    e.timer = setTimeout(() => {
      e.timer = null;
      if (e.running) {
        this.arm(e, e.job.intervalMs);
        return;
      }
      void this.execute(e, 'schedule', false).finally(() => this.arm(e, e.job.intervalMs));
    }, delayMs);
    e.timer.unref?.();
  }

  private execute(e: Entry, trigger: 'schedule' | 'manual', rethrow: boolean): Promise<void> {
    const run = (async () => {
      try {
        await e.job.run(trigger);
      } catch (err) {
        this.logger?.error('scheduled job failed', { job: e.job.name, trigger, err });
        if (rethrow) throw err;
      } finally {
        e.running = null;
      }
    })();
    // The async body always yields before it can finish, so this assignment happens first.
    e.running = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/** JobScheduler that never ticks: jobs run only when `trigger` is called. For tests and one-shot runs. */
export class ManualJobScheduler extends IntervalJobScheduler {
  override readonly name: string = 'manual';

  override start(): void {
    // Jobs run only through trigger().
  }
}
