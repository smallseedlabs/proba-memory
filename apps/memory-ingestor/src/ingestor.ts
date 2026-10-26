import type { Logger, Observation, PipelineResult, SourceAdapter, SourceItem } from '@smallseedlabs/proba-memory-core';

/** What the ingestor needs of the write path (WritePipeline satisfies it). */
export interface ObservationProcessor {
  process(observation: Observation): Promise<PipelineResult>;
}

export interface IngestorOptions {
  sources: SourceAdapter[];
  pipeline: ObservationProcessor;
  logger: Logger;
  /** Observations processed at the same time per source. */
  concurrency: number;
  /** How often to ask each source for items another consumer left pending. */
  reclaimIntervalMs: number;
  /** Backoff when a source itself fails (not an item): base and ceiling. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** How long one poll may wait for new items (sources that block, like Redis Streams). */
  pollBlockMs?: number;
  /** Pause after a poll that returned nothing, per source (sources that do not block poll again after this). */
  idleDelayMs?: (source: SourceAdapter) => number;
  /** Items fetched per poll. */
  batchSize?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface IngestTotals {
  polled: number;
  processed: number;
  skipped: number;
  duplicate: number;
  failed: number;
  created: number;
  merged: number;
  superseded: number;
}

const emptyTotals = (): IngestTotals => ({ polled: 0, processed: 0, skipped: 0, duplicate: 0, failed: 0, created: 0, merged: 0, superseded: 0 });

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Pulls Observations from every configured source and runs each through the write path.
 *
 * An item is acknowledged only after the pipeline finished it (processed, skipped or already done).
 * A failure leaves it pending: the source hands it out again (reclaim) and, after too many deliveries,
 * dead-letters it. The write path is idempotent by observation id, so redelivery is always safe.
 */
export class Ingestor {
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];
  private readonly totals = emptyTotals();
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private started = false;

  constructor(private readonly options: IngestorOptions) {
    this.sleep = options.sleep ?? abortableSleep;
  }

  get stats(): Readonly<IngestTotals> {
    return { ...this.totals };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const source of this.options.sources) {
      this.loops.push(this.pollLoop(source), this.reclaimLoop(source));
    }
    this.options.logger.info('ingestor started', { lifecycle: 'ingestor_started', sources: this.options.sources.map((s) => s.name), concurrency: this.options.concurrency });
  }

  /** Stop polling and wait for observations in progress to finish. */
  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.loops);
    this.loops = [];
    this.started = false;
  }

  /** Poll each source until it returns nothing, once. For the seed command and tests. */
  async drain(maxRounds = 1000): Promise<IngestTotals> {
    const totals = emptyTotals();
    for (const source of this.options.sources) {
      for (let round = 0; round < maxRounds; round += 1) {
        const items = await source.poll({ max: this.options.batchSize ?? 50, blockMs: 0 });
        if (items.length === 0) break;
        this.add(totals, await this.handle(source, items));
      }
    }
    return totals;
  }

  private add(into: IngestTotals, from: IngestTotals): void {
    for (const key of Object.keys(into) as (keyof IngestTotals)[]) {
      into[key] += from[key];
      this.totals[key] += from[key];
    }
  }

  private async pollLoop(source: SourceAdapter): Promise<void> {
    const { logger } = this.options;
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const items = await source.poll({ max: this.options.batchSize ?? 50, blockMs: this.options.pollBlockMs ?? 2000 });
        failures = 0;
        if (items.length === 0) {
          // Sources that do not block (the content feed) would spin: wait a little between empty polls.
          await this.sleep(this.options.idleDelayMs?.(source) ?? 100, this.abort.signal);
          continue;
        }
        this.add(emptyTotals(), await this.handle(source, items));
      } catch (err) {
        failures += 1;
        const delay = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** Math.min(failures - 1, 10));
        logger.error('source poll failed', { source: source.name, failures, retryInMs: delay, err });
        await this.sleep(delay, this.abort.signal);
      }
    }
  }

  private async reclaimLoop(source: SourceAdapter): Promise<void> {
    const { logger } = this.options;
    while (!this.abort.signal.aborted) {
      await this.sleep(this.options.reclaimIntervalMs, this.abort.signal);
      if (this.abort.signal.aborted) return;
      try {
        const items = await source.reclaim({ max: this.options.batchSize ?? 50 });
        if (items.length > 0) {
          logger.info('reclaimed pending items', { source: source.name, count: items.length });
          this.add(emptyTotals(), await this.handle(source, items));
        }
      } catch (err) {
        logger.error('source reclaim failed', { source: source.name, err });
      }
    }
  }

  /** Process a batch with bounded concurrency. Never throws: a failing item is counted and left pending. */
  private async handle(source: SourceAdapter, items: SourceItem[]): Promise<IngestTotals> {
    const totals = emptyTotals();
    totals.polled = items.length;
    const queue = [...items];
    const worker = async (): Promise<void> => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        await this.one(source, item, totals);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.options.concurrency, items.length)) }, worker));
    return totals;
  }

  private async one(source: SourceAdapter, item: SourceItem, totals: IngestTotals): Promise<void> {
    const { logger } = this.options;
    try {
      const result = await this.options.pipeline.process(item.observation);
      totals[result.status] += 1;
      totals.created += result.created.length;
      totals.merged += result.merged.length;
      totals.superseded += result.superseded.length;
      await item.ack();
    } catch (err) {
      totals.failed += 1;
      logger.error('observation not processed, left pending for redelivery', {
        source: source.name,
        observationId: item.observation.id,
        workspaceId: item.observation.workspaceId,
        deliveryCount: item.deliveryCount,
        err,
      });
    }
  }
}
