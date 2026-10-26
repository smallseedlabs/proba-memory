/**
 * EventBus port: durable, at-least-once messaging with consumer groups.
 *
 * Delivery model (every adapter must follow it):
 * - publish appends a message to a topic.
 * - Each consumer group sees every message once; consumers in the same group
 *   share the work.
 * - read() delivers new messages to a consumer. They stay *pending* for the group
 *   until ack()ed.
 * - reclaimPending() re-delivers pending messages that have been idle too long
 *   (a crashed or slow consumer). Each delivery increments deliveryCount.
 * - A message that reaches maxDeliveries without an ack is dead-lettered by
 *   reclaimPending(); consumers can also deadLetter() a poison message at once.
 *   Dead letters live in the topic's dead-letter store (see dlqTopic).
 */

export interface PublishOptions {
  /** Optional partition/ordering hint. Adapters may ignore it. */
  key?: string;
}

export interface BusMessage<T = unknown> {
  /** Adapter-assigned id, unique within the topic and ordered. */
  id: string;
  topic: string;
  payload: T;
  key?: string;
  /** UTC ISO 8601 with trailing Z. */
  publishedAt: string;
  /** 1 on first delivery, +1 on every re-delivery to the group. */
  deliveryCount: number;
}

export interface SubscribeOptions {
  topic: string;
  group: string;
  /** Unique within the group, for example hostname-pid. */
  consumer: string;
  /** Where a brand-new group starts. Default 'earliest'. */
  startFrom?: 'earliest' | 'latest';
  /** Dead-letter after this many unacked deliveries. Default 5. */
  maxDeliveries?: number;
  /** Default minimum idle time before a pending message may be reclaimed. Default 60000. */
  claimIdleMs?: number;
}

export interface ReadOptions {
  /** Max messages to return. Default 100. */
  max?: number;
  /** Wait up to this long for a message when none is available. Default 0 (do not wait). */
  blockMs?: number;
}

export interface ReclaimOptions {
  /** Overrides SubscribeOptions.claimIdleMs. */
  minIdleMs?: number;
  /** Max messages to return. Default 100. */
  max?: number;
}

export interface DeadLetter<T = unknown> {
  id: string;
  topic: string;
  originalId: string;
  group: string;
  payload: T;
  reason: string;
  deliveryCount: number;
  /** UTC ISO 8601 with trailing Z. */
  deadAt: string;
}

export interface Subscription {
  readonly topic: string;
  readonly group: string;
  readonly consumer: string;
  /** New messages for this group, delivered to this consumer. */
  read<T = unknown>(options?: ReadOptions): Promise<BusMessage<T>[]>;
  /** Acknowledge messages so they are never delivered again to this group. */
  ack(ids: string[]): Promise<void>;
  /**
   * Take over pending messages idle for at least minIdleMs and return them for
   * retry. Messages already delivered maxDeliveries times are dead-lettered
   * instead of returned.
   */
  reclaimPending<T = unknown>(options?: ReclaimOptions): Promise<BusMessage<T>[]>;
  /** Copy messages to the dead-letter store with a reason, and ack them. */
  deadLetter(messages: BusMessage[], reason: string): Promise<void>;
  /** Number of delivered but unacknowledged messages for the group. */
  pendingCount(): Promise<number>;
  close(): Promise<void>;
}

export interface EventBus {
  publish(topic: string, payload: unknown, options?: PublishOptions): Promise<string>;
  /** Publishes in order; returns ids in the same order. */
  publishBatch(topic: string, payloads: unknown[], options?: PublishOptions): Promise<string[]>;
  /** Creates the consumer group if it does not exist. */
  subscribe(options: SubscribeOptions): Promise<Subscription>;
  listDeadLetters<T = unknown>(topic: string, options?: { max?: number }): Promise<DeadLetter<T>[]>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Name of the dead-letter store for a topic. Adapters use it as stream/topic name. */
export function dlqTopic(topic: string): string {
  return `${topic}.dlq`;
}

/**
 * What a dead-letter store keeps of a payload. Audit events may carry raw conversation text in a top-level
 * `content` field (protocol 0.3.3); the dead-letter store is operational data that people browse, so it
 * never keeps a second copy: the field is dropped and `contentRemoved: true` marks the gap.
 * Adapters apply this to every payload they dead-letter (explicitly or after too many deliveries).
 */
export function deadLetterPayload<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('content' in payload)) return payload;
  const { content: _content, ...rest } = payload as Record<string, unknown>;
  return { ...rest, contentRemoved: true } as T;
}
