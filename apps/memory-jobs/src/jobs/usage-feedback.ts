import { clamp01, round, type Job, type JobContext, type JobResult, type RetrievalLogEntry, type RetrievalVerdict, type StoredObservation } from '@smallseedlabs/proba-memory-core';
import type { UsageFeedbackConfig } from '../job-configs.js';
import { isDecisive } from './evidence.js';
import { capIds, jobDraft, loadJobConfig, need, type JobDeps } from './shared.js';

const MS_PER_HOUR = 3_600_000;

/** The first approval or rejection in the retrieval's trace that came after the retrieval. */
export function decisiveObservation(entry: RetrievalLogEntry, observations: StoredObservation[]): StoredObservation | null {
  return observations.find((o) => o.traceId === entry.traceId && isDecisive(o.kind) && o.occurredAt >= entry.createdAt) ?? null;
}

export const verdictOf = (o: StoredObservation): Exclude<RetrievalVerdict, 'none'> => (o.kind === 'approval.granted' ? 'approved' : 'rejected');

/** usefulness moves toward `target` by learningRate x position weight of the distance. */
export function nextUsefulness(current: number, target: number, position: number, cfg: Pick<UsageFeedbackConfig, 'learningRate' | 'positionDiscount'>): number {
  const weight = 1 / (1 + cfg.positionDiscount * Math.max(0, position - 1));
  return clamp01(current + cfg.learningRate * weight * (target - current));
}

/**
 * Usage feedback: updates the learned `usefulness` feature of memories from what happened after they were retrieved.
 *  1. Resolve: a retrieval whose trace later saw an approval granted or rejected gets that outcome (first one wins);
 *     one with no such observation after `outcomeWindowHours` is closed as `none`.
 *  2. Apply: each memory returned by an approved retrieval moves toward `approvedTarget`, by a rejected one toward
 *     `rejectedTarget`, by learningRate and a discount for lower positions. Retrievals with outcome `none` change
 *     nothing. The claim on a retrieval's outcome commits in the same transaction as its usefulness updates, so an
 *     outcome is applied exactly once however often the job runs or overlaps.
 * This is a correlation between a retrieval and a decision, not proof the memory caused it.
 */
export class UsageFeedbackJob implements Job {
  readonly name = 'usage-feedback';
  readonly description = 'Update the learned usefulness of memories from the outcomes of the retrievals that returned them.';
  readonly intervalMs: number;

  constructor(private readonly deps: JobDeps) {
    this.intervalMs = deps.intervalsMs['usage-feedback'];
    need(deps.logStore, 'retrieval log store', this.name);
  }

  async run(ctx: JobContext): Promise<JobResult> {
    const logStore = need(this.deps.logStore, 'retrieval log store', this.name);
    const loaded = await loadJobConfig(ctx, this.deps.configs, 'usage-feedback');
    const cfg: UsageFeedbackConfig = loaded.config;
    const now = ctx.clock.isoNow();
    const windowEnd = new Date(ctx.clock.now().getTime() - cfg.outcomeWindowHours * MS_PER_HOUR).toISOString();

    // 1. Resolve outcomes.
    const unresolved = await logStore.listUnresolved(ctx.workspaceId, { createdBefore: now, limit: cfg.maxLogsPerRun });
    const observations = await ctx.store.listObservationsByTrace(ctx.workspaceId, unresolved.map((e) => e.traceId));
    let approved = 0;
    let rejected = 0;
    let closedNone = 0;
    for (const entry of unresolved) {
      const decisive = decisiveObservation(entry, observations);
      let verdict: RetrievalVerdict | null = null;
      if (decisive) verdict = verdictOf(decisive);
      else if (entry.createdAt <= windowEnd) verdict = 'none';
      if (!verdict) continue;
      if (verdict === 'approved') approved += 1;
      else if (verdict === 'rejected') rejected += 1;
      else closedNone += 1;
      if (ctx.dryRun) continue;
      await logStore.recordOutcome(ctx.workspaceId, entry.id, { verdict, ...(decisive ? { observationId: decisive.id } : {}), resolvedAt: now });
    }

    // 2. Apply them.
    const toApply = await logStore.listUnapplied(ctx.workspaceId, { limit: cfg.maxLogsPerRun });
    let logsApplied = 0;
    let memoriesUpdated = 0;
    for (const entry of toApply) {
      if (ctx.signal.aborted) break;
      const n = ctx.dryRun ? await this.plan(ctx, cfg, entry) : await this.apply(ctx, cfg, loaded.version, entry, now);
      if (n === null) continue;
      logsApplied += 1;
      memoriesUpdated += n;
    }

    return {
      processed: unresolved.length + toApply.length,
      changed: ctx.dryRun ? 0 : approved + rejected + closedNone + memoriesUpdated,
      details: { configVersion: loaded.version, resolved: { approved, rejected, none: closedNone }, logsApplied, memoriesUpdated },
    };
  }

  /** How many memories this entry's outcome would move (dry run). */
  private async plan(ctx: JobContext, cfg: UsageFeedbackConfig, entry: RetrievalLogEntry): Promise<number | null> {
    const verdict = entry.outcome?.verdict;
    if (!verdict) return null;
    if (verdict === 'none') return 0;
    const target = verdict === 'approved' ? cfg.approvedTarget : cfg.rejectedTarget;
    const memories = new Map((await ctx.store.getMemories(ctx.workspaceId, entry.results.map((r) => r.id))).map((m) => [m.id, m]));
    return entry.results.filter((r) => {
      const m = memories.get(r.id);
      return m && m.status === 'active' && Math.abs(nextUsefulness(m.usefulness, target, r.position, cfg) - m.usefulness) >= cfg.minChange;
    }).length;
  }

  private async apply(ctx: JobContext, cfg: UsageFeedbackConfig, configVersion: number, entry: RetrievalLogEntry, now: string): Promise<number | null> {
    const logStore = need(this.deps.logStore, 'retrieval log store', this.name);
    const verdict = entry.outcome?.verdict;
    if (!verdict) return null;
    return ctx.store.transaction(async (tx) => {
      // The claim and the updates commit together: exactly one runner applies an outcome.
      const claimed = await logStore.markOutcomeApplied(ctx.workspaceId, entry.id, now, tx.handle);
      if (!claimed) return null;
      if (verdict === 'none') return 0;
      const target = verdict === 'approved' ? cfg.approvedTarget : cfg.rejectedTarget;
      const updated: string[] = [];
      for (const result of entry.results) {
        const memory = await tx.getMemory(ctx.workspaceId, result.id);
        if (!memory || memory.status !== 'active') continue;
        const next = nextUsefulness(memory.usefulness, target, result.position, cfg);
        if (Math.abs(next - memory.usefulness) < cfg.minChange) continue;
        const ok = await tx.updateMemory(ctx.workspaceId, memory.id, { usefulness: next }, now);
        if (ok) updated.push(memory.id);
      }
      if (updated.length > 0) {
        await ctx.emitter.emit(
          jobDraft({
            ctx,
            service: this.deps.service,
            job: 'usage-feedback',
            action: 'memory.usage_updated',
            memoryId: updated[0],
            configVersion,
            details: { retrievalId: entry.id, verdict, updated: updated.length, results: entry.results.length, memoryIds: capIds(updated).ids, learningRate: round(cfg.learningRate) },
          }),
          { tx: tx.handle }
        );
      }
      return updated.length;
    });
  }
}
