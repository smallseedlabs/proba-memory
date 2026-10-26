import type pg from 'pg';
import {
  DEFAULT_PROFILE_NAME,
  DEFAULT_SCORING_CONFIG_V1,
  GLOBAL_PROFILE_WORKSPACE,
  parseScoringConfig,
  type ProfileStatus,
  type ScoringProfile,
} from '@smallseedlabs/proba-memory-scoring';
import { type NewScoringProfile, type ScoringProfileStore } from '@smallseedlabs/proba-memory-core';
import { assertValidProfileInput, DEFAULT_PROFILE_ID } from '../memory/profile-store.js';
import { iso, withTransaction } from './pool.js';

const COLUMNS = 'id, workspace_id, name, version, status, canary_percent, config, description, created_by, created_at';

function toProfile(r: Record<string, unknown>): ScoringProfile {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    name: String(r.name),
    version: Number(r.version),
    status: r.status as ProfileStatus,
    canaryPercent: Number(r.canary_percent),
    config: parseScoringConfig(r.config),
    description: String(r.description ?? ''),
    createdBy: String(r.created_by),
    createdAt: iso(r.created_at),
  };
}

/** ScoringProfileStore on Postgres (`scoring_profiles`). A version's config never changes; only its status does. */
export class PostgresScoringProfileStore implements ScoringProfileStore {
  constructor(private readonly pool: pg.Pool) {}

  async ensureDefault(): Promise<ScoringProfile> {
    // Without a conflict target so that any unique violation (version or "one active") leaves existing data alone.
    await this.pool.query(
      `INSERT INTO scoring_profiles (id, workspace_id, name, version, status, canary_percent, config, description, created_by)
       VALUES ($1, $2, $3, 1, 'active', 0, $4::jsonb, 'Built-in default scoring profile', 'system')
       ON CONFLICT DO NOTHING`,
      [DEFAULT_PROFILE_ID, GLOBAL_PROFILE_WORKSPACE, DEFAULT_PROFILE_NAME, JSON.stringify(DEFAULT_SCORING_CONFIG_V1)]
    );
    const r = await this.pool.query(`SELECT ${COLUMNS} FROM scoring_profiles WHERE workspace_id = $1 AND name = $2 AND version = 1`, [
      GLOBAL_PROFILE_WORKSPACE,
      DEFAULT_PROFILE_NAME,
    ]);
    if (!r.rows[0]) throw new Error('the default scoring profile could not be created');
    return toProfile(r.rows[0]);
  }

  async list(workspaceId: string): Promise<ScoringProfile[]> {
    const r = await this.pool.query(
      `SELECT ${COLUMNS} FROM scoring_profiles WHERE workspace_id = $1 OR workspace_id = $2 ORDER BY workspace_id = $2 DESC, name, version`,
      [workspaceId, GLOBAL_PROFILE_WORKSPACE]
    );
    return r.rows.map(toProfile);
  }

  async resolve(workspaceId: string, name: string): Promise<ScoringProfile[]> {
    const own = await this.pool.query(`SELECT ${COLUMNS} FROM scoring_profiles WHERE workspace_id = $1 AND name = $2 ORDER BY version`, [workspaceId, name]);
    const ownProfiles = own.rows.map(toProfile);
    if (ownProfiles.some((p) => p.status === 'active')) return ownProfiles;
    const global = await this.pool.query(`SELECT ${COLUMNS} FROM scoring_profiles WHERE workspace_id = $1 AND name = $2 ORDER BY version`, [
      GLOBAL_PROFILE_WORKSPACE,
      name,
    ]);
    return global.rows.map(toProfile);
  }

  async put(input: NewScoringProfile): Promise<ScoringProfile> {
    assertValidProfileInput(input.config, input.canaryPercent);
    const config = parseScoringConfig(input.config);
    const status = input.status ?? 'draft';
    return withTransaction(this.pool, async (client) => {
      // Serialise version allocation per (workspace, name).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`scoring-profile:${input.workspaceId}:${input.name}`]);
      const next = await client.query('SELECT coalesce(max(version), 0) + 1 AS v FROM scoring_profiles WHERE workspace_id = $1 AND name = $2', [
        input.workspaceId,
        input.name,
      ]);
      if (status === 'active') {
        await client.query("UPDATE scoring_profiles SET status = 'retired' WHERE workspace_id = $1 AND name = $2 AND status = 'active'", [input.workspaceId, input.name]);
      }
      const r = await client.query(
        `INSERT INTO scoring_profiles (workspace_id, name, version, status, canary_percent, config, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING ${COLUMNS}`,
        [input.workspaceId, input.name, Number(next.rows[0]?.v ?? 1), status, input.canaryPercent ?? 0, JSON.stringify(config), input.description ?? '', input.createdBy]
      );
      return toProfile(r.rows[0] as Record<string, unknown>);
    });
  }

  async setStatus(workspaceId: string, name: string, version: number, status: ProfileStatus, canaryPercent?: number): Promise<ScoringProfile | null> {
    assertValidProfileInput(DEFAULT_SCORING_CONFIG_V1, canaryPercent);
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`scoring-profile:${workspaceId}:${name}`]);
      const target = await client.query('SELECT id, canary_percent FROM scoring_profiles WHERE workspace_id = $1 AND name = $2 AND version = $3 FOR UPDATE', [
        workspaceId,
        name,
        version,
      ]);
      const row = target.rows[0];
      if (!row) return null;
      if (status === 'active') {
        await client.query("UPDATE scoring_profiles SET status = 'retired' WHERE workspace_id = $1 AND name = $2 AND status = 'active' AND id <> $3", [
          workspaceId,
          name,
          row.id,
        ]);
      }
      const percent = status === 'canary' ? (canaryPercent ?? Number(row.canary_percent)) : 0;
      const r = await client.query(`UPDATE scoring_profiles SET status = $2, canary_percent = $3 WHERE id = $1 RETURNING ${COLUMNS}`, [row.id, status, percent]);
      return toProfile(r.rows[0] as Record<string, unknown>);
    });
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    // The pool belongs to the runtime that created it.
  }
}

