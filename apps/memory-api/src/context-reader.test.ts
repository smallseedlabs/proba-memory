/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
/**
 * The `context-reader` role: a service token and an act-as assertion, one user's own memories (and the ones shared with the workspace),
 * never anybody else's. Other users and another workspace are seeded as canaries: none of them may show up in any answer.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryFilter } from '@smallseedlabs/proba-memory-core';
import { InMemoryMemoryStore, InMemoryVectorIndex } from '@smallseedlabs/proba-memory-adapters';
import { DIMENSION, FOREIGN_WORKSPACE, NOW, TOKENS, WORKSPACE, createHarness, type Harness } from './harness.testing.js';
import { API_LIMITS } from './http/schemas.js';

const USER = randomUUID();
const OTHER_USER = randomUUID();
const QUERY = 'discount banner countdown timer';
const text = (marker: string): string => `The ${marker} discount banner with a countdown timer feels pushy to shoppers.`;

const OWN = 'OWN-MARKER';
const OWN_SECOND = 'OWN-SECOND-MARKER';
const SHARED = 'SHARED-MARKER';
const CANARY_OTHER = 'CANARY-OTHER-USER';
const CANARY_ORPHAN = 'CANARY-NO-OWNER';
const CANARY_FOREIGN = 'CANARY-FOREIGN-WORKSPACE';
const CANARY_FOREIGN_SHARED = 'CANARY-FOREIGN-SHARED';

let h: Harness;
let ids: Record<string, string> = {};

// Everything the search and the reads of the shared harness do runs as the same few callers: the limits are raised so this file tests
// scope and authentication, not throttling (the rate limit has its own harness below).
const HIGH_LIMITS = { MEMORY_API_RATE_LIMIT_MAX: '100000', MEMORY_API_SEARCH_RATE_LIMIT_MAX: '100000', MEMORY_API_AUTH_FAILURE_LIMIT_MAX: '100000' };

beforeAll(async () => {
  h = await createHarness({ contextReader: true, env: HIGH_LIMITS });
  const seeded = async (workspace: string, marker: string, extra: Record<string, unknown> = {}) => (await h.seed(workspace, [{ content: text(marker), ...extra }]))[0].id;
  ids = {
    own: await seeded(WORKSPACE, OWN, { ownerActorId: USER, visibility: 'owner', category: 'semantic' }),
    ownSecond: await seeded(WORKSPACE, OWN_SECOND, { ownerActorId: USER, visibility: 'owner', category: 'procedural', provenance: { extractor: null, observationIds: [], stance: 'negative', signals: ['approval.rejected'], createdBy: 'test' } }),
    shared: await seeded(WORKSPACE, SHARED, { ownerActorId: OTHER_USER, visibility: 'workspace' }),
    other: await seeded(WORKSPACE, CANARY_OTHER, { ownerActorId: OTHER_USER, visibility: 'owner' }),
    orphan: await seeded(WORKSPACE, CANARY_ORPHAN, { ownerActorId: null, visibility: 'owner' }),
    foreign: await seeded(FOREIGN_WORKSPACE, CANARY_FOREIGN, { ownerActorId: USER, visibility: 'owner' }),
    foreignShared: await seeded(FOREIGN_WORKSPACE, CANARY_FOREIGN_SHARED, { ownerActorId: OTHER_USER, visibility: 'workspace' }),
  };
  // The own memory is linked to a shared memory and to another user's private one.
  await h.store.transaction(async (tx) => {
    await tx.insertLink({ workspaceId: WORKSPACE, fromId: ids.own, toId: ids.shared, relation: 'supports', weight: 0.7, createdAt: NOW });
    await tx.insertLink({ workspaceId: WORKSPACE, fromId: ids.own, toId: ids.other, relation: 'contradicts', weight: 0.5, createdAt: NOW });
  });
});
afterAll(async () => {
  await h.close();
});

const search = (body: Record<string, unknown> = {}, o: Parameters<Harness['asContextReader']>[1] = {}) =>
  h.asContextReader('/v1/memories/search', { actorId: USER, ...o, body: { query: QUERY, ...body } });
const contents = (body: any): string => body.results.map((r: any) => r.content).join('\n');
const resultIds = (body: any): string[] => body.results.map((r: any) => r.id);
const withoutTrace = (body: any) => ({ ...body, traceId: null });

describe('context-reader: authentication', () => {
  it('needs a bridge token', async () => {
    const none = await search({}, { service: null });
    expect(none.status).toBe(401);
    expect(none.body.error).toBe('missing_token');
    expect((await h.asContextReader('/v1/profiles', { actorId: USER, service: null })).status).toBe(401);
  });

  it('refuses a token from another issuer or for another audience with 401', async () => {
    for (const service of ['garbage', await h.signers.mintServiceToken({ iss: 'proba-hub' }), await h.signers.mintServiceToken({ aud: 'proba-audit' }), await h.signers.mintServiceToken({ aud: ['proba-audit', 'proba-context'] })]) {
      const res = await search({}, { service });
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain(OWN);
    }
  });

  it('refuses expired tokens, tokens that live too long, and tokens signed by the Hub key with 401', async () => {
    const expired = await search({}, { service: { iatOffset: -600, expOffset: -300 } });
    expect(expired.status).toBe(401);
    expect(expired.body.error).toBe('token_expired');
    expect((await search({}, { service: { ttl: 300 } })).status).toBe(401);
    expect((await search({}, { service: await h.signers.mintServiceToken({}, h.signers.hub) })).status).toBe(401);
  });

  it('a bridge token does not work as an assertion, and an assertion does not work as a bridge token', async () => {
    expect((await search({}, { service: await h.signers.mintAssertion() })).status).toBe(401);
    const res = await search({}, { assertion: await h.signers.mintServiceToken() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('act_as_invalid');
  });

  it('is off unless enabled: the same token is just an unknown token', async () => {
    const off = await createHarness();
    try {
      const token = await off.signers.mintServiceToken();
      const res = await off.post('/v1/memories/search', { query: QUERY }, token, { 'x-act-as': await off.signers.mintAssertion() });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
      expect((await off.get('/v1/profiles', token, { 'x-act-as': await off.signers.mintAssertion() })).status).toBe(401);
    } finally {
      await off.close();
    }
  });
});

describe('context-reader: the act-as assertion and the request must agree', () => {
  it('answers 400 when the assertion is missing', async () => {
    const res = await search({}, { assertion: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('act_as_required');
    const get = await h.asContextReader(`/v1/memories/${ids.own}`, { actorId: USER, assertion: null });
    expect(get.status).toBe(400);
    expect(get.body.error).toBe('act_as_required');
  });

  it('answers 400 when actorId or workspaceId is missing (the search names them in its body, the reads in the query)', async () => {
    for (const scope of [{ actorId: null }, { workspaceId: null }, { actorId: null, workspaceId: null }] as const) {
      const post = await search({}, { scope });
      expect(post.status, JSON.stringify(scope)).toBe(400);
      expect(post.body.error).toBe('act_as_scope_required');
      const get = await h.asContextReader(`/v1/memories/${ids.own}`, { actorId: USER, scope });
      expect(get.status, JSON.stringify(scope)).toBe(400);
      expect(get.body.error).toBe('act_as_scope_required');
      expect((await h.asContextReader('/v1/profiles', { actorId: USER, scope })).status).toBe(400);
    }
    expect((await search({}, { scope: false })).status).toBe(400);
    expect((await search({}, { scope: { actorId: '' } })).status).toBe(400);
    // The search reads them from its body: the query string does not count.
    const inQuery = await h.asContextReader(`/v1/memories/search?actorId=${USER}&workspaceId=${WORKSPACE}`, { actorId: USER, scope: false, body: { query: QUERY } });
    expect(inQuery.status).toBe(400);
    expect(inQuery.body.error).toBe('act_as_scope_required');
  });

  it('answers 403 when actorId or workspaceId differ from the assertion', async () => {
    for (const scope of [{ actorId: OTHER_USER }, { workspaceId: FOREIGN_WORKSPACE }]) {
      const post = await search({}, { scope });
      expect(post.status).toBe(403);
      expect(post.body.error).toBe('act_as_mismatch');
      const get = await h.asContextReader(`/v1/memories/${ids.own}`, { actorId: USER, scope });
      expect(get.status).toBe(403);
      expect(get.body.error).toBe('act_as_mismatch');
      expect((await h.asContextReader('/v1/profiles', { actorId: USER, scope })).status).toBe(403);
    }
    // Nothing of the other user or workspace is in a refusal.
    const refused = await search({}, { scope: { actorId: OTHER_USER } });
    expect(JSON.stringify(refused.body)).not.toContain(OTHER_USER);
    expect(JSON.stringify(refused.body)).not.toContain(CANARY_OTHER);
  });

  it('answers 403 for an assertion that is expired, for another audience or issuer, or signed with another key', async () => {
    const cases: [string, Parameters<Harness['signers']['mintAssertion']>[0], string][] = [
      ['audience', { sub: USER, aud: ['proba-context', 'proba-audit'] }, 'act_as_invalid'],
      ['issuer', { sub: USER, iss: 'proba-context' }, 'act_as_invalid'],
      ['expired', { sub: USER, iatOffset: -600, expOffset: -300 }, 'act_as_expired'],
      ['too long', { sub: USER, ttl: 600 }, 'act_as_invalid'],
    ];
    for (const [label, options, code] of cases) {
      const res = await search({}, { actorId: USER, assertion: options });
      expect(res.status, label).toBe(403);
      expect(res.body.error, label).toBe(code);
    }
    const bridgeSigned = await h.signers.mintAssertion({ sub: USER, workspaceId: WORKSPACE }, h.signers.service);
    expect((await search({}, { assertion: bridgeSigned })).status).toBe(403);
    expect((await search({}, { assertion: 'garbage' })).status).toBe(403);
  });

  it('refuses every route outside the allow-list with 403, whatever the assertion says', async () => {
    const calls = [
      h.asContextReader('/v1/session', { actorId: USER }),
      h.asContextReader('/v1/memories', { actorId: USER }),
      h.asContextReader('/v1/memories?limit=5', { actorId: USER }),
      h.asContextReader(`/v1/retrievals/${randomUUID()}`, { actorId: USER }),
      h.asContextReader(`/v1/memories/${ids.own}/retrievals`, { actorId: USER }),
      h.asContextReader('/v1/jobs/runs', { actorId: USER }),
      h.asContextReader('/v1/session', { actorId: USER, assertion: null, scope: false }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('insufficient_role');
    }
  });

  it('is not an administrator: administrator-only options of the search stay refused', async () => {
    expect((await search({ includeCandidates: true })).status).toBe(403);
    expect((await search({ filter: { statuses: ['superseded'] } })).status).toBe(403);
    expect((await h.asContextReader('/v1/profiles', { actorId: USER })).body.profiles.every((p: any) => p.config === undefined)).toBe(true);
  });
});

describe('context-reader: what a user may read', () => {
  it('search returns the user\'s own memories and the workspace\'s shared ones, never another user\'s, an unowned one or another workspace\'s', async () => {
    const res = await search();
    expect(res.status).toBe(200);
    const body = contents(res.body);
    expect(body).toContain(OWN);
    expect(body).toContain(OWN_SECOND);
    expect(body).toContain(SHARED);
    for (const canary of [CANARY_OTHER, CANARY_ORPHAN, CANARY_FOREIGN, CANARY_FOREIGN_SHARED]) expect(JSON.stringify(res.body)).not.toContain(canary);
    expect(resultIds(res.body).sort()).toEqual([ids.own, ids.ownSecond, ids.shared].sort());
    expect(JSON.stringify(res.body)).not.toContain(OTHER_USER);
    expect(res.body.results.every((r: any) => r.trust === 'untrusted_data')).toBe(true);
  });

  it('the other user sees their own and the shared memories, and the user\'s are canaries to them', async () => {
    const res = await search({}, { actorId: OTHER_USER });
    expect(res.status).toBe(200);
    expect(resultIds(res.body).sort()).toEqual([ids.other, ids.shared].sort());
    expect(JSON.stringify(res.body)).not.toContain(OWN);
  });

  it('a user in another workspace reads that workspace only', async () => {
    const res = await search({}, { actorId: USER, workspaceId: FOREIGN_WORKSPACE });
    expect(res.status).toBe(200);
    expect(resultIds(res.body).sort()).toEqual([ids.foreign, ids.foreignShared].sort());
    expect(JSON.stringify(res.body)).not.toContain(OWN);
  });

  it('a user who owns nothing reads the shared memories only', async () => {
    const res = await search({}, { actorId: randomUUID() });
    expect(res.status).toBe(200);
    expect(resultIds(res.body)).toEqual([ids.shared]);
  });

  it('applies the structured filter, kinds, tags and minScore inside the scope', async () => {
    const procedural = await search({ filter: { kinds: ['procedural'] } });
    expect(resultIds(procedural.body)).toEqual([ids.ownSecond]);
    const categories = await search({ filter: { categories: ['procedural'] } });
    expect(resultIds(categories.body)).toEqual([ids.ownSecond]);
    expect((await search({ filter: { kinds: ['procedural'], categories: ['semantic'] } })).status).toBe(400);
    const tagged = await search({ filter: { tags: ['approval.rejected'] } });
    expect(resultIds(tagged.body)).toEqual([ids.ownSecond]);
    expect((await search({ filter: { tags: ['no.such.tag'] } })).body.results).toEqual([]);
    const strict = await search({ minScore: 1 });
    expect(strict.status).toBe(200);
    expect(strict.body.results).toEqual([]);
    expect((await search({ minScore: 2 })).status).toBe(400);
  });

  it('caps what the bridge may ask for', async () => {
    const caps = API_LIMITS.contextReader;
    expect((await search({ limit: caps.maxLimit })).status).toBe(200);
    expect((await search({ limit: caps.maxLimit + 1 })).status).toBe(400);
    expect((await search({ tokenBudget: caps.maxTokenBudget + 1 })).status).toBe(400);
    expect((await search({ limit: 1 })).body.results).toHaveLength(1);
  });

  it('never reports the candidates of the ranking', async () => {
    const res = await search();
    expect(res.body.candidates).toBeUndefined();
  });

  it('get by id returns the user\'s own memory and a shared one, with links limited to readable memories', async () => {
    const own = await h.asContextReader(`/v1/memories/${ids.own}`, { actorId: USER });
    expect(own.status).toBe(200);
    expect(own.body.memory.id).toBe(ids.own);
    expect(own.body.memory.content).toContain(OWN);
    // The link to the other user's private memory is not shown, the one to the shared memory is.
    expect(own.body.links.map((l: any) => l.toId)).toEqual([ids.shared]);
    expect(JSON.stringify(own.body)).not.toContain(ids.other);
    expect(JSON.stringify(own.body)).not.toContain(OTHER_USER);
    expect((await h.asContextReader(`/v1/memories/${ids.shared}`, { actorId: USER })).status).toBe(200);
  });

  it('get by id of another user\'s memory, an unowned one or another workspace\'s is 404, exactly like a missing one (never 403)', async () => {
    const missing = await h.asContextReader(`/v1/memories/${randomUUID()}`, { actorId: USER });
    expect(missing.status).toBe(404);
    for (const id of [ids.other, ids.orphan, ids.foreign, ids.foreignShared]) {
      const res = await h.asContextReader(`/v1/memories/${id}`, { actorId: USER });
      expect(res.status, id).toBe(404);
      expect(withoutTrace(res.body), id).toEqual(withoutTrace(missing.body));
    }
    // The owner of that memory does read it.
    expect((await h.asContextReader(`/v1/memories/${ids.other}`, { actorId: OTHER_USER })).status).toBe(200);
    // And a viewer is unchanged: it reads the whole workspace.
    expect((await h.get(`/v1/memories/${ids.other}`)).status).toBe(200);
  });

  it('a bad id or an unexpected query parameter is a 400', async () => {
    expect((await h.asContextReader('/v1/memories/not-a-uuid', { actorId: USER })).status).toBe(400);
    expect((await h.asContextReader(`/v1/memories/${ids.own}?extra=1`, { actorId: USER })).status).toBe(400);
    expect((await search({ unknown: true })).status).toBe(400);
  });

  it('profiles are served, without their configuration', async () => {
    const res = await h.asContextReader('/v1/profiles', { actorId: USER });
    expect(res.status).toBe(200);
    expect(res.body.profiles.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('"weights"');
    expect((await h.asContextReader('/v1/profiles', { actorId: USER, scope: { actorId: USER, workspaceId: WORKSPACE } })).status).toBe(200);
  });
});

describe('context-reader: the reader scope reaches every candidate generator', () => {
  it('passes visibleTo to the vector index and to the full-text search, and to hydration', async () => {
    const store = new InMemoryMemoryStore();
    const index = new InMemoryVectorIndex(store, DIMENSION);
    const filters: { generator: string; filter: MemoryFilter | undefined }[] = [];
    const searchText = store.searchText.bind(store);
    store.searchText = async (query) => {
      filters.push({ generator: 'text', filter: query.filter });
      return searchText(query);
    };
    const vectorSearch = index.search.bind(index);
    index.search = async (query) => {
      filters.push({ generator: 'vector', filter: query.filter });
      return vectorSearch(query);
    };
    const hydrated: (string | undefined)[] = [];
    const getMemories = store.getMemories.bind(store);
    store.getMemories = async (workspaceId, memoryIds, visibleTo) => {
      hydrated.push(visibleTo);
      return getMemories(workspaceId, memoryIds, visibleTo);
    };
    const own = await createHarness({ contextReader: true, store, index, env: HIGH_LIMITS });
    try {
      await own.seed(WORKSPACE, [
        { content: text(OWN), ownerActorId: USER, visibility: 'owner' },
        { content: text(CANARY_OTHER), ownerActorId: OTHER_USER, visibility: 'owner' },
      ]);
      const res = await own.asContextReader('/v1/memories/search', { actorId: USER, body: { query: QUERY } });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(filters.map((f) => f.generator).sort()).toEqual(['text', 'vector']);
      for (const { generator, filter } of filters) expect(filter?.visibleTo, generator).toBe(USER);
      expect(hydrated).toEqual([USER]);

      // A viewer's search carries no reader scope: unchanged.
      filters.length = 0;
      const viewer = await own.post('/v1/memories/search', { query: QUERY });
      expect(viewer.body.results).toHaveLength(2);
      for (const { filter } of filters) expect(filter?.visibleTo).toBeUndefined();
    } finally {
      await own.close();
    }
  });
});

describe('context-reader: the audit trail of its own reads', () => {
  it('records each read under the bridge with the assertion id, and no memory text', async () => {
    await h.emitted();
    const assertion = await h.signers.mintAssertion({ sub: USER, jti: 'assertion-jti-777' });
    const service = await h.signers.mintServiceToken({ jti: 'service-jti-888' });
    const searched = await search({}, { assertion, service });
    expect(searched.status).toBe(200);
    expect((await h.asContextReader(`/v1/memories/${ids.own}`, { actorId: USER, assertion, service })).status).toBe(200);
    expect((await h.asContextReader(`/v1/memories/${ids.other}`, { actorId: USER, assertion, service })).status).toBe(404);
    expect((await h.asContextReader('/v1/profiles', { actorId: USER, assertion, service })).status).toBe(200);

    const reads = (await h.emitted()).filter((e) => e.action === 'memory.retrieved');
    expect(reads.map((e) => (e.details as any).operation).sort()).toEqual(['get', 'get', 'profiles', 'search']);
    for (const e of reads) {
      expect(e.actor).toEqual({ type: 'service', id: 'context-reader' });
      expect(e.userId).toBe(USER);
      expect(e.workspaceId).toBe(WORKSPACE);
      expect(e.details).toMatchObject({ caller: 'context-reader', assertionJti: 'assertion-jti-777', tokenJti: 'service-jti-888' });
      const serialized = JSON.stringify(e);
      for (const marker of [OWN, OWN_SECOND, SHARED, CANARY_OTHER, 'countdown timer', QUERY]) expect(serialized).not.toContain(marker);
      expect(serialized).not.toContain(assertion);
      expect(serialized).not.toContain(service);
    }
    const search1 = reads.find((e) => (e.details as any).operation === 'search')!;
    expect((search1.details as any).ids.sort()).toEqual([ids.own, ids.ownSecond, ids.shared].sort());
    // The refused read of somebody else's memory names no id.
    const refused = reads.filter((e) => (e.details as any).operation === 'get').find((e) => (e.details as any).found === false)!;
    expect(refused.details).toMatchObject({ count: 0, ids: [] });
  });

  it('records denials with the caller and, once known, the assertion id', async () => {
    // A harness of its own: the audit trail keeps only a few denials per reason and client address per minute.
    const own = await createHarness({ contextReader: true, env: HIGH_LIMITS });
    try {
      const assertion = await own.signers.mintAssertion({ sub: USER, jti: 'assertion-jti-999' });
      const mismatch = await own.asContextReader('/v1/memories/search', { actorId: USER, assertion, scope: { actorId: OTHER_USER }, body: { query: QUERY } });
      expect(mismatch.status).toBe(403);
      expect((await own.asContextReader('/v1/memories', { actorId: USER })).status).toBe(403);
      expect((await own.asContextReader('/v1/profiles', { actorId: USER, assertion: null })).status).toBe(400);
      expect((await own.asContextReader('/v1/profiles', { actorId: USER, assertion: { aud: ['proba-audit'] } })).status).toBe(403);
      expect((await own.asContextReader('/v1/profiles', { actorId: USER, scope: { workspaceId: null } })).status).toBe(400);
      const denied = (await own.emitted()).filter((e) => e.action === 'auth.denied');
      expect(denied.map((e) => e.errorCode).sort()).toEqual(['act_as_invalid', 'act_as_mismatch', 'act_as_required', 'act_as_scope_required', 'insufficient_role']);
      for (const e of denied) {
        expect(e.actor).toEqual({ type: 'service', id: 'context-reader' });
        expect(e.outcome).toBe('denied');
        expect(e.details).toMatchObject({ caller: 'context-reader', verifier: 'context-service' });
        expect(e.details).toHaveProperty('tokenJti');
      }
      expect(denied.find((e) => e.errorCode === 'act_as_mismatch')!.details).toMatchObject({ assertionJti: 'assertion-jti-999' });
      expect(JSON.stringify(denied)).not.toContain(OTHER_USER);
    } finally {
      await own.close();
    }
  });

  it('refuses the read when its audit event cannot be sent (fails closed)', async () => {
    const strict = await createHarness({
      contextReader: true,
      env: HIGH_LIMITS,
      emitter: () => ({ emit: async () => Promise.reject(new Error('bus down')), forTrace() { return this; } }) as any,
    });
    try {
      for (const res of [await strict.asContextReader('/v1/profiles', { actorId: USER }), await strict.asContextReader(`/v1/memories/${randomUUID()}`, { actorId: USER })]) {
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('bus down');
      }
    } finally {
      await strict.close();
    }
  });
});

describe('context-reader: rate limits and other roles', () => {
  it('limits each acting user on their own', async () => {
    const limited = await createHarness({ contextReader: true, env: { MEMORY_API_RATE_LIMIT_MAX: '2' } });
    try {
      const a = randomUUID();
      const b = randomUUID();
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await limited.asContextReader('/v1/profiles', { actorId: a })).status);
      expect(statuses).toEqual([200, 200, 429]);
      expect((await limited.asContextReader('/v1/profiles', { actorId: b })).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('gives each acting user a search allowance of their own', async () => {
    const limited = await createHarness({ contextReader: true, env: { MEMORY_API_SEARCH_RATE_LIMIT_MAX: '1' } });
    try {
      const a = randomUUID();
      const first = await limited.asContextReader('/v1/memories/search', { actorId: a, body: { query: QUERY } });
      const second = await limited.asContextReader('/v1/memories/search', { actorId: a, body: { query: QUERY } });
      expect([first.status, second.status]).toEqual([200, 429]);
      expect(second.body.error).toBe('rate_limited');
      expect(second.headers['retry-after']).toBeDefined();
      expect((await limited.asContextReader('/v1/memories/search', { actorId: randomUUID(), body: { query: QUERY } })).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('leaves viewers and administrators as they were', async () => {
    // A viewer cannot use the bridge parameters, and an assertion header means nothing to it.
    const withParams = await h.post('/v1/memories/search', { query: QUERY, actorId: USER, workspaceId: WORKSPACE });
    expect(withParams.status).toBe(400);
    expect((await h.get(`/v1/memories/${ids.own}?actorId=${USER}&workspaceId=${WORKSPACE}`)).status).toBe(400);
    const withHeader = await h.post('/v1/memories/search', { query: QUERY }, TOKENS.viewer, { 'x-act-as': await h.signers.mintAssertion({ sub: USER }) });
    expect(withHeader.status).toBe(200);
    // Viewers and administrators still read the whole workspace, but never another workspace.
    const viewer = await h.post('/v1/memories/search', { query: QUERY, limit: 50 });
    expect(viewer.status).toBe(200);
    expect(resultIds(viewer.body)).toEqual(expect.arrayContaining([ids.own, ids.ownSecond, ids.shared, ids.other, ids.orphan]));
    expect(JSON.stringify(viewer.body)).not.toContain(CANARY_FOREIGN);
    const admin = await h.post('/v1/memories/search', { query: QUERY, limit: 50, includeCandidates: true }, TOKENS.admin);
    expect(admin.status).toBe(200);
    expect(admin.body.candidates.length).toBeGreaterThan(0);
    const list = await h.get('/v1/memories?limit=100');
    expect(list.status).toBe(200);
    expect(list.body.memories.map((m: any) => m.id)).toEqual(expect.arrayContaining([ids.own, ids.other, ids.orphan]));
    expect((await h.get('/v1/profiles', TOKENS.admin)).body.profiles[0].config).toBeDefined();
    expect((await h.get('/v1/session', TOKENS.admin)).body.role).toBe('admin');
  });
});
