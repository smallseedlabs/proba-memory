/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
/** The read API on Postgres + pgvector: the same server as the unit tests, a real store and index. */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresMemoryStore, PostgresVectorIndex, TEST_DIMENSION, getTestPool } from '@smallseedlabs/proba-memory-adapters/testing';
import { uniqueName } from '@smallseedlabs/proba-memory-core/testing';
import { SEED, TOKENS, createHarness, type Harness } from './harness.testing.js';

const pool = await getTestPool();
const workspace = uniqueName('api-ws');
const foreign = uniqueName('api-foreign');
const harnesses: Harness[] = [];

async function open(options: { contextReader?: boolean } = {}): Promise<Harness> {
  const h = await createHarness({
    ...options,
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

describe('the context-reader role on Postgres', () => {
  const topic = 'autumn banner countdown timer';

  it('reads only the acting user’s memories and the shared ones, through search, get by id and links, in every candidate query', async () => {
    const h = await open({ contextReader: true });
    const user = randomUUID();
    const colleague = randomUUID();
    const [mine, shared, theirs, orphan] = await h.seed(workspace, [
      { content: `${topic} was rejected as pushy MINE`, ownerActorId: user, visibility: 'owner' },
      { content: `${topic} guideline of the whole workspace SHARED`, ownerActorId: null, visibility: 'workspace' },
      { content: `${topic} private to a colleague CANARY-OTHER`, ownerActorId: colleague, visibility: 'owner' },
      { content: `${topic} learned without a user CANARY-ORPHAN`, ownerActorId: null, visibility: 'owner' },
    ]);
    const [foreignMine] = await h.seed(foreign, [{ content: `${topic} same user, another workspace CANARY-FOREIGN`, ownerActorId: user, visibility: 'owner' }]);
    await h.store.transaction(async (tx) => {
      const at = '2026-10-26T09:00:00.000Z';
      await tx.insertLink({ workspaceId: workspace, fromId: mine.id, toId: theirs.id, relation: 'contradicts', weight: 0.9, createdAt: at });
      await tx.insertLink({ workspaceId: workspace, fromId: mine.id, toId: shared.id, relation: 'supports', weight: 0.7, createdAt: at });
    });

    for (const query of [topic, 'CANARY-OTHER', 'CANARY-ORPHAN', 'CANARY-FOREIGN', 'private to a colleague']) {
      const found = await h.asContextReader('/v1/memories/search', { actorId: user, workspaceId: workspace, body: { query, limit: 20 } });
      expect(found.status, query).toBe(200);
      expect(JSON.stringify(found.body), query).not.toMatch(/CANARY/);
      for (const r of found.body.results) expect([mine.id, shared.id], query).toContain(r.id);
    }
    const all = await h.asContextReader('/v1/memories/search', { actorId: user, workspaceId: workspace, body: { query: topic, limit: 20 } });
    expect(all.body.results.map((r: any) => r.id).sort()).toEqual([mine.id, shared.id].sort());
    // limit 1: the scope is applied before the limit, so the answer is a readable memory, not an empty list.
    const one = await h.asContextReader('/v1/memories/search', { actorId: user, workspaceId: workspace, body: { query: 'CANARY-OTHER private colleague', limit: 1 } });
    expect(one.body.results.every((r: any) => [mine.id, shared.id].includes(r.id))).toBe(true);

    const own = await h.asContextReader(`/v1/memories/${mine.id}`, { actorId: user, workspaceId: workspace });
    expect(own.status).toBe(200);
    expect(own.body.links.map((l: any) => l.toId)).toEqual([shared.id]);
    const missing = await h.asContextReader(`/v1/memories/${randomUUID()}`, { actorId: user, workspaceId: workspace });
    for (const hidden of [theirs.id, orphan.id, foreignMine.id]) {
      const res = await h.asContextReader(`/v1/memories/${hidden}`, { actorId: user, workspaceId: workspace });
      expect(res.status).toBe(404);
      expect({ ...res.body, traceId: null }).toEqual({ ...missing.body, traceId: null });
    }
    expect((await h.asContextReader('/v1/profiles', { actorId: user, workspaceId: workspace })).status).toBe(200);

    // A viewer still reads the whole workspace and an administrator the candidates.
    const viewer = await h.post('/v1/memories/search', { query: 'CANARY-OTHER private colleague', limit: 20 });
    expect(JSON.stringify(viewer.body)).toContain('CANARY-OTHER');
    expect((await h.post('/v1/memories/search', { query: topic, includeCandidates: true }, TOKENS.admin)).status).toBe(200);

    const events = (await h.emitted()).filter((e) => e.action === 'memory.retrieved' && (e.actor as { id: string }).id === 'context-reader');
    expect(events.length).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(events)).not.toMatch(/CANARY|MINE|SHARED|pushy/);
    for (const e of events) expect(e.details).toMatchObject({ caller: 'context-reader', assertionJti: expect.any(String) });
  });
});
