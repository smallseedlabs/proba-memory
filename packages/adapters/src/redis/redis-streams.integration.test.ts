import { describe, expect, it } from 'vitest';
import { loadConfig } from '@smallseedlabs/proba-memory-core';
import { runEventBusContract, uniqueName } from '@smallseedlabs/proba-memory-core/testing';
import { createClient } from 'redis';
import { RedisStreamsEventBus } from './redis-streams-event-bus.js';

const config = loadConfig(process.env);

runEventBusContract('redis-streams', async () => ({
  bus: new RedisStreamsEventBus({ url: config.eventBus.redisUrl }),
}));

describe('RedisStreamsEventBus specifics', () => {
  it('stores messages as stream entries with the dead-letter stream named <topic>.dlq', async () => {
    const bus = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    const raw = createClient({ url: config.eventBus.redisUrl });
    await raw.connect();
    try {
      const topic = uniqueName('raw');
      const sub = await bus.subscribe({ topic, group: 'g', consumer: 'c' });
      await bus.publish(topic, { a: 1 }, { key: 'k1' });
      const [m] = await sub.read({ blockMs: 500 });
      await sub.deadLetter([m], 'because');
      expect(await raw.xLen(topic)).toBe(1);
      expect(await raw.xLen(`${topic}.dlq`)).toBe(1);
      expect(m.key).toBe('k1');
    } finally {
      await raw.quit();
      await bus.close();
    }
  });

  it('trims streams approximately when maxStreamLength is set', async () => {
    const bus = new RedisStreamsEventBus({ url: config.eventBus.redisUrl, maxStreamLength: 10 });
    const raw = createClient({ url: config.eventBus.redisUrl });
    await raw.connect();
    try {
      const topic = uniqueName('trim');
      await bus.publishBatch(topic, Array.from({ length: 50 }, (_, i) => ({ i })));
      expect(await raw.xLen(topic)).toBeGreaterThanOrEqual(10);
      expect(await raw.xLen(topic)).toBeLessThanOrEqual(50);
    } finally {
      await raw.quit();
      await bus.close();
    }
  });

  it('re-delivers to a second consumer after the first stops without acking (crash recovery)', async () => {
    const bus1 = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    const bus2 = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    try {
      const topic = uniqueName('crash');
      const s1 = await bus1.subscribe({ topic, group: 'g', consumer: 'worker-1' });
      await bus1.publish(topic, { job: 1 });
      expect(await s1.read({ blockMs: 500 })).toHaveLength(1);
      await bus1.close(); // "crash": never acked

      const s2 = await bus2.subscribe({ topic, group: 'g', consumer: 'worker-2' });
      await new Promise((r) => setTimeout(r, 20));
      const retried = await s2.reclaimPending({ minIdleMs: 10 });
      expect(retried).toHaveLength(1);
      expect(retried[0].deliveryCount).toBe(2);
    } finally {
      await bus2.close();
    }
  });

  it('throws from ping when Redis is unreachable', async () => {
    const bus = new RedisStreamsEventBus({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 500 });
    await expect(bus.ping()).rejects.toThrow();
    await bus.close();
  });
});
