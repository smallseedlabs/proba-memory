/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
/**
 * Example requests and responses of the `context-reader` role, kept in docs/contracts/context-reader/*.json for the context bridge
 * (and anybody else who calls the role) to build against. They are produced from what the server really answers and this test
 * fails when a file no longer matches: regenerate them with
 *
 *   UPDATE_CONTRACT_FIXTURES=1 npm test -- contract-fixtures
 *
 * and commit the result. Every response body is also validated against docs/openapi.yaml, and the claims examples against the
 * protocol's act-as schema.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actAsAssertionClaimsSchema } from '@smallseedlabs/proba-protocol';
import { WORKSPACE, createHarness, type Harness } from './harness.testing.js';

const nodeRequire = createRequire(import.meta.url);
type Validate = ((data: unknown) => boolean) & { errors?: unknown };
type AjvInstance = { addSchema(schema: object): unknown; compile(schema: object): Validate };
const Ajv2020 = nodeRequire('ajv/dist/2020').default as new (options: object) => AjvInstance;
const addFormats = nodeRequire('ajv-formats').default as (ajv: AjvInstance) => unknown;

const DIR = fileURLToPath(new URL('../../../docs/contracts/context-reader/', import.meta.url));
const doc: any = yaml.load(readFileSync(fileURLToPath(new URL('../../../docs/openapi.yaml', import.meta.url)), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'openapi', ...doc });
const validator = (name: string) => ajv.compile({ $ref: `openapi#/components/schemas/${name}` });

const UPDATE = process.env.UPDATE_CONTRACT_FIXTURES === '1';
const TRACE_ID_IN_BODIES = '00000000-0000-4000-8000-000000000000';
const DURATION_MS = 14;

const USER = '660e8400-e29b-41d4-a716-446655440001';
const OTHER_USER = '660e8400-e29b-41d4-a716-446655440009';
const GOAL = '770e8400-e29b-41d4-a716-446655440002';
const THREAD = '880e8400-e29b-41d4-a716-446655440003';
const MEMORY = 'aa0e8400-e29b-41d4-a716-000000000001';
const MEMORY_SHARED = 'aa0e8400-e29b-41d4-a716-000000000002';
const MEMORY_OTHER = 'aa0e8400-e29b-41d4-a716-000000000003';
const OTHER_MARKER = 'CANARY-OTHER-USER';

const FROM_AUDIT = (n: number) => ({
  sourceRefs: [{ kind: 'audit' as const, id: `bb0e8400-e29b-41d4-a716-00000000000${n}`, ref: `audit:bb0e8400-e29b-41d4-a716-00000000000${n}` }],
  provenance: { extractor: null, observationIds: [], stance: 'neutral' as const, signals: [] as string[], createdBy: 'extractor' },
});

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ contextReader: true });
  await h.seed(WORKSPACE, [
    {
      id: MEMORY,
      content: 'The user rejected the discount banner with a countdown timer because it feels pushy.',
      summary: 'Rejects pushy countdown banners',
      category: 'semantic',
      importance: 0.9,
      confidence: 0.8,
      goalId: GOAL,
      threadId: THREAD,
      ownerActorId: USER,
      visibility: 'owner',
      ...FROM_AUDIT(1),
      provenance: { extractor: null, observationIds: [], stance: 'negative', signals: ['approval.rejected'], createdBy: 'extractor' },
    },
    {
      id: MEMORY_SHARED,
      content: 'Keep every headline under forty characters because placements truncate longer ones.',
      category: 'procedural',
      importance: 0.7,
      confidence: 0.7,
      ownerActorId: OTHER_USER,
      visibility: 'workspace',
      ...FROM_AUDIT(2),
    },
    {
      id: MEMORY_OTHER,
      content: `${OTHER_MARKER}: the discount banner countdown timer worked well for this other user.`,
      category: 'semantic',
      ownerActorId: OTHER_USER,
      visibility: 'owner',
      ...FROM_AUDIT(3),
    },
  ]);
  await h.store.transaction((tx) => tx.insertLink({ workspaceId: WORKSPACE, fromId: MEMORY, toId: MEMORY_SHARED, relation: 'supports', weight: 0.7, createdAt: '2026-10-26T12:00:00.000Z' }));
});
afterAll(async () => {
  await h.close();
});

interface Recorded {
  description: string;
  request: { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: Record<string, unknown>; headers: Record<string, string> };
  response: { status: number; body: unknown };
}

const HEADERS = { Authorization: 'Bearer <service token>', 'X-Act-As': '<act-as assertion>' };
const POST_HEADERS = { ...HEADERS, 'Content-Type': 'application/json' };

/** Replace what changes from run to run (the trace id, durations) so a recorded answer is stable. */
const stable = (body: unknown, traceId: unknown): unknown =>
  JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (key === 'traceId' && typeof value === 'string' && value === traceId) return TRACE_ID_IN_BODIES;
      if (key === 'durationMs' && typeof value === 'number') return DURATION_MS;
      return value;
    })
  );

/** Call a GET as the bridge would and describe the exchange; `query` is everything after actorId and workspaceId. */
async function read(description: string, path: string, options: Parameters<Harness['asContextReader']>[1] = {}, headers: Record<string, string> = HEADERS): Promise<Recorded> {
  const res = await h.asContextReader(path, { actorId: USER, ...options });
  const shown: Record<string, string> = {};
  if (options.scope !== false) {
    shown.actorId = options.scope?.actorId === undefined ? USER : (options.scope.actorId ?? '');
    shown.workspaceId = options.scope?.workspaceId === undefined ? WORKSPACE : (options.scope.workspaceId ?? '');
    for (const [k, v] of Object.entries(shown)) if (v === '') delete shown[k];
  }
  return { description, request: { method: 'GET', path, query: shown, headers }, response: { status: res.status, body: stable(res.body, res.headers['x-trace-id']) } };
}

/** The same for the search: `actorId` and `workspaceId` are part of the body. */
async function searchOf(description: string, body: Record<string, unknown>, options: Parameters<Harness['asContextReader']>[1] = {}): Promise<Recorded> {
  const res = await h.asContextReader('/v1/memories/search', { actorId: USER, ...options, body });
  const shown: Record<string, unknown> = {};
  if (options.scope !== false) {
    const actor = options.scope?.actorId === undefined ? USER : options.scope.actorId;
    const workspace = options.scope?.workspaceId === undefined ? WORKSPACE : options.scope.workspaceId;
    if (actor !== null) shown.actorId = actor;
    if (workspace !== null) shown.workspaceId = workspace;
  }
  return {
    description,
    request: { method: 'POST', path: '/v1/memories/search', body: { ...body, ...shown }, headers: POST_HEADERS },
    response: { status: res.status, body: stable(res.body, res.headers['x-trace-id']) },
  };
}

const cases: { file: string; schema?: string; each?: string; run: () => Promise<Recorded> }[] = [
  {
    file: 'search.json',
    schema: 'SearchResponse',
    run: () =>
      searchOf('The memories most useful for a query, among those the user owns and those shared with the workspace. Another user\'s private memories are never candidates.', {
        query: 'discount banner countdown timer',
        limit: 5,
        tokenBudget: 1500,
        minScore: 0.1,
        filter: { kinds: ['semantic', 'procedural'] },
      }),
  },
  {
    file: 'search-by-tag.json',
    schema: 'SearchResponse',
    run: () => searchOf('The same search narrowed to the memories learned from a rejection.', { query: 'discount banner countdown timer', filter: { tags: ['approval.rejected'] } }),
  },
  {
    file: 'memory-get.json',
    schema: 'MemoryDetail',
    run: () => read('One of the user\'s memories with its links. A link to a memory the user may not read is left out.', `/v1/memories/${MEMORY}`),
  },
  {
    file: 'profiles.json',
    each: 'Profile',
    run: () => read('The scoring profiles of the workspace, without their configuration.', '/v1/profiles'),
  },
  {
    file: 'error-act-as-required.json',
    schema: 'Error',
    run: () => read('The X-Act-As assertion is required.', `/v1/memories/${MEMORY}`, { assertion: null }, { Authorization: 'Bearer <service token>' }),
  },
  {
    file: 'error-scope-required.json',
    schema: 'Error',
    run: () => read('actorId and workspaceId are required (in the body for the search, in the query for the reads).', `/v1/memories/${MEMORY}`, { scope: { workspaceId: null } }),
  },
  {
    file: 'error-scope-mismatch.json',
    schema: 'Error',
    run: () => searchOf('actorId and workspaceId must equal the assertion\'s.', { query: 'discount banner' }, { scope: { actorId: OTHER_USER } }),
  },
  {
    file: 'error-assertion-invalid.json',
    schema: 'Error',
    run: () => read('The assertion is not valid (here: it lists another audience).', '/v1/profiles', { assertion: { aud: ['proba-context', 'proba-audit'] } }),
  },
  {
    file: 'error-route-not-allowed.json',
    schema: 'Error',
    run: () => read('Listing, retrieval logs, job runs and the session route are not available to this role.', '/v1/memories'),
  },
  {
    file: 'error-memory-of-another-user.json',
    schema: 'Error',
    run: () => read('A memory of another user is answered as if it did not exist.', `/v1/memories/${MEMORY_OTHER}`),
  },
];

const EXPECTED_STATUS: Record<string, number> = {
  'error-act-as-required.json': 400,
  'error-scope-required.json': 400,
  'error-scope-mismatch.json': 403,
  'error-assertion-invalid.json': 403,
  'error-route-not-allowed.json': 403,
  'error-memory-of-another-user.json': 404,
};

const claims = {
  'service-token.claims.json': {
    description: 'Claims of the bridge\'s service token (EdDSA; header carries the kid of a key in CONTEXT_SERVICE_PUBLIC_KEY_FILE). exp is at most 120 seconds after iat.',
    header: { alg: 'EdDSA', typ: 'JWT', kid: 'bridge-key-1' },
    claims: { iss: 'proba-context', aud: 'proba-memory', sub: 'context-reader', iat: 1761386400, exp: 1761386460, jti: 'f3a9c1d0-5b7e-4a52-9d59-2d1f6a0b8c11' },
  },
  'act-as-assertion.claims.json': {
    description: 'Claims of the Hub\'s act-as assertion sent as X-Act-As (EdDSA; header carries the kid of a key in HUB_ASSERTION_PUBLIC_KEY_FILE). sub and workspaceId must equal actorId and workspaceId of the request. exp is at most 300 seconds after iat.',
    header: { alg: 'EdDSA', typ: 'JWT', kid: 'hub-key-1' },
    claims: {
      iss: 'proba-hub',
      aud: ['proba-context', 'proba-memory'],
      sub: USER,
      workspaceId: WORKSPACE,
      goalId: GOAL,
      threadId: THREAD,
      scopes: ['context:build'],
      iat: 1761386400,
      exp: 1761386520,
      jti: '0d6b3c2e-7a41-4f6b-8a35-61c9e4d2b7a0',
    },
  },
} as const;

const readFixture = (file: string): unknown => JSON.parse(readFileSync(`${DIR}${file}`, 'utf8'));
const write = (file: string, value: unknown): void => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}${file}`, `${JSON.stringify(value, null, 2)}\n`);
};

describe('docs/contracts/context-reader', () => {
  for (const c of cases) {
    it(`${c.file} is what the server answers`, async () => {
      const recorded = await c.run();
      expect(recorded.response.status).toBe(EXPECTED_STATUS[c.file] ?? 200);
      if (c.schema) {
        const validate = validator(c.schema);
        expect(validate(recorded.response.body), JSON.stringify(validate.errors)).toBe(true);
      }
      if (c.each) {
        const validate = validator(c.each);
        const list = (recorded.response.body as any).profiles as unknown[];
        expect(list.length).toBeGreaterThan(0);
        for (const item of list) expect(validate(item), JSON.stringify(validate.errors)).toBe(true);
      }
      const shown = JSON.stringify(recorded.response.body);
      expect(shown).not.toContain(OTHER_MARKER);
      expect(shown).not.toContain(MEMORY_OTHER);
      expect(shown).not.toContain(OTHER_USER);
      expect(shown).not.toContain('"weights"');
      if (UPDATE) write(c.file, recorded);
      else expect(readFixture(c.file)).toEqual(recorded);
    });
  }

  for (const [file, example] of Object.entries(claims)) {
    it(`${file} is what the role accepts`, () => {
      if (file.startsWith('act-as')) expect(actAsAssertionClaimsSchema.safeParse(example.claims).success).toBe(true);
      else {
        const { iat, exp } = example.claims as { iat: number; exp: number };
        expect(exp - iat).toBeLessThanOrEqual(120);
      }
      if (UPDATE) write(file, example);
      else expect(readFixture(file)).toEqual(example);
    });
  }

  it('has no file this test does not own', () => {
    if (UPDATE) return;
    const owned = new Set([...cases.map((c) => c.file), ...Object.keys(claims)]);
    expect(readdirSync(DIR).filter((f) => f.endsWith('.json') && !owned.has(f))).toEqual([]);
  });
});
