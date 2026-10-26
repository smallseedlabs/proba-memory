import type { RetrievalLogEntry, RetrievalLogStore, RetrievalOutcome } from '@smallseedlabs/proba-memory-core';

/** In-process RetrievalLogStore. The transaction handle is ignored. */
export class InMemoryRetrievalLogStore implements RetrievalLogStore {
  private readonly entries: RetrievalLogEntry[] = [];

  async append(entry: RetrievalLogEntry): Promise<void> {
    this.entries.push(structuredClone(entry));
  }

  async get(workspaceId: string, id: string): Promise<RetrievalLogEntry | null> {
    const e = this.entries.find((x) => x.workspaceId === workspaceId && x.id === id);
    return e ? structuredClone(e) : null;
  }

  async list(workspaceId: string, options: { limit?: number } = {}): Promise<RetrievalLogEntry[]> {
    return structuredClone(
      this.entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.workspaceId === workspaceId)
        .sort((a, b) => (a.e.createdAt === b.e.createdAt ? b.i - a.i : a.e.createdAt < b.e.createdAt ? 1 : -1))
        .slice(0, options.limit ?? 50)
        .map(({ e }) => e)
    );
  }

  async listUnresolved(workspaceId: string, options: { createdBefore: string; limit: number }): Promise<RetrievalLogEntry[]> {
    return structuredClone(
      this.entries
        .filter((e) => e.workspaceId === workspaceId && !e.outcome && e.createdAt <= options.createdBefore)
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
        .slice(0, options.limit)
    );
  }

  async listUnapplied(workspaceId: string, options: { limit: number }): Promise<RetrievalLogEntry[]> {
    return structuredClone(
      this.entries
        .filter((e) => e.workspaceId === workspaceId && e.outcome && !e.outcomeAppliedAt)
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
        .slice(0, options.limit)
    );
  }

  async recordOutcome(workspaceId: string, id: string, outcome: RetrievalOutcome): Promise<boolean> {
    const e = this.entries.find((x) => x.workspaceId === workspaceId && x.id === id);
    if (!e || e.outcome) return false;
    e.outcome = structuredClone(outcome);
    return true;
  }

  async markOutcomeApplied(workspaceId: string, id: string, at: string): Promise<boolean> {
    const e = this.entries.find((x) => x.workspaceId === workspaceId && x.id === id);
    if (!e || !e.outcome || e.outcomeAppliedAt) return false;
    e.outcomeAppliedAt = new Date(at).toISOString();
    return true;
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
