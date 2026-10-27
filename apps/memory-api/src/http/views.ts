import type { JobRun, Memory, MemoryLink, RetrievalLogEntry } from '@smallseedlabs/proba-memory-core';
import type { ScoringProfile } from '@smallseedlabs/proba-memory-scoring';
import type { Role } from '../authorization.js';

/**
 * A memory as the API returns it. The vector, the full-text column and the internal evidence lists are
 * never exposed. `content` is text written by users and models: clients (and any model they feed it to)
 * must treat it as data, never as instructions: `trust` says so on every record.
 */
export interface MemoryView {
  id: string;
  category: Memory['category'];
  content: string;
  summary: string | null;
  status: Memory['status'];
  importance: number;
  confidence: number;
  usefulness: number;
  supersedesId: string | null;
  validFrom: string;
  validTo: string | null;
  lastReinforcedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  evidenceCount: number;
  goalId: string | null;
  threadId: string | null;
  sourceRefs: { kind: string; ref: string }[];
  embedding: { model: string | null; version: string | null };
  provenance: { stance: string; signals: string[]; createdBy: string; extractor: { provider: string; model: string; promptVersion: string } | null };
  createdAt: string;
  updatedAt: string;
  trust: 'untrusted_data';
}

export function toMemoryView(m: Memory): MemoryView {
  return {
    id: m.id,
    category: m.category,
    content: m.content,
    summary: m.summary,
    status: m.status,
    importance: m.importance,
    confidence: m.confidence,
    usefulness: m.usefulness,
    supersedesId: m.supersedesId,
    validFrom: m.validFrom,
    validTo: m.validTo,
    lastReinforcedAt: m.lastReinforcedAt,
    lastAccessedAt: m.lastAccessedAt,
    accessCount: m.accessCount,
    evidenceCount: m.evidenceCount,
    goalId: m.goalId,
    threadId: m.threadId,
    sourceRefs: m.sourceRefs.map((s) => ({ kind: s.kind, ref: s.ref })),
    embedding: { model: m.embeddingModel, version: m.embeddingVersion },
    provenance: {
      stance: m.provenance.stance,
      signals: m.provenance.signals ?? [],
      createdBy: m.provenance.createdBy,
      extractor: m.provenance.extractor,
    },
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    trust: 'untrusted_data',
  };
}

export interface LinkView {
  fromId: string;
  toId: string;
  relation: MemoryLink['relation'];
  weight: number;
  createdAt: string;
}

export const toLinkView = (l: MemoryLink): LinkView => ({ fromId: l.fromId, toId: l.toId, relation: l.relation, weight: l.weight, createdAt: l.createdAt });

export interface ProfileView {
  name: string;
  version: number;
  status: ScoringProfile['status'];
  scope: 'workspace' | 'global';
  canaryPercent: number;
  description: string;
  createdAt: string;
  /** The full configuration: administrators only. */
  config?: ScoringProfile['config'];
}

export function toProfileView(p: ScoringProfile, role: Role): ProfileView {
  return {
    name: p.name,
    version: p.version,
    status: p.status,
    scope: p.workspaceId === '*' ? 'global' : 'workspace',
    canaryPercent: p.canaryPercent,
    description: p.description,
    createdAt: p.createdAt,
    ...(role === 'admin' ? { config: p.config } : {}),
  };
}

/** One retrieval log entry as the portal expects it (administrators only). */
export interface RetrievalRecordView {
  id: string;
  traceId: string;
  createdAt: string;
  queryText: string;
  filter: Record<string, unknown>;
  profile: { name: string; version: number; served: 'active' | 'canary'; shadowVersion: number | null };
  results: { id: string; score: number; position: number }[];
  candidates: RetrievalLogEntry['candidates'];
  stats: RetrievalLogEntry['stats'];
  outcome: { verdict: 'approved' | 'rejected' | 'none'; resolvedAt: string } | null;
}

export function toRetrievalRecordView(entry: RetrievalLogEntry): RetrievalRecordView {
  return {
    id: entry.id,
    traceId: entry.traceId,
    createdAt: entry.createdAt,
    queryText: entry.queryText,
    filter: entry.filter as Record<string, unknown>,
    profile: {
      name: entry.profileName,
      version: entry.profileVersion,
      served: entry.profileServed,
      shadowVersion: entry.shadowProfileVersion,
    },
    results: entry.results,
    candidates: entry.candidates,
    stats: entry.stats,
    outcome: entry.outcome
      ? { verdict: entry.outcome.verdict, resolvedAt: entry.outcome.resolvedAt }
      : null,
  };
}

/** A retrieval that returned one memory (administrators only). */
export interface MemoryRetrievalView {
  retrievalId: string;
  traceId: string;
  createdAt: string;
  position: number;
  score: number;
  profile: { name: string; version: number };
  outcome: 'approved' | 'rejected' | 'none' | null;
}

export function toMemoryRetrievalView(entry: RetrievalLogEntry, memoryId: string): MemoryRetrievalView | null {
  const hit = entry.results.find((r) => r.id === memoryId);
  if (!hit) return null;
  return {
    retrievalId: entry.id,
    traceId: entry.traceId,
    createdAt: entry.createdAt,
    position: hit.position,
    score: hit.score,
    profile: { name: entry.profileName, version: entry.profileVersion },
    outcome: entry.outcome?.verdict ?? null,
  };
}

/** A job run as returned to the portal (workspaceId never leaves the server). */
export interface JobRunView {
  id: string;
  jobName: string;
  traceId: string;
  trigger: JobRun['trigger'];
  status: JobRun['status'];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  processed: number;
  changed: number;
  error: string | null;
  details: Record<string, unknown>;
}

export function toJobRunView(run: JobRun): JobRunView {
  return {
    id: run.id,
    jobName: run.jobName,
    traceId: run.traceId,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    processed: run.processed,
    changed: run.changed,
    error: run.error,
    details: run.details,
  };
}
