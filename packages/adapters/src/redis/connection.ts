import type { RedisClientOptions } from 'redis';

/**
 * Shared Redis connection rules for every Redis adapter (event bus, rate limiter).
 *
 * - `redis://` is plain TCP, `rediss://` is TLS (certificate and host name verified against the system trust store;
 *   for a private CA set NODE_EXTRA_CA_CERTS). Any other scheme is refused.
 * - Credentials travel in the URL: `redis://user:password@host:6379` (the user is optional: `redis://:password@host`).
 */

export class InvalidRedisUrlError extends Error {
  constructor(reason: string) {
    super(`Invalid REDIS_URL: ${reason}`);
    this.name = 'InvalidRedisUrlError';
  }
}

export interface RedisUrlInfo {
  /** True for `rediss://`. */
  tls: boolean;
  /** The ACL user in the URL, or '' (the default user). */
  username: string;
  /** True when the URL carries a non-empty password. */
  hasPassword: boolean;
  host: string;
}

/** Parse a Redis URL without ever returning (or logging) the password. Throws InvalidRedisUrlError. */
export function parseRedisUrl(url: string): RedisUrlInfo {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InvalidRedisUrlError('not a URL (expected redis://[user]:password@host:port or rediss://...)');
  }
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') {
    throw new InvalidRedisUrlError(`unsupported scheme "${u.protocol}" (use redis:// or rediss://)`);
  }
  return {
    tls: u.protocol === 'rediss:',
    username: decodeURIComponent(u.username),
    hasPassword: decodeURIComponent(u.password) !== '',
    host: u.hostname,
  };
}

/** True when the URL carries a non-empty password. Unparseable URLs count as having none. */
export function redisUrlHasPassword(url: string): boolean {
  try {
    return parseRedisUrl(url).hasPassword;
  } catch {
    return false;
  }
}

/**
 * node-redis options for a URL: TLS for `rediss://`, with certificate verification left ON.
 * `socket` carries the caller's timeouts and reconnect strategy.
 */
export function redisClientOptions(
  url: string,
  extra: Omit<RedisClientOptions, 'url' | 'socket'> & { socket?: { connectTimeout?: number; reconnectStrategy?: (retries: number) => number | Error } } = {}
): RedisClientOptions {
  const info = parseRedisUrl(url);
  const { socket, ...rest } = extra;
  return {
    ...rest,
    url,
    socket: { ...(socket ?? {}), ...(info.tls ? { tls: true as const, rejectUnauthorized: true } : {}) },
  } as RedisClientOptions;
}
