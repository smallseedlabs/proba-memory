import type pg from 'pg';
import {
  createBusAuditEmitter,
  createOutboxAuditEmitter,
  OutboxRelay,
  type AppConfig,
  type AuditEmitter,
  type Clock,
  type Embedder,
  type EmbeddingMigrationStore,
  type JobConfigStore,
  type EventBus,
  type IdGenerator,
  type JobRunStore,
  type JobScheduler,
  type LlmProvider,
  type Logger,
  type MemoryStore,
  type OutboxStore,
  type OutcomeLinker,
  type RetrievalLogStore,
  type ScoringProfileStore,
  type TokenCounter,
  type VectorIndex,
} from '@smallseedlabs/proba-memory-core';
import { createPgPool } from '../postgres/pool.js';
import { createDefaultRegistries, type AdapterDeps, type Registries } from './registries.js';
import { RandomIdGenerator, SystemClock } from './system.js';

/** Which optional ports an app needs. Ports an app does not need are never created (no keys, no connections). */
export interface RuntimeNeeds {
  /** Embedder (write path, retrieval). */
  embedder?: boolean;
  /** LlmProvider (extraction; retrieval rerank when RERANK_ENABLED). */
  llm?: boolean;
  /** Scoring profiles, retrieval log, token counter. */
  retrieval?: boolean;
  /** Job run store, job config store, embedding migration store, scheduler, outcome linker. */
  jobs?: boolean;
}

export interface CreateRuntimeOptions {
  /** Service name stamped on audit events, for example memory-api. */
  service: string;
  logger: Logger;
  needs?: RuntimeNeeds;
  clock?: Clock;
  ids?: IdGenerator;
  /** Replace the built-in registries (to add adapters). */
  registries?: Registries;
}

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
  service: string;
  store: MemoryStore;
  index: VectorIndex;
  outbox: OutboxStore;
  bus: EventBus;
  /** Audit events of this service (outbox or bus, AUDIT_TRANSPORT). A failure to record rejects the call. */
  emitter: AuditEmitter;
  /** Same destination, but a failure is logged and swallowed (job lifecycle events). */
  lifecycleEmitter: AuditEmitter;
  /** Needs `embedder`. */
  embedder: Embedder;
  /** Needs `llm`. */
  llm: LlmProvider;
  /** Needs `retrieval`. */
  profiles: ScoringProfileStore;
  logStore: RetrievalLogStore;
  tokens: TokenCounter;
  /** Needs `jobs`. */
  jobRuns: JobRunStore;
  jobConfigs: JobConfigStore;
  embeddingMigration: EmbeddingMigrationStore;
  scheduler: JobScheduler;
  outcomes: OutcomeLinker;
  registries: Registries;
  deps: AdapterDeps;
  /** The relay that publishes the outbox to the bus, or null when AUDIT_TRANSPORT=bus or the relay is disabled. */
  createRelay(): OutboxRelay | null;
  close(): Promise<void>;
}

const notCreated = (name: string, need: string) => (): never => {
  throw new Error(`${name} is not available in this process (it was not requested: needs.${need})`);
};

/** Build every port this app needs from config. */
export async function createRuntime(config: AppConfig, options: CreateRuntimeOptions): Promise<Runtime> {
  const registries = options.registries ?? createDefaultRegistries();
  const needs = options.needs ?? {};
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new RandomIdGenerator();
  const { logger } = options;

  let pool: pg.Pool | null = null;
  const getPool = (): pg.Pool => (pool ??= createPgPool(config.postgres.url, config.postgres.poolMax));
  const deps: AdapterDeps = { config, logger, clock, ids, pool: getPool };

  const closers: (() => Promise<void>)[] = [];
  const track = <T extends { close(): Promise<void> }>(port: T): T => {
    closers.push(() => port.close());
    return port;
  };

  const a = config.adapters;
  const store = track(await registries.memoryStore.create(a.memoryStore, deps));
  deps.memoryStore = store;
  const index = track(await registries.vectorIndex.create(a.vectorIndex, deps));
  const outbox = track(await registries.outboxStore.create(a.outboxStore, deps));
  const bus = track(await registries.eventBus.create(a.eventBus, deps));
  deps.bus = bus;

  const embedder = needs.embedder ? track(await registries.embedder.create(a.embedder, deps)) : undefined;
  if (embedder && embedder.dimension !== config.postgres.embeddingDimension) {
    throw new Error(`The embedder produces ${embedder.dimension}-dimension vectors but EMBEDDING_DIMENSION=${config.postgres.embeddingDimension}`);
  }
  const llm = needs.llm ? track(await registries.llmProvider.create(a.llmProvider, deps)) : undefined;
  const profiles = needs.retrieval ? track(await registries.scoringProfileStore.create(a.scoringProfileStore, deps)) : undefined;
  const logStore = needs.retrieval ? track(await registries.retrievalLogStore.create(a.retrievalLogStore, deps)) : undefined;
  const tokens = needs.retrieval ? await registries.tokenCounter.create(a.tokenCounter, deps) : undefined;
  const jobRuns = needs.jobs ? track(await registries.jobRunStore.create(a.jobRunStore, deps)) : undefined;
  const jobConfigs = needs.jobs ? track(await registries.jobConfigStore.create(a.jobConfigStore, deps)) : undefined;
  const embeddingMigration = needs.jobs ? track(await registries.embeddingMigrationStore.create(a.embeddingMigrationStore, deps)) : undefined;
  const scheduler = needs.jobs ? await registries.jobScheduler.create(a.jobScheduler, deps) : undefined;
  const outcomes = needs.jobs ? await registries.outcomeLinker.create(a.outcomeLinker, deps) : undefined;

  const emitterDeps = { service: options.service, defaultWorkspaceId: config.audit.workspaceId, clock, ids, logger };
  const makeEmitter = (failureMode: 'throw' | 'swallow'): AuditEmitter =>
    config.audit.transport === 'outbox'
      ? createOutboxAuditEmitter({ ...emitterDeps, failureMode, outbox })
      : createBusAuditEmitter({ ...emitterDeps, failureMode, bus, topic: config.eventBus.auditTopic });

  logger.info('adapters created', {
    lifecycle: 'adapters_created',
    memoryStore: a.memoryStore,
    vectorIndex: a.vectorIndex,
    eventBus: a.eventBus,
    auditTransport: config.audit.transport,
    ...(embedder ? { embedder: `${embedder.name}/${embedder.model}`, embeddingDimension: embedder.dimension } : {}),
    ...(llm ? { llm: `${llm.name}/${llm.model}` } : {}),
  });

  return {
    config,
    logger,
    clock,
    ids,
    service: options.service,
    store,
    index,
    outbox,
    bus,
    emitter: makeEmitter('throw'),
    lifecycleEmitter: makeEmitter('swallow'),
    get embedder() {
      return embedder ?? notCreated('embedder', 'embedder')();
    },
    get llm() {
      return llm ?? notCreated('llm provider', 'llm')();
    },
    get profiles() {
      return profiles ?? notCreated('scoring profile store', 'retrieval')();
    },
    get logStore() {
      return logStore ?? notCreated('retrieval log store', 'retrieval')();
    },
    get tokens() {
      return tokens ?? notCreated('token counter', 'retrieval')();
    },
    get jobRuns() {
      return jobRuns ?? notCreated('job run store', 'jobs')();
    },
    get jobConfigs() {
      return jobConfigs ?? notCreated('job config store', 'jobs')();
    },
    get embeddingMigration() {
      return embeddingMigration ?? notCreated('embedding migration store', 'jobs')();
    },
    get scheduler() {
      return scheduler ?? notCreated('job scheduler', 'jobs')();
    },
    get outcomes() {
      return outcomes ?? notCreated('outcome linker', 'jobs')();
    },
    registries,
    deps,
    createRelay() {
      if (config.audit.transport !== 'outbox' || !config.audit.relay.enabled) return null;
      return new OutboxRelay({
        outbox,
        bus,
        topic: config.eventBus.auditTopic,
        logger: logger.child({ component: 'outbox-relay' }),
        batchSize: config.audit.relay.batchSize,
        pollIntervalMs: config.audit.relay.pollIntervalMs,
        leaseMs: config.audit.relay.leaseMs,
        clock,
      });
    },
    async close() {
      await Promise.allSettled(closers.map((c) => c()));
      if (pool) await pool.end().catch(() => undefined);
    },
  };
}
