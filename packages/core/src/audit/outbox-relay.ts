import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/event-bus.js';
import type { Logger } from '../ports/logger.js';
import type { OutboxStore } from '../ports/outbox-store.js';

export interface OutboxRelayOptions {
  outbox: OutboxStore;
  bus: EventBus;
  topic: string;
  logger: Logger;
  /** Rows per cycle. Default 100. */
  batchSize?: number;
  /** Pause between cycles when the outbox is empty. Default 500. */
  pollIntervalMs?: number;
  /** Lease on claimed rows; also the retry delay after a failure. Default 30000. */
  leaseMs?: number;
  /** Published rows older than this are pruned. 0 disables pruning. Default 24 hours. */
  retainPublishedMs?: number;
  /** Used only for pruning. */
  clock?: Clock;
}

export interface RelayCycleResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Moves outbox rows to the bus: claim, publish (in order), mark published.
 * If publishing fails the rows are marked failed and retried after the lease.
 * Delivery is at-least-once: a crash between publish and markPublished
 * re-publishes, and the audit consumer dedupes by eventId.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly retainPublishedMs: number;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private lastPrune = 0;

  constructor(private readonly options: OutboxRelayOptions) {
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retainPublishedMs = options.retainPublishedMs ?? 24 * 60 * 60 * 1000;
  }

  /** One claim/publish cycle. Never throws for a publish failure (it is recorded on the rows). */
  async runOnce(): Promise<RelayCycleResult> {
    const { outbox, bus, topic, logger } = this.options;
    const entries = await outbox.claim(this.batchSize, this.leaseMs);
    if (entries.length === 0) return { claimed: 0, published: 0, failed: 0 };

    const ids = entries.map((e) => e.id);
    try {
      await bus.publishBatch(
        topic,
        entries.map((e) => e.event)
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('outbox relay failed to publish', { err, count: entries.length, retryInMs: this.leaseMs });
      await outbox.markFailed(ids, message);
      return { claimed: entries.length, published: 0, failed: entries.length };
    }
    await outbox.markPublished(ids);
    logger.debug('outbox relay published events', { count: entries.length, topic });
    return { claimed: entries.length, published: entries.length, failed: 0 };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.options.logger.info('outbox relay started', { topic: this.options.topic });
  }

  /** Stop after the current cycle finishes. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
    this.options.logger.info('outbox relay stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = (await this.runOnce()).claimed;
        await this.maybePrune();
      } catch (err) {
        this.options.logger.error('outbox relay cycle failed', { err });
      }
      // A full batch means more is waiting: go again immediately.
      if (this.running && claimed < this.batchSize) await this.pause(this.pollIntervalMs);
    }
  }

  private async maybePrune(): Promise<void> {
    const { clock, outbox, logger } = this.options;
    if (this.retainPublishedMs <= 0 || !clock) return;
    const now = clock.now().getTime();
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    const pruned = await outbox.prunePublished(new Date(now - this.retainPublishedMs).toISOString());
    if (pruned > 0) logger.info('outbox pruned published rows', { pruned });
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
