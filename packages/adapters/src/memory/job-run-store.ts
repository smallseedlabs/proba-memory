import type { JobResult, JobRun, JobRunStore, StartJobRun } from '@smallseedlabs/proba-memory-core';

/** In-process JobRunStore. */
export class InMemoryJobRunStore implements JobRunStore {
  private readonly runs: JobRun[] = [];

  async start(run: StartJobRun): Promise<JobRun | null> {
    const cutoff = new Date(run.startedAt).getTime() - run.staleAfterMs;
    for (const r of this.runs) {
      if (r.jobName === run.jobName && r.workspaceId === run.workspaceId && r.status === 'running' && new Date(r.startedAt).getTime() < cutoff) {
        r.status = 'failed';
        r.error = 'abandoned: no result recorded before the lease expired';
        r.finishedAt = run.startedAt;
        r.durationMs = new Date(run.startedAt).getTime() - new Date(r.startedAt).getTime();
      }
    }
    if (this.runs.some((r) => r.jobName === run.jobName && r.workspaceId === run.workspaceId && r.status === 'running')) return null;
    const created: JobRun = {
      id: run.id,
      jobName: run.jobName,
      workspaceId: run.workspaceId,
      traceId: run.traceId,
      trigger: run.trigger,
      status: 'running',
      startedAt: new Date(run.startedAt).toISOString(),
      finishedAt: null,
      durationMs: null,
      processed: 0,
      changed: 0,
      error: null,
      details: {},
    };
    this.runs.push(created);
    return structuredClone(created);
  }

  private find(id: string): JobRun {
    const r = this.runs.find((x) => x.id === id);
    if (!r) throw new Error(`unknown job run ${id}`);
    return r;
  }

  async finishSuccess(id: string, result: JobResult, finishedAt: string): Promise<JobRun> {
    const r = this.find(id);
    r.status = 'succeeded';
    r.finishedAt = new Date(finishedAt).toISOString();
    r.durationMs = new Date(finishedAt).getTime() - new Date(r.startedAt).getTime();
    r.processed = result.processed;
    r.changed = result.changed;
    r.details = structuredClone(result.details ?? {});
    return structuredClone(r);
  }

  async finishFailure(id: string, error: string, finishedAt: string): Promise<JobRun> {
    const r = this.find(id);
    r.status = 'failed';
    r.finishedAt = new Date(finishedAt).toISOString();
    r.durationMs = new Date(finishedAt).getTime() - new Date(r.startedAt).getTime();
    r.error = error.slice(0, 2000);
    return structuredClone(r);
  }

  async list(options: { jobName?: string; workspaceId?: string; limit?: number } = {}): Promise<JobRun[]> {
    return structuredClone(
      this.runs
        .filter((r) => (!options.jobName || r.jobName === options.jobName) && (!options.workspaceId || r.workspaceId === options.workspaceId))
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .slice(0, options.limit ?? 50)
    );
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
