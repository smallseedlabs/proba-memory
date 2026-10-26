/**
 * Structured JSON logger (pino), implementing the Logger port.
 *
 * Mirrors proba-hub: pino, level labels, pretty output only in development.
 * Timestamps are UTC ISO 8601. `hooks` receive every emitted record, which is
 * where a later AuditEmitter plugs in (not built yet).
 */

import pino, { type DestinationStream } from 'pino';
import type { LogFields, LogHook, LogLevel, LogRecord, Logger } from '../ports/logger.js';

export interface CreateLoggerOptions {
  service: string;
  level?: pino.LevelWithSilent;
  env?: string;
  /** Human-readable output (pino-pretty). Development only. */
  pretty?: boolean;
  /** Where to write JSON lines. Default stdout. Mainly for tests. */
  destination?: DestinationStream;
  /** Called with every record that passes the level filter. Errors thrown by hooks are swallowed. */
  hooks?: LogHook[];
  /** Fields added to every line. */
  bindings?: LogFields;
}

class PinoLogger implements Logger {
  constructor(
    private readonly base: pino.Logger,
    private readonly hooks: readonly LogHook[]
  ) {}

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields);
  }

  child(bindings: LogFields): Logger {
    return new PinoLogger(this.base.child(bindings), this.hooks);
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (!this.base.isLevelEnabled(level)) return;
    this.base[level](fields ?? {}, msg);
    if (this.hooks.length === 0) return;
    const record: LogRecord = {
      level,
      msg,
      time: new Date().toISOString(),
      fields: { ...this.base.bindings(), ...fields },
    };
    for (const hook of this.hooks) {
      try {
        hook(record);
      } catch {
        // A failing hook must never break the caller.
      }
    }
  }
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const base = pino(
    {
      level: options.level ?? 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: { err: pino.stdSerializers.err },
      formatters: { level: (label) => ({ level: label }) },
      base: { service: options.service, ...(options.env ? { env: options.env } : {}), ...options.bindings },
      transport:
        options.pretty && !options.destination
          ? {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
            }
          : undefined,
    },
    options.destination
  );
  return new PinoLogger(base, options.hooks ?? []);
}

/** Logger whose lines all carry the traceId (the web command's clientMsgId or a job run id). */
export function withTrace(logger: Logger, traceId: string): Logger {
  return logger.child({ traceId });
}

/** Logger that records instead of writing; for tests and as the in-memory Logger adapter. */
export class MemoryLogger implements Logger {
  readonly records: LogRecord[];

  constructor(
    private readonly bindings: LogFields = {},
    records: LogRecord[] = []
  ) {
    this.records = records;
  }

  debug(msg: string, fields?: LogFields): void {
    this.add('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.add('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.add('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.add('error', msg, fields);
  }

  child(bindings: LogFields): Logger {
    return new MemoryLogger({ ...this.bindings, ...bindings }, this.records);
  }

  private add(level: LogLevel, msg: string, fields?: LogFields): void {
    this.records.push({ level, msg, time: new Date().toISOString(), fields: { ...this.bindings, ...fields } });
  }
}
