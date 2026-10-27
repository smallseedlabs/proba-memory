/**
 * Environment configuration, validated with zod (fail fast with a readable message). Adapter names are
 * plain strings on purpose: they are checked against the adapter registry when the adapter is created,
 * so a new backend needs no change to this schema.
 */

import { hostname } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { DEFAULT_HALF_LIVES_DAYS, MEMORY_CATEGORIES, type MemoryCategory } from '@smallseedlabs/proba-memory-scoring';

const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;

const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);
const nonNegativeInt = (def: number) => z.coerce.number().int().nonnegative().default(def);
const nonEmpty = (def: string) => z.string().min(1).default(def);
const unit = (def: number) => z.coerce.number().min(0).max(1).default(def);
const bool = (def: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1).optional(),
  HOST: nonEmpty('0.0.0.0'),
  PORT: nonNegativeInt(3200),
  LOG_LEVEL: z.enum(logLevels).default('info'),

  // Adapter selection. Names are registry keys (see docs/ARCHITECTURE.md, "Swapping an adapter").
  MEMORY_STORE: nonEmpty('postgres'),
  VECTOR_INDEX: nonEmpty('postgres'),
  SCORING_PROFILE_STORE: nonEmpty('postgres'),
  RETRIEVAL_LOG_STORE: nonEmpty('postgres'),
  JOB_RUN_STORE: nonEmpty('postgres'),
  JOB_CONFIG_STORE: nonEmpty('postgres'),
  EMBEDDING_MIGRATION_STORE: nonEmpty('postgres'),
  OUTBOX_STORE: nonEmpty('postgres'),
  EVENT_BUS: nonEmpty('redis-streams'),
  EMBEDDER: nonEmpty('openai-compatible'),
  LLM_PROVIDER: nonEmpty('deepseek'),
  TOKEN_COUNTER: nonEmpty('approx'),
  JOB_SCHEDULER: nonEmpty('interval'),
  OUTCOME_LINKER: nonEmpty('noop'),

  // Postgres + pgvector
  DATABASE_URL: nonEmpty('postgresql://proba:proba@localhost:5432/proba_memory'),
  PG_POOL_MAX: positiveInt(10),
  PG_MIGRATIONS_DIR: nonEmpty('migrations/postgres'),
  // Vector length of the `memories.embedding` column. Changing it later needs a re-embed migration.
  EMBEDDING_DIMENSION: z.coerce.number().int().min(8).max(2000).default(1024),

  // Redis Streams
  REDIS_URL: nonEmpty('redis://localhost:6379'),
  AUDIT_TOPIC: nonEmpty('proba.audit.events'),
  MEMORY_AUDIT_CONSUMER_GROUP: nonEmpty('memory-ingestor'),
  CONSUMER_NAME: z.string().min(1).optional(),
  BUS_BATCH_SIZE: positiveInt(50),
  BUS_BLOCK_MS: nonNegativeInt(2000),
  BUS_CLAIM_IDLE_MS: nonNegativeInt(60000),
  BUS_MAX_DELIVERIES: positiveInt(5),
  BUS_MAX_STREAM_LENGTH: z.coerce.number().int().positive().optional(),

  // Audit emission: `outbox` writes events in the service's own transaction and a relay publishes them
  // (the proba-audit pattern); `bus` publishes straight to the stream.
  AUDIT_TRANSPORT: z.enum(['outbox', 'bus']).default('outbox'),
  OUTBOX_RELAY_ENABLED: bool('true'),
  OUTBOX_RELAY_POLL_MS: positiveInt(500),
  OUTBOX_RELAY_BATCH: positiveInt(100),
  OUTBOX_RELAY_LEASE_MS: positiveInt(30000),
  AUDIT_WORKSPACE_ID: nonEmpty('seedbed'),

  // Embedder (OpenAI-compatible HTTP). No vendor is assumed: set base URL and model.
  EMBEDDER_BASE_URL: z.string().default(''),
  EMBEDDER_MODEL: z.string().default(''),
  EMBEDDER_VERSION: nonEmpty('1'),
  EMBEDDER_API_KEY: z.string().default(''),
  EMBEDDER_TIMEOUT_MS: positiveInt(30000),
  EMBEDDER_BATCH_SIZE: positiveInt(32),
  EMBEDDER_MAX_RETRIES: nonNegativeInt(2),
  // Send `dimensions` in the request (supported by some APIs, rejected by others).
  EMBEDDER_SEND_DIMENSIONS: bool('false'),
  // The local hash embedder (label `local-hash`) refuses production unless this is true.
  ALLOW_LOCAL_EMBEDDER: bool('false'),

  // LLM provider (OpenAI-compatible chat completions; DeepSeek by default).
  LLM_BASE_URL: nonEmpty('https://api.deepseek.com'),
  LLM_MODEL: nonEmpty('deepseek-flash'),
  LLM_API_KEY: z.string().default(''),
  LLM_TIMEOUT_MS: positiveInt(60000),
  LLM_MAX_RETRIES: nonNegativeInt(2),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  // JSON object merged into every chat request body (provider-specific switches, for example thinking mode).
  LLM_EXTRA_BODY: z.string().default(''),
  // The scripted provider (deterministic rules) refuses production unless this is true.
  ALLOW_SCRIPTED_LLM: bool('false'),
  // Never honoured in production: in-memory adapters are refused there. Setting it to true when NODE_ENV=production is
  // itself an error (InMemoryAdaptersNotAllowedError), so a stale opt-in cannot go unnoticed.
  ALLOW_IN_MEMORY_ADAPTERS: bool('false'),

  // Write path
  SOURCES: z.string().default('audit'),
  HUB_CONTENT_SOURCE: nonEmpty('dev'),
  // The development content source refuses production unless this is true.
  ALLOW_DEV_CONTENT_SOURCE: bool('false'),
  DEV_CONTENT_SEED: nonEmpty('proba-dev'),
  DEV_CONTENT_WORKSPACE_ID: nonEmpty('seedbed'),
  DEV_CONTENT_PAGE_SIZE: positiveInt(20),
  CONTENT_POLL_MS: positiveInt(5000),
  RESOLVER_SIMILARITY_THRESHOLD: unit(0.9),
  RESOLVER_RELATED_THRESHOLD: unit(0.75),
  EXTRACTION_MAX_CANDIDATES: positiveInt(5),
  EXTRACTION_MAX_ATTEMPTS: positiveInt(3),
  MEMORY_MAX_CONTENT_CHARS: positiveInt(1000),
  REDACT_PII: bool('true'),
  INGEST_CONCURRENCY: positiveInt(4),
  INGEST_RECLAIM_INTERVAL_MS: positiveInt(30000),
  INGEST_RETRY_BASE_MS: positiveInt(500),
  INGEST_RETRY_MAX_MS: positiveInt(30000),
  // Floors for new memories by evidence kind (approvals and rejections are the strongest preference signal).
  SIGNAL_IMPORTANCE_APPROVAL: unit(0.85),
  SIGNAL_IMPORTANCE_REJECTION: unit(0.9),
  SIGNAL_CONFIDENCE_APPROVAL: unit(0.7),
  SIGNAL_CONFIDENCE_REJECTION: unit(0.75),

  // Retrieval
  RETRIEVAL_DEFAULT_LIMIT: positiveInt(10),
  RETRIEVAL_MAX_LIMIT: positiveInt(50),
  RETRIEVAL_MAX_QUERY_CHARS: positiveInt(2000),
  RETRIEVAL_PROFILE_NAME: nonEmpty('default'),
  // Global switch for the optional LLM rerank step (the profile and the request must also ask for it).
  RERANK_ENABLED: bool('false'),

  // Jobs (apps/memory-jobs)
  JOBS_ENABLED: nonEmpty('decay'),
  JOB_LEASE_MS: positiveInt(600000),
  DECAY_INTERVAL_MS: positiveInt(3600000),
  DECAY_BATCH_SIZE: positiveInt(500),
  DECAY_CONFIDENCE_FLOOR: unit(0.05),
  DECAY_IMPORTANCE_FLOOR: unit(0.05),
  // Importance fades this many times slower than confidence.
  DECAY_IMPORTANCE_HALF_LIFE_MULTIPLIER: z.coerce.number().min(1).max(100).default(2),
  // Do not write a row whose values would move less than this.
  DECAY_MIN_CHANGE: z.coerce.number().min(0).max(0.5).default(0.002),
  // M2 jobs. Their rules and thresholds are NOT here: they live in the versioned `job_configs` table (see docs/ARCHITECTURE.md).
  // Scheduled runs only compute and report when this is true; `npm run job -- <name> --dry-run` does the same once.
  JOBS_DRY_RUN: bool('false'),
  // Memories read per page by the M2 jobs.
  JOBS_BATCH_SIZE: positiveInt(200),
  // Tries (including the first) for each structured LLM call a job makes.
  JOBS_LLM_MAX_ATTEMPTS: positiveInt(3),
  CONSOLIDATE_INTERVAL_MS: positiveInt(21600000),
  PROMOTE_INTERVAL_MS: positiveInt(86400000),
  COLLAPSE_INTERVAL_MS: positiveInt(43200000),
  CONTRADICTIONS_INTERVAL_MS: positiveInt(43200000),
  REEMBED_INTERVAL_MS: positiveInt(600000),
  USAGE_FEEDBACK_INTERVAL_MS: positiveInt(3600000),
  CLEANUP_INTERVAL_MS: positiveInt(21600000),
  // category=days pairs overriding the default half-lives, for example `working=1,episodic=10`.
  DECAY_HALF_LIFE_DAYS: z.string().default(''),

  // Read API (apps/memory-api). Adapter names are registry keys, like the ports above.
  MEMORY_API_TOKEN_VERIFIER: nonEmpty('firebase'),
  MEMORY_API_RATE_LIMITER: nonEmpty('memory'),
  FIREBASE_PROJECT_ID: z.string().default(''),
  // JSON array of { token, subject, email, emailVerified? }. Only for the `static` verifier, never in production.
  MEMORY_API_STATIC_TOKENS: z.string().default(''),
  // The one workspace this deployment serves. Injected into every call from here, never from the request.
  MEMORY_API_WORKSPACE_ID: nonEmpty('seedbed'),
  MEMORY_API_ALLOWED_EMAILS: z.string().default(''),
  MEMORY_API_ALLOWED_EMAIL_DOMAINS: z.string().default(''),
  MEMORY_API_ADMIN_EMAILS: z.string().default(''),
  MEMORY_API_CORS_ORIGINS: z.string().default(''),
  MEMORY_API_TRUST_PROXY: bool('false'),
  MEMORY_API_RATE_LIMIT_MAX: positiveInt(120),
  MEMORY_API_RATE_LIMIT_WINDOW_MS: positiveInt(60000),
  // Search is the expensive call (embedding + several queries): its own, lower limit per caller.
  MEMORY_API_SEARCH_RATE_LIMIT_MAX: positiveInt(30),
  MEMORY_API_AUTH_FAILURE_LIMIT_MAX: positiveInt(30),
  MEMORY_API_AUTH_FAILURE_WINDOW_MS: positiveInt(900000),
});

export type Env = z.infer<typeof envSchema>;

/** The jobs added in M2, by the name used in JOBS_ENABLED and `npm run job`. */
export const M2_JOB_NAMES = ['consolidate', 'promote', 'collapse', 'contradictions', 'reembed', 'usage-feedback', 'cleanup'] as const;
export type M2JobName = (typeof M2_JOB_NAMES)[number];

export interface StaticTokenEntry {
  token: string;
  subject: string;
  email: string;
  emailVerified: boolean;
}

const staticTokensSchema = z.array(
  z.object({
    token: z.string().min(8),
    subject: z.string().min(1).max(128),
    email: z.string().email(),
    emailVerified: z.boolean().default(true),
  })
);

/** `a@x.com, B@x.com` -> lower-case, trimmed, de-duplicated. */
export function parseList(value: string): string[] {
  return [...new Set(value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

/** CORS origins must be exact origins: scheme://host[:port], never `*` and never with a path. */
export function parseCorsOrigins(value: string): string[] {
  const origins: string[] = [];
  for (const raw of value.split(',').map((v) => v.trim()).filter(Boolean)) {
    let origin: string;
    try {
      const u = new URL(raw);
      origin = u.origin;
      if (!/^https?:$/.test(u.protocol) || origin !== raw.replace(/\/$/, '')) throw new Error('not an origin');
    } catch {
      throw new Error(`"${raw}" is not an origin like https://insights.example.com (no wildcard, no path)`);
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/** `working=1,episodic=10` -> partial map; unknown categories and non-positive numbers are errors. */
export function parseHalfLives(value: string): Partial<Record<MemoryCategory, number>> {
  const out: Partial<Record<MemoryCategory, number>> = {};
  for (const raw of value.split(',').map((v) => v.trim()).filter(Boolean)) {
    const [name, days] = raw.split('=').map((s) => s.trim());
    if (!(MEMORY_CATEGORIES as readonly string[]).includes(name) || !(Number(days) > 0)) {
      throw new Error(`"${raw}" is not category=days (category one of ${MEMORY_CATEGORIES.join(', ')}, days > 0)`);
    }
    out[name as MemoryCategory] = Number(days);
  }
  return out;
}

export function parseNameList(value: string): string[] {
  return [...new Set(value.split(',').map((v) => v.trim()).filter(Boolean))];
}

export interface AppConfig {
  env: Env['NODE_ENV'];
  isDevelopment: boolean;
  isProduction: boolean;
  isTest: boolean;
  /** ALLOW_IN_MEMORY_ADAPTERS. Refused when NODE_ENV=production (see InMemoryAdaptersNotAllowedError). */
  allowInMemoryAdapters: boolean;
  service: { name: string; host: string; port: number };
  log: { level: Env['LOG_LEVEL'] };
  /** Registry names of the selected adapters. */
  adapters: {
    memoryStore: string;
    vectorIndex: string;
    scoringProfileStore: string;
    retrievalLogStore: string;
    jobRunStore: string;
    jobConfigStore: string;
    embeddingMigrationStore: string;
    outboxStore: string;
    eventBus: string;
    embedder: string;
    llmProvider: string;
    tokenCounter: string;
    jobScheduler: string;
    outcomeLinker: string;
    hubContentSource: string;
    tokenVerifier: string;
    rateLimiter: string;
  };
  postgres: { url: string; poolMax: number; migrationsDir: string; embeddingDimension: number };
  eventBus: {
    redisUrl: string;
    auditTopic: string;
    consumerGroup: string;
    consumerName: string;
    batchSize: number;
    blockMs: number;
    claimIdleMs: number;
    maxDeliveries: number;
    maxStreamLength?: number;
  };
  audit: {
    transport: 'outbox' | 'bus';
    workspaceId: string;
    relay: { enabled: boolean; pollIntervalMs: number; batchSize: number; leaseMs: number };
  };
  embedder: {
    baseUrl: string;
    model: string;
    version: string;
    apiKey: string;
    timeoutMs: number;
    batchSize: number;
    maxRetries: number;
    sendDimensions: boolean;
    allowLocal: boolean;
  };
  llm: {
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    maxRetries: number;
    temperature: number;
    extraBody: Record<string, unknown>;
    allowScripted: boolean;
  };
  write: {
    sources: string[];
    devContent: { allowed: boolean; seed: string; workspaceId: string; pageSize: number };
    contentPollMs: number;
    resolver: { similarityThreshold: number; relatedThreshold: number };
    extraction: { maxCandidates: number; maxAttempts: number };
    maxContentChars: number;
    redactPii: boolean;
    concurrency: number;
    reclaimIntervalMs: number;
    retryBaseMs: number;
    retryMaxMs: number;
    signals: {
      approvalImportance: number;
      rejectionImportance: number;
      approvalConfidence: number;
      rejectionConfidence: number;
    };
  };
  retrieval: { defaultLimit: number; maxLimit: number; maxQueryChars: number; profileName: string; rerankEnabled: boolean };
  jobs: {
    enabled: string[];
    leaseMs: number;
    dryRun: boolean;
    batchSize: number;
    llmMaxAttempts: number;
    /** Schedule of the M2 jobs by job name. */
    intervalsMs: Record<M2JobName, number>;
    decay: {
      intervalMs: number;
      batchSize: number;
      confidenceFloor: number;
      importanceFloor: number;
      importanceHalfLifeMultiplier: number;
      minChange: number;
      halfLifeDays: Record<MemoryCategory, number>;
    };
  };
  api: {
    workspaceId: string;
    firebaseProjectId: string;
    staticTokens: StaticTokenEntry[];
    access: { allowedEmails: string[]; allowedEmailDomains: string[]; adminEmails: string[] };
    corsOrigins: string[];
    trustProxy: boolean;
    rateLimit: { max: number; windowMs: number; searchMax: number; authFailureMax: number; authFailureWindowMs: number };
  };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export type EnvSource = Record<string, string | undefined>;

export interface LoadConfigOptions {
  serviceName?: string;
  defaultPort?: number;
}

export function loadConfig(env: EnvSource = process.env, options: LoadConfigOptions = {}): AppConfig {
  // Treat empty strings as unset so `FOO=` in a .env file falls back to the default.
  const cleaned: EnvSource = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  if (cleaned.PORT === undefined && options.defaultPort !== undefined) cleaned.PORT = String(options.defaultPort);

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const e = parsed.data;

  const issues: string[] = [];
  let staticTokens: StaticTokenEntry[] = [];
  if (e.MEMORY_API_STATIC_TOKENS !== '') {
    try {
      staticTokens = staticTokensSchema.parse(JSON.parse(e.MEMORY_API_STATIC_TOKENS));
    } catch (err) {
      issues.push(`MEMORY_API_STATIC_TOKENS: not a JSON array of { token, subject, email } (${(err as Error).message.slice(0, 120)})`);
    }
  }
  let corsOrigins: string[] = [];
  try {
    corsOrigins = parseCorsOrigins(e.MEMORY_API_CORS_ORIGINS);
  } catch (err) {
    issues.push(`MEMORY_API_CORS_ORIGINS: ${(err as Error).message}`);
  }
  let llmExtraBody: Record<string, unknown> = {};
  if (e.LLM_EXTRA_BODY !== '') {
    try {
      const parsedBody: unknown = JSON.parse(e.LLM_EXTRA_BODY);
      if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) throw new Error('not an object');
      llmExtraBody = parsedBody as Record<string, unknown>;
    } catch (err) {
      issues.push(`LLM_EXTRA_BODY: not a JSON object (${(err as Error).message.slice(0, 80)})`);
    }
  }
  let halfLives: Partial<Record<MemoryCategory, number>> = {};
  try {
    halfLives = parseHalfLives(e.DECAY_HALF_LIFE_DAYS);
  } catch (err) {
    issues.push(`DECAY_HALF_LIFE_DAYS: ${(err as Error).message}`);
  }
  if (e.RESOLVER_RELATED_THRESHOLD > e.RESOLVER_SIMILARITY_THRESHOLD) {
    issues.push('RESOLVER_RELATED_THRESHOLD must not be greater than RESOLVER_SIMILARITY_THRESHOLD');
  }
  if (e.RETRIEVAL_DEFAULT_LIMIT > e.RETRIEVAL_MAX_LIMIT) issues.push('RETRIEVAL_DEFAULT_LIMIT must not be greater than RETRIEVAL_MAX_LIMIT');
  if (issues.length > 0) throw new ConfigError(issues);

  return {
    env: e.NODE_ENV,
    isDevelopment: e.NODE_ENV === 'development',
    isProduction: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
    allowInMemoryAdapters: e.ALLOW_IN_MEMORY_ADAPTERS,
    service: { name: e.SERVICE_NAME ?? options.serviceName ?? 'proba-memory', host: e.HOST, port: e.PORT },
    log: { level: e.LOG_LEVEL },
    adapters: {
      memoryStore: e.MEMORY_STORE,
      vectorIndex: e.VECTOR_INDEX,
      scoringProfileStore: e.SCORING_PROFILE_STORE,
      retrievalLogStore: e.RETRIEVAL_LOG_STORE,
      jobRunStore: e.JOB_RUN_STORE,
      jobConfigStore: e.JOB_CONFIG_STORE,
      embeddingMigrationStore: e.EMBEDDING_MIGRATION_STORE,
      outboxStore: e.OUTBOX_STORE,
      eventBus: e.EVENT_BUS,
      embedder: e.EMBEDDER,
      llmProvider: e.LLM_PROVIDER,
      tokenCounter: e.TOKEN_COUNTER,
      jobScheduler: e.JOB_SCHEDULER,
      outcomeLinker: e.OUTCOME_LINKER,
      hubContentSource: e.HUB_CONTENT_SOURCE,
      tokenVerifier: e.MEMORY_API_TOKEN_VERIFIER,
      rateLimiter: e.MEMORY_API_RATE_LIMITER,
    },
    postgres: {
      url: e.DATABASE_URL,
      poolMax: e.PG_POOL_MAX,
      migrationsDir: e.PG_MIGRATIONS_DIR,
      embeddingDimension: e.EMBEDDING_DIMENSION,
    },
    eventBus: {
      redisUrl: e.REDIS_URL,
      auditTopic: e.AUDIT_TOPIC,
      consumerGroup: e.MEMORY_AUDIT_CONSUMER_GROUP,
      consumerName: e.CONSUMER_NAME ?? `${hostname()}-${process.pid}`,
      batchSize: e.BUS_BATCH_SIZE,
      blockMs: e.BUS_BLOCK_MS,
      claimIdleMs: e.BUS_CLAIM_IDLE_MS,
      maxDeliveries: e.BUS_MAX_DELIVERIES,
      maxStreamLength: e.BUS_MAX_STREAM_LENGTH,
    },
    audit: {
      transport: e.AUDIT_TRANSPORT,
      workspaceId: e.AUDIT_WORKSPACE_ID,
      relay: { enabled: e.OUTBOX_RELAY_ENABLED, pollIntervalMs: e.OUTBOX_RELAY_POLL_MS, batchSize: e.OUTBOX_RELAY_BATCH, leaseMs: e.OUTBOX_RELAY_LEASE_MS },
    },
    embedder: {
      baseUrl: e.EMBEDDER_BASE_URL,
      model: e.EMBEDDER_MODEL,
      version: e.EMBEDDER_VERSION,
      apiKey: e.EMBEDDER_API_KEY,
      timeoutMs: e.EMBEDDER_TIMEOUT_MS,
      batchSize: e.EMBEDDER_BATCH_SIZE,
      maxRetries: e.EMBEDDER_MAX_RETRIES,
      sendDimensions: e.EMBEDDER_SEND_DIMENSIONS,
      allowLocal: e.ALLOW_LOCAL_EMBEDDER,
    },
    llm: {
      baseUrl: e.LLM_BASE_URL,
      model: e.LLM_MODEL,
      apiKey: e.LLM_API_KEY,
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxRetries: e.LLM_MAX_RETRIES,
      temperature: e.LLM_TEMPERATURE,
      extraBody: llmExtraBody,
      allowScripted: e.ALLOW_SCRIPTED_LLM,
    },
    write: {
      sources: parseNameList(e.SOURCES),
      devContent: {
        allowed: e.ALLOW_DEV_CONTENT_SOURCE,
        seed: e.DEV_CONTENT_SEED,
        workspaceId: e.DEV_CONTENT_WORKSPACE_ID,
        pageSize: e.DEV_CONTENT_PAGE_SIZE,
      },
      contentPollMs: e.CONTENT_POLL_MS,
      resolver: { similarityThreshold: e.RESOLVER_SIMILARITY_THRESHOLD, relatedThreshold: e.RESOLVER_RELATED_THRESHOLD },
      extraction: { maxCandidates: e.EXTRACTION_MAX_CANDIDATES, maxAttempts: e.EXTRACTION_MAX_ATTEMPTS },
      maxContentChars: e.MEMORY_MAX_CONTENT_CHARS,
      redactPii: e.REDACT_PII,
      concurrency: e.INGEST_CONCURRENCY,
      reclaimIntervalMs: e.INGEST_RECLAIM_INTERVAL_MS,
      retryBaseMs: e.INGEST_RETRY_BASE_MS,
      retryMaxMs: e.INGEST_RETRY_MAX_MS,
      signals: {
        approvalImportance: e.SIGNAL_IMPORTANCE_APPROVAL,
        rejectionImportance: e.SIGNAL_IMPORTANCE_REJECTION,
        approvalConfidence: e.SIGNAL_CONFIDENCE_APPROVAL,
        rejectionConfidence: e.SIGNAL_CONFIDENCE_REJECTION,
      },
    },
    retrieval: {
      defaultLimit: e.RETRIEVAL_DEFAULT_LIMIT,
      maxLimit: e.RETRIEVAL_MAX_LIMIT,
      maxQueryChars: e.RETRIEVAL_MAX_QUERY_CHARS,
      profileName: e.RETRIEVAL_PROFILE_NAME,
      rerankEnabled: e.RERANK_ENABLED,
    },
    jobs: {
      enabled: parseNameList(e.JOBS_ENABLED),
      leaseMs: e.JOB_LEASE_MS,
      dryRun: e.JOBS_DRY_RUN,
      batchSize: e.JOBS_BATCH_SIZE,
      llmMaxAttempts: e.JOBS_LLM_MAX_ATTEMPTS,
      intervalsMs: {
        consolidate: e.CONSOLIDATE_INTERVAL_MS,
        promote: e.PROMOTE_INTERVAL_MS,
        collapse: e.COLLAPSE_INTERVAL_MS,
        contradictions: e.CONTRADICTIONS_INTERVAL_MS,
        reembed: e.REEMBED_INTERVAL_MS,
        'usage-feedback': e.USAGE_FEEDBACK_INTERVAL_MS,
        cleanup: e.CLEANUP_INTERVAL_MS,
      },
      decay: {
        intervalMs: e.DECAY_INTERVAL_MS,
        batchSize: e.DECAY_BATCH_SIZE,
        confidenceFloor: e.DECAY_CONFIDENCE_FLOOR,
        importanceFloor: e.DECAY_IMPORTANCE_FLOOR,
        importanceHalfLifeMultiplier: e.DECAY_IMPORTANCE_HALF_LIFE_MULTIPLIER,
        minChange: e.DECAY_MIN_CHANGE,
        halfLifeDays: { ...DEFAULT_HALF_LIVES_DAYS, ...halfLives },
      },
    },
    api: {
      workspaceId: e.MEMORY_API_WORKSPACE_ID,
      firebaseProjectId: e.FIREBASE_PROJECT_ID.trim(),
      staticTokens,
      access: {
        allowedEmails: parseList(e.MEMORY_API_ALLOWED_EMAILS),
        allowedEmailDomains: parseList(e.MEMORY_API_ALLOWED_EMAIL_DOMAINS),
        adminEmails: parseList(e.MEMORY_API_ADMIN_EMAILS),
      },
      corsOrigins,
      trustProxy: e.MEMORY_API_TRUST_PROXY,
      rateLimit: {
        max: e.MEMORY_API_RATE_LIMIT_MAX,
        windowMs: e.MEMORY_API_RATE_LIMIT_WINDOW_MS,
        searchMax: e.MEMORY_API_SEARCH_RATE_LIMIT_MAX,
        authFailureMax: e.MEMORY_API_AUTH_FAILURE_LIMIT_MAX,
        authFailureWindowMs: e.MEMORY_API_AUTH_FAILURE_WINDOW_MS,
      },
    },
  };
}

/** Load a local .env file (if present), then validate process.env. */
export function loadConfigFromEnvironment(options: LoadConfigOptions = {}): AppConfig {
  loadDotenv();
  return loadConfig(process.env, options);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '[REDACTED]';
    if (u.username && u.password) u.username = '[REDACTED]';
    return u.toString();
  } catch {
    return '[unparseable url]';
  }
}

const mask = (v: string): string => (v ? '[REDACTED]' : '');

/** Copy of the config that is safe to log: keys, tokens and URL credentials removed. */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  return {
    ...config,
    postgres: { ...config.postgres, url: redactUrl(config.postgres.url) },
    eventBus: { ...config.eventBus, redisUrl: redactUrl(config.eventBus.redisUrl) },
    embedder: { ...config.embedder, apiKey: mask(config.embedder.apiKey) },
    llm: { ...config.llm, apiKey: mask(config.llm.apiKey) },
    api: { ...config.api, staticTokens: config.api.staticTokens.map(() => '[REDACTED]') },
  };
}

/** True when no email, domain or admin is configured for the read API: nobody can use it. */
export function isPolicyEmptyForConfig(config: AppConfig): boolean {
  const a = config.api.access;
  return a.allowedEmails.length === 0 && a.allowedEmailDomains.length === 0 && a.adminEmails.length === 0;
}
