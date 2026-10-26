import { MEMORY_ACTOR, type Job, type JobContext, type JobResult } from '@smallseedlabs/proba-memory-core';
import type { ReembedConfig } from '../job-configs.js';
import { loadJobConfig, need, type JobDeps } from './shared.js';

/**
 * Re-embed: when the embedder's model name or version (EMBEDDER_MODEL / EMBEDDER_VERSION) differs from what a
 * memory was embedded with, compute the new vector in batches and STAGE it beside the current one. Vector search
 * keeps reading the current vector, so retrieval never goes down. Once every active memory has a staged (or already
 * current) target vector, one atomic cutover makes the staged vectors current. Until then nothing user-visible changes.
 *
 * Rollout order (docs/ARCHITECTURE.md): run this job with the NEW embedder settings while memory-api and
 * memory-ingestor still use the old ones; after the cutover, move them to the new settings. Idempotent: a memory that
 * is current or staged at the target is not pending, so a second run embeds nothing and swaps nothing.
 * Only active memories are migrated; superseded and tombstoned ones are never searched.
 */
export class ReembedJob implements Job {
  readonly name = 'reembed';
  readonly description = 'Re-embed memories whose embedding model or version is not the configured one, in batches, then cut over atomically.';
  readonly intervalMs: number;

  constructor(private readonly deps: JobDeps) {
    this.intervalMs = deps.intervalsMs.reembed;
    need(deps.embedder, 'embedder', this.name);
    need(deps.migration, 'embedding migration store', this.name);
  }

  async run(ctx: JobContext): Promise<JobResult> {
    const embedder = need(this.deps.embedder, 'embedder', this.name);
    const migration = need(this.deps.migration, 'embedding migration store', this.name);
    const loaded = await loadJobConfig(ctx, this.deps.configs, 'reembed');
    const cfg: ReembedConfig = loaded.config;
    const target = { model: embedder.model, version: embedder.version };
    const start = await migration.stats(ctx.workspaceId, target);
    const details: Record<string, unknown> = { configVersion: loaded.version, target: `${target.model}@${target.version}`, before: start };
    if (ctx.dryRun) {
      return { processed: start.active, changed: 0, details: { ...details, wouldEmbed: Math.min(start.pending, cfg.maxPerRun), wouldCutOver: cfg.autoCutover && start.pending <= cfg.maxPerRun ? start.pending + start.staged : 0 } };
    }

    let staged = 0;
    let batches = 0;
    while (staged < cfg.maxPerRun && !ctx.signal.aborted) {
      const limit = Math.min(this.deps.batchSize, cfg.maxPerRun - staged);
      const pending = await migration.listPending(ctx.workspaceId, target, limit);
      if (pending.length === 0) break;
      // Memory text is already redacted at ingestion; redact again before it leaves the process.
      const texts = pending.map((p) => this.deps.redactor.redact(p.text).text);
      const vectors = await embedder.embed(texts, { purpose: 'document' });
      if (vectors.length !== pending.length || vectors.some((v) => v.length !== embedder.dimension)) {
        throw new Error('the embedder returned the wrong number of vectors or a vector of the wrong length');
      }
      const written = await migration.writeStaged(ctx.workspaceId, target, pending.map((p, i) => ({ id: p.id, vector: vectors[i] })));
      batches += 1;
      staged += written;
      await ctx.emitter.emit({
        actor: MEMORY_ACTOR(this.deps.service),
        workspaceId: ctx.workspaceId,
        action: 'memory.reembedded',
        category: 'memory',
        outcome: 'success',
        target: { type: 'job', id: this.name },
        details: { job: this.name, runId: ctx.runId, configVersion: loaded.version, phase: 'staged', batch: batches, requested: pending.length, staged: written, embeddingModel: target.model, embeddingVersion: target.version },
      });
      ctx.logger.info('reembed batch staged', { batch: batches, requested: pending.length, staged: written });
      // No progress (the rows left or changed under us): stop instead of spinning; the next run continues.
      if (written === 0) break;
    }

    let swapped = 0;
    const after = await migration.stats(ctx.workspaceId, target);
    if (cfg.autoCutover && after.pending === 0 && after.staged > 0) {
      const result = await migration.cutover(ctx.workspaceId, target);
      swapped = result.swapped;
      if (swapped > 0) {
        await ctx.emitter.emit({
          actor: MEMORY_ACTOR(this.deps.service),
          workspaceId: ctx.workspaceId,
          action: 'memory.reembedded',
          category: 'memory',
          outcome: 'success',
          target: { type: 'job', id: this.name },
          details: { job: this.name, runId: ctx.runId, configVersion: loaded.version, phase: 'cutover', swapped, embeddingModel: target.model, embeddingVersion: target.version },
        });
      }
    }
    return { processed: start.active, changed: staged + swapped, details: { ...details, staged, batches, swapped, after: await migration.stats(ctx.workspaceId, target) } };
  }
}
