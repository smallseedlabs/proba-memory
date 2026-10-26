/**
 * Memory domain types. A memory is one self-contained statement about a workspace
 * (a preference, a decision, a procedure) with the evidence it came from.
 */

import type { MemoryCategory } from '@smallseedlabs/proba-memory-scoring';

export { MEMORY_CATEGORIES, isMemoryCategory, type MemoryCategory } from '@smallseedlabs/proba-memory-scoring';

export const MEMORY_STATUSES = ['active', 'superseded', 'tombstoned'] as const;
/**
 * active: returned by retrieval. superseded: replaced by a newer memory (supersedesId on the new one).
 * tombstoned: retired (cleanup, user request). Memories are never hard-deleted.
 */
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export type Stance = 'positive' | 'negative' | 'neutral';

/** Where a memory's evidence came from. `ref` is the namespaced source reference, for example `audit:<eventId>` or `dev:goal-3`. */
export interface SourceRef {
  kind: 'audit' | 'goal' | 'approval' | 'thread' | 'analytics' | 'other';
  id: string;
  ref: string;
}

export interface MemoryProvenance {
  /** The extractor that wrote the text; null for memories created by a job. */
  extractor: { provider: string; model: string; promptVersion: string } | null;
  /** Observations that created or reinforced the memory (capped). */
  observationIds: string[];
  /** The direction of the evidence: used to tell a contradiction from a repetition. */
  stance: Stance;
  /** Observation kinds that contributed (for example `approval.rejected`). */
  signals: string[];
  createdBy: string;
}

export interface Memory {
  id: string;
  workspaceId: string;
  category: MemoryCategory;
  content: string;
  summary: string | null;
  /** Model and version that produced the stored vector; null while the memory has no vector. */
  embeddingModel: string | null;
  embeddingVersion: string | null;
  /** 0..1 */
  importance: number;
  /** 0..1 */
  confidence: number;
  /** 0..1, learned from how retrieved memories are used. 0.5 = no evidence yet. */
  usefulness: number;
  status: MemoryStatus;
  /** The memory this one replaced. */
  supersedesId: string | null;
  /** UTC ISO 8601. */
  validFrom: string;
  validTo: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  /** Last time new evidence reinforced the memory (or it was created). Recency is measured from here. */
  lastReinforcedAt: string;
  /** Last time the decay job lowered importance/confidence; decay continues from here. */
  decayedAt: string | null;
  /** Number of distinct observations behind the memory. */
  evidenceCount: number;
  goalId: string | null;
  threadId: string | null;
  sourceRefs: SourceRef[];
  provenance: MemoryProvenance;
  createdAt: string;
  updatedAt: string;
}

/** A memory as written to a store: the same fields plus the vector, when one exists. */
export interface MemoryInsert extends Omit<Memory, 'createdAt' | 'updatedAt'> {
  embedding: number[] | null;
  createdAt?: string;
}

/** The fields a store may change on an existing memory. */
export interface MemoryPatch {
  content?: string;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  usefulness?: number;
  status?: MemoryStatus;
  validTo?: string | null;
  lastReinforcedAt?: string;
  decayedAt?: string | null;
  evidenceCount?: number;
  sourceRefs?: SourceRef[];
  provenance?: MemoryProvenance;
  embedding?: { vector: number[]; model: string; version: string };
}

export const MEMORY_LINK_RELATIONS = ['supports', 'contradicts', 'supersedes'] as const;
export type MemoryLinkRelation = (typeof MEMORY_LINK_RELATIONS)[number];

export interface MemoryLink {
  workspaceId: string;
  fromId: string;
  toId: string;
  relation: MemoryLinkRelation;
  /** 0..1 strength of the relation (for example the similarity that triggered it). */
  weight: number;
  createdAt: string;
}

/** Structured filters, ANDed. `statuses` defaults to ['active'] everywhere. */
export interface MemoryFilter {
  categories?: MemoryCategory[];
  statuses?: MemoryStatus[];
  minConfidence?: number;
  minImportance?: number;
  goalId?: string;
  threadId?: string;
  /** Only memories with at least one source of this kind. */
  sourceKind?: SourceRef['kind'];
  /** Created at or after / before (UTC ISO 8601). */
  createdFrom?: string;
  createdTo?: string;
}

export interface MemoryListQuery {
  workspaceId: string;
  filter?: MemoryFilter;
  /** Newest first by createdAt, then id. */
  limit?: number;
  cursor?: string;
}

export interface MemoryPage {
  memories: Memory[];
  nextCursor: string | null;
}

export const MEMORY_LIST_DEFAULT_LIMIT = 50;
export const MEMORY_LIST_MAX_LIMIT = 200;

export interface TextHit {
  id: string;
  /** Full-text rank (higher is better). */
  rank: number;
}

export interface TextSearchQuery {
  workspaceId: string;
  query: string;
  limit: number;
  filter?: MemoryFilter;
}

export function defaultFilter(filter?: MemoryFilter): MemoryFilter & { statuses: MemoryStatus[] } {
  return { ...filter, statuses: filter?.statuses?.length ? filter.statuses : ['active'] };
}

/** Does `memory` pass `filter`? The in-memory adapters use this; SQL adapters express the same rules in SQL. */
export function matchesFilter(memory: Memory, filter?: MemoryFilter): boolean {
  const f = defaultFilter(filter);
  if (!f.statuses.includes(memory.status)) return false;
  if (f.categories?.length && !f.categories.includes(memory.category)) return false;
  if (f.minConfidence !== undefined && memory.confidence < f.minConfidence) return false;
  if (f.minImportance !== undefined && memory.importance < f.minImportance) return false;
  if (f.goalId !== undefined && memory.goalId !== f.goalId) return false;
  if (f.threadId !== undefined && memory.threadId !== f.threadId) return false;
  if (f.sourceKind !== undefined && !memory.sourceRefs.some((s) => s.kind === f.sourceKind)) return false;
  if (f.createdFrom !== undefined && memory.createdAt < f.createdFrom) return false;
  if (f.createdTo !== undefined && memory.createdAt >= f.createdTo) return false;
  return true;
}

/** Opaque keyset cursor: base64url of `createdAt|id`. */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!createdAt || !id || Number.isNaN(new Date(createdAt).getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

