/**
 * EmbeddingMigrationStore port: changing the embedding model or version without downtime.
 *
 * Memories keep serving from their current vector (`embedding` + model + version) while the re-embed job writes a
 * second ("staged") vector for the target model next to it. Vector search only reads the current vector, so
 * retrieval is unaffected during the migration. When every active memory has a staged vector, `cutover` swaps
 * staged to current in one atomic step. Only active memories are migrated: superseded and tombstoned ones are
 * never retrieved.
 */

export interface EmbeddingTarget {
  model: string;
  version: string;
}

export interface PendingEmbedding {
  id: string;
  /** The text to embed (the memory's content). */
  text: string;
}

export interface EmbeddingMigrationStats {
  /** Active memories of the workspace. */
  active: number;
  /** Already served by the target model and version. */
  atTarget: number;
  /** Not at the target, but with a staged target vector waiting for cutover. */
  staged: number;
  /** Neither at the target nor staged: still to embed. */
  pending: number;
}

export interface EmbeddingMigrationStore {
  /** Active memories that still need a target vector, in id order. At most `limit`. */
  listPending(workspaceId: string, target: EmbeddingTarget, limit: number): Promise<PendingEmbedding[]>;
  stats(workspaceId: string, target: EmbeddingTarget): Promise<EmbeddingMigrationStats>;
  /** Stage target vectors. Idempotent; ignores ids of other workspaces or non-active memories. Returns how many were staged. */
  writeStaged(workspaceId: string, target: EmbeddingTarget, items: { id: string; vector: number[] }[]): Promise<number>;
  /**
   * Make the staged vectors current, for every active memory that has one. Does nothing (swapped 0) while any active
   * memory is still pending. Atomic.
   */
  cutover(workspaceId: string, target: EmbeddingTarget): Promise<{ swapped: number; pending: number }>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
