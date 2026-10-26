import type { RetrievalLogEntry } from '../domain/index.js';

/** RetrievalLogStore port: one row per retrieval with every candidate's features and the profile version used. */
export interface RetrievalLogStore {
  /** Pass the transaction handle of the MemoryStore to commit with the memories' access counters and the audit event. */
  append(entry: RetrievalLogEntry, tx?: unknown): Promise<void>;
  get(workspaceId: string, id: string): Promise<RetrievalLogEntry | null>;
  /** Newest first. */
  list(workspaceId: string, options?: { limit?: number }): Promise<RetrievalLogEntry[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
