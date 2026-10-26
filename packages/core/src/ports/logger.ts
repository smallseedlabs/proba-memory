/**
 * Structured logger port.
 *
 * Every line is JSON with at least level, time, msg and service. When a
 * traceId is known it is included (use `withTrace` or `child({ traceId })`).
 * A LogHook receives every emitted record: a later AuditEmitter can register one
 * to turn lifecycle logs into audit events without changing any call site.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  /** Pass an Error as `fields.err` to log its message and stack. */
  error(msg: string, fields?: LogFields): void;
  /** New logger whose lines always carry `bindings` (for example { traceId }). */
  child(bindings: LogFields): Logger;
}

export interface LogRecord {
  level: LogLevel;
  msg: string;
  /** UTC ISO 8601 with trailing Z. */
  time: string;
  /** Bindings merged with call-site fields. */
  fields: LogFields;
}

export type LogHook = (record: LogRecord) => void;
