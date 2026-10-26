import { decayValue, type MemoryCategory } from '@smallseedlabs/proba-memory-scoring';
import { MEMORY_ACTOR, round, type Job, type JobContext, type JobResult, type Memory } from '@smallseedlabs/proba-memory-core';

export interface DecayOptions {
  intervalMs: number;
  /** Memories examined and updated per transaction. */
  batchSize: number;
  /** Confidence never decays below this (or below its current value if that is already lower). */
  confidenceFloor: number;
  importanceFloor: number;
  /** Importance decays with half-life = category half-life x this. */
  importanceHalfLifeMultiplier: number;
  /** A memory is only rewritten when confidence or importance would move by at least this much. */
  minChange: number;
  halfLifeDays: Record<MemoryCategory, number>;
  /** Service name stamped on the audit events. */
  service: string;
}

export interface DecayChange {
  confidence: number;
  importance: number;
}

const DAY_MS = 86_400_000;
/** Ids listed in one memory.decayed event (the count is always exact). */
const MAX_EVENT_IDS = 50;

/**
 * What decay does to one memory at `now`, or null when nothing needs to change.
 *
 * Confidence and importance fall exponentially toward their floors with the category's half-life,
 * measured from the last time the memory was reinforced or last decayed (whichever is later), so
 * running the job twice in a row, or more often than needed, changes nothing the second time.
 * Changes smaller than `minChange` are skipped and the clock is NOT reset, so they accumulate.
 */
export function computeDecay(memory: Memory, now: string, options: DecayOptions): DecayChange | null {
  const reference = Math.max(Date.parse(memory.lastReinforcedAt), memory.decayedAt ? Date.parse(memory.decayedAt) : 0);
  const elapsedDays = (Date.parse(now) - reference) / DAY_MS;
  if (!Number.isFinite(elapsedDays) || elapsedDays <= 0) return null;
  const halfLife = options.halfLifeDays[memory.category];
  const confidence = decayValue(memory.confidence, elapsedDays, halfLife, options.confidenceFloor);
  const importance = decayValue(memory.importance, elapsedDays, halfLife * options.importanceHalfLifeMultiplier, options.importanceFloor);
  const moved = Math.max(memory.confidence - confidence, memory.importance - importance);
  if (moved < options.minChange) return null;
  return { confidence, importance };
}

/**
 * Decay job: memories that nobody reinforces lose confidence and importance over time, at a
 * per-category pace (working memory fast, procedural and super memory slowly). Never deletes and never
 * changes a memory's status: a decayed memory still exists and simply ranks lower until it is reinforced.
 * One memory.decayed audit event per batch, committed in the same transaction as the changes.
 */
export class DecayJob implements Job {
  readonly name = 'decay';
  readonly description = 'Lower confidence and importance of memories that have not been reinforced, per category half-life.';
  readonly intervalMs: number;

  constructor(private readonly options: DecayOptions) {
    this.intervalMs = options.intervalMs;
  }

  async run(ctx: JobContext): Promise<JobResult> {
    const { store, logger, workspaceId } = ctx;
    let processed = 0;
    let changed = 0;
    let batches = 0;
    let cursor: string | undefined;
    do {
      if (ctx.signal.aborted) {
        logger.info('decay stopped early: shutting down', { processed, changed });
        break;
      }
      const page = await store.listMemories({ workspaceId, filter: { statuses: ['active'] }, limit: this.options.batchSize, ...(cursor ? { cursor } : {}) });
      cursor = page.nextCursor ?? undefined;
      if (page.memories.length === 0) break;
      processed += page.memories.length;
      const applied = await this.applyBatch(ctx, page.memories, batches + 1);
      changed += applied;
      batches += 1;
    } while (cursor);
    return { processed, changed, details: { batches } };
  }

  private async applyBatch(ctx: JobContext, batch: Memory[], batchNumber: number): Promise<number> {
    const now = ctx.clock.isoNow();
    return ctx.store.transaction(async (tx) => {
      const ids: string[] = [];
      const byCategory: Record<string, number> = {};
      let confidenceLost = 0;
      let importanceLost = 0;
      for (const listed of batch) {
        // Re-read inside the transaction: it may have been reinforced or retired since the page was read.
        const memory = await tx.getMemory(ctx.workspaceId, listed.id);
        if (!memory || memory.status !== 'active') continue;
        const change = computeDecay(memory, now, this.options);
        if (!change) continue;
        const ok = await tx.updateMemory(ctx.workspaceId, memory.id, { ...change, decayedAt: now }, now);
        if (!ok) continue;
        ids.push(memory.id);
        byCategory[memory.category] = (byCategory[memory.category] ?? 0) + 1;
        confidenceLost += memory.confidence - change.confidence;
        importanceLost += memory.importance - change.importance;
      }
      if (ids.length > 0) {
        await ctx.emitter.emit(
          {
            actor: MEMORY_ACTOR(this.options.service),
            workspaceId: ctx.workspaceId,
            action: 'memory.decayed',
            category: 'memory',
            outcome: 'success',
            target: { type: 'job', id: this.name },
            details: {
              job: this.name,
              runId: ctx.runId,
              batch: batchNumber,
              examined: batch.length,
              decayed: ids.length,
              byCategory,
              meanConfidenceLoss: round(confidenceLost / ids.length),
              meanImportanceLoss: round(importanceLost / ids.length),
              memoryIds: ids.slice(0, MAX_EVENT_IDS),
              memoryIdsTruncated: ids.length > MAX_EVENT_IDS,
            },
          },
          { tx: tx.handle }
        );
      }
      ctx.logger.info('decay batch applied', { batch: batchNumber, examined: batch.length, decayed: ids.length });
      return ids.length;
    });
  }
}
