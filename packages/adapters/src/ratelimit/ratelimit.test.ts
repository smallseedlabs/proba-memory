import { describe, expect, it } from 'vitest';
import { ManualClock } from '../memory/clock-ids.js';
import { InMemoryRateLimiter } from './memory-rate-limiter.js';
import { runRateLimiterContract } from './rate-limiter.contract.js';

runRateLimiterContract('memory', async () => {
  const clock = new ManualClock();
  return { limiter: new InMemoryRateLimiter(clock), advance: (ms) => clock.advance(ms) };
});

describe('InMemoryRateLimiter windows', () => {
  it('opens a new window after windowMs and counts keys separately', async () => {
    const clock = new ManualClock();
    const limiter = new InMemoryRateLimiter(clock);
    for (let i = 0; i < 2; i += 1) expect((await limiter.hit('a', 2, 1000)).allowed).toBe(true);
    const blocked = await limiter.hit('a', 2, 1000);
    expect(blocked).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 1, limit: 2 });
    expect((await limiter.hit('b', 2, 1000)).allowed).toBe(true);
    clock.advance(1001);
    expect(await limiter.hit('a', 2, 1000)).toMatchObject({ allowed: true, remaining: 1 });
  });
});
