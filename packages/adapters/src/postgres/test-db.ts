import pg from 'pg';
import { migrate } from './migrate.js';
import { createPgPool } from './pool.js';

/** Vector length of the test database. */
export const TEST_DIMENSION = 1024;

const DEFAULT_URL = 'postgresql://proba:proba@localhost:5432/proba_memory';

/** Connection string of the throwaway test database (same server as DATABASE_URL, database `proba_memory_test`). */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_URL);
  url.pathname = '/proba_memory_test';
  return url.toString();
}

export function testRedisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://localhost:6379';
}

async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`unexpected test database name ${name}`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if ((exists.rowCount ?? 0) === 0) {
      try {
        await client.query(`CREATE DATABASE ${name}`);
      } catch (err) {
        // Another test process created it first.
        if (!(err as { code?: string }).code || (err as { code?: string }).code !== '42P04') throw err;
      }
    }
  } finally {
    await client.end();
  }
}

let shared: Promise<pg.Pool> | null = null;

/** A pool on the migrated test database, shared by every test in the process. Never close it from a test. */
export function getTestPool(): Promise<pg.Pool> {
  shared ??= (async () => {
    const url = testDatabaseUrl();
    await ensureDatabase(url);
    const pool = createPgPool(url, 10);
    await migrate({ pool, embeddingDimension: TEST_DIMENSION });
    return pool;
  })();
  return shared;
}

export async function truncateOutbox(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE audit_outbox RESTART IDENTITY');
}
