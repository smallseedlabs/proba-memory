import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RateLimiter } from '@smallseedlabs/proba-memory-core';

export interface RateLimiterHarness {
  limiter: RateLimiter;
  /** Move time forward: advances a manual clock, or really waits for adapters that use real time. */
  advance: (ms: number) => Promise<void> | void;
}

/** Contract any RateLimiter adapter must satisfy. Keys are unique per test so a shared Redis can run it. */
export function runRateLimiterContract(name: string, factory: () => Promise<RateLimiterHarness>): void {
  describe(`RateLimiter contract: ${name}`, () => {
    const open: RateLimiter[] = [];
    let advance: RateLimiterHarness['advance'] = () => undefined;
    afterEach(async () => {
      while (open.length) await open.pop()!.close();
    });
    const create = async (): Promise<RateLimiter> => {
      const h = await factory();
      advance = h.advance;
      open.push(h.limiter);
      return h.limiter;
    };

    it('allows `limit` hits per window and then refuses with a retry time', async () => {
      const limiter = await create();
      const key = `k-${randomUUID()}`;
      const results = [];
      for (let i = 0; i < 4; i += 1) results.push(await limiter.hit(key, 3, 60_000));
      expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
      expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
      expect(results[3].limit).toBe(3);
      expect(results[3].retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(results[3].retryAfterSeconds).toBeLessThanOrEqual(60);
    });

    it('counts keys separately', async () => {
      const limiter = await create();
      const a = `a-${randomUUID()}`;
      const b = `b-${randomUUID()}`;
      await limiter.hit(a, 1, 60_000);
      expect((await limiter.hit(a, 1, 60_000)).allowed).toBe(false);
      expect((await limiter.hit(b, 1, 60_000)).allowed).toBe(true);
    });

    it('peeks without counting: the next hit is allowed while fewer than `limit` were counted', async () => {
      const limiter = await create();
      const key = `p-${randomUUID()}`;
      expect(await limiter.peek(key, 2, 60_000)).toMatchObject({ allowed: true, remaining: 2 });
      await limiter.hit(key, 2, 60_000);
      expect(await limiter.peek(key, 2, 60_000)).toMatchObject({ allowed: true, remaining: 1 });
      await limiter.hit(key, 2, 60_000);
      expect(await limiter.peek(key, 2, 60_000)).toMatchObject({ allowed: false, remaining: 0 });
      expect(await limiter.peek(key, 2, 60_000)).toMatchObject({ allowed: false }); // peeking changed nothing
    });

    it('starts a new window once the old one has passed', async () => {
      const limiter = await create();
      const key = `w-${randomUUID()}`;
      await limiter.hit(key, 1, 150);
      expect((await limiter.hit(key, 1, 150)).allowed).toBe(false);
      await advance(200);
      expect((await limiter.hit(key, 1, 150)).allowed).toBe(true);
    });
  });
}
