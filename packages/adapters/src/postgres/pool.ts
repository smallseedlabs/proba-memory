import pg from 'pg';

/** Anything with pg's query(): a Pool or a PoolClient. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

// timestamptz is returned as a Date by default; int8 (bigint) as string. Both are what the stores expect.
export function createPgPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  // An idle client that errors must not crash the process; the next query reports a real failure.
  pool.on('error', () => undefined);
  return pool;
}

/** Run `fn` in BEGIN..COMMIT on a dedicated client; roll back and rethrow on error. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the useful one.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** pgvector text form: `[0.1,0.2]`. */
export function toVectorLiteral(vector: number[]): string {
  for (const v of vector) if (!Number.isFinite(v)) throw new Error('vector contains a non-finite number');
  return `[${vector.join(',')}]`;
}

export function parseVectorLiteral(text: string): number[] {
  return JSON.parse(text) as number[];
}

export const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
export const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
