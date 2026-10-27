import { describe, expect, it } from 'vitest';
import { MemoryLogger, loadConfig } from '@smallseedlabs/proba-memory-core';
import { InMemoryAdaptersNotAllowedError, assertInMemoryAdaptersAllowed, selectedInMemoryAdapters } from './in-memory-guard.js';
import { RedisPasswordRequiredError, assertProductionGuards, assertRedisAuthenticated } from './production-guards.js';
import { createDefaultRegistries } from './registries.js';
import { createRuntime } from './runtime.js';
import { InMemoryEventBus } from '../memory/event-bus.js';
import type { EventBus } from '@smallseedlabs/proba-memory-core';

// Everything durable, as a real deployment; the tests change one thing at a time.
const prodEnv = {
  NODE_ENV: 'production',
  MEMORY_STORE: 'postgres',
  VECTOR_INDEX: 'postgres',
  SCORING_PROFILE_STORE: 'postgres',
  RETRIEVAL_LOG_STORE: 'postgres',
  JOB_RUN_STORE: 'postgres',
  JOB_CONFIG_STORE: 'postgres',
  EMBEDDING_MIGRATION_STORE: 'postgres',
  OUTBOX_STORE: 'postgres',
  EVENT_BUS: 'redis-streams',
  OUTCOME_LINKER: 'noop',
  MEMORY_API_RATE_LIMITER: 'redis',
  DATABASE_URL: 'postgresql://proba:pg-pw@postgres:5432/proba_memory',
  REDIS_URL: 'redis://proba:redis-pw@redis:6379',
};
const prod = (extra: Record<string, string> = {}) => loadConfig({ ...prodEnv, ...extra });
const all = { includeRateLimiter: true, includeRetrieval: true, includeJobs: true };

describe('Redis authentication guard (production)', () => {
  it.each(['redis://redis:6379', 'redis://proba@redis:6379', 'redis://proba:@redis:6379', 'rediss://cache.example.com:6380'])(
    'refuses a Redis URL without a password: %s',
    (url) => {
      expect(() => assertRedisAuthenticated(prod({ REDIS_URL: url }))).toThrow(RedisPasswordRequiredError);
    }
  );

  it('names what uses Redis and never prints the URL', () => {
    const err = (() => {
      try {
        assertRedisAuthenticated(prod({ REDIS_URL: 'redis://redis:6379' }), { includeRateLimiter: true });
        return undefined;
      } catch (e) {
        return e as RedisPasswordRequiredError;
      }
    })();
    expect(err).toBeInstanceOf(RedisPasswordRequiredError);
    expect(err!.users).toEqual(['EVENT_BUS=redis-streams', 'MEMORY_API_RATE_LIMITER=redis']);
    expect(err!.message).toContain('REDIS_URL');
    expect(err!.message).not.toContain('redis://redis:6379');
  });

  it('accepts a password, plain or TLS', () => {
    expect(() => assertRedisAuthenticated(prod(), all)).not.toThrow();
    expect(() => assertRedisAuthenticated(prod({ REDIS_URL: 'rediss://:pw@cache.example.com:6380' }), all)).not.toThrow();
  });

  it('does not apply outside production', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(() => assertRedisAuthenticated(prod({ NODE_ENV, REDIS_URL: 'redis://localhost:6379' }), all)).not.toThrow();
    }
  });

  it('does not apply when nothing uses Redis', () => {
    // The rate limiter only counts for the process that declares it (memory-api).
    const config = prod({ REDIS_URL: 'redis://redis:6379', EVENT_BUS: 'memory' });
    expect(() => assertRedisAuthenticated(config)).not.toThrow();
    expect(() => assertRedisAuthenticated(config, { includeRateLimiter: true })).toThrow(RedisPasswordRequiredError);
    expect(() => assertRedisAuthenticated(prod({ REDIS_URL: 'redis://redis:6379', EVENT_BUS: 'memory', MEMORY_API_RATE_LIMITER: 'memory' }), { includeRateLimiter: true })).not.toThrow();
  });

  it('refuses an unusable Redis URL', () => {
    expect(() => assertRedisAuthenticated(prod({ REDIS_URL: 'http://redis:6379' }))).toThrow(/Invalid REDIS_URL/);
  });

  it('createRuntime refuses before creating any adapter', async () => {
    const registries = createDefaultRegistries();
    let created = false;
    registries.memoryStore.register('probe', () => {
      created = true;
      throw new Error('must not be created');
    });
    const err = await createRuntime(prod({ REDIS_URL: 'redis://redis:6379', MEMORY_STORE: 'probe' }), { service: 'memory-api', logger: new MemoryLogger(), registries }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedisPasswordRequiredError);
    expect(created).toBe(false);
  });
});

describe('in-memory adapters are never allowed in production', () => {
  const durableOnly = (key: string, extra: Record<string, string> = {}) => prod({ [key]: 'memory', ...extra });

  it('passes with every adapter durable', () => {
    expect(() => assertProductionGuards(prod(), all)).not.toThrow();
    expect(selectedInMemoryAdapters(prod(), all)).toEqual([]);
  });

  it('refuses all of them at once, naming each', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      MEMORY_STORE: 'memory',
      VECTOR_INDEX: 'memory',
      SCORING_PROFILE_STORE: 'memory',
      RETRIEVAL_LOG_STORE: 'memory',
      JOB_RUN_STORE: 'memory',
      JOB_CONFIG_STORE: 'memory',
      EMBEDDING_MIGRATION_STORE: 'memory',
      OUTBOX_STORE: 'memory',
      EVENT_BUS: 'memory',
      OUTCOME_LINKER: 'memory',
      MEMORY_API_RATE_LIMITER: 'memory',
      REDIS_URL: 'redis://:pw@redis:6379',
    });
    const err = (() => {
      try {
        assertInMemoryAdaptersAllowed(config, all);
        return undefined;
      } catch (e) {
        return e as InMemoryAdaptersNotAllowedError;
      }
    })();
    expect(err).toBeInstanceOf(InMemoryAdaptersNotAllowedError);
    expect(err!.adapters).toEqual([
      'MEMORY_STORE',
      'VECTOR_INDEX',
      'OUTBOX_STORE',
      'EVENT_BUS',
      'SCORING_PROFILE_STORE',
      'RETRIEVAL_LOG_STORE',
      'JOB_RUN_STORE',
      'JOB_CONFIG_STORE',
      'EMBEDDING_MIGRATION_STORE',
      'OUTCOME_LINKER',
      'MEMORY_API_RATE_LIMITER',
    ]);
    expect(err!.message).toContain('never allowed in production');
  });

  it.each([
    ['MEMORY_STORE', {}],
    ['VECTOR_INDEX', {}],
    ['OUTBOX_STORE', {}],
    ['EVENT_BUS', {}],
    ['SCORING_PROFILE_STORE', {}],
    ['RETRIEVAL_LOG_STORE', {}],
    ['JOB_RUN_STORE', {}],
    ['JOB_CONFIG_STORE', {}],
    ['EMBEDDING_MIGRATION_STORE', {}],
    ['OUTCOME_LINKER', {}],
    ['MEMORY_API_RATE_LIMITER', {}],
  ])('a single in-memory %s is enough to refuse', (key, extra) => {
    let err: InMemoryAdaptersNotAllowedError | undefined;
    try {
      assertProductionGuards(durableOnly(key, extra), all);
    } catch (e) {
      err = e as InMemoryAdaptersNotAllowedError;
    }
    expect(err).toBeInstanceOf(InMemoryAdaptersNotAllowedError);
    expect(err!.adapters).toEqual([key]);
  });

  it('ports an app does not create do not count (ingestor: no retrieval, no jobs, no rate limiter)', () => {
    const config = prod({ SCORING_PROFILE_STORE: 'memory', RETRIEVAL_LOG_STORE: 'memory', JOB_RUN_STORE: 'memory', OUTCOME_LINKER: 'memory', MEMORY_API_RATE_LIMITER: 'memory' });
    expect(() => assertProductionGuards(config, {})).not.toThrow();
    expect(() => assertProductionGuards(config, { includeRetrieval: true })).toThrow(InMemoryAdaptersNotAllowedError);
    expect(() => assertProductionGuards(config, { includeJobs: true })).toThrow(InMemoryAdaptersNotAllowedError);
    expect(() => assertProductionGuards(config, { includeRateLimiter: true })).toThrow(InMemoryAdaptersNotAllowedError);
  });

  it('has no escape hatch: ALLOW_IN_MEMORY_ADAPTERS=true is itself refused in production', () => {
    const config = prod({ MEMORY_STORE: 'memory', ALLOW_IN_MEMORY_ADAPTERS: 'true' });
    expect(config.allowInMemoryAdapters).toBe(true);
    let err: InMemoryAdaptersNotAllowedError | undefined;
    try {
      assertProductionGuards(config, all);
    } catch (e) {
      err = e as InMemoryAdaptersNotAllowedError;
    }
    expect(err).toBeInstanceOf(InMemoryAdaptersNotAllowedError);
    expect(err!.adapters).toEqual(['MEMORY_STORE']);
    expect(err!.optInRefused).toBe(true);
  });

  it('refuses a stale ALLOW_IN_MEMORY_ADAPTERS=true even when every adapter is durable', () => {
    const err = (() => {
      try {
        assertProductionGuards(prod({ ALLOW_IN_MEMORY_ADAPTERS: 'true' }), all);
        return undefined;
      } catch (e) {
        return e as InMemoryAdaptersNotAllowedError;
      }
    })();
    expect(err).toBeInstanceOf(InMemoryAdaptersNotAllowedError);
    expect(err!.adapters).toEqual([]);
    expect(err!.message).toContain('ALLOW_IN_MEMORY_ADAPTERS=true is refused');
  });

  it('is allowed outside production, with or without the flag', () => {
    for (const NODE_ENV of ['development', 'test']) {
      for (const flag of ['true', 'false']) {
        const config = loadConfig({ NODE_ENV, MEMORY_STORE: 'memory', EVENT_BUS: 'memory', MEMORY_API_RATE_LIMITER: 'memory', ALLOW_IN_MEMORY_ADAPTERS: flag });
        expect(() => assertProductionGuards(config, all)).not.toThrow();
      }
    }
  });

  it('parses ALLOW_IN_MEMORY_ADAPTERS strictly and defaults it to false', () => {
    expect(loadConfig({}).allowInMemoryAdapters).toBe(false);
    expect(loadConfig({ ALLOW_IN_MEMORY_ADAPTERS: 'true' }).allowInMemoryAdapters).toBe(true);
    expect(() => loadConfig({ ALLOW_IN_MEMORY_ADAPTERS: 'yes' })).toThrow();
  });

  it('createRuntime refuses before creating any adapter, for the in-memory store and for a stale opt-in', async () => {
    const registries = createDefaultRegistries();
    let created = false;
    registries.eventBus.register('probe', () => {
      created = true;
      return new InMemoryEventBus() as EventBus;
    });
    const logger = new MemoryLogger();
    await expect(createRuntime(prod({ MEMORY_STORE: 'memory', EVENT_BUS: 'probe' }), { service: 'memory-ingestor', logger, registries })).rejects.toBeInstanceOf(InMemoryAdaptersNotAllowedError);
    await expect(createRuntime(prod({ ALLOW_IN_MEMORY_ADAPTERS: 'true', EVENT_BUS: 'probe' }), { service: 'memory-ingestor', logger, registries })).rejects.toBeInstanceOf(InMemoryAdaptersNotAllowedError);
    expect(created).toBe(false);
  });

  it.each([
    ['memory-api', { retrieval: true, rateLimiter: true, embedder: true }],
    ['memory-ingestor', { embedder: true, llm: true }],
    ['memory-jobs', { jobs: true }],
  ])('createRuntime for %s refuses an in-memory store in production', async (service, needs) => {
    const err = await createRuntime(prod({ MEMORY_STORE: 'memory' }), { service, logger: new MemoryLogger(), needs }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InMemoryAdaptersNotAllowedError);
  });
});
