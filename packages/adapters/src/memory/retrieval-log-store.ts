import type { RetrievalLogEntry, RetrievalLogStore } from '@smallseedlabs/proba-memory-core';

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

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
