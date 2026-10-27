/* eslint-disable @typescript-eslint/no-explicit-any -- the OpenAPI document and response bodies are inspected loosely */
/**
 * Keeps docs/openapi.yaml honest: the document, the routes the server registers, the request schemas it
 * validates with, the caps in API_LIMITS and the bodies it actually returns must all agree.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMORY_CATEGORIES, MEMORY_STATUSES } from '@smallseedlabs/proba-memory-core';
import { makeLogEntry } from '@smallseedlabs/proba-memory-core/testing';
import { API_LIMITS, SOURCE_KINDS, filterBodySchema, jobRunsQuerySchema, listQuerySchema, searchBodySchema } from './http/schemas.js';
import { SEED, TOKENS, WORKSPACE, createHarness, type Harness } from './harness.testing.js';

// Both packages are CommonJS: load them the way Node does, whatever the test runner's interop.
const nodeRequire = createRequire(import.meta.url);
type Validate = ((data: unknown) => boolean) & { errors?: unknown };
type AjvInstance = { addSchema(schema: object): unknown; compile(schema: object): Validate };
const Ajv2020 = nodeRequire('ajv/dist/2020').default as new (options: object) => AjvInstance;
const addFormats = nodeRequire('ajv-formats').default as (ajv: AjvInstance) => unknown;

const doc: any = yaml.load(readFileSync(fileURLToPath(new URL('../../../docs/openapi.yaml', import.meta.url)), 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const operations: { method: string; path: string; op: any }[] = Object.entries<any>(doc.paths).flatMap(([path, item]) =>
  Object.entries<any>(item)
    .filter(([m]) => METHODS.includes(m))
    .map(([method, op]) => ({ method, path, op }))
);

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'openapi', ...doc });
const validator = (schemaName: string) => ajv.compile({ $ref: `openapi#/components/schemas/${schemaName}` });

const resolveRef = (node: any): any => {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    return node.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((acc: any, key: string) => acc[key], doc);
  }
  return node;
};
const expectValid = (name: string, body: unknown): void => {
  const validate = validator(name);
  expect(validate(body), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
};

describe('docs/openapi.yaml', () => {
  it('is an OpenAPI 3.1 document with unique operation ids and a bearer scheme', () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    const ids = operations.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.components.securitySchemes.firebaseIdToken).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.security).toEqual([{ firebaseIdToken: [] }]);
  });

  it('describes reads, plus search as the only POST (nothing that writes, edits or deletes a memory)', () => {
    expect(operations.filter((o) => o.method !== 'get').map((o) => `${o.method} ${o.path}`)).toEqual(['post /v1/memories/search']);
  });

  it('describes exactly the routes the server registers', async () => {
    const h = await createHarness();
    try {
      for (const { method, path } of operations) {
        expect(h.app.hasRoute({ method: method.toUpperCase() as 'GET', url: path.replace(/\{(\w+)\}/g, ':$1') }), `${method} ${path}`).toBe(true);
      }
      // The routing tree lists each route once with its methods (HEAD is added by Fastify next to each GET);
      // apart from the CORS preflight catch-all there must be no route the document does not describe.
      const tree = h.app.printRoutes({ commonPrefix: false }).replace(/^.*\* \(OPTIONS\)$/m, '');
      const entries = [...tree.matchAll(/\(([A-Z, ]+)\)/g)].map((m) => m[1].split(',').map((x) => x.trim()).filter((x) => x !== 'HEAD'));
      expect(entries.every((methods) => methods.length === 1)).toBe(true);
      expect(entries.map((e) => e[0]).sort()).toEqual(operations.map((o) => o.method.toUpperCase()).sort());
    } finally {
      await h.close();
    }
  });

  it('keeps public routes public and every /v1 route authenticated, documenting 401, 403 and 429', () => {
    for (const { path, op } of operations) {
      if (path.startsWith('/v1')) {
        expect(op.security, path).toBeUndefined();
        expect(Object.keys(op.responses), path).toEqual(expect.arrayContaining(['401', '403', '429']));
      } else {
        expect(op.security, path).toEqual([]);
      }
    }
  });

  it('has no workspace parameter or request field anywhere', () => {
    for (const { op } of operations) for (const p of (op.parameters ?? []).map(resolveRef)) expect(p.name.toLowerCase()).not.toContain('workspace');
    expect(Object.keys(doc.components.schemas.SearchRequest.properties)).not.toContain('workspaceId');
    expect(Object.keys(doc.components.schemas.SearchFilter.properties)).not.toContain('workspaceId');
  });
});

describe('request schemas match the validation code', () => {
  it('GET /v1/memories: same parameter names, defaults and caps as listQuerySchema', () => {
    const shape = (listQuerySchema as any).shape as Record<string, any>;
    const spec = doc.paths['/v1/memories'].get.parameters.map(resolveRef);
    expect(spec.map((p: any) => p.name).sort()).toEqual(Object.keys(shape).sort());
    for (const p of spec) {
      expect(p.in).toBe('query');
      expect(Boolean(p.required), `${p.name} required`).toBe(!shape[p.name].isOptional());
      if (p.schema.default !== undefined) expect(shape[p.name].parse(undefined), `${p.name} default`).toEqual(p.schema.default);
      if (p.schema.maximum !== undefined && p.name === 'limit') {
        expect(shape.limit.safeParse(String(p.schema.maximum)).success).toBe(true);
        expect(shape.limit.safeParse(String(p.schema.maximum + 1)).success).toBe(false);
      }
    }
    expect(spec.find((p: any) => p.name === 'limit').schema).toMatchObject({ default: API_LIMITS.list.defaultLimit, maximum: API_LIMITS.list.maxLimit });
  });

  it('POST /v1/memories/search: same body fields, required flags and caps as searchBodySchema', () => {
    const schema = doc.components.schemas.SearchRequest;
    const shape = (searchBodySchema as any).shape as Record<string, any>;
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(shape).sort());
    expect(schema.required.sort()).toEqual(Object.keys(shape).filter((k) => !shape[k].isOptional()).sort());
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.query.maxLength).toBe(API_LIMITS.search.maxQueryChars);
    expect(schema.properties.limit.maximum).toBe(API_LIMITS.search.maxLimit);
    expect(schema.properties.tokenBudget.maximum).toBe(API_LIMITS.search.maxTokenBudget);
    const ok = { query: 'x' };
    expect(searchBodySchema.safeParse({ ...ok, limit: schema.properties.limit.maximum }).success).toBe(true);
    expect(searchBodySchema.safeParse({ ...ok, limit: schema.properties.limit.maximum + 1 }).success).toBe(false);
    expect(searchBodySchema.safeParse({ query: 'x'.repeat(schema.properties.query.maxLength + 1) }).success).toBe(false);
    expect(searchBodySchema.safeParse({ ...ok, tokenBudget: schema.properties.tokenBudget.maximum + 1 }).success).toBe(false);
  });

  it('the search filter lists the fields filterBodySchema accepts, and nothing else', () => {
    const props = doc.components.schemas.SearchFilter.properties;
    expect(Object.keys(props).sort()).toEqual(Object.keys((filterBodySchema as any).shape).sort());
    expect(doc.components.schemas.SearchFilter.additionalProperties).toBe(false);
    expect(props.categories.maxItems).toBe(MEMORY_CATEGORIES.length);
    expect(props.statuses.maxItems).toBe(MEMORY_STATUSES.length);
  });

  it('enumerations in the document are the ones the code accepts', () => {
    expect(doc.components.schemas.Category.enum).toEqual([...MEMORY_CATEGORIES]);
    expect(doc.components.schemas.Status.enum).toEqual([...MEMORY_STATUSES]);
    expect(doc.components.schemas.SourceKind.enum).toEqual([...SOURCE_KINDS]);
    for (const c of MEMORY_CATEGORIES) expect(filterBodySchema.safeParse({ categories: [c] }).success).toBe(true);
    expect(filterBodySchema.safeParse({ categories: ['nonsense'] }).success).toBe(false);
  });

  it('the request body cap in the description matches the server limit', () => {
    expect(doc.components.responses.TooLarge.description).toContain(`${API_LIMITS.bodyMaxBytes / 1024} KiB`);
  });

  it('GET /v1/jobs/runs: same parameter names, defaults and caps as jobRunsQuerySchema', () => {
    const shape = (jobRunsQuerySchema as any).shape as Record<string, any>;
    const spec = doc.paths['/v1/jobs/runs'].get.parameters.map(resolveRef);
    expect(spec.map((p: any) => p.name).sort()).toEqual(Object.keys(shape).sort());
    expect(spec.find((p: any) => p.name === 'limit').schema).toMatchObject({
      default: API_LIMITS.jobs.defaultLimit,
      maximum: API_LIMITS.jobs.maxLimit,
    });
    expect(shape.limit.safeParse(String(API_LIMITS.jobs.maxLimit)).success).toBe(true);
    expect(shape.limit.safeParse(String(API_LIMITS.jobs.maxLimit + 1)).success).toBe(false);
  });

  it('GET /v1/memories/{id}/retrievals: limit cap matches API_LIMITS.retrievals', () => {
    const limit = doc.paths['/v1/memories/{id}/retrievals'].get.parameters.map(resolveRef).find((p: any) => p.name === 'limit');
    expect(limit.schema).toMatchObject({ default: API_LIMITS.retrievals.defaultLimit, maximum: API_LIMITS.retrievals.maxLimit });
  });
});

describe('real responses conform to the document', () => {
  let h: Harness;
  let someId: string;
  beforeAll(async () => {
    h = await createHarness();
    const seeded = await h.seed(WORKSPACE, SEED);
    someId = seeded[0].id;
    await h.store.transaction((tx) => tx.insertLink({ workspaceId: WORKSPACE, fromId: seeded[0].id, toId: seeded[1].id, relation: 'supports', weight: 0.7, createdAt: '2026-10-26T12:00:00.000Z' }));
  });
  afterAll(() => h.close());

  it('GET /health, /ready, /v1/session', async () => {
    expect((await h.get('/health', null)).body).toMatchObject({ status: 'ok' });
    expectValid('Readiness', (await h.get('/ready', null)).body);
    expectValid('Session', (await h.get('/v1/session')).body);
  });

  it('POST /v1/memories/search (viewer and admin with candidates)', async () => {
    const viewer = await h.post('/v1/memories/search', { query: 'countdown timer banner headline' });
    expect(viewer.status).toBe(200);
    expectValid('SearchResponse', viewer.body);
    const admin = await h.post('/v1/memories/search', { query: 'countdown timer banner headline', includeCandidates: true }, TOKENS.admin);
    expect(admin.body.candidates.length).toBeGreaterThan(0);
    expectValid('SearchResponse', admin.body);
  });

  it('GET /v1/memories, /v1/memories/:id, /v1/profiles (viewer and admin)', async () => {
    const page = await h.get('/v1/memories?limit=2');
    expect(page.body.memories).toHaveLength(2);
    expectValid('MemoryPage', page.body);
    const detail = await h.get(`/v1/memories/${someId}`);
    expect(detail.body.links).toHaveLength(1);
    expectValid('MemoryDetail', detail.body);
    for (const token of [TOKENS.viewer, TOKENS.admin]) {
      const res = await h.get('/v1/profiles', token);
      for (const p of res.body.profiles) expectValid('Profile', p);
    }
  });

  it('GET /v1/retrievals/:id, /v1/memories/:id/retrievals, /v1/jobs/runs (admin)', async () => {
    const entry = makeLogEntry(WORKSPACE, {
      results: [{ id: someId, score: 0.7, position: 1 }],
      outcome: { verdict: 'none', resolvedAt: '2026-10-26T12:00:00.000Z' },
    });
    await h.logStore.append(entry);
    const started = await h.jobRuns.start({
      id: randomUUID(),
      jobName: 'decay',
      workspaceId: WORKSPACE,
      traceId: randomUUID(),
      trigger: 'schedule',
      startedAt: '2026-10-26T08:00:00.000Z',
      staleAfterMs: 60_000,
    });
    await h.jobRuns.finishSuccess(started!.id, { processed: 1, changed: 0 }, '2026-10-26T08:00:01.000Z');

    const retrieval = await h.get(`/v1/retrievals/${entry.id}`, TOKENS.admin);
    expect(retrieval.status).toBe(200);
    expectValid('RetrievalRecord', retrieval.body);

    const history = await h.get(`/v1/memories/${someId}/retrievals`, TOKENS.admin);
    expect(history.status).toBe(200);
    expectValid('MemoryRetrievals', history.body);

    const runs = await h.get('/v1/jobs/runs', TOKENS.admin);
    expect(runs.status).toBe(200);
    expectValid('JobRunsPage', runs.body);

    expect((await h.get(`/v1/retrievals/${entry.id}`, TOKENS.viewer)).status).toBe(403);
    expect((await h.get('/v1/jobs/runs', TOKENS.viewer)).status).toBe(403);
  });

  it('every documented error status has the documented error body', async () => {
    const errors = [
      await h.get('/v1/session', null),
      await h.get('/v1/session', TOKENS.outsider),
      await h.get('/v1/memories?bogus=1'),
      await h.get(`/v1/memories/${randomUUID()}`),
      await h.post('/v1/memories/search', { query: '' }),
      await h.post('/v1/memories/search', { query: 'x', filter: { goalId: 'g'.repeat(40_000) } }),
    ];
    expect(errors.map((e) => e.status)).toEqual([401, 403, 400, 404, 400, 413]);
    for (const e of errors) expectValid('Error', e.body);
    expect(String(errors[0].headers['www-authenticate'])).toContain('Bearer');
  });

  it('a rate-limited answer has the documented body and Retry-After header', async () => {
    const limited = await createHarness({ env: { MEMORY_API_RATE_LIMIT_MAX: '1' } });
    try {
      await limited.get('/v1/profiles');
      const res = await limited.get('/v1/profiles');
      expect(res.status).toBe(429);
      expectValid('Error', res.body);
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});
