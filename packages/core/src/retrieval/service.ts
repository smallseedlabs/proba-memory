import {
  cosineSimilarity,
  jaccardSimilarity,
  mmrSelect,
  packByTokenBudget,
  reciprocalRankFusion,
  scoreCandidate,
  selectProfiles,
  type ScoringConfig,
} from '@smallseedlabs/proba-memory-scoring';
import type { AuditActor } from '../audit/protocol.js';
import type { AuditEmitter } from '../ports/audit-emitter.js';
import type { Clock } from '../ports/clock.js';
import type { Embedder } from '../ports/embedder.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { LlmProvider } from '../ports/llm-provider.js';
import type { Logger } from '../ports/logger.js';
import type { MemoryStore } from '../ports/memory-store.js';
import type { RetrievalLogStore } from '../ports/retrieval-log-store.js';
import type { ScoringProfileStore } from '../ports/scoring-profile-store.js';
import type { TokenCounter } from '../ports/token-counter.js';
import type { VectorIndex } from '../ports/vector-index.js';
import {
  matchesFilter,
  type CandidateTrace,
  type Memory,
  type MemoryFilter,
  type RetrievalLogEntry,
  type RetrievedMemory,
  type SearchRequest,
  type SearchResponse,
} from '../domain/index.js';
import { round } from '../write/memory-audit.js';
import type { Redactor } from '../write/redaction.js';
import { sha256Hex, truncate } from '../util/index.js';
import { llmRerank } from './rerank.js';

export interface RetrievalSettings {
  defaultLimit: number;
  maxLimit: number;
  maxQueryChars: number;
  profileName: string;
  rerankEnabled: boolean;
}

export interface RetrievalDeps {
  store: MemoryStore;
  index: VectorIndex;
  embedder: Embedder;
  profiles: ScoringProfileStore;
  logStore: RetrievalLogStore;
  tokens: TokenCounter;
  /** Must fail closed: a retrieval whose audit event cannot be recorded is not returned. */
  emitter: AuditEmitter;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  redactor: Redactor;
  llm?: LlmProvider;
  settings: RetrievalSettings;
  /** Service name stamped on events, for example memory-api. */
  service: string;
}

/** Who is asking and for which workspace. The workspace is decided by the caller's session, never by the request. */
export interface RetrievalContext {
  workspaceId: string;
  actor: AuditActor;
  traceId: string;
  userId?: string;
  /** Include the full candidate table in the response (admins). It is always logged. */
  includeCandidates?: boolean;
}

export class RetrievalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalInputError';
  }
}

interface Ranked {
  traces: CandidateTrace[];
  /** Selected after MMR, in MMR order. */
  selected: CandidateTrace[];
  vectorCount: number;
  textCount: number;
}

const MAX_AUDIT_IDS = 50;
const MAX_LOGGED_CANDIDATES = 100;

/**
 * Hybrid retrieval: vector search + Postgres full-text + structured filters, reciprocal rank fusion,
 * the profile's weighted score (a pure function), MMR diversity, optional LLM rerank and token packing.
 * Every retrieval is logged with its features and profile version, and audited as memory.retrieved.
 */
export class RetrievalService {
  constructor(private readonly deps: RetrievalDeps) {}

  async search(ctx: RetrievalContext, request: SearchRequest): Promise<SearchResponse> {
    const { deps } = this;
    const started = Date.now();
    const log = deps.logger.child({ traceId: ctx.traceId, workspaceId: ctx.workspaceId, component: 'retrieval' });
    const query = request.query.replace(/\s+/g, ' ').trim();
    if (query.length === 0) throw new RetrievalInputError('query must not be empty');
    if (query.length > deps.settings.maxQueryChars) throw new RetrievalInputError(`query is longer than ${deps.settings.maxQueryChars} characters`);
    const limit = Math.min(request.limit ?? deps.settings.defaultLimit, deps.settings.maxLimit);
    if (!(limit >= 1)) throw new RetrievalInputError('limit must be at least 1');

    const now = deps.clock.isoNow();
    const versions = await deps.profiles.resolve(ctx.workspaceId, deps.settings.profileName);
    const selection = selectProfiles(versions, ctx.traceId);
    const profile = selection.served;
    const config = profile.config;
    const filter: MemoryFilter = request.filter ?? {};
    const degraded: string[] = [];

    // Candidate generation: vector and full text in parallel; either may fail without losing the other.
    const [vectorHits, textHits] = await Promise.all([
      this.vectorCandidates(ctx.workspaceId, query, config, filter, degraded, log),
      deps.store
        .searchText({ workspaceId: ctx.workspaceId, query, limit: config.candidates.ftsK, filter })
        .catch((err: unknown) => {
          degraded.push('text_search_unavailable');
          log.error('full-text search failed', { err });
          return [];
        }),
    ]);

    const ids = [...new Set([...vectorHits.map((h) => h.id), ...textHits.map((h) => h.id)])];
    const hydrated = await deps.store.getMemories(ctx.workspaceId, ids);
    const memories = new Map<string, Memory>();
    for (const m of hydrated) {
      if (m.workspaceId !== ctx.workspaceId) {
        // Isolation is enforced by the store; this is a second, independent check.
        log.error('isolation violation: store returned a memory of another workspace', { memoryId: m.id });
        continue;
      }
      if (matchesFilter(m, filter)) memories.set(m.id, m);
    }

    const rankArgs = { vectorHits, textHits, memories, now, query, workspaceId: ctx.workspaceId, limit };
    const ranked = await this.rank(config, rankArgs);
    let selected = ranked.selected;

    // Optional LLM rerank of the diverse shortlist.
    const wantRerank = config.rerank.enabled && deps.settings.rerankEnabled && request.rerank !== false && deps.llm !== undefined;
    if (wantRerank && selected.length > 1) {
      const head = selected.slice(0, config.rerank.topN);
      try {
        const order = await llmRerank({
          llm: deps.llm as LlmProvider,
          logger: log,
          query,
          items: head.map((t) => ({ id: t.id, content: memories.get(t.id)?.content ?? '' })),
        });
        const byId = new Map(head.map((t) => [t.id, t]));
        selected = [...order.map((id) => byId.get(id)).filter((t): t is CandidateTrace => t !== undefined), ...selected.slice(config.rerank.topN)];
      } catch (err) {
        degraded.push('rerank_unavailable');
        log.warn('rerank failed; keeping score order', { err });
      }
    }

    // Token-budget packing, in order, up to the limit.
    const budget = request.tokenBudget ?? config.packing.tokenBudget;
    const sized = selected.map((t) => ({ id: t.id, tokens: deps.tokens.count(memories.get(t.id)?.content ?? '') + 4 }));
    const packed = packByTokenBudget(sized, budget, config.packing.maxItemTokens);
    const packedIds = new Map(packed.packed.map((p) => [p.id, p]));
    const overBudget = new Set(packed.dropped.map((d) => d.id));
    const results: RetrievedMemory[] = [];
    for (const trace of selected) {
      const item = packedIds.get(trace.id);
      if (!item) {
        trace.selected = false;
        trace.droppedReason = overBudget.has(trace.id) ? 'over_budget' : 'over_limit';
        continue;
      }
      if (results.length >= limit) {
        trace.selected = false;
        trace.droppedReason = 'over_limit';
        continue;
      }
      const m = memories.get(trace.id) as Memory;
      const rawTokens = sized.find((s) => s.id === trace.id)?.tokens ?? item.tokens;
      const content = item.truncated ? truncate(m.content, Math.max(20, Math.floor((m.content.length * (item.tokens - 4)) / Math.max(1, rawTokens - 4)))) : m.content;
      trace.selected = true;
      trace.position = results.length + 1;
      results.push({
        id: m.id,
        category: m.category,
        content,
        summary: m.summary,
        score: round(trace.score),
        importance: m.importance,
        confidence: m.confidence,
        usefulness: m.usefulness,
        createdAt: m.createdAt,
        lastReinforcedAt: m.lastReinforcedAt,
        sourceRefs: m.sourceRefs.map((s) => ({ kind: s.kind, ref: s.ref })),
        trust: 'untrusted_data',
        tokens: item.tokens,
        truncated: item.truncated,
      });
    }
    for (const t of ranked.selected) if (!t.selected && !t.droppedReason) t.droppedReason = 'over_limit';

    // Shadow profile: scored over the same candidates, logged, never returned.
    let shadowResults: RetrievalLogEntry['shadowResults'] = null;
    if (selection.shadow) {
      try {
        const shadow = await this.rank(selection.shadow.config, rankArgs);
        shadowResults = shadow.selected.slice(0, limit).map((t) => ({ id: t.id, score: round(t.score) }));
      } catch (err) {
        log.warn('shadow profile scoring failed', { err, shadowVersion: selection.shadow.version });
      }
    }

    const tokensUsed = results.reduce((n, r) => n + r.tokens, 0);
    const retrievalId = deps.ids.uuid();
    const stats: SearchResponse['stats'] = {
      vectorCandidates: ranked.vectorCount,
      textCandidates: ranked.textCount,
      fused: ranked.traces.length,
      scored: ranked.traces.length,
      returned: results.length,
      tokensUsed,
      tokenBudget: budget,
      degraded,
      durationMs: Date.now() - started,
    };
    const redactedQuery = deps.redactor.redact(query).text;
    const entry: RetrievalLogEntry = {
      id: retrievalId,
      workspaceId: ctx.workspaceId,
      traceId: ctx.traceId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      queryText: truncate(redactedQuery, 500),
      queryHash: sha256Hex(redactedQuery.toLowerCase()).slice(0, 32),
      filter,
      profileName: profile.name,
      profileVersion: profile.version,
      profileServed: selection.reason,
      shadowProfileVersion: selection.shadow?.version ?? null,
      candidates: [...ranked.traces].sort((a, b) => b.score - a.score).slice(0, MAX_LOGGED_CANDIDATES),
      shadowResults,
      results: results.map((r, i) => ({ id: r.id, score: r.score, position: i + 1 })),
      stats,
      createdAt: now,
    };

    // Log, count access and audit in one transaction. If the audit event cannot be written, nothing is returned.
    await deps.store.transaction(async (tx) => {
      await deps.logStore.append(entry, tx.handle);
      if (results.length > 0) await tx.recordAccess(ctx.workspaceId, results.map((r) => r.id), now);
      await deps.emitter.forTrace(ctx.traceId).emit(
        {
          actor: ctx.actor,
          workspaceId: ctx.workspaceId,
          ...(ctx.userId ? { userId: ctx.userId } : {}),
          action: 'memory.retrieved',
          category: 'memory',
          outcome: 'success',
          target: { type: 'retrieval', id: retrievalId },
          durationMs: stats.durationMs,
          details: {
            operation: 'search',
            count: results.length,
            ids: results.slice(0, MAX_AUDIT_IDS).map((r) => r.id),
            profile: { name: profile.name, version: profile.version, served: selection.reason, shadowVersion: selection.shadow?.version ?? null },
            queryLength: query.length,
            queryHash: entry.queryHash,
            candidates: ranked.traces.length,
            tokensUsed,
            degraded,
          },
        },
        { tx: tx.handle }
      );
    });

    log.info('memories retrieved', {
      retrievalId,
      returned: results.length,
      candidates: ranked.traces.length,
      profileVersion: profile.version,
      served: selection.reason,
      degraded,
      durationMs: stats.durationMs,
    });

    return {
      retrievalId,
      traceId: ctx.traceId,
      query: { length: query.length },
      profile: {
        name: profile.name,
        version: profile.version,
        status: profile.status,
        served: selection.reason,
        ...(selection.shadow ? { shadow: { name: selection.shadow.name, version: selection.shadow.version } } : {}),
      },
      results,
      stats,
      ...(ctx.includeCandidates ? { candidates: entry.candidates } : {}),
    };
  }

  /** Audit a non-search read (by id, list, profiles) as memory.retrieved. Throws if the event cannot be recorded. */
  async recordRead(ctx: RetrievalContext, operation: string, details: Record<string, unknown>, ids: string[] = []): Promise<void> {
    await this.deps.emitter.forTrace(ctx.traceId).emit({
      actor: ctx.actor,
      workspaceId: ctx.workspaceId,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      action: 'memory.retrieved',
      category: 'memory',
      outcome: 'success',
      details: { operation, count: ids.length, ids: ids.slice(0, MAX_AUDIT_IDS), ...details },
    });
  }

  private async vectorCandidates(
    workspaceId: string,
    query: string,
    config: ScoringConfig,
    filter: MemoryFilter,
    degraded: string[],
    log: Logger
  ): Promise<{ id: string; similarity: number }[]> {
    const { embedder, index } = this.deps;
    try {
      const [vector] = await embedder.embed([query], { purpose: 'query' });
      const hits = await index.search({
        workspaceId,
        vector,
        limit: config.candidates.vectorK,
        model: embedder.model,
        version: embedder.version,
        filter,
      });
      return hits;
    } catch (err) {
      degraded.push('vector_search_unavailable');
      log.error('vector search failed', { err });
      return [];
    }
  }

  /** Fuse, score and diversify candidates with one profile. Pure apart from reading vectors for MMR. */
  private async rank(
    config: ScoringConfig,
    args: {
      vectorHits: { id: string; similarity: number }[];
      textHits: { id: string; rank: number }[];
      memories: Map<string, Memory>;
      now: string;
      query: string;
      workspaceId: string;
      limit: number;
    }
  ): Promise<Ranked> {
    const { memories } = args;
    const vector = args.vectorHits.filter((h) => h.similarity >= config.candidates.minVectorSimilarity && memories.has(h.id));
    const text = args.textHits.filter((h) => memories.has(h.id));
    const vectorRank = new Map(vector.map((h, i) => [h.id, { rank: i + 1, similarity: h.similarity }]));
    const textRank = new Map(text.map((h, i) => [h.id, { rank: i + 1, score: h.rank }]));
    const fused = reciprocalRankFusion(
      [
        { name: 'vector', weight: config.fusion.vectorWeight, ids: vector.map((h) => h.id) },
        { name: 'fts', weight: config.fusion.ftsWeight, ids: text.map((h) => h.id) },
      ],
      config.fusion.k
    );

    const traces: CandidateTrace[] = [];
    for (const f of fused) {
      const m = memories.get(f.id) as Memory;
      const s = scoreCandidate(
        { fusedScore: f.score, category: m.category, referenceTime: m.lastReinforcedAt, importance: m.importance, confidence: m.confidence, usefulness: m.usefulness },
        config,
        args.now
      );
      traces.push({
        id: m.id,
        category: m.category,
        vectorRank: vectorRank.get(m.id)?.rank ?? null,
        vectorSimilarity: vectorRank.has(m.id) ? round(vectorRank.get(m.id)?.similarity ?? 0) : null,
        ftsRank: textRank.get(m.id)?.rank ?? null,
        ftsScore: textRank.has(m.id) ? round(textRank.get(m.id)?.score ?? 0) : null,
        fusedScore: round(f.score, 6),
        score: s.score,
        features: s.features,
        components: s.components,
        selected: false,
      });
    }
    traces.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

    const eligible: CandidateTrace[] = [];
    for (const t of traces) {
      if (t.score < config.minScore) t.droppedReason = 'below_min_score';
      else if (eligible.length >= config.candidates.poolSize) t.droppedReason = 'outside_pool';
      else eligible.push(t);
    }

    const take = Math.min(eligible.length, args.limit * 2);
    let selected: CandidateTrace[];
    if (config.mmr.enabled && eligible.length > 1) {
      const vectors = await this.deps.index.getVectors(args.workspaceId, eligible.map((t) => t.id)).catch(() => new Map<string, number[]>());
      const similarity = (a: CandidateTrace, b: CandidateTrace): number => {
        const va = vectors.get(a.id);
        const vb = vectors.get(b.id);
        if (va && vb) return cosineSimilarity(va, vb);
        return jaccardSimilarity(memories.get(a.id)?.content ?? '', memories.get(b.id)?.content ?? '');
      };
      const picks = mmrSelect(
        eligible,
        { lambda: config.mmr.lambda, limit: take, similarity }
      );
      selected = picks.map((p) => {
        p.item.mmrScore = round(p.mmrScore);
        p.item.maxSimilarity = round(p.maxSimilarity);
        return p.item;
      });
    } else {
      selected = eligible.slice(0, take);
    }
    const chosen = new Set(selected.map((t) => t.id));
    for (const t of eligible) if (!chosen.has(t.id)) t.droppedReason = config.mmr.enabled ? 'diversity' : 'over_limit';

    return { traces, selected, vectorCount: vector.length, textCount: text.length };
  }
}

