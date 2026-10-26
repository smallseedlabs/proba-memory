import { createLogger, loadConfigFromEnvironment } from '@smallseedlabs/proba-memory-core';
import { migrate } from './migrate.js';
import { createPgPool } from './pool.js';

async function main(): Promise<void> {
  const config = loadConfigFromEnvironment({ serviceName: 'memory-migrate' });
  const logger = createLogger({ service: config.service.name, level: config.log.level, env: config.env, pretty: config.isDevelopment });
  const pool = createPgPool(config.postgres.url, 2);
  try {
    const result = await migrate({
      pool,
      embeddingDimension: config.postgres.embeddingDimension,
      dir: config.postgres.migrationsDir || undefined,
      logger,
    });
    logger.info('migrations complete', { applied: result.applied, alreadyApplied: result.alreadyApplied.length, embeddingDimension: config.postgres.embeddingDimension });
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
