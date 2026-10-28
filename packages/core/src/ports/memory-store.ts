/**
 * MemoryStore port: durable storage of memories, links and observations.
 *
 * Writes happen inside `transaction()`: everything done through the `tx` object commits together or
 * not at all, and `tx.handle` is the adapter's transaction handle, which is passed to the audit
 * emitter (outbox) and the retrieval log so that they commit in the same transaction.
 *
 * Every method that touches memories takes the workspace id and MUST NOT return or change anything
 * of another workspace: tenant isolation is part of the contract. A read that names `visibleTo` (or a filter with `visibleTo`)
 * MUST also return nothing the user may not read: their own memories and those with visibility `workspace`.
 */

import type {
  ClaimResult,
  Memory,
  MemoryInsert,
  MemoryLink,
  MemoryListQuery,
  MemoryPage,
  MemoryPatch,
  StoredObservation,
  TextHit,
  TextSearchQuery,
  Observation,
  ObservationStatus,
} from '../domain/index.js';

export interface MemoryReader {
  /** `visibleTo` (a user id) limits the read to what that user may read: a memory of another user answers null, like a missing one. */
  getMemory(workspaceId: string, id: string, visibleTo?: string): Promise<Memory | null>;
  /** The memories that exist in the workspace (missing or foreign ids are simply absent). Order unspecified. `visibleTo` as for getMemory. */
  getMemories(workspaceId: string, ids: string[], visibleTo?: string): Promise<Memory[]>;
  /** Keyset-paginated, newest first. Filters default to active memories. */
  listMemories(query: MemoryListQuery): Promise<MemoryPage>;
  /** Full-text candidates (best first). Honours the filter and returns only active memories unless the filter says otherwise. */
  searchText(query: TextSearchQuery): Promise<TextHit[]>;
  /** Links in which the memory takes part, either direction. */
  listLinks(workspaceId: string, memoryId: string): Promise<MemoryLink[]>;
  getObservation(workspaceId: string, id: string): Promise<StoredObservation | null>;
  /** Observations of the workspace recorded under any of the trace ids, oldest first. */
  listObservationsByTrace(workspaceId: string, traceIds: string[]): Promise<StoredObservation[]>;
  /** Memories that were created from (or reinforced by) the observation. */
  listObservationMemoryIds(workspaceId: string, observationId: string): Promise<string[]>;
  /** Workspaces that have at least one memory or observation. */
  listWorkspaceIds(): Promise<string[]>;
  countMemories(workspaceId: string, filter?: MemoryListQuery['filter']): Promise<number>;
}

export interface MemoryWriter {
  /** Insert a memory. Inserting an id that exists is an error. */
  insertMemory(memory: MemoryInsert): Promise<void>;
  /** Change fields of a memory of the workspace. Returns false when it does not exist there. */
  updateMemory(workspaceId: string, id: string, patch: MemoryPatch, at: string): Promise<boolean>;
  /** Idempotent: the same (from, to, relation) is stored once. */
  insertLink(link: MemoryLink): Promise<void>;
  /** Record that an observation created or reinforced a memory. Idempotent. */
  linkSource(workspaceId: string, memoryId: string, observationId: string, relation: 'created' | 'reinforced'): Promise<void>;
  /** Count one read of each memory (last_accessed_at, access_count). */
  recordAccess(workspaceId: string, ids: string[], at: string): Promise<void>;
  /** Set the processing state of an observation (the same transaction that stored its memories). */
  markObservation(workspaceId: string, id: string, status: Exclude<ObservationStatus, 'pending'>, at: string, error?: string): Promise<void>;
}

export interface MemoryStoreTx extends MemoryReader, MemoryWriter {
  /** The adapter's transaction handle (pg client for Postgres, undefined in memory). */
  readonly handle: unknown;
}

export interface MemoryStore extends MemoryReader {
  /**
   * Record an observation (idempotent by id) and say what to do with it:
   * 'new' (first time), 'reprocess' (stored earlier but never finished), 'done' (already processed or skipped).
   * Counts an attempt for 'new' and 'reprocess'.
   */
  claimObservation(observation: Observation, at: string): Promise<ClaimResult>;
  /** Run `fn` atomically. A throw rolls everything back and is rethrown. */
  transaction<T>(fn: (tx: MemoryStoreTx) => Promise<T>): Promise<T>;
  /** Record a failed attempt on an observation (not part of any transaction). */
  recordObservationFailure(workspaceId: string, id: string, error: string, at: string): Promise<void>;
  /** Throws if the backing service is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
