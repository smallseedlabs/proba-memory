import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig, MemoryLogger } from '@smallseedlabs/proba-memory-core';
import { RedisRateLimiter } from './redis-rate-limiter.js';
import { runRateLimiterContract } from './rate-limiter.contract.js';

const config = loadConfig(process.env);

runRateLimiterContract('redis', async () => ({
  limiter: new RedisRateLimiter({ url: config.eventBus.redisUrl, keyPrefix: `rl-test:${randomUUID()}:` }),
  advance: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));

describe('RedisRateLimiter against a real Redis', () => {
  it('shares counts between instances (two API replicas see one budget)', async () => {
    const prefix = `rl-test:${randomUUID()}:`;
    const a = new RedisRateLimiter({ url: config.eventBus.redisUrl, keyPrefix: prefix });
    const b = new RedisRateLimiter({ url: config.eventBus.redisUrl, keyPrefix: prefix });
    try {
      expect((await a.hit('user-1', 2, 60_000)).allowed).toBe(true);
      expect((await b.hit('user-1', 2, 60_000)).allowed).toBe(true);
      expect((await a.hit('user-1', 2, 60_000)).allowed).toBe(false);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it('fails open, and says so in the log, when Redis is unreachable', async () => {
    const logger = new MemoryLogger();
    const limiter = new RedisRateLimiter({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 200, logger });
    try {
      expect((await limiter.hit('k', 1, 1000)).allowed).toBe(true);
      expect((await limiter.peek('k', 1, 1000)).allowed).toBe(true);
      expect(logger.records.some((r) => r.level === 'warn' || r.level === 'error')).toBe(true);
    } finally {
      await limiter.close();
    }
  });
});
