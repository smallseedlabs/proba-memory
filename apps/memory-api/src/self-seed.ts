import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SelfSeedError,
  parseSelfSeed,
  seedSelfMemory,
  type AppConfig,
  type Clock,
  type Logger,
  type MemoryStore,
  type SeedSelfResult,
  type SelfSeed,
} from '@smallseedlabs/proba-memory-core';

/** The seed shipped with the service: bootstrap/proba-self.json at the repository (and image) root. */
export const DEFAULT_SELF_SEED_FILE = fileURLToPath(new URL('../../../bootstrap/proba-self.json', import.meta.url));

export function loadSelfSeedFile(path: string = DEFAULT_SELF_SEED_FILE): SelfSeed {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new SelfSeedError(`cannot read the self memory seed file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSelfSeed(raw);
}

/**
 * Start-up step of memory-api: upsert Proba's bootstrap self memory into the system workspace. Idempotent (keyed by the seed's
 * version). A seed file that is missing or invalid stops the start, like a missing migration: every session depends on it.
 */
export async function bootstrapSelfMemory(deps: { config: AppConfig; store: MemoryStore; clock: Clock; logger: Logger }): Promise<SeedSelfResult | null> {
  const { selfSeed } = deps.config.api;
  if (!selfSeed.enabled) {
    deps.logger.warn('self memory seeding is off (MEMORY_SELF_SEED_ENABLED=false): sessions get no bootstrap self memory', { lifecycle: 'self_memory_off' });
    return null;
  }
  const seed = loadSelfSeedFile(selfSeed.file || DEFAULT_SELF_SEED_FILE);
  const result = await seedSelfMemory(deps.store, seed, { clock: deps.clock, logger: deps.logger });
  deps.logger.info('self memory seeded', { lifecycle: 'self_memory_seeded', ...result, conflicts: result.conflicts.length });
  return result;
}
