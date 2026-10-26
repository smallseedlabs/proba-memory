import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { Logger } from '@smallseedlabs/proba-memory-core';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations/postgres', import.meta.url));

/** Serialises concurrent migrators (several services may start at once). */
const ADVISORY_LOCK_KEY = 7_340_112_001;

export interface MigrateOptions {
  pool: pg.Pool;
  embeddingDimension: number;
  dir?: string;
  logger?: Logger;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return { version: file.slice(0, 4), name: file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/** Replace the placeholders a migration may use. */
export function renderMigration(sql: string, embeddingDimension: number): string {
  if (!Number.isInteger(embeddingDimension) || embeddingDimension < 1 || embeddingDimension > 2000) {
    throw new RangeError('embeddingDimension must be a whole number between 1 and 2000 (the HNSW limit of the vector type)');
  }
  return sql.replaceAll('{{EMBEDDING_DIMENSION}}', String(embeddingDimension));
}

/** The dimension of the `memories.embedding` column, or null when the table does not exist yet. */
export async function readEmbeddingColumnDimension(pool: pg.Pool): Promise<number | null> {
  const result = await pool.query(
    `SELECT a.atttypmod AS dim FROM pg_attribute a
     WHERE a.attrelid = to_regclass('memories') AND a.attname = 'embedding' AND NOT a.attisdropped`
  );
  const dim = result.rows[0]?.dim;
  return dim === undefined || dim === null ? null : Number(dim);
}

/**
 * Apply the versioned SQL migrations in order, once each. Safe to run concurrently and repeatedly:
 * a lock serialises runners, applied versions are skipped, and a changed file is refused. After
 * applying, it checks that the vector column has the configured dimension and fails fast if not
 * (changing the embedding dimension needs a re-embed, never a silent mix).
 */
export async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  const files = readMigrations(options.dir ?? DEFAULT_MIGRATIONS_DIR);
  const client = await options.pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version    TEXT PRIMARY KEY,
           name       TEXT        NOT NULL,
           checksum   TEXT        NOT NULL,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
      const applied = new Map<string, string>();
      for (const row of (await client.query('SELECT version, checksum FROM schema_migrations')).rows) {
        applied.set(String(row.version), String(row.checksum));
      }
      for (const file of files) {
        const existing = applied.get(file.version);
        if (existing !== undefined) {
          if (existing !== file.checksum) throw new Error(`migration ${file.name} was changed after it was applied; add a new migration instead`);
          result.alreadyApplied.push(file.name);
          continue;
        }
        try {
          await client.query('BEGIN');
          await client.query(renderMigration(file.sql, options.embeddingDimension));
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [file.version, file.name, file.checksum]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new Error(`migration ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        result.applied.push(file.name);
        options.logger?.info('migration applied', { migration: file.name });
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
  const actual = await readEmbeddingColumnDimension(options.pool);
  if (actual !== null && actual !== options.embeddingDimension) {
    throw new Error(
      `The database stores ${actual}-dimension vectors but EMBEDDING_DIMENSION=${options.embeddingDimension}. ` +
        'Use the same dimension as the existing data, or create a new database and re-embed.'
    );
  }
  return result;
}
