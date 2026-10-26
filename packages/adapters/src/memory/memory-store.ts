import { cosineSimilarity } from '@smallseedlabs/proba-memory-scoring';
import {
  decodeCursor,
  defaultFilter,
  encodeCursor,
  matchesFilter,
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_MAX_LIMIT,
  type ClaimResult,
  type Memory,
  type MemoryInsert,
  type MemoryLink,
  type MemoryListQuery,
  type MemoryPage,
  type MemoryPatch,
  type MemoryFilter,
  type EmbeddingMigrationStats,
  type EmbeddingMigrationStore,
  type EmbeddingTarget,
  type MemoryStore,
  type MemoryStoreTx,
  type PendingEmbedding,
  type Observation,
  type ObservationStatus,
  type StoredObservation,
  type TextHit,
  type TextSearchQuery,
  type VectorEntry,
  type VectorHit,
  type VectorIndex,
  type VectorSearchQuery,
} from '@smallseedlabs/proba-memory-core';
import { rankDocuments } from './text-search.js';

interface Row {
  memory: Memory;
  embedding: number[] | null;
  /** A vector of a newer model, written by the re-embed job and not served until cutover. */
  staged: { vector: number[]; model: string; version: string } | null;
}

interface State {
  rows: Map<string, Row>;
  links: MemoryLink[];
  observations: Map<string, StoredObservation>;
  sources: Map<string, Set<string>>;
}

const iso = (t: string): string => new Date(t).toISOString();
const clone = <T>(v: T): T => structuredClone(v);
const obsKey = (ws: string, id: string): string => `${ws}\u0000${id}`;

function cloneState(s: State): State {
  return {
    rows: new Map([...s.rows].map(([k, r]) => [k, { memory: clone(r.memory), embedding: r.embedding ? [...r.embedding] : null, staged: r.staged ? clone(r.staged) : null }])),
    links: clone(s.links),
    observations: new Map([...s.observations].map(([k, o]) => [k, clone(o)])),
    sources: new Map([...s.sources].map(([k, v]) => [k, new Set(v)])),
  };
}

/**
 * In-process MemoryStore following the port's semantics, including transactions (all-or-nothing, with
 * its own writes visible) and workspace isolation. Its vectors live in the same rows, exactly like the
 * pgvector column, and InMemoryVectorIndex reads them from here. For tests and single-process local runs.
 */
export class InMemoryMemoryStore implements MemoryStore, EmbeddingMigrationStore {
  private state: State = { rows: new Map(), links: [], observations: new Map(), sources: new Map() };
  private lock: Promise<unknown> = Promise.resolve();

  // --- reads (shared with transactions) ---

  private readonly reader = (state: () => State) => ({
    getMemory: async (workspaceId: string, id: string): Promise<Memory | null> => {
      const row = state().rows.get(id);
      return row && row.memory.workspaceId === workspaceId ? clone(row.memory) : null;
    },
    getMemories: async (workspaceId: string, ids: string[]): Promise<Memory[]> => {
      const out: Memory[] = [];
      for (const id of new Set(ids)) {
        const row = state().rows.get(id);
        if (row && row.memory.workspaceId === workspaceId) out.push(clone(row.memory));
      }
      return out;
    },
    listMemories: async (q: MemoryListQuery): Promise<MemoryPage> => {
      const limit = Math.min(q.limit ?? MEMORY_LIST_DEFAULT_LIMIT, MEMORY_LIST_MAX_LIMIT);
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      if (q.cursor && !cursor) throw new Error('invalid cursor');
      const all = [...state().rows.values()]
        .map((r) => r.memory)
        .filter((m) => m.workspaceId === q.workspaceId && matchesFilter(m, q.filter))
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
        .filter((m) => !cursor || m.createdAt < cursor.createdAt || (m.createdAt === cursor.createdAt && m.id < cursor.id));
      const page = all.slice(0, limit);
      const last = page[page.length - 1];
      return { memories: clone(page), nextCursor: all.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
    },
    searchText: async (q: TextSearchQuery): Promise<TextHit[]> => {
      const docs = [...state().rows.values()]
        .map((r) => r.memory)
        .filter((m) => m.workspaceId === q.workspaceId && matchesFilter(m, q.filter))
        .map((m) => ({ id: m.id, text: `${m.content} ${m.summary ?? ''}` }));
      return rankDocuments(q.query, docs).slice(0, q.limit);
    },
    listObservationsByTrace: async (workspaceId: string, traceIds: string[]): Promise<StoredObservation[]> => {
      const wanted = new Set(traceIds);
      return clone(
        [...state().observations.values()]
          .filter((o) => o.workspaceId === workspaceId && o.traceId !== undefined && wanted.has(o.traceId))
          .sort((a, b) => (a.occurredAt === b.occurredAt ? (a.id < b.id ? -1 : 1) : a.occurredAt < b.occurredAt ? -1 : 1))
      );
    },
    listLinks: async (workspaceId: string, memoryId: string): Promise<MemoryLink[]> =>
      clone(state().links.filter((l) => l.workspaceId === workspaceId && (l.fromId === memoryId || l.toId === memoryId))),
    getObservation: async (workspaceId: string, id: string): Promise<StoredObservation | null> => {
      const o = state().observations.get(obsKey(workspaceId, id));
      return o ? clone(o) : null;
    },
    listObservationMemoryIds: async (workspaceId: string, observationId: string): Promise<string[]> =>
      [...(state().sources.get(obsKey(workspaceId, observationId)) ?? [])].filter((id) => state().rows.get(id)?.memory.workspaceId === workspaceId),
    listWorkspaceIds: async (): Promise<string[]> => {
      const ids = new Set<string>();
      for (const r of state().rows.values()) ids.add(r.memory.workspaceId);
      for (const o of state().observations.values()) ids.add(o.workspaceId);
      return [...ids].sort();
    },
    countMemories: async (workspaceId: string, filter?: MemoryFilter): Promise<number> =>
      [...state().rows.values()].filter((r) => r.memory.workspaceId === workspaceId && matchesFilter(r.memory, filter)).length,
  });

  getMemory = this.reader(() => this.state).getMemory;
  getMemories = this.reader(() => this.state).getMemories;
  listMemories = this.reader(() => this.state).listMemories;
  searchText = this.reader(() => this.state).searchText;
  listLinks = this.reader(() => this.state).listLinks;
  getObservation = this.reader(() => this.state).getObservation;
  listObservationsByTrace = this.reader(() => this.state).listObservationsByTrace;
  listObservationMemoryIds = this.reader(() => this.state).listObservationMemoryIds;
  listWorkspaceIds = this.reader(() => this.state).listWorkspaceIds;
  countMemories = this.reader(() => this.state).countMemories;

  // --- writes ---

  private writer() {
    const state = (): State => this.state;
    return {
      insertMemory: async (m: MemoryInsert): Promise<void> => {
        if (state().rows.has(m.id)) throw new Error(`memory ${m.id} already exists`);
        const { embedding, createdAt, ...rest } = m;
        const at = iso(createdAt ?? new Date().toISOString());
        state().rows.set(m.id, {
          memory: clone({ ...rest, validFrom: iso(rest.validFrom), lastReinforcedAt: iso(rest.lastReinforcedAt), createdAt: at, updatedAt: at } as Memory),
          embedding: embedding ? [...embedding] : null,
          staged: null,
        });
      },
      updateMemory: async (workspaceId: string, id: string, patch: MemoryPatch, at: string): Promise<boolean> => {
        const row = state().rows.get(id);
        if (!row || row.memory.workspaceId !== workspaceId) return false;
        const { embedding, ...fields } = patch;
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) continue;
          (row.memory as unknown as Record<string, unknown>)[k] = typeof v === 'string' && /(At|validTo)$/.test(k) ? iso(v) : clone(v);
        }
        if (embedding) {
          row.embedding = [...embedding.vector];
          row.memory.embeddingModel = embedding.model;
          row.memory.embeddingVersion = embedding.version;
        }
        row.memory.updatedAt = iso(at);
        return true;
      },
      insertLink: async (link: MemoryLink): Promise<void> => {
        const exists = state().links.some((l) => l.workspaceId === link.workspaceId && l.fromId === link.fromId && l.toId === link.toId && l.relation === link.relation);
        if (!exists) state().links.push(clone(link));
      },
      linkSource: async (workspaceId: string, memoryId: string, observationId: string): Promise<void> => {
        const key = obsKey(workspaceId, observationId);
        const set = state().sources.get(key) ?? new Set<string>();
        set.add(memoryId);
        state().sources.set(key, set);
      },
      recordAccess: async (workspaceId: string, ids: string[], at: string): Promise<void> => {
        for (const id of new Set(ids)) {
          const row = state().rows.get(id);
          if (!row || row.memory.workspaceId !== workspaceId) continue;
          row.memory.accessCount += 1;
          row.memory.lastAccessedAt = iso(at);
        }
      },
      markObservation: async (workspaceId: string, id: string, status: Exclude<ObservationStatus, 'pending'>, at: string, error?: string): Promise<void> => {
        const o = state().observations.get(obsKey(workspaceId, id));
        if (!o) throw new Error(`observation ${id} was never claimed`);
        o.status = status;
        o.processedAt = iso(at);
        o.lastError = error ?? null;
      },
    };
  }

  async claimObservation(observation: Observation, at: string): Promise<ClaimResult> {
    return this.serial(async () => {
      const key = obsKey(observation.workspaceId, observation.id);
      const existing = this.state.observations.get(key);
      if (!existing) {
        this.state.observations.set(key, { ...clone(observation), status: 'pending', attempts: 1, lastError: null, processedAt: null, createdAt: iso(at) });
        return 'new';
      }
      if (existing.status === 'processed' || existing.status === 'skipped') return 'done';
      existing.attempts += 1;
      return 'reprocess';
    });
  }

  async recordObservationFailure(workspaceId: string, id: string, error: string): Promise<void> {
    await this.serial(async () => {
      const o = this.state.observations.get(obsKey(workspaceId, id));
      if (o) o.lastError = error.slice(0, 1000);
    });
  }

  async transaction<T>(fn: (tx: MemoryStoreTx) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const snapshot = cloneState(this.state);
      const tx: MemoryStoreTx = { handle: undefined, ...this.reader(() => this.state), ...this.writer() };
      try {
        return await fn(tx);
      } catch (err) {
        this.state = snapshot;
        throw err;
      }
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  // --- vector access for InMemoryVectorIndex ---

  /** @internal */
  vectorRows(): Iterable<Row> {
    return this.state.rows.values();
  }

  /** @internal */
  getRow(id: string): Row | undefined {
    return this.state.rows.get(id);
  }

  // --- embedding migration (the staged vector lives next to the current one, like the second pgvector column) ---

  private isAtTarget(row: Row, target: EmbeddingTarget): boolean {
    return row.embedding !== null && row.memory.embeddingModel === target.model && row.memory.embeddingVersion === target.version;
  }

  private isStaged(row: Row, target: EmbeddingTarget): boolean {
    return row.staged !== null && row.staged.model === target.model && row.staged.version === target.version;
  }

  async listPending(workspaceId: string, target: EmbeddingTarget, limit: number): Promise<PendingEmbedding[]> {
    return this.serial(async () =>
      [...this.state.rows.values()]
        .filter((r) => r.memory.workspaceId === workspaceId && r.memory.status === 'active' && !this.isAtTarget(r, target) && !this.isStaged(r, target))
        .sort((a, b) => (a.memory.id < b.memory.id ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ id: r.memory.id, text: r.memory.content }))
    );
  }

  async stats(workspaceId: string, target: EmbeddingTarget): Promise<EmbeddingMigrationStats> {
    return this.serial(async () => {
      const stats: EmbeddingMigrationStats = { active: 0, atTarget: 0, staged: 0, pending: 0 };
      for (const r of this.state.rows.values()) {
        if (r.memory.workspaceId !== workspaceId || r.memory.status !== 'active') continue;
        stats.active += 1;
        if (this.isAtTarget(r, target)) stats.atTarget += 1;
        else if (this.isStaged(r, target)) stats.staged += 1;
        else stats.pending += 1;
      }
      return stats;
    });
  }

  async writeStaged(workspaceId: string, target: EmbeddingTarget, items: { id: string; vector: number[] }[]): Promise<number> {
    return this.serial(async () => {
      let n = 0;
      for (const item of items) {
        const row = this.state.rows.get(item.id);
        if (!row || row.memory.workspaceId !== workspaceId || row.memory.status !== 'active') continue;
        row.staged = { vector: [...item.vector], model: target.model, version: target.version };
        n += 1;
      }
      return n;
    });
  }

  async cutover(workspaceId: string, target: EmbeddingTarget): Promise<{ swapped: number; pending: number }> {
    return this.serial(async () => {
      const active = [...this.state.rows.values()].filter((r) => r.memory.workspaceId === workspaceId && r.memory.status === 'active');
      const pending = active.filter((r) => !this.isAtTarget(r, target) && !this.isStaged(r, target)).length;
      if (pending > 0) return { swapped: 0, pending };
      let swapped = 0;
      for (const r of active) {
        if (this.isAtTarget(r, target) || !r.staged) continue;
        r.embedding = r.staged.vector;
        r.memory.embeddingModel = r.staged.model;
        r.memory.embeddingVersion = r.staged.version;
        r.staged = null;
        swapped += 1;
      }
      return { swapped, pending: 0 };
    });
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

/** VectorIndex over the vectors held in an InMemoryMemoryStore. */
export class InMemoryVectorIndex implements VectorIndex {
  readonly name = 'memory';

  constructor(
    private readonly store: InMemoryMemoryStore,
    readonly dimension: number
  ) {}

  private check(vector: number[]): void {
    if (vector.length !== this.dimension) throw new Error(`vector has ${vector.length} dimensions, the index uses ${this.dimension}`);
  }

  async upsert(entries: VectorEntry[]): Promise<void> {
    for (const e of entries) this.check(e.vector);
    for (const e of entries) {
      const row = this.store.getRow(e.id);
      if (!row || row.memory.workspaceId !== e.workspaceId) continue;
      row.embedding = [...e.vector];
      row.memory.embeddingModel = e.model;
      row.memory.embeddingVersion = e.version;
    }
  }

  async search(q: VectorSearchQuery): Promise<VectorHit[]> {
    this.check(q.vector);
    const f = defaultFilter(q.filter);
    const hits: VectorHit[] = [];
    for (const row of this.store.vectorRows()) {
      const m = row.memory;
      if (m.workspaceId !== q.workspaceId || !row.embedding) continue;
      if (m.embeddingModel !== q.model || m.embeddingVersion !== q.version) continue;
      if (!matchesFilter(m, f)) continue;
      hits.push({ id: m.id, similarity: cosineSimilarity(q.vector, row.embedding) });
    }
    return hits.sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1)).slice(0, q.limit);
  }

  async getVectors(workspaceId: string, ids: string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    for (const id of ids) {
      const row = this.store.getRow(id);
      if (row && row.memory.workspaceId === workspaceId && row.embedding) out.set(id, [...row.embedding]);
    }
    return out;
  }

  async remove(workspaceId: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      const row = this.store.getRow(id);
      if (row && row.memory.workspaceId === workspaceId) {
        row.embedding = null;
        row.memory.embeddingModel = null;
        row.memory.embeddingVersion = null;
      }
    }
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // The store owns the data.
  }
}
