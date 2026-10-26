import type { Clock, RateLimitDecision, RateLimiter } from '@smallseedlabs/proba-memory-core';
import { SystemClock } from '../runtime/system.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_KEYS = 10_000;

/**
 * Fixed-window, in-process limiter (same approach as proba-hub's sign-in limiter). Right for a single
 * memory-api instance; with several replicas use the `redis` adapter so the limit is shared.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly clock: Clock = new SystemClock()) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = this.clock.now().getTime();
    let bucket = this.live(key, now);
    if (!bucket) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
      if (this.buckets.size > MAX_KEYS) this.sweep(now);
    }
    bucket.count += 1;
    return decision(bucket, limit, now, true);
  }

  async peek(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = this.clock.now().getTime();
    return decision(this.live(key, now) ?? { count: 0, resetAt: now + windowMs }, limit, now, false);
  }

  async close(): Promise<void> {
    this.buckets.clear();
  }

  private live(key: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= now) {
      this.buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}

/** After a hit, the hit itself is allowed while count <= limit. Peeking, the NEXT hit is allowed while count < limit. */
function decision(bucket: Bucket, limit: number, now: number, counted: boolean): RateLimitDecision {
  const allowed = counted ? bucket.count <= limit : bucket.count < limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}
