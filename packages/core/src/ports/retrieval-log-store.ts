import type { RetrievalLogEntry, RetrievalOutcome } from '../domain/index.js';

/** RetrievalLogStore port: one row per retrieval with every candidate's features and the profile version used. */
export interface RetrievalLogStore {
  /** Pass the transaction handle of the MemoryStore to commit with the memories' access counters and the audit event. */
  append(entry: RetrievalLogEntry, tx?: unknown): Promise<void>;
  get(workspaceId: string, id: string): Promise<RetrievalLogEntry | null>;
  /** Newest first. */
  list(workspaceId: string, options?: { limit?: number }): Promise<RetrievalLogEntry[]>;
  /** Entries without an outcome created at or before `createdBefore`, oldest first. */
  listUnresolved(workspaceId: string, options: { createdBefore: string; limit: number }): Promise<RetrievalLogEntry[]>;
  /** Entries with an outcome that was not applied yet, oldest first. */
  listUnapplied(workspaceId: string, options: { limit: number }): Promise<RetrievalLogEntry[]>;
  /** Set the outcome once. Returns false when the entry has one already (the first outcome wins) or does not exist. */
  recordOutcome(workspaceId: string, id: string, outcome: RetrievalOutcome): Promise<boolean>;
  /**
   * Claim the outcome for application: true exactly once per entry. Pass the MemoryStore transaction handle so the
   * claim commits together with the usefulness updates it licenses.
   */
  markOutcomeApplied(workspaceId: string, id: string, at: string, tx?: unknown): Promise<boolean>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
