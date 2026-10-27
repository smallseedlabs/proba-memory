import type { AppConfig } from '@smallseedlabs/proba-memory-core';
import { parseRedisUrl } from '../redis/connection.js';
import { assertInMemoryAdaptersAllowed, type InMemoryGuardOptions } from './in-memory-guard.js';

/**
 * Startup guards that only apply when NODE_ENV=production. Each one throws a descriptive error BEFORE any adapter is
 * created, so a misconfigured production process never serves traffic with an open Redis or a volatile store.
 */

export class RedisPasswordRequiredError extends Error {
  constructor(readonly users: string[]) {
    super(
      `Redis is used by ${users.join(', ')} but REDIS_URL carries no password. Production requires Redis authentication: ` +
        `use redis://<user>:<password>@host:6379 (rediss:// for TLS). Generate one with \`openssl rand -hex 24\`.`
    );
    this.name = 'RedisPasswordRequiredError';
  }
}

export interface ProductionGuardOptions extends InMemoryGuardOptions {}

/** The settings of this process that use Redis (they all read REDIS_URL). */
export function redisUsers(config: AppConfig, options: ProductionGuardOptions = {}): string[] {
  const users: string[] = [];
  if (config.adapters.eventBus === 'redis-streams') users.push('EVENT_BUS=redis-streams');
  if (options.includeRateLimiter && config.adapters.rateLimiter === 'redis') users.push('MEMORY_API_RATE_LIMITER=redis');
  return users;
}

/** Production + a Redis adapter + a REDIS_URL without a password (or an unusable URL) = refuse to start. */
export function assertRedisAuthenticated(config: AppConfig, options: ProductionGuardOptions = {}): void {
  if (!config.isProduction) return;
  const users = redisUsers(config, options);
  if (users.length === 0) return;
  if (!parseRedisUrl(config.eventBus.redisUrl).hasPassword) throw new RedisPasswordRequiredError(users);
}

/** Every production guard that needs no connection. createRuntime runs this first. */
export function assertProductionGuards(config: AppConfig, options: ProductionGuardOptions = {}): void {
  assertInMemoryAdaptersAllowed(config, options);
  assertRedisAuthenticated(config, options);
}
