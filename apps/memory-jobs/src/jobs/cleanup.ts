import { MEMORY_ACTOR, round, type Job, type JobContext, type JobResult, type Memory } from '@smallseedlabs/proba-memory-core';
import type { CleanupConfig } from '../job-configs.js';
import { capIds, loadJobConfig, pagesOf, type JobDeps } from './shared.js';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export type CleanupReason = 'expired_working' | 'stale_low_importance';

/** Why the memory should be tombstoned now, or null. */
export function cleanupReason(memory: Memory, nowMs: number, cfg: CleanupConfig): CleanupReason | null {
  if (memory.category === 'working') {
    const expiredByDate = memory.validTo !== null && new Date(memory.validTo).getTime() <= nowMs;
    const idleMs = nowMs - new Date(memory.lastReinforcedAt).getTime();
    if (expiredByDate || idleMs >= cfg.workingTtlHours * MS_PER_HOUR) return 'expired_working';
    return null;
  }
  if (!cfg.stale.categories.includes(memory.category) || memory.importance > cfg.stale.maxImportance) return null;
  const lastTouch = Math.max(new Date(memory.lastReinforcedAt).getTime(), memory.lastAccessedAt ? new Date(memory.lastAccessedAt).getTime() : 0);
  return nowMs - lastTouch >= cfg.stale.minIdleDays * MS_PER_DAY ? 'stale_low_importance' : null;
}

/**
 * Cleanup: tombstones working memories that have expired and stale items of low importance (nobody reinforced or
 * retrieved them for a long time, and decay has taken their importance down). It NEVER deletes: a tombstoned memory
 * keeps its row, its links and its history, and is simply no longer retrieved. One memory.tombstoned event per
 * batch, committed with the batch. Idempotent: tombstoned memories are not active, so they are not looked at again.
 */
export class CleanupJob implements Job {
  readonly name = 'cleanup';
  readonly description = 'Tombstone expired working memories and stale, low-importance memories. Never deletes.';
  readonly intervalMs: number;

  constructor(private readonly deps: JobDeps) {
    this.intervalMs = deps.intervalsMs.cleanup;
  }

  async run(ctx: JobContext): Promise<JobResult> {
    const loaded = await loadJobConfig(ctx, this.deps.configs, 'cleanup');
    const cfg: CleanupConfig = loaded.config;
    const nowMs = ctx.clock.now().getTime();
    let scanned = 0;
    let tombstoned = 0;
    const byReason: Record<CleanupReason, number> = { expired_working: 0, stale_low_importance: 0 };
    let batch = 0;
    for await (const page of pagesOf(ctx, { statuses: ['active'] }, this.deps.batchSize)) {
      scanned += page.length;
      const room = cfg.maxPerRun - tombstoned;
      if (room <= 0) break;
      const due = page.flatMap((m) => {
        const reason = cleanupReason(m, nowMs, cfg);
        return reason ? [{ memory: m, reason }] : [];
      }).slice(0, room);
      if (due.length === 0) continue;
      if (ctx.dryRun) {
        for (const d of due) byReason[d.reason] += 1;
        tombstoned += due.length;
        continue;
      }
      batch += 1;
      const applied = await this.tombstoneBatch(ctx, loaded.version, due, nowMs, cfg, batch);
      for (const reason of Object.keys(applied.byReason) as CleanupReason[]) byReason[reason] += applied.byReason[reason];
      tombstoned += applied.count;
    }
    return {
      processed: scanned,
      changed: ctx.dryRun ? 0 : tombstoned,
      details: { configVersion: loaded.version, ...(ctx.dryRun ? { wouldTombstone: tombstoned } : { tombstoned }), byReason, batches: batch },
    };
  }

  private async tombstoneBatch(
    ctx: JobContext,
    configVersion: number,
    due: { memory: Memory; reason: CleanupReason }[],
    nowMs: number,
    cfg: CleanupConfig,
    batch: number
  ): Promise<{ count: number; byReason: Record<CleanupReason, number> }> {
    return ctx.store.transaction(async (tx) => {
      const now = ctx.clock.isoNow();
      const ids: string[] = [];
      const byReason: Record<CleanupReason, number> = { expired_working: 0, stale_low_importance: 0 };
      for (const { memory: listed } of due) {
        // Re-read: it may have been reinforced, retrieved or retired since the page was read.
        const memory = await tx.getMemory(ctx.workspaceId, listed.id);
        if (!memory || memory.status !== 'active') continue;
        const reason = cleanupReason(memory, nowMs, cfg);
        if (!reason) continue;
        const ok = await tx.updateMemory(ctx.workspaceId, memory.id, { status: 'tombstoned', validTo: memory.validTo ?? now }, now);
        if (!ok) continue;
        ids.push(memory.id);
        byReason[reason] += 1;
      }
      if (ids.length > 0) {
        await ctx.emitter.emit(
          {
            actor: MEMORY_ACTOR(this.deps.service),
            workspaceId: ctx.workspaceId,
            action: 'memory.tombstoned',
            category: 'memory',
            outcome: 'success',
            target: { type: 'job', id: this.name },
            details: {
              job: this.name,
              runId: ctx.runId,
              configVersion,
              batch,
              tombstoned: ids.length,
              byReason,
              memoryIds: capIds(ids).ids,
              memoryIdsTruncated: ids.length > 25,
              workingTtlHours: round(cfg.workingTtlHours, 2),
            },
          },
          { tx: tx.handle }
        );
      }
      return { count: ids.length, byReason };
    });
  }
}
