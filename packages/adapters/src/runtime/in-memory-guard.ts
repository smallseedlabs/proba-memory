import type { AppConfig } from '@smallseedlabs/proba-memory-core';

/** The registry name every in-memory adapter is registered under. */
export const IN_MEMORY_ADAPTER_NAME = 'memory';

export class InMemoryAdaptersNotAllowedError extends Error {
  constructor(
    readonly adapters: string[],
    readonly optInRefused = false
  ) {
    super(
      optInRefused && adapters.length === 0
        ? `ALLOW_IN_MEMORY_ADAPTERS=true is refused when NODE_ENV=production: in-memory adapters never run in production. Remove it.`
        : `In-memory adapters lose their data on restart and are not shared between replicas, so they are never allowed in production ` +
          `(selected: ${adapters.join(', ')}). Select a durable adapter (postgres, redis-streams, redis); there is no opt-in` +
          `${optInRefused ? ' (ALLOW_IN_MEMORY_ADAPTERS=true is refused in production too)' : ''}.`
    );
    this.name = 'InMemoryAdaptersNotAllowedError';
  }
}

export interface InMemoryGuardOptions {
  /** The read API's rate limiter is created outside createRuntime; only memory-api checks it (MEMORY_API_RATE_LIMITER). */
  includeRateLimiter?: boolean;
  /** Retrieval ports (scoring profiles, retrieval log) are only created by the processes that retrieve. */
  includeRetrieval?: boolean;
  /** Job ports (run store, job config, embedding migration, outcome linker) are only created by memory-jobs. */
  includeJobs?: boolean;
  /** Job run store alone (memory-api admin list of runs). */
  includeJobRunStore?: boolean;
}

/** The config keys (for example `MEMORY_STORE`) whose selected adapter is the in-memory one. */
export function selectedInMemoryAdapters(config: AppConfig, options: InMemoryGuardOptions = {}): string[] {
  const a = config.adapters;
  const candidates: [string, string][] = [
    ['MEMORY_STORE', a.memoryStore],
    ['VECTOR_INDEX', a.vectorIndex],
    ['OUTBOX_STORE', a.outboxStore],
    ['EVENT_BUS', a.eventBus],
  ];
  if (options.includeRetrieval) candidates.push(['SCORING_PROFILE_STORE', a.scoringProfileStore], ['RETRIEVAL_LOG_STORE', a.retrievalLogStore]);
  if (options.includeJobs) {
    candidates.push(['JOB_RUN_STORE', a.jobRunStore], ['JOB_CONFIG_STORE', a.jobConfigStore], ['EMBEDDING_MIGRATION_STORE', a.embeddingMigrationStore], ['OUTCOME_LINKER', a.outcomeLinker]);
  } else if (options.includeJobRunStore) {
    candidates.push(['JOB_RUN_STORE', a.jobRunStore]);
  }
  if (options.includeRateLimiter) candidates.push(['MEMORY_API_RATE_LIMITER', a.rateLimiter]);
  return candidates.filter(([, adapter]) => adapter === IN_MEMORY_ADAPTER_NAME).map(([key]) => key);
}

/**
 * Throws in production when any in-memory adapter is selected. There is no escape hatch: ALLOW_IN_MEMORY_ADAPTERS=true is itself
 * refused when NODE_ENV=production (it exists only so an accidental opt-in fails loudly). Outside production everything is allowed.
 */
export function assertInMemoryAdaptersAllowed(config: AppConfig, options: InMemoryGuardOptions = {}): void {
  if (!config.isProduction) return;
  const selected = selectedInMemoryAdapters(config, options);
  if (selected.length > 0 || config.allowInMemoryAdapters) throw new InMemoryAdaptersNotAllowedError(selected, config.allowInMemoryAdapters);
}
