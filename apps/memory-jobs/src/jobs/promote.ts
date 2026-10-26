import { deterministicUuid, round, type Job, type JobContext, type JobResult, type Memory, type MemoryInsert } from '@smallseedlabs/proba-memory-core';
import type { PromoteConfig } from '../job-configs.js';
import { preferenceEvidence, type PreferenceEvidence } from './evidence.js';
import { byCreatedThenId, capIds, jobDraft, loadJobConfig, MAX_PROVENANCE_IDS, pagesOf, uniq, type JobDeps } from './shared.js';

const MS_PER_DAY = 86_400_000;

type Rule = PromoteConfig['toProcedural'];
type Target = 'procedural' | 'super';

export interface PromotionAssessment {
  target: Target | null;
  evidence: PreferenceEvidence;
  ageDays: number;
  /** Why the memory does not qualify for `super` / `procedural`, for the dry-run report. */
  blockedBy: string[];
}

export function ageDaysOf(memory: Memory, nowMs: number): number {
  return Math.max(0, (nowMs - new Date(memory.validFrom).getTime()) / MS_PER_DAY);
}

/** The first rule in `rule` the memory fails, or null when it passes all of them. */
export function failedCriterion(memory: Memory, evidence: PreferenceEvidence, ageDays: number, rule: Rule): string | null {
  const decisive = evidence.agree;
  if (memory.evidenceCount < rule.minEvidence) return 'evidence';
  if (memory.confidence < rule.minConfidence) return 'confidence';
  if (ageDays < rule.minAgeDays) return 'age';
  if (evidence.weighted < rule.minWeightedEvidence) return 'weighted_evidence';
  if (decisive < rule.minDecisiveSignals) return 'decisive_signals';
  if (memory.usefulness < rule.minUsefulness) return 'usefulness';
  return null;
}

/**
 * Promote: a semantic memory that is repeated (evidence count), confirmed (approvals and rejections that agree with
 * it are the strongest signal, weighted), confident, old enough and not contradicted becomes a procedural memory;
 * one that clears the stricter `toSuper` rule becomes a `super` memory. Both rules come from the versioned config.
 *
 * The promoted memory is a new row (category changes are history, not an edit): it supersedes the semantic one, keeps
 * its vector, evidence and decay clock, and links to it. Idempotent: the semantic source stops being active, and the
 * new id is derived from (source, target).
 */
export class PromoteJob implements Job {
  readonly name = 'promote';
  readonly description = 'Promote repeated, confirmed, high-confidence semantic memories to procedural or super memory.';
  readonly intervalMs: number;

  constructor(private readonly deps: JobDeps) {
    this.intervalMs = deps.intervalsMs.promote;
  }

  async run(ctx: JobContext): Promise<JobResult> {
    const loaded = await loadJobConfig(ctx, this.deps.configs, 'promote');
    const cfg: PromoteConfig = loaded.config;
    const nowMs = ctx.clock.now().getTime();
    const basic: Rule = {
      // Cheap pre-filter: the weakest of the two rules, so evidence lookups only happen for plausible candidates.
      minEvidence: Math.min(cfg.toProcedural.minEvidence, cfg.toSuper.minEvidence),
      minConfidence: Math.min(cfg.toProcedural.minConfidence, cfg.toSuper.minConfidence),
      minAgeDays: Math.min(cfg.toProcedural.minAgeDays, cfg.toSuper.minAgeDays),
      minWeightedEvidence: 0,
      minDecisiveSignals: 0,
      minUsefulness: 0,
    };

    let scanned = 0;
    const candidates: { memory: Memory; target: Target; assessment: PromotionAssessment }[] = [];
    const blocked: Record<string, number> = {};
    for await (const page of pagesOf(ctx, { categories: ['semantic'], statuses: ['active'] }, this.deps.batchSize)) {
      scanned += page.length;
      for (const memory of page) {
        const ageDays = ageDaysOf(memory, nowMs);
        const early = failedCriterion(memory, { agree: 0, disagree: 0, other: 0, weighted: 0 }, ageDays, basic);
        if (early) {
          blocked[early] = (blocked[early] ?? 0) + 1;
          continue;
        }
        const assessment = await this.assess(ctx, memory, cfg, ageDays);
        if (assessment.target) candidates.push({ memory, target: assessment.target, assessment });
        else for (const reason of assessment.blockedBy) blocked[reason] = (blocked[reason] ?? 0) + 1;
      }
    }
    candidates.sort((a, b) => byCreatedThenId(a.memory, b.memory));
    const chosen = candidates.slice(0, cfg.maxPromotionsPerRun);
    const toProcedural = chosen.filter((c) => c.target === 'procedural').length;
    const toSuper = chosen.length - toProcedural;
    const details: Record<string, unknown> = { configVersion: loaded.version, candidates: candidates.length, blocked };

    if (ctx.dryRun) {
      return { processed: scanned, changed: 0, details: { ...details, wouldPromote: { procedural: toProcedural, super: toSuper }, memoryIds: capIds(chosen.map((c) => c.memory.id)).ids } };
    }

    let promoted = 0;
    let skipped = 0;
    for (const c of chosen) {
      if (ctx.signal.aborted) break;
      if (await this.promote(ctx, loaded.version, c.memory, c.target, c.assessment)) promoted += 1;
      else skipped += 1;
    }
    // Each promotion creates one row and supersedes one.
    return { processed: scanned, changed: promoted * 2, details: { ...details, promoted, toProcedural, toSuper, skippedChanged: skipped } };
  }

  private async assess(ctx: JobContext, memory: Memory, cfg: PromoteConfig, ageDays: number): Promise<PromotionAssessment> {
    const evidence = await preferenceEvidence(ctx.store, memory, cfg.decisiveWeight);
    const blockedBy: string[] = [];
    if (cfg.blockOnActiveContradiction && (await this.hasActiveContradiction(ctx, memory))) {
      return { target: null, evidence, ageDays, blockedBy: ['active_contradiction'] };
    }
    const superMiss = failedCriterion(memory, evidence, ageDays, cfg.toSuper);
    if (superMiss === null) return { target: 'super', evidence, ageDays, blockedBy };
    const procMiss = failedCriterion(memory, evidence, ageDays, cfg.toProcedural);
    if (procMiss === null) return { target: 'procedural', evidence, ageDays, blockedBy };
    return { target: null, evidence, ageDays, blockedBy: [procMiss] };
  }

  private async hasActiveContradiction(ctx: JobContext, memory: Memory): Promise<boolean> {
    const links = (await ctx.store.listLinks(ctx.workspaceId, memory.id)).filter((l) => l.relation === 'contradicts');
    if (links.length === 0) return false;
    const otherIds = links.map((l) => (l.fromId === memory.id ? l.toId : l.fromId));
    const others = await ctx.store.getMemories(ctx.workspaceId, otherIds);
    return others.some((o) => o.status === 'active');
  }

  private async promote(ctx: JobContext, configVersion: number, listed: Memory, target: Target, assessment: PromotionAssessment): Promise<boolean> {
    const vectors = await this.deps.index.getVectors(ctx.workspaceId, [listed.id]);
    const vector = vectors.get(listed.id) ?? null;
    const id = deterministicUuid('promote', `${ctx.workspaceId}:${listed.id}:${target}`);
    return ctx.store.transaction(async (tx) => {
      const now = ctx.clock.isoNow();
      const source = await tx.getMemory(ctx.workspaceId, listed.id);
      // Retired, superseded or reinforced into another category since it was listed: leave it for the next run.
      if (!source || source.status !== 'active' || source.category !== 'semantic') return false;
      const memory: MemoryInsert = {
        ...source,
        id,
        category: target,
        embedding: vector,
        status: 'active',
        supersedesId: source.id,
        validTo: null,
        lastAccessedAt: source.lastAccessedAt,
        provenance: {
          ...source.provenance,
          createdBy: 'job:promote',
          derivedFrom: [source.id],
          observationIds: source.provenance.observationIds.slice(-MAX_PROVENANCE_IDS),
        },
        createdAt: now,
      };
      await tx.insertMemory(memory);
      for (const observationId of uniq(source.provenance.observationIds)) await tx.linkSource(ctx.workspaceId, id, observationId, 'created');
      const ok = await tx.updateMemory(ctx.workspaceId, source.id, { status: 'superseded', validTo: now }, now);
      if (!ok) throw new Error(`memory ${source.id} disappeared during promotion`);
      await tx.insertLink({ workspaceId: ctx.workspaceId, fromId: id, toId: source.id, relation: 'supersedes', weight: 1, createdAt: now });
      await ctx.emitter.emit(
        jobDraft({
          ctx,
          service: this.deps.service,
          job: 'promote',
          action: 'memory.promoted',
          memoryId: id,
          configVersion,
          details: {
            fromMemoryId: source.id,
            fromCategory: 'semantic',
            toCategory: target,
            evidenceCount: source.evidenceCount,
            confidence: round(source.confidence),
            ageDays: round(assessment.ageDays, 2),
            weightedEvidence: round(assessment.evidence.weighted, 2),
            approvalsAgreeing: assessment.evidence.agree,
            approvalsDisagreeing: assessment.evidence.disagree,
          },
        }),
        { tx: tx.handle }
      );
      return true;
    });
  }
}
