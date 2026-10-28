/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
/**
 * Test harness: the real memory-api server on in-memory adapters (store, vector index, profiles, log,
 * bus, rate limiter), the local hash embedder and the static token verifier, plus helpers to seed
 * memories and to read the audit events the API emitted.
 */
import {
  MemoryLogger,
  RetrievalService,
  Redactor,
  createBusAuditEmitter,
  loadConfig,
  type AppConfig,
  type AuditEmitter,
  type AuditEvent,
  type Memory,
  type MemoryInsert,
  type MemoryStore,
  type RateLimiter,
  type Subscription,
  type VectorIndex,
} from '@smallseedlabs/proba-memory-core';
import { makeMemoryInsert } from '@smallseedlabs/proba-memory-core/testing';
import {
  ApproxTokenCounter,
  HashEmbedder,
  InMemoryEventBus,
  InMemoryJobRunStore,
  InMemoryMemoryStore,
  InMemoryRateLimiter,
  InMemoryRetrievalLogStore,
  InMemoryScoringProfileStore,
  InMemoryVectorIndex,
  ManualClock,
  SequentialIdGenerator,
  StaticTokenVerifier,
  createContextBridgeAuth,
  createContextBridgeSigners,
  type AssertionOptions,
  type ContextBridgeSigners,
  type ServiceTokenOptions,
} from '@smallseedlabs/proba-memory-adapters';
import { randomUUID } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { JobRunStore, RetrievalLogStore, ScoringProfileStore } from '@smallseedlabs/proba-memory-core';
import { buildServer, type ReadinessCheck } from './server.js';

export const TOPIC = 'proba.audit.events';
export const WORKSPACE = 'seedbed';
export const FOREIGN_WORKSPACE = 'other-workspace';
export const DIMENSION = 64;
export const NOW = '2026-10-26T12:00:00.000Z';

export const TOKENS = {
  viewer: 'viewer-token-0001',
  admin: 'admin-token-0002',
  domain: 'domain-token-0003',
  outsider: 'outsider-token-0004',
  unverified: 'unverified-token-0005',
} as const;

const IDENTITIES = [
  { token: TOKENS.viewer, subject: 'uid-viewer', email: 'Viewer@insights.example' },
  { token: TOKENS.admin, subject: 'uid-admin', email: 'admin@insights.example' },
  { token: TOKENS.domain, subject: 'uid-domain', email: 'someone@partner.example' },
  { token: TOKENS.outsider, subject: 'uid-outsider', email: 'stranger@elsewhere.example' },
  { token: TOKENS.unverified, subject: 'uid-unverified', email: 'viewer@insights.example', emailVerified: false },
];

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      EMBEDDING_DIMENSION: String(DIMENSION),
      MEMORY_API_TOKEN_VERIFIER: 'static',
      MEMORY_API_STATIC_TOKENS: JSON.stringify(IDENTITIES),
      MEMORY_API_ALLOWED_EMAILS: 'viewer@insights.example',
      MEMORY_API_ALLOWED_EMAIL_DOMAINS: 'partner.example',
      MEMORY_API_ADMIN_EMAILS: 'admin@insights.example',
      MEMORY_API_CORS_ORIGINS: 'http://localhost:5173',
      MEMORY_API_WORKSPACE_ID: WORKSPACE,
      ...overrides,
    },
    { serviceName: 'memory-api' }
  );
}

export interface HarnessOptions {
  env?: Record<string, string>;
  /** Turn the `context-reader` role on, with its two key files written to a temporary directory. */
  contextReader?: boolean;
  limiter?: RateLimiter;
  readiness?: ReadinessCheck[];
  /** Replace the store and index (to run the same server on Postgres). */
  store?: MemoryStore;
  index?: VectorIndex;
  /** Replace the emitter used for reads (to make auditing fail). */
  emitter?: (base: AuditEmitter) => AuditEmitter;
}

export interface Harness {
  app: FastifyInstance;
  config: AppConfig;
  store: MemoryStore;
  index: VectorIndex;
  embedder: HashEmbedder;
  bus: InMemoryEventBus;
  logger: MemoryLogger;
  clock: ManualClock;
  logStore: RetrievalLogStore;
  jobRuns: JobRunStore;
  profiles: ScoringProfileStore;
  /** Insert memories (with vectors from the embedder) into a workspace and index them. */
  seed(workspaceId: string, items: Partial<MemoryInsert>[]): Promise<Memory[]>;
  get(path: string, token?: string | null, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: OutgoingHttpHeaders }>;
  post(path: string, body: unknown, token?: string | null, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: OutgoingHttpHeaders }>;
  /** The signers of the bridge's service token and the Hub's assertion (present when `contextReader` is on). */
  signers: ContextBridgeSigners;
  /**
   * A call as the `context-reader` role: a valid service token and a valid assertion for `actorId` in `workspaceId` unless
   * overridden. A GET carries `actorId` and `workspaceId` in the query; a call with a `body` is a POST (the search) and carries
   * them in the body. `scope: false` sends none, and `scope` values override or (with `null`) drop one of them.
   */
  asContextReader(
    path: string,
    options?: {
      actorId?: string;
      workspaceId?: string;
      assertion?: AssertionOptions | string | null;
      service?: ServiceTokenOptions | string | null;
      /** The request body of a search; its presence makes the call a POST. */
      body?: Record<string, unknown>;
      /** The actorId / workspaceId sent: default the acting user's. `false` sends none. */
      scope?: { actorId?: string | null; workspaceId?: string | null } | false;
    }
  ): Promise<{ status: number; body: any; headers: OutgoingHttpHeaders }>;
  /** Everything the API published on the audit topic since the last call. */
  emitted(): Promise<AuditEvent[]>;
  close(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new ManualClock(NOW);
  const signers = await createContextBridgeSigners(() => clock.now());
  const keyEnv: Record<string, string> = options.contextReader
    ? {
        MEMORY_API_CONTEXT_READER_ENABLED: 'true',
        CONTEXT_SERVICE_PUBLIC_KEY_FILE: await signers.service.writeJwks(),
        HUB_ASSERTION_PUBLIC_KEY_FILE: await signers.hub.writeJwks(),
      }
    : {};
  const config = testConfig({ ...keyEnv, ...options.env });
  const contextBridge = await createContextBridgeAuth(config, { now: () => clock.now() });
  const ids = new SequentialIdGenerator();
  const logger = new MemoryLogger();
  const memoryStore = options.store ?? new InMemoryMemoryStore();
  const index = options.index ?? new InMemoryVectorIndex(memoryStore as InMemoryMemoryStore, config.postgres.embeddingDimension);
  const embedder = new HashEmbedder({ dimension: config.postgres.embeddingDimension, nodeEnv: 'test', allowLocal: false });
  const profiles = new InMemoryScoringProfileStore(clock);
  await profiles.ensureDefault();
  const logStore = new InMemoryRetrievalLogStore();
  const jobRuns = new InMemoryJobRunStore();
  const bus = new InMemoryEventBus(clock);
  const limiter = options.limiter ?? new InMemoryRateLimiter(clock);
  const emitterDeps = { bus, topic: TOPIC, service: 'memory-api', defaultWorkspaceId: WORKSPACE, clock, ids, logger };
  const strict = createBusAuditEmitter({ ...emitterDeps, failureMode: 'throw' });
  const retrieval = new RetrievalService({
    store: memoryStore,
    index,
    embedder,
    profiles,
    logStore,
    tokens: new ApproxTokenCounter(),
    emitter: options.emitter ? options.emitter(strict) : strict,
    clock,
    ids,
    logger,
    redactor: new Redactor({ pii: config.write.redactPii }),
    settings: config.retrieval,
    service: 'memory-api',
  });
  const app = await buildServer({
    config,
    logger,
    clock,
    verifier: new StaticTokenVerifier({ tokens: config.api.staticTokens, nodeEnv: config.env }),
    ...(contextBridge ? { contextBridge } : {}),
    limiter,
    store: memoryStore,
    profiles,
    retrieval,
    logStore,
    jobRuns,
    bestEffortEmitter: createBusAuditEmitter({ ...emitterDeps, failureMode: 'swallow' }),
    readiness: options.readiness ?? [
      { name: 'memoryStore', check: () => memoryStore.ping() },
      { name: 'jobRuns', check: () => jobRuns.ping() },
    ],
  });

  const parse = (res: { json(): unknown; body: string }): unknown => {
    try {
      return res.json();
    } catch {
      return res.body;
    }
  };
  const authHeader = (token: string | null | undefined): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

  const send = async (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(payload !== undefined ? { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}),
    });
    return { status: res.statusCode, body: parse(res), headers: res.headers };
  };

  let reader: Subscription | undefined;
  return {
    app,
    config,
    store: memoryStore,
    index,
    embedder,
    bus,
    logger,
    clock,
    logStore,
    jobRuns,
    profiles,
    signers,
    async seed(workspaceId, items) {
      const out: Memory[] = [];
      for (const item of items) {
        const content = item.content ?? 'The workspace prefers short headlines under forty characters.';
        const [vector] = await embedder.embed([`${item.summary ?? ''} ${content}`]);
        const insert = makeMemoryInsert(workspaceId, {
          ...item,
          content,
          embedding: vector,
          embeddingModel: embedder.model,
          embeddingVersion: embedder.version,
          lastReinforcedAt: item.lastReinforcedAt ?? NOW,
          createdAt: item.createdAt ?? NOW,
          validFrom: item.validFrom ?? NOW,
        });
        await memoryStore.transaction((tx) => tx.insertMemory(insert));
        const stored = await memoryStore.getMemory(workspaceId, insert.id);
        out.push(stored!);
      }
      return out;
    },
    async get(path, token = TOKENS.viewer, headers = {}) {
      const res = await app.inject({ method: 'GET', url: path, headers: { ...authHeader(token), ...headers } });
      return { status: res.statusCode, body: parse(res), headers: res.headers };
    },
    async post(path, body, token = TOKENS.viewer, headers = {}) {
      const res = await app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/json', ...authHeader(token), ...headers },
        payload: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: res.statusCode, body: parse(res), headers: res.headers };
    },
    async asContextReader(path, o = {}) {
      const actorId = o.actorId ?? randomUUID();
      const workspaceId = o.workspaceId ?? WORKSPACE;
      const token = typeof o.service === 'string' ? o.service : o.service === null ? null : await signers.mintServiceToken(o.service);
      const assertion =
        typeof o.assertion === 'string' ? o.assertion : o.assertion === null ? null : await signers.mintAssertion({ sub: actorId, workspaceId, ...o.assertion });
      const scope: Record<string, string> = {};
      if (o.scope !== false) {
        const actor = o.scope?.actorId === undefined ? actorId : o.scope.actorId;
        const workspace = o.scope?.workspaceId === undefined ? workspaceId : o.scope.workspaceId;
        if (actor !== null) scope.actorId = actor;
        if (workspace !== null) scope.workspaceId = workspace;
      }
      const headers = { ...authHeader(token), ...(assertion ? { 'x-act-as': assertion } : {}) };
      if (o.body !== undefined) return send('POST', path, headers, { ...o.body, ...scope });
      const params = new URLSearchParams(scope).toString();
      return send('GET', params ? `${path}${path.includes('?') ? '&' : '?'}${params}` : path, headers);
    },
    async emitted() {
      reader ??= await bus.subscribe({ topic: TOPIC, group: 'test-reader', consumer: 'c1' });
      const messages = await reader.read<AuditEvent>({ max: 1000 });
      await reader.ack(messages.map((m) => m.id));
      return messages.map((m) => m.payload);
    },
    async close() {
      await app.close();
      await limiter.close();
    },
  };
}

/** The standard small workspace the tests search. */
export const SEED = [
  { content: 'The user rejected the discount banner with a countdown timer because it feels pushy.', category: 'semantic', importance: 0.9, confidence: 0.8, provenance: { extractor: null, observationIds: [], stance: 'negative', signals: ['approval.rejected'], createdBy: 'test' } },
  { content: 'Lifestyle imagery of the collection outdoors was approved for the autumn launch.', category: 'semantic', importance: 0.8, confidence: 0.75 },
  { content: 'Keep every headline under forty characters because placements truncate longer ones.', category: 'procedural', importance: 0.7, confidence: 0.7 },
  { content: 'Weekly spend reports go to the finance lead on Monday mornings as a short summary.', category: 'procedural', importance: 0.6, confidence: 0.7 },
  { content: 'A goal was set to grow newsletter sign-ups by twenty percent before the holidays.', category: 'episodic', importance: 0.5, confidence: 0.8 },
] satisfies Partial<MemoryInsert>[];
