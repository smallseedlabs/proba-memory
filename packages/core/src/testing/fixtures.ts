/**
 * Fixtures for contract tests. Pure data builders, no I/O.
 */

import { randomUUID } from 'node:crypto';
import type { Memory, MemoryInsert, Observation } from '../domain/index.js';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Unique name so contract tests never collide on shared Postgres/Redis. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Deterministic unit vector of `dimension` from a seed: same seed, same vector; different seeds, different directions. */
export function seededVector(dimension: number, seed: number): number[] {
  const v: number[] = [];
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < dimension; i += 1) {
    x = (Math.imul(x ^ (x >>> 15), 2246822519) + 3266489917 + i) >>> 0;
    v.push((x / 0xffffffff) * 2 - 1);
  }
  return normalise(v);
}

export function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** A vector close to `base` (small perturbation), still unit length. */
export function nearVector(base: number[], amount = 0.05, seed = 1): number[] {
  const noise = seededVector(base.length, 1000 + seed);
  return normalise(base.map((x, i) => x + noise[i] * amount));
}

export function makeMemoryInsert(workspaceId: string, overrides: Partial<MemoryInsert> = {}): MemoryInsert {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    workspaceId,
    category: 'semantic',
    content: 'The workspace prefers short headlines under forty characters.',
    summary: null,
    embedding: null,
    embeddingModel: null,
    embeddingVersion: null,
    importance: 0.6,
    confidence: 0.7,
    usefulness: 0.5,
    status: 'active',
    supersedesId: null,
    validFrom: '2026-10-20T10:00:00.000Z',
    validTo: null,
    lastAccessedAt: null,
    accessCount: 0,
    lastReinforcedAt: '2026-10-20T10:00:00.000Z',
    decayedAt: null,
    evidenceCount: 1,
    goalId: null,
    threadId: null,
    sourceRefs: [{ kind: 'goal', id: 'g1', ref: 'dev:goal-1' }],
    provenance: { extractor: null, observationIds: [], stance: 'neutral', signals: [], createdBy: 'test' },
    createdAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

export function makeObservation(workspaceId: string, overrides: Partial<Observation> = {}): Observation {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    workspaceId,
    source: 'audit',
    sourceRef: `audit:${id}`,
    kind: 'approval.rejected',
    occurredAt: '2026-10-25T10:00:00.000Z',
    traceId: randomUUID(),
    goalId: randomUUID(),
    actor: { type: 'user', id: 'u1' },
    target: { type: 'plan', id: 'p1' },
    text: null,
    facts: { action: 'approval.rejected', outcome: 'success' },
    signal: { polarity: 'negative', strength: 0.9 },
    significance: 'high',
    ...overrides,
  };
}

export type { Memory };
