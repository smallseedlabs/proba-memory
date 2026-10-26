import { createClient } from 'redis';
import type { Logger, RateLimitDecision, RateLimiter } from '@smallseedlabs/proba-memory-core';

type RedisClient = ReturnType<typeof createClient>;

export interface RedisRateLimiterOptions {
  url: string;
  /** Prefix of every key, so limiters of different deployments can share a Redis. */
  keyPrefix?: string;
  connectTimeoutMs?: number;
  logger?: Logger;
}

// INCR and the expiry set atomically: a crash between them can never leave a counter that never expires.
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if c == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
`;

/**
 * Fixed-window limiter on Redis, shared by every audit-api replica. If Redis cannot be reached the
 * limiter fails OPEN (the request is allowed and the error is logged): the rate limit protects the
 * service, it is not what keeps data private, and an audit-api that cannot reach Redis cannot emit
 * its own audit events anyway, so the reads are refused there.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly client: RedisClient;
  private connecting?: Promise<void>;

  constructor(private readonly options: RedisRateLimiterOptions) {
    const timeoutMs = options.connectTimeoutMs ?? 3000;
    this.client = createClient({
      url: options.url,
      // Never queue commands while disconnected and never retry in a tight loop: a limiter that cannot
      // reach Redis must answer immediately (fail open), not hold the request.
      disableOfflineQueue: true,
      socket: { connectTimeout: timeoutMs, reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
    });
    this.client.on('error', (err) => options.logger?.error('rate limiter redis error', { err }));
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    try {
      await this.connect();
      const reply = (await this.withTimeout(this.client.eval(HIT_SCRIPT, { keys: [this.key(key)], arguments: [String(windowMs)] }))) as [number, number];
      return decide(Number(reply[0]), Number(reply[1]), limit, true);
    } catch (err) {
      this.options.logger?.error('rate limiter unavailable, allowing the request', { err });
      return { allowed: true, limit, remaining: limit, retryAfterSeconds: 1 };
    }
  }

  async peek(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    try {
      await this.connect();
      const [count, ttl] = await this.withTimeout(Promise.all([this.client.get(this.key(key)), this.client.pTTL(this.key(key))]));
      return decide(Number(count ?? 0), ttl > 0 ? ttl : windowMs, limit, false);
    } catch (err) {
      this.options.logger?.error('rate limiter unavailable, allowing the request', { err });
      return { allowed: true, limit, remaining: limit, retryAfterSeconds: 1 };
    }
  }

  async close(): Promise<void> {
    if (!this.client.isOpen) return;
    if (this.client.isReady) {
      await this.client.quit().catch(() => this.client.disconnect());
    } else {
      await this.client.disconnect(); // still connecting or reconnecting: there is nothing to quit
    }
  }

  private key(key: string): string {
    return `${this.options.keyPrefix ?? 'proba:memory-api:rl'}:${key}`;
  }

  private async connect(): Promise<void> {
    if (this.client.isOpen) return;
    this.connecting ??= this.withTimeout(this.client.connect()).then(
      () => undefined,
      (err) => {
        this.connecting = undefined;
        throw err;
      }
    );
    await this.connecting;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis did not answer in time')), this.options.connectTimeoutMs ?? 3000);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

/** After a hit, the hit itself is allowed while count <= limit. Peeking, the NEXT hit is allowed while count < limit. */
function decide(count: number, ttlMs: number, limit: number, counted: boolean): RateLimitDecision {
  const allowed = counted ? count <= limit : count < limit;
  return { allowed, limit, remaining: Math.max(0, limit - count), retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
}
