import type { z } from 'zod';
import {
  MEMORY_ACTOR,
  GLOBAL_WORKSPACE,
  type AuditDraft,
  type Embedder,
  type EmbeddingMigrationStore,
  type JobConfigRecord,
  type JobConfigStore,
  type JobContext,
  type LlmProvider,
  type M2JobName,
  type Memory,
  type MemoryFilter,
  type MemoryStore,
  type Redactor,
  type RetrievalLogStore,
  type VectorIndex,
} from '@smallseedlabs/proba-memory-core';
import { defaultJobConfig, JOB_CONFIG_SPECS } from '../job-configs.js';

/** Everything the M2 jobs get besides the per-run JobContext. Optional ports are only present when a job needs them. */
export interface JobDeps {
  /** Service name stamped on audit events. */
  service: string;
  configs: JobConfigStore;
  index: VectorIndex;
  redactor: Redactor;
  /** Memories read per page. */
  batchSize: number;
  /** Tries per structured LLM call. */
  llmMaxAttempts: number;
  /** Per-job schedule. */
  intervalsMs: Record<M2JobName, number>;
  embedder?: Embedder;
  llm?: LlmProvider;
  migration?: EmbeddingMigrationStore;
  logStore?: RetrievalLogStore;
}

export function need<T>(value: T | undefined, port: string, job: string): T {
  if (value === undefined) throw new Error(`job "${job}" needs the ${port}, which this process did not create`);
  return value;
}

export interface LoadedConfig<S extends z.ZodTypeAny> {
  config: z.infer<S>;
  /** 0 when no version exists yet and this is a dry run, which uses the built-in defaults without writing them. */
  version: number;
  source: 'database' | 'defaults';
  /** The workspace the version belongs to: the run's own, or `*` for the global one. */
  scope: string;
}

/**
 * The job's rules for this run: the active version for the workspace (its own, else the global one) from the
 * JobConfigStore, validated. With no version anywhere, a real run seeds version 1 of the global config from the
 * built-in defaults first; a dry run just uses them and writes nothing. An invalid stored version fails the run
 * loudly rather than falling back silently.
 */
export async function loadJobConfig<N extends M2JobName>(
  ctx: JobContext,
  configs: JobConfigStore,
  name: N
): Promise<LoadedConfig<(typeof JOB_CONFIG_SPECS)[N]['schema']>> {
  const spec = JOB_CONFIG_SPECS[name];
  let record: JobConfigRecord | null = await configs.resolve(ctx.workspaceId, name);
  if (!record) {
    if (ctx.dryRun) return { config: spec.schema.parse(defaultJobConfig(name)), version: 0, source: 'defaults', scope: GLOBAL_WORKSPACE };
    record = await configs.publish({
      workspaceId: GLOBAL_WORKSPACE,
      jobName: name,
      config: defaultJobConfig(name),
      note: 'seeded from the built-in defaults',
      createdBy: 'system:defaults',
      at: ctx.clock.isoNow(),
      onlyIfAbsent: true,
    });
    ctx.logger.info('job config seeded from defaults', { job: name, version: record.version });
  }
  const parsed = spec.schema.safeParse(record.config);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`job config ${name} v${record.version} (${record.workspaceId}) is invalid: ${issues.join('; ')}`);
  }
  return { config: parsed.data, version: record.version, source: 'database', scope: record.workspaceId };
}

/** The memory.* draft every job event starts from. Details carry ids, counts and scores, never memory text. */
export function jobDraft(args: {
  ctx: JobContext;
  service: string;
  job: M2JobName;
  action: string;
  memoryId: string;
  configVersion: number;
  details: Record<string, unknown>;
}): AuditDraft {
  return {
    actor: MEMORY_ACTOR(args.service),
    workspaceId: args.ctx.workspaceId,
    action: args.action,
    category: 'memory',
    outcome: 'success',
    target: { type: 'memory', id: args.memoryId },
    details: { job: args.job, runId: args.ctx.runId, configVersion: args.configVersion, ...args.details },
  };
}

export const capIds = (ids: string[], max = 25): { ids: string[]; truncated: boolean } => ({ ids: ids.slice(0, max), truncated: ids.length > max });

/** Walk every memory matching `filter` (in the workspace of the run) page by page. */
export async function* pagesOf(ctx: JobContext, filter: MemoryFilter, pageSize: number): AsyncGenerator<Memory[]> {
  let cursor: string | undefined;
  do {
    if (ctx.signal.aborted) return;
    const page = await ctx.store.listMemories({ workspaceId: ctx.workspaceId, filter, limit: pageSize, ...(cursor ? { cursor } : {}) });
    cursor = page.nextCursor ?? undefined;
    if (page.memories.length > 0) yield page.memories;
  } while (cursor);
}

export interface Neighbour {
  memory: Memory;
  similarity: number;
}

/**
 * Active memories close to `memory`, in the vector space of the model that embedded it (so a half-migrated
 * workspace never compares vectors of different models). Workspace-scoped by the index; `memory` itself is excluded.
 */
export async function findNeighbours(args: {
  workspaceId: string;
  store: Pick<MemoryStore, 'getMemories'>;
  index: VectorIndex;
  memory: Memory;
  vector: number[];
  categories: Memory['category'][];
  threshold: number;
  limit: number;
  createdFrom?: string;
  createdTo?: string;
}): Promise<Neighbour[]> {
  const { memory } = args;
  if (!memory.embeddingModel || !memory.embeddingVersion) return [];
  const hits = await args.index.search({
    workspaceId: args.workspaceId,
    vector: args.vector,
    limit: args.limit + 1,
    model: memory.embeddingModel,
    version: memory.embeddingVersion,
    filter: {
      categories: args.categories,
      statuses: ['active'],
      ...(args.createdFrom ? { createdFrom: args.createdFrom } : {}),
      ...(args.createdTo ? { createdTo: args.createdTo } : {}),
    },
  });
  const wanted = hits.filter((h) => h.id !== memory.id && h.similarity >= args.threshold);
  if (wanted.length === 0) return [];
  const found = new Map((await args.store.getMemories(args.workspaceId, wanted.map((h) => h.id))).map((m) => [m.id, m]));
  return wanted.flatMap((h) => {
    const m = found.get(h.id);
    return m && m.status === 'active' ? [{ memory: m, similarity: h.similarity }] : [];
  });
}

/** Union-find over string ids. */
export class DisjointSets {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    this.add(id);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }

  groups(): string[][] {
    const out = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      out.set(root, [...(out.get(root) ?? []), id]);
    }
    return [...out.values()];
  }
}

export const byCreatedThenId = (a: Memory, b: Memory): number => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1);

export const isoFromMs = (ms: number): string => new Date(ms).toISOString();

/** Cap for lists kept inside a memory's provenance. */
export const MAX_PROVENANCE_IDS = 50;
export const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
