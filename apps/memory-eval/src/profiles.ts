import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import { DEFAULT_SCORING_CONFIG_V1, parseScoringConfig, type ScoringConfig } from '@smallseedlabs/proba-memory-scoring';
import { sha256Hex } from '@smallseedlabs/proba-memory-core';
import { GoldenSetError, parseDocument, stableStringify } from './golden.js';

/** One scoring profile under evaluation. */
export interface ProfileSpec {
  name: string;
  description: string;
  config: ScoringConfig;
  /** sha256 of the config, so a report says exactly what was measured. */
  digest: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge of plain objects; arrays and scalars in `patch` replace. */
export function mergeConfig(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isObject(current) && isObject(value) ? mergeConfig(current, value) : value;
  }
  return out;
}

export function makeProfile(name: string, patch: unknown, description = ''): ProfileSpec {
  if (!NAME.test(name)) throw new GoldenSetError(`profile name "${name}" must use letters, digits, ., _ and - only`);
  if (patch !== undefined && !isObject(patch)) throw new GoldenSetError(`profile "${name}": config must be an object`);
  let config: ScoringConfig;
  try {
    config = parseScoringConfig(mergeConfig(DEFAULT_SCORING_CONFIG_V1 as unknown as Json, (patch ?? {}) as Json));
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new GoldenSetError(`profile "${name}" is invalid:\n${err.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
    }
    throw err;
  }
  return { name, description, config, digest: sha256Hex(stableStringify(config)) };
}

/** The built-in default profile (version 1 of "default"). */
export const defaultProfile = (name = 'default'): ProfileSpec => makeProfile(name, {}, 'Built-in default scoring profile');

const profileFileSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().default(''),
    /** Only the fields that differ from the default profile; everything else is inherited. */
    config: z.record(z.unknown()).default({}),
  })
  .strict();

/**
 * Parse `--profile` values: `default`, `name=default`, a file path, or `name=path`.
 * A file holds `{ name?, description?, config: { ...overrides of the default profile } }`.
 */
export function loadProfile(spec: string): ProfileSpec {
  const eq = spec.indexOf('=');
  const alias = eq > 0 ? spec.slice(0, eq) : undefined;
  const ref = eq > 0 ? spec.slice(eq + 1) : spec;
  if (ref === 'default') return defaultProfile(alias ?? 'default');
  let text: string;
  try {
    text = readFileSync(ref, 'utf8');
  } catch (err) {
    throw new GoldenSetError(`cannot read profile ${ref}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = profileFileSchema.safeParse(parseDocument(text, ref));
  if (!parsed.success) {
    throw new GoldenSetError(`profile ${ref} is invalid:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
  }
  const fallback = basename(ref, extname(ref));
  return makeProfile(alias ?? parsed.data.name ?? fallback, parsed.data.config, parsed.data.description);
}
