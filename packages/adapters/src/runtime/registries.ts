import type pg from 'pg';
import {
  AdapterRegistry,
  type AppConfig,
  type Clock,
  type Embedder,
  type EventBus,
  type HubContentSource,
  type IdGenerator,
  type JobRunStore,
  type JobScheduler,
  type LlmProvider,
  type Logger,
  type MemoryStore,
  type OutboxStore,
  type OutcomeLinker,
  type RateLimiter,
  type RetrievalLogStore,
  type ScoringProfileStore,
  type SourceAdapter,
  type TokenCounter,
  type TokenVerifier,
  type VectorIndex,
} from '@smallseedlabs/proba-memory-core';
import { FirebaseTokenVerifier } from '../auth/firebase-token-verifier.js';
import { StaticTokenVerifier } from '../auth/static-token-verifier.js';
import { HashEmbedder } from '../embedders/hash-embedder.js';
import { OpenAiCompatibleEmbedder } from '../embedders/openai-compatible-embedder.js';
import { DeepSeekLlmProvider, OpenAiCompatibleLlmProvider } from '../llm/openai-compatible-llm.js';
import { ScriptedLlmProvider } from '../llm/scripted-llm.js';
import { InMemoryEventBus } from '../memory/event-bus.js';
import { InMemoryJobRunStore } from '../memory/job-run-store.js';
import { InMemoryMemoryStore, InMemoryVectorIndex } from '../memory/memory-store.js';
import { InMemoryOutboxStore } from '../memory/outbox-store.js';
import { InMemoryOutcomeLinker, NoopOutcomeLinker } from '../memory/outcome-linker.js';
import { InMemoryScoringProfileStore } from '../memory/profile-store.js';
import { InMemoryRetrievalLogStore } from '../memory/retrieval-log-store.js';
import { ApproxTokenCounter } from '../memory/token-counter.js';
import { PostgresJobRunStore } from '../postgres/job-run-store.js';
import { PostgresMemoryStore } from '../postgres/memory-store.js';
import { PostgresOutboxStore } from '../postgres/outbox-store.js';
import { PostgresScoringProfileStore } from '../postgres/profile-store.js';
import { PostgresRetrievalLogStore } from '../postgres/retrieval-log-store.js';
import { PostgresVectorIndex } from '../postgres/vector-index.js';
import { InMemoryRateLimiter } from '../ratelimit/memory-rate-limiter.js';
import { RedisRateLimiter } from '../ratelimit/redis-rate-limiter.js';
import { RedisStreamsEventBus } from '../redis/redis-streams-event-bus.js';
import { IntervalJobScheduler, ManualJobScheduler } from '../scheduler/interval-scheduler.js';
import { AuditEventSource } from '../sources/audit-event-source.js';
import { ContentFeedSource } from '../sources/content-feed-source.js';
import { DevHubContentSource } from '../sources/dev-content-source.js';
import { RandomIdGenerator, SystemClock } from './system.js';

/** What every adapter factory receives. */
export interface AdapterDeps {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
  /** The service's shared Postgres pool (created on first use, closed by the runtime). */
  pool: () => pg.Pool;
  /** The MemoryStore, once created (the in-memory VectorIndex reads its vectors). */
  memoryStore?: MemoryStore;
  /** The EventBus, once created (the audit source consumes from it). */
  bus?: EventBus;
  /** Consumer name of this process, for bus subscriptions. */
  consumerName?: string;
}

export interface Registries {
  memoryStore: AdapterRegistry<MemoryStore, AdapterDeps>;
  vectorIndex: AdapterRegistry<VectorIndex, AdapterDeps>;
  scoringProfileStore: AdapterRegistry<ScoringProfileStore, AdapterDeps>;
  retrievalLogStore: AdapterRegistry<RetrievalLogStore, AdapterDeps>;
  jobRunStore: AdapterRegistry<JobRunStore, AdapterDeps>;
  outboxStore: AdapterRegistry<OutboxStore, AdapterDeps>;
  eventBus: AdapterRegistry<EventBus, AdapterDeps>;
  embedder: AdapterRegistry<Embedder, AdapterDeps>;
  llmProvider: AdapterRegistry<LlmProvider, AdapterDeps>;
  tokenCounter: AdapterRegistry<TokenCounter, AdapterDeps>;
  jobScheduler: AdapterRegistry<JobScheduler, AdapterDeps>;
  outcomeLinker: AdapterRegistry<OutcomeLinker, AdapterDeps>;
  /** The Hub's text feed (HUB_CONTENT_SOURCE). */
  hubContentSource: AdapterRegistry<HubContentSource, AdapterDeps>;
  /** The entries of SOURCES: `audit` and `content`. */
  sourceAdapter: AdapterRegistry<SourceAdapter, AdapterDeps>;
  /** Who is calling the read API: MEMORY_API_TOKEN_VERIFIER. */
  tokenVerifier: AdapterRegistry<TokenVerifier, AdapterDeps>;
  /** How the read API counts requests: MEMORY_API_RATE_LIMITER. */
  rateLimiter: AdapterRegistry<RateLimiter, AdapterDeps>;
}

/**
 * The built-in adapters. To add a backend (Qdrant, Kafka, another LLM, ...): write the adapter,
 * `register('name', factory)` on the matching registry, and set the config value. Nothing else changes.
 */
export function createDefaultRegistries(): Registries {
  const memoryStore = new AdapterRegistry<MemoryStore, AdapterDeps>('MemoryStore')
    .register('postgres', ({ pool }) => new PostgresMemoryStore({ pool: pool() }))
    .register('memory', () => new InMemoryMemoryStore());

  const vectorIndex = new AdapterRegistry<VectorIndex, AdapterDeps>('VectorIndex')
    .register('postgres', ({ pool, config }) => new PostgresVectorIndex({ pool: pool(), dimension: config.postgres.embeddingDimension }))
    .register('memory', ({ memoryStore: store, config }) => {
      if (!(store instanceof InMemoryMemoryStore)) throw new Error('VECTOR_INDEX=memory needs MEMORY_STORE=memory (it reads the vectors held by the in-memory store)');
      return new InMemoryVectorIndex(store, config.postgres.embeddingDimension);
    });

  const scoringProfileStore = new AdapterRegistry<ScoringProfileStore, AdapterDeps>('ScoringProfileStore')
    .register('postgres', ({ pool }) => new PostgresScoringProfileStore(pool()))
    .register('memory', ({ clock }) => new InMemoryScoringProfileStore(clock));

  const retrievalLogStore = new AdapterRegistry<RetrievalLogStore, AdapterDeps>('RetrievalLogStore')
    .register('postgres', ({ pool }) => new PostgresRetrievalLogStore(pool()))
    .register('memory', () => new InMemoryRetrievalLogStore());

  const jobRunStore = new AdapterRegistry<JobRunStore, AdapterDeps>('JobRunStore')
    .register('postgres', ({ pool }) => new PostgresJobRunStore(pool()))
    .register('memory', () => new InMemoryJobRunStore());

  const outboxStore = new AdapterRegistry<OutboxStore, AdapterDeps>('OutboxStore')
    .register('postgres', ({ pool }) => new PostgresOutboxStore({ pool: pool() }) as OutboxStore)
    .register('memory', ({ clock }) => new InMemoryOutboxStore(clock));

  const eventBus = new AdapterRegistry<EventBus, AdapterDeps>('EventBus')
    .register('redis-streams', ({ config, clock, logger }) =>
      new RedisStreamsEventBus({ url: config.eventBus.redisUrl, maxStreamLength: config.eventBus.maxStreamLength, clock, logger })
    )
    .register('memory', ({ clock }) => new InMemoryEventBus(clock));

  const embedder = new AdapterRegistry<Embedder, AdapterDeps>('Embedder')
    .register('openai-compatible', ({ config, logger }) => {
      const e = config.embedder;
      if (!e.baseUrl) throw new Error('EMBEDDER_BASE_URL is required for EMBEDDER=openai-compatible');
      if (!e.model) throw new Error('EMBEDDER_MODEL is required for EMBEDDER=openai-compatible');
      return new OpenAiCompatibleEmbedder({
        baseUrl: e.baseUrl,
        model: e.model,
        version: e.version,
        dimension: config.postgres.embeddingDimension,
        apiKey: e.apiKey || undefined,
        timeoutMs: e.timeoutMs,
        batchSize: e.batchSize,
        maxRetries: e.maxRetries,
        sendDimensions: e.sendDimensions,
        logger,
      });
    })
    .register('hash', ({ config }) => new HashEmbedder({ dimension: config.postgres.embeddingDimension, nodeEnv: config.env, allowLocal: config.embedder.allowLocal }));

  const llmProvider = new AdapterRegistry<LlmProvider, AdapterDeps>('LlmProvider')
    .register('deepseek', ({ config, logger }) => new DeepSeekLlmProvider(llmOptions(config, logger)))
    .register('openai-compatible', ({ config, logger }) => new OpenAiCompatibleLlmProvider(llmOptions(config, logger)))
    .register('scripted', ({ config }) => new ScriptedLlmProvider({ nodeEnv: config.env, allowScripted: config.llm.allowScripted }));

  const tokenCounter = new AdapterRegistry<TokenCounter, AdapterDeps>('TokenCounter').register('approx', () => new ApproxTokenCounter());

  const jobScheduler = new AdapterRegistry<JobScheduler, AdapterDeps>('JobScheduler')
    .register('interval', ({ logger }) => new IntervalJobScheduler(logger))
    .register('manual', ({ logger }) => new ManualJobScheduler(logger));

  const outcomeLinker = new AdapterRegistry<OutcomeLinker, AdapterDeps>('OutcomeLinker')
    .register('noop', ({ logger }) => new NoopOutcomeLinker(logger))
    .register('memory', () => new InMemoryOutcomeLinker());

  // The Hub does not expose message text yet (docs/ARCHITECTURE.md, "Hub content feed"). Until it does, only the development source exists.
  const hubContentSource = new AdapterRegistry<HubContentSource, AdapterDeps>('HubContentSource').register(
    'dev',
    ({ config }) =>
      new DevHubContentSource({
        workspaceId: config.write.devContent.workspaceId,
        seed: config.write.devContent.seed,
        nodeEnv: config.env,
        allowDev: config.write.devContent.allowed,
      })
  );

  const sourceAdapter = new AdapterRegistry<SourceAdapter, AdapterDeps>('SourceAdapter')
    .register('audit', ({ config, logger, bus, consumerName }) => {
      if (!bus) throw new Error('the audit source needs an event bus');
      return new AuditEventSource({
        bus,
        topic: config.eventBus.auditTopic,
        group: config.eventBus.consumerGroup,
        consumer: consumerName ?? config.eventBus.consumerName,
        maxDeliveries: config.eventBus.maxDeliveries,
        claimIdleMs: config.eventBus.claimIdleMs,
        logger: logger.child({ source: 'audit' }),
      });
    })
    .register('content', async (deps) => {
      const source = await hubContentSource.create(deps.config.adapters.hubContentSource, deps);
      return new ContentFeedSource({ source, logger: deps.logger.child({ source: 'content' }), claimIdleMs: deps.config.eventBus.claimIdleMs, maxDeliveries: deps.config.eventBus.maxDeliveries });
    });

  const tokenVerifier = new AdapterRegistry<TokenVerifier, AdapterDeps>('TokenVerifier')
    .register('firebase', ({ config }) => new FirebaseTokenVerifier({ projectId: config.api.firebaseProjectId }))
    .register('static', ({ config }) => new StaticTokenVerifier({ tokens: config.api.staticTokens, nodeEnv: config.env }));

  const rateLimiter = new AdapterRegistry<RateLimiter, AdapterDeps>('RateLimiter')
    .register('memory', ({ clock }) => new InMemoryRateLimiter(clock))
    .register('redis', ({ config, logger }) => new RedisRateLimiter({ url: config.eventBus.redisUrl, keyPrefix: 'proba:memory-api:rl', logger }));

  return {
    memoryStore,
    vectorIndex,
    scoringProfileStore,
    retrievalLogStore,
    jobRunStore,
    outboxStore,
    eventBus,
    embedder,
    llmProvider,
    tokenCounter,
    jobScheduler,
    outcomeLinker,
    hubContentSource,
    sourceAdapter,
    tokenVerifier,
    rateLimiter,
  };
}

function llmOptions(config: AppConfig, logger: Logger) {
  const l = config.llm;
  if (!l.baseUrl) throw new Error('LLM_BASE_URL is required for this LLM provider');
  return {
    baseUrl: l.baseUrl,
    model: l.model,
    apiKey: l.apiKey,
    timeoutMs: l.timeoutMs,
    maxRetries: l.maxRetries,
    defaultTemperature: l.temperature,
    extraBody: l.extraBody,
    logger,
  };
}

export const systemDeps = (): { clock: Clock; ids: IdGenerator } => ({ clock: new SystemClock(), ids: new RandomIdGenerator() });
