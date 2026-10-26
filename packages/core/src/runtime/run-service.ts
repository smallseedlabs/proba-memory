/**
 * Shared process skeleton for every proba-memory app: load config, create the
 * logger, log each lifecycle step, serve /health, and shut down cleanly on
 * SIGTERM/SIGINT. Apps add behaviour through onStart/onStop (none yet).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfigFromEnvironment, redactConfig, type AppConfig } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import type { Logger } from '../ports/logger.js';

export interface ServiceContext {
  config: AppConfig;
  logger: Logger;
}

export interface ServiceDefinition {
  /** Default service name, for example "memory-api". Overridable with SERVICE_NAME. */
  name: string;
  defaultPort: number;
  onStart?: (ctx: ServiceContext) => Promise<void>;
  onStop?: (ctx: ServiceContext) => Promise<void>;
}

export interface RunServiceOptions {
  /** Config to use instead of loading from the environment (tests). */
  config?: AppConfig;
  logger?: Logger;
  /** Register SIGTERM/SIGINT handlers. Default true. */
  handleSignals?: boolean;
  /** Called with the exit code after a signal-triggered shutdown. Default process.exit. */
  exit?: (code: number) => void;
}

export interface RunningService {
  config: AppConfig;
  logger: Logger;
  /** Actual listening port (differs from config when PORT=0). */
  port: number;
  stop(reason?: string): Promise<void>;
}

export async function runService(
  definition: ServiceDefinition,
  options: RunServiceOptions = {}
): Promise<RunningService> {
  const config =
    options.config ??
    loadConfigFromEnvironment({ serviceName: definition.name, defaultPort: definition.defaultPort });
  const logger =
    options.logger ??
    createLogger({
      service: config.service.name,
      level: config.log.level,
      env: config.env,
      pretty: config.isDevelopment && Boolean(process.stdout.isTTY),
    });
  const ctx: ServiceContext = { config, logger };
  const startedAt = Date.now();
  let stopping = false;

  logger.info('service starting', { lifecycle: 'starting', nodeVersion: process.version });
  logger.info('config loaded', { lifecycle: 'config_loaded', config: redactConfig(config) });

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      const body = {
        status: stopping ? 'stopping' : 'ok',
        service: config.service.name,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      };
      res.writeHead(stopping ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  try {
    await definition.onStart?.(ctx);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.service.port, config.service.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    logger.error('service failed to start', { lifecycle: 'start_failed', err });
    throw err;
  }

  const port = (server.address() as AddressInfo).port;
  logger.info('health endpoint listening', { lifecycle: 'listening', host: config.service.host, port });
  logger.info('service started', { lifecycle: 'started' });

  let stopPromise: Promise<void> | undefined;
  const stop = (reason = 'stop'): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true;
      logger.info('service stopping', { lifecycle: 'stopping', reason });
      try {
        await definition.onStop?.(ctx);
      } catch (err) {
        logger.error('error while stopping', { lifecycle: 'stop_error', err });
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      removeSignalHandlers();
      logger.info('service stopped', { lifecycle: 'stopped' });
    })();
    return stopPromise;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    const exit = options.exit ?? ((code: number) => process.exit(code));
    stop(signal).then(
      () => exit(0),
      () => exit(1)
    );
  };
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  const removeSignalHandlers = (): void => {
    for (const s of signals) process.off(s, onSignal);
  };
  if (options.handleSignals !== false) {
    for (const s of signals) process.on(s, onSignal);
  }

  return { config, logger, port, stop };
}
