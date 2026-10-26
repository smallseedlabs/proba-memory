/**
 * VectorIndex port: nearest-neighbour search over memory embeddings.
 *
 * The Postgres adapter is the same database as the MemoryStore (pgvector, HNSW, cosine); another
 * adapter (Qdrant, ...) can keep vectors elsewhere. An adapter without the memory metadata must
 * apply `filter` by looking the candidates up in the MemoryStore and over-fetching.
 */

import type { MemoryFilter } from '../domain/index.js';

export interface VectorEntry {
  id: string;
  workspaceId: string;
  vector: number[];
  model: string;
  version: string;
}

export interface VectorSearchQuery {
  workspaceId: string;
  vector: number[];
  limit: number;
  /** Only vectors written by this model and version are comparable. */
  model: string;
  version: string;
  filter?: MemoryFilter;
}

export interface VectorHit {
  id: string;
  /** Cosine similarity, -1..1 (1 = same direction). */
  similarity: number;
}

export interface VectorIndex {
  readonly name: string;
  /** Vector length every entry must have. */
  readonly dimension: number;
  /** Insert or replace vectors. Idempotent. Rejects a vector of the wrong length. */
  upsert(entries: VectorEntry[]): Promise<void>;
  /** Best first. Never returns another workspace's vectors. */
  search(query: VectorSearchQuery): Promise<VectorHit[]>;
  /** Stored vectors of the given ids (missing ones absent). */
  getVectors(workspaceId: string, ids: string[]): Promise<Map<string, number[]>>;
  remove(workspaceId: string, ids: string[]): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
