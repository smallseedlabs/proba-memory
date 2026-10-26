import { runService, type SourceAdapter } from '@smallseedlabs/proba-memory-core';
import { createRuntime, createWritePipeline, type Runtime } from '@smallseedlabs/proba-memory-adapters';
import { Ingestor } from './ingestor.js';

/**
 * memory-ingestor: reads the configured sources (SOURCES=audit,content), runs every observation
 * through the write path and keeps the audit outbox flowing. Serves /health only.
 */
let runtime: Runtime | undefined;
let ingestor: Ingestor | undefined;
let relay: ReturnType<Runtime['createRelay']> = null;
let sources: SourceAdapter[] = [];

runService({
  name: 'memory-ingestor',
  defaultPort: 3201,
  async onStart({ config, logger }) {
    const rt = await createRuntime(config, { service: config.service.name, logger, needs: { embedder: true, llm: true } });
    runtime = rt;
    await rt.store.ping();
    if (config.write.sources.length === 0) throw new Error('SOURCES is empty: name at least one source (audit, content)');
    sources = [];
    for (const [i, name] of config.write.sources.entries()) {
      sources.push(await rt.registries.sourceAdapter.create(name, { ...rt.deps, consumerName: `${config.eventBus.consumerName}-${i}-${name}` }));
    }
    await Promise.all(sources.map((s) => s.ping()));
    relay = rt.createRelay();
    relay?.start();
    ingestor = new Ingestor({
      sources,
      pipeline: createWritePipeline(rt),
      logger,
      concurrency: config.write.concurrency,
      reclaimIntervalMs: config.write.reclaimIntervalMs,
      retryBaseMs: config.write.retryBaseMs,
      retryMaxMs: config.write.retryMaxMs,
      pollBlockMs: 2000,
      idleDelayMs: (source) => (source.name === 'hub-content' ? config.write.contentPollMs : 100),
    });
    ingestor.start();
    await rt.lifecycleEmitter.emit({
      actor: { type: 'service', id: config.service.name },
      action: 'system.started',
      category: 'system',
      outcome: 'success',
      details: { sources: sources.map((s) => s.name), embedder: rt.embedder.name, llm: rt.llm.name },
    });
  },
  async onStop({ config }) {
    await runtime?.lifecycleEmitter.emit({
      actor: { type: 'service', id: config.service.name },
      action: 'system.stopped',
      category: 'system',
      outcome: 'success',
      details: {},
    });
    await ingestor?.stop();
    await Promise.allSettled(sources.map((s) => s.close()));
    await relay?.stop();
    await runtime?.close();
  },
}).catch((err) => {
  console.error('fatal: memory-ingestor failed to start', err);
  process.exit(1);
});
