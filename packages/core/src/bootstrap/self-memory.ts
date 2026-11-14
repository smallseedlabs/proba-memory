/**
 * Proba's bootstrap "self" memory: who Proba is, how it should behave and what its limbs do.
 *
 * The content is versioned data (bootstrap/proba-self.json), not code. memory-api upserts it on start into the reserved
 * system workspace, where every tenant may read it (through GET /v1/self) and none may write it: the write pipeline
 * refuses observations for that workspace and the job runner never runs jobs there, so nothing but this seeder changes it.
 *
 * Seeding is idempotent and keyed by version: each entry's memory id is derived from (version, key). Re-seeding the same
 * version changes nothing; a new version inserts new memories that supersede the previous version's (status `superseded`,
 * `supersedesId` set), and entries dropped from the file are tombstoned. Memories are never deleted or edited in place.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Memory, MemoryInsert } from '../domain/memory.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { MemoryStore } from '../ports/memory-store.js';

/** The workspace that holds system-owned memories. Reserved: tenants can read it through /v1/self only and never write it. */
export const SYSTEM_WORKSPACE_ID = '__proba_system__';
/** `provenance.createdBy` of every self memory; also the only writer allowed in the system workspace. */
export const SELF_MEMORY_CREATED_BY = 'bootstrap:self';
/** Signal (tag) carried by every self memory. */
export const SELF_MEMORY_SIGNAL = 'proba.self';

export function isReservedWorkspaceId(workspaceId: string): boolean {
  return workspaceId.trim().toLowerCase() === SYSTEM_WORKSPACE_ID;
}

const keySchema = z
  .string()
  .regex(/^[0-9]{2}-[a-z0-9-]{1,60}$/, 'key is a two-digit order prefix and a lower-case slug, for example 01-identity');

export const selfSeedSchema = z
  .object({
    schema: z.literal('proba.self-memory/v1'),
    version: z.string().regex(/^[0-9A-Za-z.\-_]{1,64}$/),
    description: z.string().max(2000).optional(),
    entries: z
      .array(
        z
          .object({
            key: keySchema,
            title: z.string().min(1).max(200),
            category: z.enum(['semantic', 'procedural']),
            content: z.string().min(1).max(3500),
          })
          .strict()
      )
      .min(1)
      .max(30),
  })
  .strict()
  .superRefine((seed, ctx) => {
    const keys = seed.entries.map((e) => e.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'entry keys must be unique', path: ['entries'] });
  });

export type SelfSeed = z.infer<typeof selfSeedSchema>;
export type SelfSeedEntry = SelfSeed['entries'][number];

export class SelfSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfSeedError';
  }
}

export function parseSelfSeed(raw: unknown): SelfSeed {
  const parsed = selfSeedSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SelfSeedError(`invalid self memory seed: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return parsed.data;
}

/** Deterministic memory id for (version, key): a UUID-shaped digest, so the same seed always maps to the same rows. */
export function selfMemoryId(version: string, key: string): string {
  const hex = createHash('sha256').update(`proba-self\u0000${version}\u0000${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/** The key and version a self memory was seeded from (kept in its source ref). */
export function selfMemoryKey(memory: Pick<Memory, 'sourceRefs'>): { key: string; version: string } | null {
  const ref = memory.sourceRefs.find((s) => s.kind === 'other' && s.ref.startsWith('self:'));
  if (!ref) return null;
  const [, version, key] = ref.ref.split(':');
  return version && key ? { key, version } : null;
}

const isSelfMemory = (m: Memory): boolean => m.provenance.createdBy === SELF_MEMORY_CREATED_BY && selfMemoryKey(m) !== null;

async function listAllSelf(store: Pick<MemoryStore, 'listMemories'>, statuses: Memory['status'][]): Promise<Memory[]> {
  const out: Memory[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listMemories({ workspaceId: SYSTEM_WORKSPACE_ID, filter: { statuses }, limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...page.memories.filter(isSelfMemory));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

/** The active self memories, in entry order (by key). */
export async function listSelfMemories(store: Pick<MemoryStore, 'listMemories'>): Promise<Memory[]> {
  const active = await listAllSelf(store, ['active']);
  return active.sort((a, b) => (selfMemoryKey(a)!.key < selfMemoryKey(b)!.key ? -1 : 1));
}

export interface SeedSelfResult {
  version: string;
  inserted: number;
  superseded: number;
  tombstoned: number;
  unchanged: number;
  /** Entries whose stored text differs from the file for the same version: the file changed without a version bump. Kept as stored. */
  conflicts: string[];
}

function toInsert(seed: SelfSeed, entry: SelfSeedEntry, now: string, supersedesId: string | null): MemoryInsert {
  return {
    id: selfMemoryId(seed.version, entry.key),
    workspaceId: SYSTEM_WORKSPACE_ID,
    category: entry.category,
    content: entry.content,
    summary: entry.title,
    embeddingModel: null,
    embeddingVersion: null,
    embedding: null,
    importance: 1,
    confidence: 1,
    usefulness: 0.5,
    status: 'active',
    supersedesId,
    validFrom: now,
    validTo: null,
    lastAccessedAt: null,
    accessCount: 0,
    lastReinforcedAt: now,
    decayedAt: null,
    evidenceCount: 1,
    goalId: null,
    threadId: null,
    ownerActorId: null,
    visibility: 'workspace',
    sourceRefs: [{ kind: 'other', id: entry.key, ref: `self:${seed.version}:${entry.key}` }],
    provenance: { extractor: null, observationIds: [], stance: 'neutral', signals: [SELF_MEMORY_SIGNAL], createdBy: SELF_MEMORY_CREATED_BY },
    createdAt: now,
  };
}

/**
 * Upsert the seed into the system workspace in one transaction. Safe to run on every start and from several replicas:
 * an id that already exists is left alone (a concurrent insert of the same id fails the transaction, which the caller may retry).
 */
export async function seedSelfMemory(store: MemoryStore, seed: SelfSeed, deps: { clock: Clock; logger?: Logger }): Promise<SeedSelfResult> {
  const now = deps.clock.isoNow();
  const result: SeedSelfResult = { version: seed.version, inserted: 0, superseded: 0, tombstoned: 0, unchanged: 0, conflicts: [] };
  await store.transaction(async (tx) => {
    const active = await listAllSelf(tx, ['active']);
    const activeByKey = new Map(active.map((m) => [selfMemoryKey(m)!.key, m]));
    const wanted = new Set(seed.entries.map((e) => e.key));
    for (const entry of seed.entries) {
      const id = selfMemoryId(seed.version, entry.key);
      const existing = await tx.getMemory(SYSTEM_WORKSPACE_ID, id);
      if (existing) {
        result.unchanged += 1;
        if (existing.content !== entry.content || existing.summary !== entry.title) result.conflicts.push(entry.key);
        continue;
      }
      const previous = activeByKey.get(entry.key);
      await tx.insertMemory(toInsert(seed, entry, now, previous?.id ?? null));
      result.inserted += 1;
      if (previous) {
        await tx.updateMemory(SYSTEM_WORKSPACE_ID, previous.id, { status: 'superseded', validTo: now }, now);
        await tx.insertLink({ workspaceId: SYSTEM_WORKSPACE_ID, fromId: id, toId: previous.id, relation: 'supersedes', weight: 1, createdAt: now });
        result.superseded += 1;
      }
    }
    for (const [key, memory] of activeByKey) {
      if (wanted.has(key)) continue;
      await tx.updateMemory(SYSTEM_WORKSPACE_ID, memory.id, { status: 'tombstoned', validTo: now }, now);
      result.tombstoned += 1;
    }
  });
  if (result.conflicts.length > 0) {
    deps.logger?.warn('self memory seed changed without a version bump: stored text kept; bump "version" in the seed file', {
      lifecycle: 'self_memory_conflict',
      version: seed.version,
      keys: result.conflicts,
    });
  }
  return result;
}
