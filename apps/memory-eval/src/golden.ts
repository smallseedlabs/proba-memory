import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { deterministicUuid, sha256Hex } from '@smallseedlabs/proba-memory-core';

/**
 * Golden set: the labelled input of the evaluation harness. YAML or JSON.
 *
 *   version: 1
 *   name: my-set
 *   workspace: eval-workspace
 *   observations:            # the corpus, replayed through the real write path
 *     - key: pref-headlines
 *       occurredAt: 2026-09-01T10:00:00Z
 *       text: "We prefer short headlines."
 *   queries:
 *     - id: q-headlines
 *       query: "how long should headlines be"
 *       expect:
 *         observations: [pref-headlines]       # memories derived from these observations
 *         facts: ["short headlines"]           # or: text the memory must contain
 *         memoryIds: ["<uuid>"]                # or: ids (stores whose ids you know)
 *
 * Every expectation is one "target". A target may be a plain string or `{ value, grade }` (grade 1..5,
 * default 1) for graded relevance in nDCG.
 */

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isoInstant = z
  .union([z.string(), z.date()])
  .transform((v, ctx) => {
    // YAML turns an unquoted timestamp into a Date; JSON keeps a string.
    const ms = v instanceof Date ? v.getTime() : Date.parse(v);
    if (!Number.isFinite(ms)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a UTC ISO 8601 timestamp' });
      return z.NEVER;
    }
    if (typeof v === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must carry a timezone (use a trailing Z)' });
      return z.NEVER;
    }
    return new Date(ms).toISOString();
  });

const target = z.union([
  z.string().min(1),
  z.object({ value: z.string().min(1), grade: z.number().int().min(1).max(5).default(1) }).strict(),
]);
export type TargetInput = z.input<typeof target>;

const extractSchema = z
  .object({
    category: z.enum(['working', 'episodic', 'semantic', 'procedural']),
    content: z.string().min(1).max(2000),
    summary: z.string().max(600).nullish(),
    importance: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    stance: z.enum(['positive', 'negative', 'neutral']).default('neutral'),
  })
  .strict();

const observationSchema = z
  .object({
    key: z.string().regex(KEY, 'letters, digits, ., _ and - only'),
    occurredAt: isoInstant,
    kind: z.string().min(1).default('thread.message'),
    text: z.string().min(1),
    /** Overrides the golden set's workspace (to test isolation). */
    workspace: z.string().min(1).optional(),
    polarity: z.enum(['positive', 'negative', 'neutral']).default('neutral'),
    strength: z.number().min(0).max(1).default(0.3),
    goalId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    /**
     * What the scripted model "extracts" from this observation. Without it the built-in rules of the
     * scripted provider write the memory. Use it to control category, importance and wording exactly.
     */
    extract: extractSchema.optional(),
  })
  .strict();

const expectSchema = z
  .object({
    observations: z.array(target).default([]),
    facts: z.array(target).default([]),
    memoryIds: z.array(target).default([]),
    /** Memories that must NOT show up in the top k (for example an outdated preference). */
    avoid: z
      .object({
        observations: z.array(z.string().min(1)).default([]),
        facts: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

const querySchema = z
  .object({
    id: z.string().regex(KEY, 'letters, digits, ., _ and - only'),
    query: z.string().min(1),
    workspace: z.string().min(1).optional(),
    /** When the question is asked. Default: the golden set's `now`, else the time of its last observation. */
    asOf: isoInstant.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    tokenBudget: z.number().int().min(1).optional(),
    filter: z.object({ categories: z.array(z.enum(['working', 'episodic', 'semantic', 'procedural', 'super'])).min(1) }).strict().optional(),
    tags: z.array(z.string()).default([]),
    expect: expectSchema,
  })
  .strict();

export const goldenSetSchema = z
  .object({
    version: z.literal(1),
    name: z.string().regex(KEY, 'letters, digits, ., _ and - only'),
    description: z.string().optional(),
    workspace: z.string().min(1),
    /** Default `asOf` of queries. */
    now: isoInstant.optional(),
    /** Cut-offs of the @k metrics. Default [1, 3, 5]. The last one is the headline k (the gate's). */
    k: z.array(z.number().int().min(1).max(50)).min(1).optional(),
    observations: z.array(observationSchema).default([]),
    queries: z.array(querySchema).min(1),
  })
  .strict();

export type GoldenSetInput = z.input<typeof goldenSetSchema>;
type Parsed = z.output<typeof goldenSetSchema>;

export type TargetKind = 'observation' | 'fact' | 'memoryId';

export interface Target {
  kind: TargetKind;
  value: string;
  grade: number;
}

export interface GoldenObservation {
  key: string;
  /** Deterministic id the write path stores the observation under. */
  id: string;
  /** Source ref that memories built from it carry in retrieval results. */
  ref: string;
  workspace: string;
  occurredAt: string;
  kind: string;
  text: string;
  polarity: 'positive' | 'negative' | 'neutral';
  strength: number;
  goalId?: string;
  threadId?: string;
  extract?: z.output<typeof extractSchema>;
}

export interface GoldenQuery {
  id: string;
  query: string;
  workspace: string;
  asOf: string;
  asOfExplicit: boolean;
  limit?: number;
  tokenBudget?: number;
  categories?: string[];
  tags: string[];
  targets: Target[];
  avoid: { observations: { key: string; ref: string }[]; facts: string[] };
}

export interface GoldenSet {
  name: string;
  description: string;
  workspace: string;
  k: number[];
  observations: GoldenObservation[];
  queries: GoldenQuery[];
  /** Latest occurredAt of the corpus (ISO), or null without observations. */
  lastObservationAt: string | null;
  /** sha256 of the normalised content: the regression baseline records it so a changed set is noticed. */
  digest: string;
}

export class GoldenSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenSetError';
  }
}

export const DEFAULT_K = [1, 3, 5];

export function observationIdOf(setName: string, key: string): string {
  return deterministicUuid('eval-observation', `${setName}:${key}`);
}

/** The source ref the write path stamps on memories built from a golden observation; retrieval returns it. */
export function observationRefOf(setName: string, key: string): string {
  return `eval:${setName}:${key}`;
}

const normaliseTarget = (kind: TargetKind) => (t: z.output<typeof target>): Target =>
  typeof t === 'string' ? { kind, value: t, grade: 1 } : { kind, value: t.value, grade: t.grade };

/** Validate an already parsed document. `source` only labels error messages. */
export function parseGoldenSet(raw: unknown, source = 'golden set'): GoldenSet {
  const result = goldenSetSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new GoldenSetError(`${source} is invalid:\n${lines.join('\n')}`);
  }
  return build(result.data, source);
}

function build(doc: Parsed, source: string): GoldenSet {
  const errors: string[] = [];
  const keys = new Set<string>();
  const texts = new Set<string>();
  const observations: GoldenObservation[] = doc.observations.map((o) => {
    if (keys.has(o.key)) errors.push(`observation key "${o.key}" is used twice`);
    keys.add(o.key);
    const norm = o.text.trim().toLowerCase();
    if (texts.has(norm)) errors.push(`observation "${o.key}" repeats the text of another observation (use one observation per statement)`);
    texts.add(norm);
    return {
      key: o.key,
      id: observationIdOf(doc.name, o.key),
      ref: observationRefOf(doc.name, o.key),
      workspace: o.workspace ?? doc.workspace,
      occurredAt: o.occurredAt,
      kind: o.kind,
      text: o.text,
      polarity: o.polarity,
      strength: o.strength,
      ...(o.goalId ? { goalId: o.goalId } : {}),
      ...(o.threadId ? { threadId: o.threadId } : {}),
      ...(o.extract ? { extract: o.extract } : {}),
    };
  });
  observations.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.key.localeCompare(b.key));
  const lastObservationAt = observations.length > 0 ? (observations[observations.length - 1] as GoldenObservation).occurredAt : null;
  const defaultNow = doc.now ?? lastObservationAt;

  const queryIds = new Set<string>();
  const queries: GoldenQuery[] = doc.queries.map((q) => {
    if (queryIds.has(q.id)) errors.push(`query id "${q.id}" is used twice`);
    queryIds.add(q.id);
    const targets = [
      ...q.expect.observations.map(normaliseTarget('observation')),
      ...q.expect.facts.map(normaliseTarget('fact')),
      ...q.expect.memoryIds.map(normaliseTarget('memoryId')),
    ];
    const avoidObservations = q.expect.avoid.observations;
    for (const t of targets) {
      if (t.kind === 'observation' && !keys.has(t.value)) errors.push(`query "${q.id}" expects unknown observation "${t.value}"`);
    }
    for (const key of avoidObservations) if (!keys.has(key)) errors.push(`query "${q.id}" avoids unknown observation "${key}"`);
    if (targets.length === 0 && avoidObservations.length === 0 && q.expect.avoid.facts.length === 0) {
      errors.push(`query "${q.id}" expects nothing (add observations, facts, memoryIds or avoid)`);
    }
    const asOf = q.asOf ?? defaultNow;
    if (!asOf) errors.push(`query "${q.id}" has no asOf and the set has neither \`now\` nor observations`);
    return {
      id: q.id,
      query: q.query,
      workspace: q.workspace ?? doc.workspace,
      asOf: asOf ?? '1970-01-01T00:00:00.000Z',
      asOfExplicit: q.asOf !== undefined,
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.tokenBudget !== undefined ? { tokenBudget: q.tokenBudget } : {}),
      ...(q.filter ? { categories: q.filter.categories } : {}),
      tags: q.tags,
      targets,
      avoid: { observations: avoidObservations.map((key) => ({ key, ref: observationRefOf(doc.name, key) })), facts: q.expect.avoid.facts },
    };
  });
  if (errors.length > 0) throw new GoldenSetError(`${source} is invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`);

  const k = [...new Set(doc.k ?? DEFAULT_K)].sort((a, b) => a - b);
  const set: Omit<GoldenSet, 'digest'> = {
    name: doc.name,
    description: doc.description ?? '',
    workspace: doc.workspace,
    k,
    observations,
    queries,
    lastObservationAt,
  };
  return { ...set, digest: sha256Hex(stableStringify(set)) };
}

/** JSON with sorted keys, so the digest does not depend on key order or file format. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

/** Parse YAML or JSON text (JSON is YAML). */
export function parseDocument(text: string, source: string): unknown {
  try {
    // JSON schema keeps `2026-09-01T10:00:00Z` as a string instead of turning it into a Date.
    return yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new GoldenSetError(`${source} is not valid YAML or JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Read a golden set file (`.yaml`, `.yml` or `.json`). */
export function loadGoldenSet(path: string): GoldenSet {
  const ext = extname(path).toLowerCase();
  if (!['.yaml', '.yml', '.json'].includes(ext)) throw new GoldenSetError(`${path}: use a .yaml, .yml or .json file`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new GoldenSetError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseGoldenSet(parseDocument(text, path), path);
}
