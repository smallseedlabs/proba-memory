import { halfLifeFactor, ageInDays } from '@smallseedlabs/proba-memory-scoring';
import { clamp01, contradicts, round, type Job, type JobContext, type JobResult, type Memory } from '@smallseedlabs/proba-memory-core';
import type { ContradictionsConfig } from '../job-configs.js';
import { preferenceEvidence } from './evidence.js';
import { byCreatedThenId, capIds, findNeighbours, jobDraft, loadJobConfig, pagesOf, type JobDeps } from './shared.js';

export interface ScoreParts {
  recency: number;
  evidence: number;
  source: number;
  total: number;
}

/** Weighted mean of the three components (weights are normalised, so they only need to be relative). */
export function combineScore(parts: Omit<ScoreParts, 'total'>, weights: ContradictionsConfig['weights']): ScoreParts {
  const sum = weights.recency + weights.evidence + weights.source;
  const total = (weights.recency * parts.recency + weights.evidence * parts.evidence + weights.source * parts.source) / sum;
  return { ...parts, total: clamp01(total) };
}

export type Resolution = { kind: 'resolved'; winner: Memory; loser: Memory; margin: number } | { kind: 'unresolved'; margin: number };

/** Winner when its score beats the other's by at least `margin`; otherwise unresolved. A tie is never broken arbitrarily. */
export function decide(a: Memory, sa: ScoreParts, b: Memory, sb: ScoreParts, margin: number): Resolution {
  const diff = sa.total - sb.total;
  if (Math.abs(diff) < margin) return { kind: 'unresolved', margin: Math.abs(diff) };
  return diff > 0 ? { kind: 'resolved', winner: a, loser: b, margin: diff } : { kind: 'resolved', winner: b, loser: a, margin: -diff };
}

interface Pair {
  a: Memory;
  b: Memory;
  similarity: number;
}

/**
 * Contradiction resolver: finds active memories about the same thing with opposite stance (a granted approval
 * against a rejection, "prefers" against "avoids") and settles each pair on three things, weighted from the config:
 * recency (when it was last reinforced), evidence strength (approvals and rejections count most) and the trust in
 * its source. A clear winner stays; the loser is superseded (never deleted) and linked `supersedes` + `contradicts`.
 * When the scores are too close to call, both stay active and are linked `contradicts` so retrieval consumers and
 * the promote job can see the conflict.
 *
 * Idempotent: a settled pair no longer has two active members; an unresolved pair keeps its single link and emits
 * nothing the second time. A pair is re-judged on every run, so new evidence can still tip an open conflict.
 * Limit: stance comes from the evidence (approval granted/rejected, wording polarity); two neutral statements that
 * disagree are not detected.
 */
export class ContradictionsJob implements Job {
  readonly name = 'contradictions';
  readonly description = 'Find memories that contradict each other; resolve by recency, evidence and source, or link them as contradicting.';
  readonly intervalMs: number;

  constructor(private readonly deps: JobDeps) {
    this.intervalMs = deps.intervalsMs.contradictions;
  }

  async run(ctx: JobContext): Promise<JobResult> {
    const loaded = await loadJobConfig(ctx, this.deps.configs, 'contradictions');
    const cfg: ContradictionsConfig = loaded.config;
    const { pairs, scanned } = await this.findPairs(ctx, cfg);
    let resolved = 0;
    let linked = 0;
    let unresolved = 0;
    const plan: { winnerId: string | null; ids: string[]; margin: number }[] = [];
    for (const pair of pairs) {
      if (ctx.signal.aborted) break;
      const outcome = await this.handlePair(ctx, cfg, loaded.version, pair);
      if (outcome === null) continue;
      if (outcome.kind === 'resolved') resolved += 1;
      else {
        unresolved += 1;
        if (outcome.linkedNow) linked += 1;
      }
      if (ctx.dryRun) plan.push({ winnerId: outcome.kind === 'resolved' ? outcome.winnerId : null, ids: [pair.a.id, pair.b.id], margin: round(outcome.margin) });
    }
    return {
      processed: scanned,
      changed: ctx.dryRun ? 0 : resolved * 2 + linked,
      details: {
        configVersion: loaded.version,
        pairs: pairs.length,
        resolved,
        unresolved,
        newLinks: linked,
        ...(ctx.dryRun ? { wouldResolve: resolved, wouldLeaveOpen: unresolved, plan: plan.slice(0, 20) } : {}),
      },
    };
  }

  private async findPairs(ctx: JobContext, cfg: ContradictionsConfig): Promise<{ pairs: Pair[]; scanned: number }> {
    const { index } = this.deps;
    const seen = new Set<string>();
    const pairs: Pair[] = [];
    let scanned = 0;
    for await (const page of pagesOf(ctx, { categories: cfg.categories, statuses: ['active'] }, this.deps.batchSize)) {
      scanned += page.length;
      const vectors = await index.getVectors(ctx.workspaceId, page.map((m) => m.id));
      for (const memory of page) {
        const vector = vectors.get(memory.id);
        if (!vector || memory.provenance.stance === 'neutral') continue;
        const neighbours = await findNeighbours({
          workspaceId: ctx.workspaceId,
          store: ctx.store,
          index,
          memory,
          vector,
          categories: cfg.categories,
          threshold: cfg.relatedThreshold,
          limit: cfg.neighbours,
        });
        for (const n of neighbours) {
          if (!contradicts(memory.provenance.stance, n.memory.provenance.stance)) continue;
          const [a, b] = byCreatedThenId(memory, n.memory) <= 0 ? [memory, n.memory] : [n.memory, memory];
          const key = `${a.id}|${b.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push({ a, b, similarity: n.similarity });
        }
      }
    }
    pairs.sort((x, y) => y.similarity - x.similarity || (x.a.id < y.a.id ? -1 : 1));
    return { pairs: pairs.slice(0, cfg.maxPairsPerRun), scanned };
  }

  async scoreOf(ctx: JobContext, cfg: ContradictionsConfig, memory: Memory): Promise<ScoreParts> {
    const evidence = await preferenceEvidence(ctx.store, memory, cfg.decisiveWeight);
    const recency = halfLifeFactor(ageInDays(memory.lastReinforcedAt, ctx.clock.isoNow()), cfg.recencyHalfLifeDays);
    const strength = 1 - Math.exp(-evidence.weighted / cfg.evidenceScale);
    const trusts = memory.sourceRefs.map((s) => cfg.sourceTrust[s.kind] ?? cfg.otherSourceTrust);
    const source = trusts.length > 0 ? Math.max(...trusts) : cfg.otherSourceTrust;
    return combineScore({ recency, evidence: strength, source }, cfg.weights);
  }

  private async handlePair(
    ctx: JobContext,
    cfg: ContradictionsConfig,
    configVersion: number,
    pair: Pair
  ): Promise<{ kind: 'resolved'; winnerId: string; margin: number } | { kind: 'unresolved'; margin: number; linkedNow: boolean } | null> {
    const [a, b] = await Promise.all([ctx.store.getMemory(ctx.workspaceId, pair.a.id), ctx.store.getMemory(ctx.workspaceId, pair.b.id)]);
    // Settled or retired since the scan: nothing to do.
    if (!a || !b || a.status !== 'active' || b.status !== 'active') return null;
    const [sa, sb] = [await this.scoreOf(ctx, cfg, a), await this.scoreOf(ctx, cfg, b)];
    const decision = decide(a, sa, b, sb, cfg.decisiveMargin);
    const parts = (s: ScoreParts) => ({ recency: round(s.recency), evidence: round(s.evidence), source: round(s.source), total: round(s.total) });

    if (decision.kind === 'resolved') {
      if (ctx.dryRun) return { kind: 'resolved', winnerId: decision.winner.id, margin: decision.margin };
      const { winner, loser } = decision;
      const scores = winner.id === a.id ? { winner: parts(sa), loser: parts(sb) } : { winner: parts(sb), loser: parts(sa) };
      await ctx.store.transaction(async (tx) => {
        const now = ctx.clock.isoNow();
        const [w, l] = [await tx.getMemory(ctx.workspaceId, winner.id), await tx.getMemory(ctx.workspaceId, loser.id)];
        if (!w || !l || w.status !== 'active' || l.status !== 'active') return;
        const ok = await tx.updateMemory(ctx.workspaceId, l.id, { status: 'superseded', validTo: now }, now);
        if (!ok) throw new Error(`memory ${l.id} disappeared during resolution`);
        const weight = clamp01(pair.similarity);
        await tx.insertLink({ workspaceId: ctx.workspaceId, fromId: w.id, toId: l.id, relation: 'supersedes', weight, createdAt: now });
        // The conflict stays on record: the pair remains linked `contradicts`.
        await tx.insertLink({ workspaceId: ctx.workspaceId, fromId: w.id, toId: l.id, relation: 'contradicts', weight, createdAt: now });
        await ctx.emitter.emit(
          jobDraft({
            ctx,
            service: this.deps.service,
            job: 'contradictions',
            action: 'memory.contradiction_resolved',
            memoryId: w.id,
            configVersion,
            details: { winnerId: w.id, loserId: l.id, similarity: round(pair.similarity), margin: round(decision.margin), scores },
          }),
          { tx: tx.handle }
        );
      });
      return { kind: 'resolved', winnerId: winner.id, margin: decision.margin };
    }

    // Too close to call: keep both, record the conflict once.
    const existing = (await ctx.store.listLinks(ctx.workspaceId, a.id)).some(
      (l) => l.relation === 'contradicts' && ((l.fromId === a.id && l.toId === b.id) || (l.fromId === b.id && l.toId === a.id))
    );
    if (existing || ctx.dryRun) return { kind: 'unresolved', margin: decision.margin, linkedNow: !existing && ctx.dryRun };
    await ctx.store.transaction(async (tx) => {
      const now = ctx.clock.isoNow();
      // Newer memory points at the older one, like the write path does.
      const [older, newer] = byCreatedThenId(a, b) <= 0 ? [a, b] : [b, a];
      await tx.insertLink({ workspaceId: ctx.workspaceId, fromId: newer.id, toId: older.id, relation: 'contradicts', weight: clamp01(pair.similarity), createdAt: now });
      await ctx.emitter.emit(
        jobDraft({
          ctx,
          service: this.deps.service,
          job: 'contradictions',
          action: 'memory.contradiction_linked',
          memoryId: newer.id,
          configVersion,
          details: { otherId: older.id, similarity: round(pair.similarity), margin: round(decision.margin), scores: { [a.id]: parts(sa), [b.id]: parts(sb) }, ids: capIds([a.id, b.id]).ids },
        }),
        { tx: tx.handle }
      );
    });
    return { kind: 'unresolved', margin: decision.margin, linkedNow: true };
  }
}
