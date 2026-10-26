import type { AuditDraft, AuditEmitter } from '../ports/audit-emitter.js';
import type { Clock } from '../ports/clock.js';
import type { Embedder } from '../ports/embedder.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Logger } from '../ports/logger.js';
import type { MemoryStore } from '../ports/memory-store.js';
import type { VectorIndex, VectorEntry } from '../ports/vector-index.js';
import type { Memory, MemoryInsert, MemoryProvenance, Observation, SourceRef } from '../domain/index.js';
import { clamp01, deterministicUuid, isUuid } from '../util/index.js';
import type { MemoryExtractor } from './extractor.js';
import { consolidatedDraft, ingestedDraft } from './memory-audit.js';
import type { Redaction, Redactor } from './redaction.js';
import { MemoryResolver, type Resolution } from './resolver.js';

export interface PipelineDeps {
  store: MemoryStore;
  index: VectorIndex;
  embedder: Embedder;
  extractor: MemoryExtractor;
  redactor: Redactor;
  resolver: MemoryResolver;
  emitter: AuditEmitter;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** Service name stamped on audit events, for example memory-ingestor. */
  service: string;
}

export type PipelineStatus = 'processed' | 'skipped' | 'duplicate';

export interface PipelineResult {
  observationId: string;
  status: PipelineStatus;
  /** Why an observation produced nothing. */
  reason?: string;
  created: string[];
  merged: string[];
  superseded: string[];
  dropped: number;
  redactions: Redaction[];
  extractionAttempts: number;
}

const MAX_SOURCE_REFS = 20;
const MAX_OBSERVATION_IDS = 50;

function sourceKindOf(observation: Observation): SourceRef['kind'] {
  if (observation.kind.startsWith('approval.')) return 'approval';
  if (observation.kind.startsWith('goal.')) return 'goal';
  if (observation.kind.startsWith('thread.')) return 'thread';
  if (observation.source === 'audit') return 'audit';
  return 'other';
}

const sourceRefOf = (observation: Observation): SourceRef => ({
  kind: sourceKindOf(observation),
  id: observation.id,
  ref: observation.sourceRef,
});

const uniq = <T>(items: T[]): T[] => [...new Set(items)];

/** Noisy-or: more independent evidence raises confidence, with diminishing returns, never above 0.99. */
export function combineConfidence(existing: number, incoming: number): number {
  return Math.min(0.99, 1 - (1 - clamp01(existing)) * (1 - 0.6 * clamp01(incoming)));
}

/**
 * The write path for one observation:
 * claim (idempotent by observation id) -> redact -> extract (LLM) -> embed -> resolve -> commit
 * (memories, links, source links, observation state and audit events in ONE transaction) -> index.
 *
 * A failure before the commit leaves the observation `pending`, so the source re-delivers it and the
 * same work is attempted again; nothing is half-written. A duplicate delivery after success is a no-op.
 */
export class WritePipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async process(raw: Observation): Promise<PipelineResult> {
    const { store, redactor, extractor, embedder, resolver, index, clock } = this.deps;
    const traceId = raw.traceId ?? this.deps.ids.uuid();
    const log = this.deps.logger.child({ traceId, observationId: raw.id, workspaceId: raw.workspaceId, source: raw.source, kind: raw.kind });
    const empty = (status: PipelineStatus, reason?: string): PipelineResult => ({
      observationId: raw.id,
      status,
      ...(reason ? { reason } : {}),
      created: [],
      merged: [],
      superseded: [],
      dropped: 0,
      redactions: [],
      extractionAttempts: 0,
    });

    // 1. Redact first: nothing unredacted is stored, logged or sent to a model.
    const { observation, redactions } = redactor.redactObservation(raw);
    if (redactions.length > 0) log.info('observation redacted', { redactions });

    // 2. Claim (idempotency).
    const claim = await store.claimObservation(observation, clock.isoNow());
    if (claim === 'done') {
      log.info('observation already processed', { claim });
      return empty('duplicate', 'already_processed');
    }

    try {
      const emitter = this.deps.emitter.forTrace(traceId, observation.spanId);

      // 3. Low-significance observations are recorded but not worth a model call.
      if (observation.significance === 'low') {
        await store.transaction(async (tx) => {
          await tx.markObservation(observation.workspaceId, observation.id, 'skipped', clock.isoNow());
        });
        log.info('observation skipped', { reason: 'low_significance' });
        return { ...empty('skipped', 'low_significance'), redactions };
      }

      // 4. Extraction.
      const extraction = await extractor.extract(observation);
      if (extraction.candidates.length === 0) {
        await store.transaction(async (tx) => {
          await tx.markObservation(observation.workspaceId, observation.id, 'skipped', clock.isoNow());
        });
        log.info('observation produced no memories', { attempts: extraction.attempts });
        return { ...empty('skipped', 'nothing_to_remember'), redactions, extractionAttempts: extraction.attempts };
      }

      // 5. Embed, 6. resolve.
      const vectors = await embedder.embed(
        extraction.candidates.map((c) => c.content),
        { purpose: 'document' }
      );
      const resolutions = await resolver.resolve(observation.workspaceId, extraction.candidates, vectors);

      // 7. Commit everything atomically.
      const now = clock.isoNow();
      const result = empty('processed');
      const entries: VectorEntry[] = [];
      const provenanceBase = (stance: MemoryProvenance['stance']): MemoryProvenance => ({
        extractor: { provider: extractor.provider.provider, model: extractor.provider.model, promptVersion: extractor.promptVersion },
        observationIds: [observation.id],
        stance,
        signals: [observation.kind],
        createdBy: this.deps.service,
      });
      const ref = sourceRefOf(observation);
      const actorFields = {
        ...(isUuid(observation.goalId) ? { goalId: observation.goalId } : {}),
        ...(isUuid(observation.threadId) ? { threadId: observation.threadId } : {}),
        ...(isUuid(observation.userId) ? { userId: observation.userId } : {}),
      };

      await store.transaction(async (tx) => {
        for (let i = 0; i < resolutions.length; i += 1) {
          const r: Resolution = resolutions[i];
          if (r.action === 'drop') {
            result.dropped += 1;
            continue;
          }
          const id = deterministicUuid('memory', `${observation.id}#${i}`);
          if (r.action === 'merge') {
            // Re-read inside the transaction: another observation may have reinforced it since the resolver looked.
            const t = (await tx.getMemory(observation.workspaceId, r.target.id)) ?? r.target;
            const fresh = !t.provenance.observationIds.includes(observation.id);
            const evidenceCount = fresh ? t.evidenceCount + 1 : t.evidenceCount;
            const confidence = fresh ? combineConfidence(t.confidence, r.candidate.confidence) : t.confidence;
            const patched = await tx.updateMemory(
              observation.workspaceId,
              t.id,
              {
                confidence,
                importance: Math.max(t.importance, r.candidate.importance),
                evidenceCount,
                lastReinforcedAt: now,
                decayedAt: null,
                sourceRefs: [...t.sourceRefs.filter((s) => s.ref !== ref.ref), ref].slice(-MAX_SOURCE_REFS),
                provenance: {
                  ...t.provenance,
                  observationIds: uniq([...t.provenance.observationIds, observation.id]).slice(-MAX_OBSERVATION_IDS),
                  signals: uniq([...t.provenance.signals, observation.kind]),
                },
              },
              now
            );
            if (!patched) throw new Error(`memory ${t.id} disappeared during merge`);
            await tx.linkSource(observation.workspaceId, t.id, observation.id, 'reinforced');
            result.merged.push(t.id);
            await emitter.emit(
              consolidatedDraft({
                service: this.deps.service,
                workspaceId: observation.workspaceId,
                memoryId: t.id,
                observationId: observation.id,
                similarity: r.similarity,
                evidenceCount,
                confidence,
                ...actorFields,
              }),
              { tx: tx.handle }
            );
            continue;
          }

          let supersedes: Memory | null = null;
          const supersedeSimilarity = r.action === 'supersede' ? r.similarity : 0;
          if (r.action === 'supersede') {
            const current = await tx.getMemory(observation.workspaceId, r.target.id);
            // Someone else already replaced or retired it: this becomes a plain new memory.
            supersedes = current?.status === 'active' ? current : null;
          }
          const memory: MemoryInsert = {
            id,
            workspaceId: observation.workspaceId,
            category: r.candidate.category,
            content: r.candidate.content,
            summary: r.candidate.summary,
            embedding: r.vector,
            embeddingModel: embedder.model,
            embeddingVersion: embedder.version,
            importance: r.candidate.importance,
            confidence: r.candidate.confidence,
            usefulness: 0.5,
            status: 'active',
            supersedesId: supersedes?.id ?? null,
            validFrom: observation.occurredAt,
            validTo: null,
            lastAccessedAt: null,
            accessCount: 0,
            lastReinforcedAt: now,
            decayedAt: null,
            evidenceCount: 1,
            goalId: isUuid(observation.goalId) ? observation.goalId : null,
            threadId: isUuid(observation.threadId) ? observation.threadId : null,
            sourceRefs: [ref],
            provenance: provenanceBase(r.candidate.stance),
          };
          await tx.insertMemory(memory);
          await tx.linkSource(observation.workspaceId, id, observation.id, 'created');
          if (supersedes) {
            await tx.updateMemory(observation.workspaceId, supersedes.id, { status: 'superseded', validTo: now }, now);
            await tx.insertLink({ workspaceId: observation.workspaceId, fromId: id, toId: supersedes.id, relation: 'supersedes', weight: clamp01(supersedeSimilarity), createdAt: now });
            await tx.insertLink({ workspaceId: observation.workspaceId, fromId: id, toId: supersedes.id, relation: 'contradicts', weight: clamp01(supersedeSimilarity), createdAt: now });
            result.superseded.push(supersedes.id);
          } else if (r.action === 'create' && r.related) {
            const relation = r.candidate.stance !== 'neutral' && r.related.memory.provenance.stance !== 'neutral' && r.candidate.stance !== r.related.memory.provenance.stance ? 'contradicts' : 'supports';
            await tx.insertLink({ workspaceId: observation.workspaceId, fromId: id, toId: r.related.memory.id, relation, weight: clamp01(r.related.similarity), createdAt: now });
          }
          result.created.push(id);
          entries.push({ id, workspaceId: observation.workspaceId, vector: r.vector, model: embedder.model, version: embedder.version });
          const draft: AuditDraft = ingestedDraft({
            service: this.deps.service,
            workspaceId: observation.workspaceId,
            memoryId: id,
            category: memory.category,
            observationId: observation.id,
            sourceRef: observation.sourceRef,
            contentLength: memory.content.length,
            importance: memory.importance,
            confidence: memory.confidence,
            embeddingModel: embedder.model,
            supersedesId: supersedes?.id ?? null,
            ...actorFields,
          });
          await emitter.emit(draft, { tx: tx.handle });
        }
        await tx.markObservation(observation.workspaceId, observation.id, 'processed', now);
      });

      // 8. Index. With the Postgres adapter the vector is already part of the committed row and this is
      // an idempotent no-op; another VectorIndex adapter is written here. A failure after the commit
      // is logged: the reindex job (M2) reconciles memories whose vector is missing from the index.
      if (entries.length > 0) {
        try {
          await index.upsert(entries);
        } catch (err) {
          log.error('vector index upsert failed after commit', { err, memories: entries.map((e) => e.id) });
        }
      }

      result.redactions = redactions;
      result.extractionAttempts = extraction.attempts;
      log.info('observation processed', {
        created: result.created.length,
        merged: result.merged.length,
        superseded: result.superseded.length,
        dropped: result.dropped,
        extractionAttempts: extraction.attempts,
        llmTokens: extraction.usage,
      });
      return result;
    } catch (err) {
      log.error('observation processing failed', { err });
      await store.recordObservationFailure(observation.workspaceId, observation.id, err instanceof Error ? err.message : String(err), clock.isoNow()).catch(() => undefined);
      throw err;
    }
  }
}

