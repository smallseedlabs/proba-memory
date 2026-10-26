import type { Memory, MemoryLink } from '@smallseedlabs/proba-memory-core';
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
