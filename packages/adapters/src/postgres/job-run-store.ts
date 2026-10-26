import type pg from 'pg';
import type { JobResult, JobRun, JobRunStore, StartJobRun } from '@smallseedlabs/proba-memory-core';
import { isUuid } from '@smallseedlabs/proba-memory-core';
import { iso, isoOrNull, withTransaction } from './pool.js';

const COLUMNS = 'id, job_name, workspace_id, trace_id, trigger, status, started_at, finished_at, duration_ms, processed, changed, error, details';

function toRun(r: Record<string, unknown>): JobRun {
  return {
    id: String(r.id),
    jobName: String(r.job_name),
    workspaceId: String(r.workspace_id),
    traceId: String(r.trace_id),
    trigger: r.trigger as JobRun['trigger'],
    status: r.status as JobRun['status'],
    startedAt: iso(r.started_at),
    finishedAt: isoOrNull(r.finished_at),
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    processed: Number(r.processed),
    changed: Number(r.changed),
    error: (r.error as string | null) ?? null,
    details: (r.details as Record<string, unknown>) ?? {},
  };
}

/** JobRunStore on Postgres (`job_runs`). A partial unique index allows one `running` run per job and workspace. */
export class PostgresJobRunStore implements JobRunStore {
  constructor(private readonly pool: pg.Pool) {}

  async start(run: StartJobRun): Promise<JobRun | null> {
    return withTransaction(this.pool, async (client) => {
      // Close runs that were abandoned (a crashed process never wrote a result).
      await client.query(
        `UPDATE job_runs SET status = 'failed', error = 'abandoned: no result recorded before the lease expired',
           finished_at = $3::timestamptz, duration_ms = GREATEST(0, (extract(epoch FROM ($3::timestamptz - started_at)) * 1000)::int)
         WHERE job_name = $1 AND workspace_id = $2 AND status = 'running' AND started_at < $3::timestamptz - ($4::int * interval '1 millisecond')`,
        [run.jobName, run.workspaceId, iso(run.startedAt), run.staleAfterMs]
      );
      const r = await client.query(
        `INSERT INTO job_runs (id, job_name, workspace_id, trace_id, trigger, status, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', $6::timestamptz)
         ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
        [run.id, run.jobName, run.workspaceId, run.traceId, run.trigger, iso(run.startedAt)]
      );
      return r.rows[0] ? toRun(r.rows[0]) : null;
    });
  }

  private async finish(id: string, set: string, params: unknown[]): Promise<JobRun> {
    if (!isUuid(id)) throw new Error(`unknown job run ${id}`);
    const r = await this.pool.query(
      `UPDATE job_runs SET ${set}, finished_at = $2::timestamptz,
         duration_ms = GREATEST(0, (extract(epoch FROM ($2::timestamptz - started_at)) * 1000)::int)
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, ...params]
    );
    if (!r.rows[0]) throw new Error(`unknown job run ${id}`);
    return toRun(r.rows[0]);
  }

  finishSuccess(id: string, result: JobResult, finishedAt: string): Promise<JobRun> {
    return this.finish(id, `status = 'succeeded', processed = $3, changed = $4, details = $5::jsonb`, [
      iso(finishedAt),
      result.processed,
      result.changed,
      JSON.stringify(result.details ?? {}),
    ]);
  }

  finishFailure(id: string, error: string, finishedAt: string): Promise<JobRun> {
    return this.finish(id, `status = 'failed', error = $3`, [iso(finishedAt), error.slice(0, 2000)]);
  }

  async list(options: { jobName?: string; workspaceId?: string; limit?: number } = {}): Promise<JobRun[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (options.jobName) {
      params.push(options.jobName);
      where.push(`job_name = $${params.length}`);
    }
    if (options.workspaceId) {
      params.push(options.workspaceId);
      where.push(`workspace_id = $${params.length}`);
    }
    params.push(Math.min(options.limit ?? 50, 500));
    const r = await this.pool.query(
      `SELECT ${COLUMNS} FROM job_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT $${params.length}`,
      params
    );
    return r.rows.map(toRun);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    // The pool belongs to the runtime that created it.
  }
}
