import { clamp01, contradicts, round, type Job, type JobContext, type JobResult, type Memory, type SourceRef } from '@smallseedlabs/proba-memory-core';
import type { CollapseConfig } from '../job-configs.js';
import { byCreatedThenId, capIds, DisjointSets, findNeighbours, jobDraft, loadJobConfig, MAX_PROVENANCE_IDS, pagesOf, uniq, type JobDeps } from './shared.js';

const MAX_SOURCE_REFS = 20;
const MAX_ADJUSTMENT_IDS = 200;

/** The memory a group of duplicates collapses into: most evidence, then most confident, then oldest, then lowest id. */
export function pickWinner(group: Memory[]): Memory {
  return [...group].sort((a, b) => b.evidenceCount - a.evidenceCount || b.confidence - a.confidence || byCreatedThenId(a, b))[0];
}

/** Each merged duplicate closes `gain` of the gap to the ceiling; never above the ceiling, never lowered. */
export function upgradedConfidence(confidence: number, merged: number, gain: number, ceiling: number): number {
  let c = confidence;
  for (let i = 0; i < merged; i += 1) c = c + (ceiling - c) * gain;
  return clamp01(Math.max(confidence, Math.min(ceiling, c)));
}

/**
 * Collapse / upgrade, in two stages:
 *  1. Collapse: active memories of the same category and stance whose vectors are at least `duplicateThreshold`
 *     similar say the same thing. The one with most evidence wins; the others are superseded, their evidence is
 *     added to the winner and the winner's confidence is upgraded.
 *  2. Adjust: each active `supports` link not seen before raises a memory's confidence, each active `contradicts`
 *     link not seen before lowers it. What was already counted is recorded on the memory (provenance.adjustments),
 *     so a link counts once however often the job runs; links to memories that are no longer active are ignored.
 */
export class CollapseJob implements Job {
  readonly name = 'collapse';
  readonly description = 'Merge memories that say the same thing; upgrade confidence when reinforced, downgrade on contradiction.';
  readonly intervalMs: number;

  constructor(private readonly deps: JobDeps) {
    this.intervalMs = deps.intervalsMs.collapse;
  }

  async run(ctx: JobContext): Promise<JobResult> {
    const loaded = await loadJobConfig(ctx, this.deps.configs, 'collapse');
    const cfg: CollapseConfig = loaded.config;
    const stage1 = await this.collapseDuplicates(ctx, cfg, loaded.version);
    const stage2 = await this.adjustConfidence(ctx, cfg, loaded.version);
    return {
      processed: stage1.scanned,
      changed: ctx.dryRun ? 0 : stage1.merged + stage1.winners + stage2.adjusted,
      details: {
        configVersion: loaded.version,
        duplicateGroups: stage1.groups,
        duplicatesMerged: stage1.merged,
        confidenceAdjusted: stage2.adjusted,
        upgraded: stage2.upgraded,
        downgraded: stage2.downgraded,
        ...(ctx.dryRun ? { dryRun: true } : {}),
      },
    };
  }

  private async collapseDuplicates(ctx: JobContext, cfg: CollapseConfig, configVersion: number): Promise<{ scanned: number; groups: number; merged: number; winners: number }> {
    const { index } = this.deps;
    const sets = new DisjointSets();
    const byId = new Map<string, Memory>();
    const similarity = new Map<string, number>();
    let scanned = 0;
    for await (const page of pagesOf(ctx, { categories: cfg.categories, statuses: ['active'] }, this.deps.batchSize)) {
      scanned += page.length;
      const vectors = await index.getVectors(ctx.workspaceId, page.map((m) => m.id));
      for (const memory of page) {
        const vector = vectors.get(memory.id);
        if (!vector) continue;
        byId.set(memory.id, memory);
        sets.add(memory.id);
        const neighbours = await findNeighbours({
          workspaceId: ctx.workspaceId,
          store: ctx.store,
          index,
          memory,
          vector,
          categories: [memory.category],
          threshold: cfg.duplicateThreshold,
          limit: cfg.neighbours,
        });
        for (const n of neighbours) {
          if (n.memory.category !== memory.category || contradicts(memory.provenance.stance, n.memory.provenance.stance)) continue;
          byId.set(n.memory.id, n.memory);
          sets.union(memory.id, n.memory.id);
          similarity.set(`${memory.id}|${n.memory.id}`, n.similarity);
          similarity.set(`${n.memory.id}|${memory.id}`, n.similarity);
        }
      }
    }
    const groups = sets
      .groups()
      .filter((g) => g.length > 1)
      .map((ids) => ids.map((id) => byId.get(id)!).sort(byCreatedThenId))
      .sort((a, b) => byCreatedThenId(a[0], b[0]))
      .slice(0, cfg.maxMergesPerRun);
    if (ctx.dryRun) return { scanned, groups: groups.length, merged: 0, winners: 0 };

    let merged = 0;
    let winners = 0;
    for (const group of groups) {
      if (ctx.signal.aborted) break;
      const n = await this.mergeGroup(ctx, cfg, configVersion, group, similarity);
      if (n > 0) {
        merged += n;
        winners += 1;
      }
    }
    return { scanned, groups: groups.length, merged, winners };
  }

  /** Returns the number of duplicates superseded (0 when the group changed under us). */
  private async mergeGroup(ctx: JobContext, cfg: CollapseConfig, configVersion: number, listed: Memory[], similarity: Map<string, number>): Promise<number> {
    return ctx.store.transaction(async (tx) => {
      const now = ctx.clock.isoNow();
      const fresh = (await tx.getMemories(ctx.workspaceId, listed.map((m) => m.id))).filter((m) => m.status === 'active');
      if (fresh.length < 2) return 0;
      const winner = pickWinner(fresh);
      const losers = fresh.filter((m) => m.id !== winner.id).sort(byCreatedThenId);
      const before = winner.confidence;
      const confidence = upgradedConfidence(winner.confidence, losers.length, cfg.mergeConfidenceGain, cfg.confidenceCeiling);
      const sourceRefs: SourceRef[] = [...winner.sourceRefs];
      for (const ref of losers.flatMap((l) => l.sourceRefs)) if (!sourceRefs.some((r) => r.ref === ref.ref)) sourceRefs.push(ref);
      const loserObservationIds = uniq(losers.flatMap((l) => l.provenance.observationIds));
      const ok = await tx.updateMemory(
        ctx.workspaceId,
        winner.id,
        {
          confidence,
          importance: Math.max(winner.importance, ...losers.map((l) => l.importance)),
          evidenceCount: winner.evidenceCount + losers.reduce((s, l) => s + l.evidenceCount, 0),
          lastReinforcedAt: [winner.lastReinforcedAt, ...losers.map((l) => l.lastReinforcedAt)].sort().at(-1)!,
          sourceRefs: sourceRefs.slice(-MAX_SOURCE_REFS),
          provenance: {
            ...winner.provenance,
            observationIds: uniq([...winner.provenance.observationIds, ...loserObservationIds]).slice(-MAX_PROVENANCE_IDS),
            signals: uniq([...winner.provenance.signals, ...losers.flatMap((l) => l.provenance.signals)]),
          },
        },
        now
      );
      if (!ok) throw new Error(`memory ${winner.id} disappeared during collapse`);
      for (const observationId of loserObservationIds) await tx.linkSource(ctx.workspaceId, winner.id, observationId, 'reinforced');
      for (const loser of losers) {
        const done = await tx.updateMemory(ctx.workspaceId, loser.id, { status: 'superseded', validTo: now }, now);
        if (!done) throw new Error(`memory ${loser.id} disappeared during collapse`);
        await tx.insertLink({
          workspaceId: ctx.workspaceId,
          fromId: winner.id,
          toId: loser.id,
          relation: 'supersedes',
          weight: clamp01(similarity.get(`${winner.id}|${loser.id}`) ?? cfg.duplicateThreshold),
          createdAt: now,
        });
      }
      await ctx.emitter.emit(
        jobDraft({
          ctx,
          service: this.deps.service,
          job: 'collapse',
          action: 'memory.collapsed',
          memoryId: winner.id,
          configVersion,
          details: {
            memoryCategory: winner.category,
            mergedCount: losers.length,
            mergedIds: capIds(losers.map((l) => l.id)).ids,
            evidenceCount: winner.evidenceCount + losers.reduce((s, l) => s + l.evidenceCount, 0),
            confidenceBefore: round(before),
            confidenceAfter: round(confidence),
          },
        }),
        { tx: tx.handle }
      );
      return losers.length;
    });
  }

  private async adjustConfidence(ctx: JobContext, cfg: CollapseConfig, configVersion: number): Promise<{ adjusted: number; upgraded: number; downgraded: number }> {
    let adjusted = 0;
    let upgraded = 0;
    let downgraded = 0;
    for await (const page of pagesOf(ctx, { categories: cfg.categories, statuses: ['active'] }, this.deps.batchSize)) {
      for (const listed of page) {
        if (ctx.signal.aborted || adjusted >= cfg.maxAdjustmentsPerRun) return { adjusted, upgraded, downgraded };
        const plan = await this.planAdjustment(ctx, cfg, listed);
        if (!plan) continue;
        if (ctx.dryRun) {
          adjusted += 1;
          if (plan.confidence > listed.confidence) upgraded += 1;
          else if (plan.confidence < listed.confidence) downgraded += 1;
          continue;
        }
        const applied = await this.applyAdjustment(ctx, cfg, configVersion, listed.id);
        if (applied) {
          adjusted += 1;
          if (applied.after > applied.before) upgraded += 1;
          else if (applied.after < applied.before) downgraded += 1;
        }
      }
    }
    return { adjusted, upgraded, downgraded };
  }

  /** New active links that have not been counted for this memory yet, and the confidence they lead to. */
  private async linksToCount(ctx: JobContext, memory: Memory, read: (ids: string[]) => Promise<Memory[]>): Promise<{ supports: string[]; contradicts: string[] }> {
    const links = await ctx.store.listLinks(ctx.workspaceId, memory.id);
    const seen = memory.provenance.adjustments ?? { supports: [], contradicts: [] };
    const others = new Map((await read(links.map((l) => (l.fromId === memory.id ? l.toId : l.fromId)))).map((m) => [m.id, m]));
    const fresh = (relation: 'supports' | 'contradicts', already: string[]): string[] =>
      uniq(
        links
          .filter((l) => l.relation === relation)
          .map((l) => (l.fromId === memory.id ? l.toId : l.fromId))
          .filter((id) => !already.includes(id) && others.get(id)?.status === 'active')
      );
    return { supports: fresh('supports', seen.supports), contradicts: fresh('contradicts', seen.contradicts) };
  }

  private async planAdjustment(ctx: JobContext, cfg: CollapseConfig, memory: Memory): Promise<{ confidence: number } | null> {
    const { supports, contradicts: against } = await this.linksToCount(ctx, memory, (ids) => ctx.store.getMemories(ctx.workspaceId, ids));
    if (supports.length === 0 && against.length === 0) return null;
    return { confidence: adjustedConfidence(memory.confidence, supports.length, against.length, cfg) };
  }

  private async applyAdjustment(ctx: JobContext, cfg: CollapseConfig, configVersion: number, id: string): Promise<{ before: number; after: number } | null> {
    return ctx.store.transaction(async (tx) => {
      const now = ctx.clock.isoNow();
      const memory = await tx.getMemory(ctx.workspaceId, id);
      if (!memory || memory.status !== 'active') return null;
      const { supports, contradicts: against } = await this.linksToCount(ctx, memory, (ids) => tx.getMemories(ctx.workspaceId, ids));
      if (supports.length === 0 && against.length === 0) return null;
      const seen = memory.provenance.adjustments ?? { supports: [], contradicts: [] };
      const after = adjustedConfidence(memory.confidence, supports.length, against.length, cfg);
      const ok = await tx.updateMemory(
        ctx.workspaceId,
        id,
        {
          confidence: after,
          provenance: {
            ...memory.provenance,
            adjustments: { supports: [...seen.supports, ...supports].slice(-MAX_ADJUSTMENT_IDS), contradicts: [...seen.contradicts, ...against].slice(-MAX_ADJUSTMENT_IDS) },
          },
        },
        now
      );
      if (!ok) return null;
      await ctx.emitter.emit(
        jobDraft({
          ctx,
          service: this.deps.service,
          job: 'collapse',
          action: 'memory.confidence_adjusted',
          memoryId: id,
          configVersion,
          details: {
            direction: after > memory.confidence ? 'up' : after < memory.confidence ? 'down' : 'unchanged',
            newSupports: supports.length,
            newContradictions: against.length,
            confidenceBefore: round(memory.confidence),
            confidenceAfter: round(after),
          },
        }),
        { tx: tx.handle }
      );
      return { before: memory.confidence, after };
    });
  }
}

export function adjustedConfidence(
  confidence: number,
  supports: number,
  contradictions: number,
  cfg: Pick<CollapseConfig, 'supportConfidenceGain' | 'contradictionPenalty' | 'confidenceFloor' | 'confidenceCeiling'>
): number {
  // Support never lifts a value above the ceiling (and never lowers one that is already above it).
  const up = Math.min(confidence + supports * cfg.supportConfidenceGain, Math.max(cfg.confidenceCeiling, confidence));
  const down = up - contradictions * cfg.contradictionPenalty;
  // A contradiction never pushes below the floor (and never lowers a value that is already below it).
  return clamp01(contradictions > 0 ? Math.max(down, Math.min(cfg.confidenceFloor, up)) : up);
}
