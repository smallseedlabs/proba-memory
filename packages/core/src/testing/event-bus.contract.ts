import { afterEach, describe, expect, it } from 'vitest';
import { dlqTopic, type EventBus } from '../ports/event-bus.js';
import { sleep, uniqueName } from './fixtures.js';

export interface EventBusHarness {
  bus: EventBus;
  cleanup?: () => Promise<void>;
}

/**
 * Contract any EventBus adapter must satisfy.
 *
 *   runEventBusContract('redis-streams', async () => ({ bus: new RedisStreamsEventBus(...) }));
 */
export function runEventBusContract(name: string, factory: () => Promise<EventBusHarness>): void {
  describe(`EventBus contract: ${name}`, () => {
    const harnesses: EventBusHarness[] = [];

    async function create(): Promise<EventBus> {
      const h = await factory();
      harnesses.push(h);
      return h.bus;
    }

    afterEach(async () => {
      while (harnesses.length) {
        const h = harnesses.pop()!;
        await h.bus.close();
        await h.cleanup?.();
      }
    });

    const sub = (bus: EventBus, topic: string, extra: Partial<Parameters<EventBus['subscribe']>[0]> = {}) =>
      bus.subscribe({ topic, group: 'g1', consumer: 'c1', ...extra });

    it('pings', async () => {
      const bus = await create();
      await expect(bus.ping()).resolves.toBeUndefined();
    });

    it('delivers a published message with payload, id and deliveryCount 1', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const s = await sub(bus, topic);
      const id = await bus.publish(topic, { hello: 'world', n: 1 });
      const msgs = await s.read({ max: 10, blockMs: 1000 });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ id, topic, payload: { hello: 'world', n: 1 }, deliveryCount: 1 });
      expect(msgs[0].publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    });

    it('publishBatch keeps order and returns ids in order', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const s = await sub(bus, topic);
      const ids = await bus.publishBatch(topic, [{ i: 0 }, { i: 1 }, { i: 2 }]);
      expect(ids).toHaveLength(3);
      const msgs = await s.read({ max: 10, blockMs: 1000 });
      expect(msgs.map((m) => (m.payload as { i: number }).i)).toEqual([0, 1, 2]);
      expect(msgs.map((m) => m.id)).toEqual(ids);
    });

    it('returns nothing (and does not hang) when empty', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const s = await sub(bus, topic);
      const started = Date.now();
      const msgs = await s.read({ blockMs: 50 });
      expect(msgs).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('starts a new group at the beginning by default, or at the end with startFrom latest', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      await bus.publish(topic, { old: true });
      const earliest = await sub(bus, topic, { group: 'early' });
      const latest = await sub(bus, topic, { group: 'late', startFrom: 'latest' });
      await bus.publish(topic, { old: false });
      expect((await earliest.read({ blockMs: 500 })).length).toBe(2);
      const lateMsgs = await latest.read({ blockMs: 500 });
      expect(lateMsgs.map((m) => m.payload)).toEqual([{ old: false }]);
    });

    it('splits messages between consumers of one group', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const a = await sub(bus, topic, { consumer: 'a' });
      const b = await sub(bus, topic, { consumer: 'b' });
      await bus.publishBatch(topic, [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }]);
      const fromA = await a.read({ max: 2, blockMs: 500 });
      const fromB = await b.read({ max: 10, blockMs: 500 });
      const all = [...fromA, ...fromB].map((m) => m.id);
      expect(all).toHaveLength(4);
      expect(new Set(all).size).toBe(4);
      expect(fromA).toHaveLength(2);
    });

    it('delivers every message to every group', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const g1 = await sub(bus, topic, { group: 'g1' });
      const g2 = await sub(bus, topic, { group: 'g2' });
      await bus.publish(topic, { x: 1 });
      expect(await g1.read({ blockMs: 500 })).toHaveLength(1);
      expect(await g2.read({ blockMs: 500 })).toHaveLength(1);
    });

    it('keeps messages pending until acked, then forgets them', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const s = await sub(bus, topic);
      await bus.publishBatch(topic, [{ i: 1 }, { i: 2 }]);
      const msgs = await s.read({ blockMs: 500 });
      expect(await s.pendingCount()).toBe(2);
      await s.ack([msgs[0].id]);
      expect(await s.pendingCount()).toBe(1);
      await s.ack([msgs[1].id]);
      expect(await s.pendingCount()).toBe(0);
      expect(await s.read({ blockMs: 20 })).toEqual([]);
    });

    it('does not reclaim a message that is not idle long enough', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const s = await sub(bus, topic);
      await bus.publish(topic, { x: 1 });
      await s.read({ blockMs: 500 });
      expect(await s.reclaimPending({ minIdleMs: 60_000 })).toEqual([]);
    });

    it('reclaims an unacked message for retry, incrementing deliveryCount', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const crashed = await sub(bus, topic, { consumer: 'crashed' });
      const rescuer = await sub(bus, topic, { consumer: 'rescuer' });
      const id = await bus.publish(topic, { retry: true });
      await crashed.read({ blockMs: 500 });
      await sleep(20);
      const reclaimed = await rescuer.reclaimPending({ minIdleMs: 10 });
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]).toMatchObject({ id, payload: { retry: true }, deliveryCount: 2 });
      await rescuer.ack([id]);
      expect(await rescuer.pendingCount()).toBe(0);
    });

    it('dead-letters a message that reaches maxDeliveries without an ack', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const s = await sub(bus, topic, { maxDeliveries: 2 });
      const id = await bus.publish(topic, { poison: true });
      await s.read({ blockMs: 500 }); // delivery 1
      await sleep(15);
      const retry = await s.reclaimPending({ minIdleMs: 5 }); // delivery 2
      expect(retry).toHaveLength(1);
      await sleep(15);
      const none = await s.reclaimPending({ minIdleMs: 5 }); // exhausted: dead-lettered
      expect(none).toEqual([]);
      expect(await s.pendingCount()).toBe(0);
      const dead = await bus.listDeadLetters(topic);
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({
        topic,
        originalId: id,
        group: 'g1',
        payload: { poison: true },
        deliveryCount: 2,
      });
      expect(dead[0].reason).toMatch(/max/i);
      expect(dead[0].deadAt).toMatch(/Z$/);
    });

    it('dead-letters explicitly with a reason and acks the message', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const s = await sub(bus, topic);
      await bus.publish(topic, { bad: 'schema' });
      const msgs = await s.read({ blockMs: 500 });
      await s.deadLetter(msgs, 'invalid audit event');
      expect(await s.pendingCount()).toBe(0);
      const dead = await bus.listDeadLetters(topic);
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({ reason: 'invalid audit event', payload: { bad: 'schema' }, originalId: msgs[0].id });
    });

    it('keeps no raw conversation text in dead letters (a top-level `content` field is dropped)', async () => {
      const bus = await create();
      const topic = uniqueName('t');
      const s = await sub(bus, topic);
      await bus.publish(topic, { eventId: 'e1', details: { n: 1 }, content: { kind: 'user_message', text: 'private words' } });
      const msgs = await s.read({ blockMs: 500 });
      expect((msgs[0].payload as { content?: unknown }).content).toBeDefined(); // consumers still get it
      await s.deadLetter(msgs, 'poison');
      const dead = await bus.listDeadLetters(topic);
      expect(dead[0].payload).toEqual({ eventId: 'e1', details: { n: 1 }, contentRemoved: true });
      expect(JSON.stringify(dead)).not.toContain('private words');
    });

    it('exposes the dead-letter store name', () => {
      expect(dlqTopic('a.b')).toBe('a.b.dlq');
    });

    it('lists no dead letters for a topic without any', async () => {
      const bus = await create();
      expect(await bus.listDeadLetters(uniqueName('t'))).toEqual([]);
    });
  });
}
