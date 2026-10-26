import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { JobConfigRecord, JobConfigStore, PublishJobConfig } from '@smallseedlabs/proba-memory-core';
import { GLOBAL_WORKSPACE } from '@smallseedlabs/proba-memory-core';
import { iso, withTransaction } from './pool.js';

const COLUMNS = 'id, workspace_id, job_name, version, status, config, note, created_by, created_at';

function toRecord(r: Record<string, unknown>): JobConfigRecord {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    jobName: String(r.job_name),
    version: Number(r.version),
    status: r.status as JobConfigRecord['status'],
    config: (r.config as Record<string, unknown>) ?? {},
    note: String(r.note ?? ''),
    createdBy: String(r.created_by),
    createdAt: iso(r.created_at),
  };
}

/** JobConfigStore on Postgres (`job_configs`): immutable versions, one active per (workspace, job) by a partial unique index. */
export class PostgresJobConfigStore implements JobConfigStore {
  constructor(private readonly pool: pg.Pool) {}

  async resolve(workspaceId: string, jobName: string): Promise<JobConfigRecord | null> {
    const r = await this.pool.query(
      `SELECT ${COLUMNS} FROM job_configs
       WHERE job_name = $2 AND status = 'active' AND workspace_id IN ($1, $3)
       ORDER BY (workspace_id = $1) DESC LIMIT 1`,
      [workspaceId, jobName, GLOBAL_WORKSPACE]
    );
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }

  async publish(input: PublishJobConfig): Promise<JobConfigRecord> {
    return withTransaction(this.pool, async (client) => {
      // One publisher at a time per (workspace, job): versions are gap-free and exactly one stays active.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))', [`jobconfig:${input.workspaceId}:${input.jobName}`]);
      if (input.onlyIfAbsent) {
        const existing = await client.query(
          `SELECT ${COLUMNS} FROM job_configs WHERE workspace_id = $1 AND job_name = $2 ORDER BY (status = 'active') DESC, version DESC LIMIT 1`,
          [input.workspaceId, input.jobName]
        );
        if (existing.rows[0]) return toRecord(existing.rows[0]);
      }
      await client.query(`UPDATE job_configs SET status = 'retired' WHERE workspace_id = $1 AND job_name = $2 AND status = 'active'`, [input.workspaceId, input.jobName]);
      const r = await client.query(
        `INSERT INTO job_configs (id, workspace_id, job_name, version, status, config, note, created_by, created_at)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(version), 0) + 1 FROM job_configs WHERE workspace_id = $2 AND job_name = $3), 'active', $4::jsonb, $5, $6, $7::timestamptz)
         RETURNING ${COLUMNS}`,
        [randomUUID(), input.workspaceId, input.jobName, JSON.stringify(input.config), input.note ?? '', input.createdBy, iso(input.at)]
      );
      return toRecord(r.rows[0]);
    });
  }

  async list(workspaceId: string, jobName: string): Promise<JobConfigRecord[]> {
    const r = await this.pool.query(`SELECT ${COLUMNS} FROM job_configs WHERE workspace_id = $1 AND job_name = $2 ORDER BY version DESC`, [workspaceId, jobName]);
    return r.rows.map(toRecord);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    // The pool belongs to the runtime that created it.
  }
}
