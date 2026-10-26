/* eslint-disable no-console -- command-line output is the point of this file */
import { createLogger, loadConfigFromEnvironment } from '@smallseedlabs/proba-memory-core';
import { createRuntime, createWritePipeline } from '@smallseedlabs/proba-memory-adapters';
import { Ingestor } from './ingestor.js';

/**
 * Load the development content (goals, approvals, preference messages) through the real write path:
 * redaction, extraction, resolver, embedding, store. Safe to run again: observations are idempotent.
 *
 *   npm run seed
 *
 * Needs ALLOW_DEV_CONTENT_SOURCE=true and refuses to run in production.
 */
async function main(): Promise<void> {
  const config = loadConfigFromEnvironment({ serviceName: 'memory-seed', defaultPort: 0 });
  const logger = createLogger({ service: config.service.name, level: config.log.level, env: config.env, pretty: config.isDevelopment && Boolean(process.stdout.isTTY) });
  const runtime = await createRuntime(config, { service: 'memory-ingestor', logger, needs: { embedder: true, llm: true } });
  try {
    await runtime.store.ping();
    const source = await runtime.registries.sourceAdapter.create('content', runtime.deps);
    const ingestor = new Ingestor({
      sources: [source],
      pipeline: createWritePipeline(runtime),
      logger,
      concurrency: config.write.concurrency,
      reclaimIntervalMs: config.write.reclaimIntervalMs,
      retryBaseMs: config.write.retryBaseMs,
      retryMaxMs: config.write.retryMaxMs,
    });
    const totals = await ingestor.drain();
    await source.close();
    const workspaceId = config.write.devContent.workspaceId;
    const counts: Record<string, number> = {};
    for (const category of ['working', 'episodic', 'semantic', 'procedural', 'super'] as const) {
      counts[category] = await runtime.store.countMemories(workspaceId, { categories: [category] });
    }
    console.log(JSON.stringify({ workspaceId, ingested: totals, activeMemories: counts, embedder: `${runtime.embedder.name}/${runtime.embedder.model}`, llm: `${runtime.llm.name}/${runtime.llm.model}` }, null, 2));
    // The audit events written during the run stay in the outbox until a relay (memory-api, ingestor or jobs) publishes them.
    if (totals.failed > 0) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

main().catch((err) => {
  console.error('fatal: seed failed', err);
  process.exit(1);
});
