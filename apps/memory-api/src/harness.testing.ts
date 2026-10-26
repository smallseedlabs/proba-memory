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
  InMemoryMemoryStore,
  InMemoryRateLimiter,
  InMemoryRetrievalLogStore,
  InMemoryScoringProfileStore,
  InMemoryVectorIndex,
  ManualClock,
  SequentialIdGenerator,
  StaticTokenVerifier,
} from '@smallseedlabs/proba-memory-adapters';
import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
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
  /** Insert memories (with vectors from the embedder) into a workspace and index them. */
  seed(workspaceId: string, items: Partial<MemoryInsert>[]): Promise<Memory[]>;
  get(path: string, token?: string | null, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: OutgoingHttpHeaders }>;
  post(path: string, body: unknown, token?: string | null, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: OutgoingHttpHeaders }>;
  /** Everything the API published on the audit topic since the last call. */
  emitted(): Promise<AuditEvent[]>;
  close(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const config = testConfig(options.env);
  const clock = new ManualClock(NOW);
  const ids = new SequentialIdGenerator();
  const logger = new MemoryLogger();
  const memoryStore = options.store ?? new InMemoryMemoryStore();
  const index = options.index ?? new InMemoryVectorIndex(memoryStore as InMemoryMemoryStore, DIMENSION);
  const embedder = new HashEmbedder({ dimension: DIMENSION, nodeEnv: 'test', allowLocal: false });
  const profiles = new InMemoryScoringProfileStore(clock);
  await profiles.ensureDefault();
  const bus = new InMemoryEventBus(clock);
  const limiter = options.limiter ?? new InMemoryRateLimiter(clock);
  const emitterDeps = { bus, topic: TOPIC, service: 'memory-api', defaultWorkspaceId: WORKSPACE, clock, ids, logger };
  const strict = createBusAuditEmitter({ ...emitterDeps, failureMode: 'throw' });
  const retrieval = new RetrievalService({
    store: memoryStore,
    index,
    embedder,
    profiles,
    logStore: new InMemoryRetrievalLogStore(),
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
    limiter,
    store: memoryStore,
    profiles,
    retrieval,
    bestEffortEmitter: createBusAuditEmitter({ ...emitterDeps, failureMode: 'swallow' }),
    readiness: options.readiness ?? [{ name: 'memoryStore', check: () => memoryStore.ping() }],
  });

  const parse = (res: { json(): unknown; body: string }): unknown => {
    try {
      return res.json();
    } catch {
      return res.body;
    }
  };
  const authHeader = (token: string | null | undefined): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

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
