import type { AuditActor } from '../audit/protocol.js';
import type { AuditDraft } from '../ports/audit-emitter.js';

/** Builds the memory.* audit drafts. Details hold ids, counts and lengths: never memory text. */
export const MEMORY_ACTOR = (service: string): AuditActor => ({ type: 'service', id: service });

export function ingestedDraft(args: {
  service: string;
  workspaceId: string;
  memoryId: string;
  category: string;
  observationId: string;
  sourceRef: string;
  contentLength: number;
  importance: number;
  confidence: number;
  embeddingModel: string | null;
  supersedesId: string | null;
  goalId?: string;
  threadId?: string;
  userId?: string;
}): AuditDraft {
  return {
    actor: MEMORY_ACTOR(args.service),
    workspaceId: args.workspaceId,
    action: 'memory.ingested',
    category: 'memory',
    outcome: 'success',
    target: { type: 'memory', id: args.memoryId },
    ...(args.goalId ? { goalId: args.goalId } : {}),
    ...(args.threadId ? { threadId: args.threadId } : {}),
    ...(args.userId ? { userId: args.userId } : {}),
    details: {
      memoryCategory: args.category,
      observationId: args.observationId,
      sourceRef: args.sourceRef,
      contentLength: args.contentLength,
      importance: round(args.importance),
      confidence: round(args.confidence),
      embeddingModel: args.embeddingModel,
      decision: args.supersedesId ? 'superseded_previous' : 'created',
      ...(args.supersedesId ? { supersedesId: args.supersedesId } : {}),
    },
  };
}

export function consolidatedDraft(args: {
  service: string;
  workspaceId: string;
  memoryId: string;
  observationId: string;
  similarity: number;
  evidenceCount: number;
  confidence: number;
  goalId?: string;
  threadId?: string;
  userId?: string;
}): AuditDraft {
  return {
    actor: MEMORY_ACTOR(args.service),
    workspaceId: args.workspaceId,
    action: 'memory.consolidated',
    category: 'memory',
    outcome: 'success',
    target: { type: 'memory', id: args.memoryId },
    ...(args.goalId ? { goalId: args.goalId } : {}),
    ...(args.threadId ? { threadId: args.threadId } : {}),
    ...(args.userId ? { userId: args.userId } : {}),
    details: {
      mergedObservationId: args.observationId,
      similarity: round(args.similarity),
      evidenceCount: args.evidenceCount,
      confidence: round(args.confidence),
    },
  };
}

export const round = (n: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
