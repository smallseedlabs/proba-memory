/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
/** The read API on Postgres + pgvector: the same server as the unit tests, a real store and index. */
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresMemoryStore, PostgresVectorIndex, TEST_DIMENSION, getTestPool } from '@smallseedlabs/proba-memory-adapters/testing';
import { uniqueName } from '@smallseedlabs/proba-memory-core/testing';
import { SEED, TOKENS, createHarness, type Harness } from './harness.testing.js';

const pool = await getTestPool();
const workspace = uniqueName('api-ws');
const foreign = uniqueName('api-foreign');
const harnesses: Harness[] = [];

async function open(): Promise<Harness> {
  const h = await createHarness({
    env: { EMBEDDING_DIMENSION: String(TEST_DIMENSION), MEMORY_API_WORKSPACE_ID: workspace },
    store: new PostgresMemoryStore({ pool }),
    index: new PostgresVectorIndex({ pool, dimension: TEST_DIMENSION }),
  });
  harnesses.push(h);
  return h;
}
afterAll(async () => {
  for (const h of harnesses) await h.app.close();
});

describe('memory-api on Postgres', () => {
  it('searches the caller’s workspace only, with scores, and audits the read', async () => {
    const h = await open();
    await h.seed(workspace, SEED);
    await h.seed(foreign, [{ content: 'FOREIGN-SECRET: discount banner with a countdown timer performs best here.', category: 'semantic', importance: 1, confidence: 1 }]);
    const res = await h.post('/v1/memories/search', { query: 'discount banner countdown timer' });
    expect(res.status).toBe(200);
    expect(res.body.results[0].content).toContain('countdown timer');
    expect(res.body.results[0].trust).toBe('untrusted_data');
    expect(JSON.stringify(res.body)).not.toContain('FOREIGN-SECRET');
    expect(res.body.profile).toMatchObject({ name: 'default', served: 'active' });
    const events = await h.emitted();
    expect(events.filter((e) => e.action === 'memory.retrieved')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('countdown timer');
  });

  it('lists and pages, gets by id, and answers 404 for another workspace’s id exactly like a missing one', async () => {
    const h = await open();
    const [mine] = await h.seed(workspace, [{ content: 'Page test memory alpha.' }]);
    const [theirs] = await h.seed(foreign, [{ content: 'Page test memory beta.' }]);
    const list = await h.get('/v1/memories?limit=2');
    expect(list.status).toBe(200);
    expect(list.body.memories).toHaveLength(2);
    expect(list.body.nextCursor).toBeTruthy();
    const next = await h.get(`/v1/memories?limit=200&cursor=${encodeURIComponent(list.body.nextCursor)}`);
    expect(next.status).toBe(200);
    expect(JSON.stringify([list.body, next.body])).not.toContain('beta');
    expect((await h.get(`/v1/memories/${mine.id}`)).status).toBe(200);
    const other = await h.get(`/v1/memories/${theirs.id}`);
    const missing = await h.get('/v1/memories/00000000-0000-4000-8000-000000000000');
    expect(other.status).toBe(404);
    expect({ ...other.body, traceId: null }).toEqual({ ...missing.body, traceId: null });
  });

  it('serves the built-in scoring profile to viewers and the full configuration to admins', async () => {
    const h = await open();
    const viewer = await h.get('/v1/profiles');
    const admin = await h.get('/v1/profiles', TOKENS.admin);
    expect(viewer.status).toBe(200);
    expect(JSON.stringify(viewer.body)).not.toContain('"weights"');
    expect(JSON.stringify(admin.body)).toContain('"weights"');
  });
});
