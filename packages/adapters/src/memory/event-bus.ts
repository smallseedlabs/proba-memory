import {
  deadLetterPayload,
  type BusMessage,
  type Clock,
  type DeadLetter,
  type EventBus,
  type PublishOptions,
  type ReadOptions,
  type ReclaimOptions,
  type SubscribeOptions,
  type Subscription,
} from '@smallseedlabs/proba-memory-core';
import { SystemClock } from '../runtime/system.js';

interface Entry {
  id: string;
  seq: number;
  payload: unknown;
  key?: string;
  publishedAt: string;
}

interface Pending {
  entry: Entry;
  consumer: string;
  deliveredAtMs: number;
  deliveryCount: number;
}

interface Group {
  cursor: number;
  pending: Map<string, Pending>;
}

interface Topic {
  entries: Entry[];
  groups: Map<string, Group>;
  dead: DeadLetter[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** In-process EventBus following the port's delivery model. For tests and local runs. */
export class InMemoryEventBus implements EventBus {
  private readonly topics = new Map<string, Topic>();
  private seq = 0;
  private closed = false;

  constructor(private readonly clock: Clock = new SystemClock()) {}

  async publish(topic: string, payload: unknown, options: PublishOptions = {}): Promise<string> {
    this.seq += 1;
    const entry: Entry = {
      id: `${this.seq}-0`,
      seq: this.seq,
      payload: structuredClone(payload),
      key: options.key,
      publishedAt: this.clock.isoNow(),
    };
    this.topic(topic).entries.push(entry);
    return entry.id;
  }

  async publishBatch(topic: string, payloads: unknown[], options: PublishOptions = {}): Promise<string[]> {
    const ids: string[] = [];
    for (const p of payloads) ids.push(await this.publish(topic, p, options));
    return ids;
  }

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    const topic = this.topic(options.topic);
    if (!topic.groups.has(options.group)) {
      topic.groups.set(options.group, {
        cursor: options.startFrom === 'latest' ? topic.entries.length : 0,
        pending: new Map(),
      });
    }
    return new MemorySubscription(this.clock, topic, options);
  }

  async listDeadLetters<T = unknown>(topic: string, options: { max?: number } = {}): Promise<DeadLetter<T>[]> {
    return (this.topics.get(topic)?.dead ?? []).slice(0, options.max ?? 100) as DeadLetter<T>[];
  }

  async ping(): Promise<void> {
    if (this.closed) throw new Error('InMemoryEventBus is closed');
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private topic(name: string): Topic {
    let t = this.topics.get(name);
    if (!t) {
      t = { entries: [], groups: new Map(), dead: [] };
      this.topics.set(name, t);
    }
    return t;
  }
}

class MemorySubscription implements Subscription {
  readonly topic: string;
  readonly group: string;
  readonly consumer: string;
  private readonly maxDeliveries: number;
  private readonly claimIdleMs: number;

  constructor(
    private readonly clock: Clock,
    private readonly t: Topic,
    options: SubscribeOptions
  ) {
    this.topic = options.topic;
    this.group = options.group;
    this.consumer = options.consumer;
    this.maxDeliveries = options.maxDeliveries ?? 5;
    this.claimIdleMs = options.claimIdleMs ?? 60_000;
  }

  private get g(): Group {
    return this.t.groups.get(this.group)!;
  }

  async read<T = unknown>(options: ReadOptions = {}): Promise<BusMessage<T>[]> {
    const max = options.max ?? 100;
    const deadline = Date.now() + (options.blockMs ?? 0);
    for (;;) {
      const out: BusMessage<T>[] = [];
      while (out.length < max && this.g.cursor < this.t.entries.length) {
        const entry = this.t.entries[this.g.cursor++];
        this.g.pending.set(entry.id, {
          entry,
          consumer: this.consumer,
          deliveredAtMs: this.clock.now().getTime(),
          deliveryCount: 1,
        });
        out.push(this.toMessage<T>(entry, 1));
      }
      if (out.length > 0 || Date.now() >= deadline) return out;
      await sleep(5);
    }
  }

  async ack(ids: string[]): Promise<void> {
    for (const id of ids) this.g.pending.delete(id);
  }

  async reclaimPending<T = unknown>(options: ReclaimOptions = {}): Promise<BusMessage<T>[]> {
    const minIdle = options.minIdleMs ?? this.claimIdleMs;
    const max = options.max ?? 100;
    const now = this.clock.now().getTime();
    const out: BusMessage<T>[] = [];
    for (const [id, p] of [...this.g.pending]) {
      if (out.length >= max) break;
      if (now - p.deliveredAtMs < minIdle) continue;
      if (p.deliveryCount >= this.maxDeliveries) {
        this.moveToDeadLetters(p, `max deliveries (${this.maxDeliveries}) reached`);
        this.g.pending.delete(id);
        continue;
      }
      p.consumer = this.consumer;
      p.deliveredAtMs = now;
      p.deliveryCount += 1;
      out.push(this.toMessage<T>(p.entry, p.deliveryCount));
    }
    return out;
  }

  async deadLetter(messages: BusMessage[], reason: string): Promise<void> {
    for (const m of messages) {
      const p = this.g.pending.get(m.id);
      const entry = p?.entry ?? this.t.entries.find((e) => e.id === m.id);
      if (!entry) continue;
      this.moveToDeadLetters(p ?? { entry, consumer: this.consumer, deliveredAtMs: 0, deliveryCount: m.deliveryCount }, reason);
      this.g.pending.delete(m.id);
    }
  }

  async pendingCount(): Promise<number> {
    return this.g.pending.size;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  private moveToDeadLetters(p: Pending, reason: string): void {
    this.t.dead.push({
      id: `${this.t.dead.length + 1}-0`,
      topic: this.topic,
      originalId: p.entry.id,
      group: this.group,
      payload: deadLetterPayload(structuredClone(p.entry.payload)),
      reason,
      deliveryCount: p.deliveryCount,
      deadAt: this.clock.isoNow(),
    });
  }

  private toMessage<T>(entry: Entry, deliveryCount: number): BusMessage<T> {
    return {
      id: entry.id,
      topic: this.topic,
      payload: structuredClone(entry.payload) as T,
      ...(entry.key !== undefined ? { key: entry.key } : {}),
      publishedAt: entry.publishedAt,
      deliveryCount,
    };
  }
}
