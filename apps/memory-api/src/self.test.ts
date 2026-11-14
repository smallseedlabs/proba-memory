/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
/**
 * GET /v1/self: Proba's bootstrap self memory, seeded on start from bootstrap/proba-self.json into the reserved system workspace.
 * Every workspace (people and the context-reader role) reads the same entries; no tenant can write them or reach them through search.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, MemoryLogger, SYSTEM_WORKSPACE_ID, listSelfMemories, loadConfig } from '@smallseedlabs/proba-memory-core';
import { FOREIGN_WORKSPACE, TOKENS, WORKSPACE, createHarness, testConfig, type Harness } from './harness.testing.js';
import { DEFAULT_SELF_SEED_FILE, bootstrapSelfMemory, loadSelfSeedFile } from './self-seed.js';

const HIGH_LIMITS = { MEMORY_API_RATE_LIMIT_MAX: '100000', MEMORY_API_SEARCH_RATE_LIMIT_MAX: '100000', MEMORY_API_AUTH_FAILURE_LIMIT_MAX: '100000' };
const USER = randomUUID();
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ contextReader: true, env: HIGH_LIMITS });
  await h.seed(WORKSPACE, [{ content: 'The workspace prefers short headlines under forty characters.', ownerActorId: USER, visibility: 'owner' }]);
  const r = await bootstrapSelfMemory({ config: h.config, store: h.store, clock: h.clock, logger: new MemoryLogger() });
  expect(r?.inserted).toBeGreaterThan(0);
});
afterAll(async () => {
  await h.close();
});

describe('the shipped seed', () => {
  it('is valid, public data that describes Proba, its rules and its limbs', () => {
    const seed = loadSelfSeedFile(DEFAULT_SELF_SEED_FILE);
    const text = seed.entries.map((e) => e.content).join('\n');
    expect(text).toMatch(/Small Seed Labs/);
    expect(text).toMatch(/what would unblock it/);
    for (const limb of ['research.gather', 'page.attach_user_page', 'ads.create_campaign', 'ads.pause_campaign', 'ads.resume_campaign']) expect(text).toContain(limb);
    expect(text).toMatch(/lookupUrls/);
    expect(text).toMatch(/exact spelling and casing/);
    expect(text).toMatch(/img-\* source/);
    expect(text).toMatch(/ADS_MAX_DAILY_BUDGET/);
    // One always-on core of ~300 tokens or fewer; everything else is tagged detail.
    expect(seed.schema).toBe('proba.self-memory/v2');
    const cores = seed.entries.filter((e) => e.tier === 'core');
    expect(cores).toHaveLength(1);
    expect(Math.ceil(cores[0].content.length / 4)).toBeLessThanOrEqual(300);
    expect(cores[0].content).toMatch(/what would unblock it/);
    for (const e of seed.entries.filter((x) => x.tier === 'detail')) expect(e.tags.length, e.key).toBeGreaterThan(0);
    // No secrets or credentials in a public seed.
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}|BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]/i);
  });

  it('re-seeding the same file on the next start changes nothing', async () => {
    const before = await listSelfMemories(h.store);
    const again = await bootstrapSelfMemory({ config: h.config, store: h.store, clock: h.clock, logger: new MemoryLogger() });
    expect(again).toMatchObject({ inserted: 0, superseded: 0, tombstoned: 0, conflicts: [] });
    expect(await listSelfMemories(h.store)).toEqual(before);
  });

  it('can be switched off', async () => {
    const config = testConfig({ MEMORY_SELF_SEED_ENABLED: 'false' });
    expect(await bootstrapSelfMemory({ config, store: h.store, clock: h.clock, logger: new MemoryLogger() })).toBeNull();
  });
});

describe('GET /v1/self', () => {
  it('serves the active entries, in key order, to a person', async () => {
    const seed = loadSelfSeedFile();
    const res = await h.get('/v1/self', TOKENS.viewer);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(seed.version);
    expect(res.body.memories.map((m: any) => m.key)).toEqual(seed.entries.map((e) => e.key));
    expect(res.body.memories[0]).toMatchObject({ title: seed.entries[0].title, content: seed.entries[0].content, version: seed.version });
    expect(res.body.core).toMatchObject({ key: '00-core', version: seed.version, content: seed.entries[0].content });
    expect(res.body.memories[0].tier).toBe('core');
    expect(res.body.memories[1]).toMatchObject({ tier: 'detail', tags: seed.entries[1].tags });
  });

  it('serves the same entries to the context-reader role in any workspace', async () => {
    const a = await h.asContextReader('/v1/self', { actorId: USER, workspaceId: WORKSPACE });
    const b = await h.asContextReader('/v1/self', { actorId: randomUUID(), workspaceId: FOREIGN_WORKSPACE });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.memories).toEqual(a.body.memories);
    expect(a.body.memories.length).toBeGreaterThan(0);
  });

  it('still checks the act-as scope and needs a sign-in', async () => {
    expect((await h.asContextReader('/v1/self', { actorId: USER, scope: { workspaceId: FOREIGN_WORKSPACE } })).status).toBe(403);
    expect((await h.get('/v1/self', null)).status).toBe(401);
    expect((await h.get('/v1/self?workspaceId=x', TOKENS.viewer)).status).toBe(400);
  });

  it('has no write route: the self memory cannot be posted, patched or deleted', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await h.app.inject({ method, url: '/v1/self', headers: { authorization: `Bearer ${TOKENS.admin}`, 'content-type': 'application/json' }, payload: '{}' });
      expect([404, 405]).toContain(res.statusCode);
    }
  });

  it('does not leak into tenant search or listing (the system workspace is never the caller workspace)', async () => {
    const seed = loadSelfSeedFile();
    const search = await h.asContextReader('/v1/memories/search', { actorId: USER, body: { query: 'Proba marketing operator Small Seed Labs approval' } });
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).not.toContain(seed.entries[0].content.slice(0, 40));
    const list = await h.get('/v1/memories', TOKENS.admin);
    const selfIds = new Set((await listSelfMemories(h.store)).map((m) => m.id));
    expect(list.status).toBe(200);
    expect(list.body.memories.length).toBeGreaterThan(0);
    expect(list.body.memories.some((m: any) => selfIds.has(m.id))).toBe(false);
  });
});

describe('the reserved system workspace in configuration', () => {
  it('cannot be configured as a tenant workspace', () => {
    for (const key of ['MEMORY_API_WORKSPACE_ID', 'AUDIT_WORKSPACE_ID', 'DEV_CONTENT_WORKSPACE_ID']) {
      expect(() => loadConfig({ NODE_ENV: 'test', [key]: SYSTEM_WORKSPACE_ID }), key).toThrow(ConfigError);
    }
  });
});
