import {
  createLogger,
  isPolicyEmptyForConfig,
  loadConfigFromEnvironment,
  redactConfig,
} from '@smallseedlabs/proba-memory-core';
import { createRetrievalService, createRuntime } from '@smallseedlabs/proba-memory-adapters';
import { buildServer } from './server.js';

/**
 * memory-api: the HTTP API over memory retrieval (search, read by id, list, profiles).
 * Lifecycle mirrors the other Proba services (config, adapters, listen, signals); Fastify.
 */
async function main(): Promise<void> {
  const config = loadConfigFromEnvironment({ serviceName: 'memory-api', defaultPort: 3200 });
  const logger = createLogger({
    service: config.service.name,
    level: config.log.level,
    env: config.env,
    pretty: config.isDevelopment && Boolean(process.stdout.isTTY),
  });
  logger.info('service starting', { lifecycle: 'starting', nodeVersion: process.version });
  logger.info('config loaded', { lifecycle: 'config_loaded', config: redactConfig(config) });

  if (isPolicyEmptyForConfig(config)) {
    logger.warn('no MEMORY_API_ALLOWED_EMAILS, MEMORY_API_ALLOWED_EMAIL_DOMAINS or MEMORY_API_ADMIN_EMAILS set: nobody can use the API', {
      lifecycle: 'no_access_configured',
    });
  }

  const runtime = await createRuntime(config, {
    service: config.service.name,
    logger,
    needs: { embedder: true, retrieval: true, rateLimiter: true, llm: config.retrieval.rerankEnabled },
  });
  const verifier = await runtime.registries.tokenVerifier.create(config.adapters.tokenVerifier, runtime.deps);
  const limiter = await runtime.registries.rateLimiter.create(config.adapters.rateLimiter, runtime.deps);
  logger.info('api adapters created', { lifecycle: 'adapters_created', tokenVerifier: verifier.name, rateLimiter: config.adapters.rateLimiter });

  await runtime.store.ping();
  try {
    await runtime.profiles.ensureDefault();
  } catch (err) {
    logger.error('the database is not ready: apply the migrations first (npm run migrate, or the migrate container)', { lifecycle: 'schema_missing', err });
    throw err;
  }
  const relay = runtime.createRelay();
  relay?.start();

  const app = await buildServer({
    config,
    logger,
    clock: runtime.clock,
    verifier,
    limiter,
    store: runtime.store,
    profiles: runtime.profiles,
    retrieval: createRetrievalService(runtime),
    bestEffortEmitter: runtime.lifecycleEmitter,
    readiness: [
      { name: 'memoryStore', check: () => runtime.store.ping() },
      { name: 'eventBus', check: () => runtime.bus.ping() },
    ],
  });

  let stopping: Promise<void> | undefined;
  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      logger.info('service stopping', { lifecycle: 'stopping', reason });
      await runtime.lifecycleEmitter.emit({
        actor: { type: 'service', id: config.service.name },
        action: 'system.stopped',
        category: 'system',
        outcome: 'success',
        details: { signal: reason },
      });
      await app.close();
      await relay?.stop();
      await Promise.allSettled([limiter.close(), runtime.close()]);
      logger.info('service stopped', { lifecycle: 'stopped' });
    })();
    return stopping;
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stop(signal).then(
        () => process.exit(0),
        (err) => {
          logger.error('error while stopping', { lifecycle: 'stop_error', err });
          process.exit(1);
        }
      );
    });
  }

  await app.listen({ port: config.service.port, host: config.service.host });
  logger.info('http server listening', { lifecycle: 'listening', host: config.service.host, port: config.service.port });
  await runtime.lifecycleEmitter.emit({
    actor: { type: 'service', id: config.service.name },
    action: 'system.started',
    category: 'system',
    outcome: 'success',
    details: { tokenVerifier: verifier.name, rateLimiter: config.adapters.rateLimiter },
  });
  logger.info('service started', { lifecycle: 'started' });
}

main().catch((err) => {
  console.error('fatal: memory-api failed to start', err);
  process.exit(1);
});
