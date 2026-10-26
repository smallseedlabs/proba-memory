import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runLoggerContract } from '../testing/logger.contract.js';
import type { LogRecord } from '../ports/logger.js';
import { MemoryLogger, createLogger, withTrace } from './index.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      cb();
    },
  });
  return { lines, destination };
}

function toRecord(line: Record<string, unknown>): LogRecord {
  const { level, msg, time, ...fields } = line;
  return { level: level as LogRecord['level'], msg: msg as string, time: time as string, fields };
}

runLoggerContract('MemoryLogger', () => {
  const logger = new MemoryLogger();
  return { logger, records: () => logger.records };
});

runLoggerContract('pino logger (JSON lines)', () => {
  const { lines, destination } = capture();
  const logger = createLogger({ service: 'test-svc', level: 'trace', destination });
  return { logger, records: () => lines.map(toRecord) };
});

describe('createLogger', () => {
  it('writes JSON with level label, ISO UTC time, service and traceId', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'audit-consumer', env: 'test', level: 'info', destination });
    const traceId = '550e8400-e29b-41d4-a716-446655440000';
    withTrace(logger, traceId).info('command received', { commandType: 'create_goal' });
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'audit-consumer',
      env: 'test',
      traceId,
      commandType: 'create_goal',
      msg: 'command received',
    });
    expect(String(lines[0].time)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('serialises errors with message and stack', () => {
    const { lines, destination } = capture();
    createLogger({ service: 's', destination }).error('failed', { err: new Error('kaput') });
    const err = lines[0].err as { message: string; stack: string };
    expect(err.message).toBe('kaput');
    expect(err.stack).toContain('Error: kaput');
  });

  it('respects the level', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 's', level: 'warn', destination });
    logger.info('hidden');
    logger.warn('shown');
    expect(lines.map((l) => l.msg)).toEqual(['shown']);
  });

  it('calls hooks with every emitted record, including child bindings, and survives a throwing hook', () => {
    const { destination } = capture();
    const seen: LogRecord[] = [];
    const logger = createLogger({
      service: 's',
      level: 'info',
      destination,
      hooks: [
        () => {
          throw new Error('hook bug');
        },
        (r) => seen.push(r),
      ],
    });
    logger.child({ traceId: 't-1' }).info('step done', { step: 2 });
    logger.debug('below level: no hook call');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ level: 'info', msg: 'step done' });
    expect(seen[0].fields).toMatchObject({ traceId: 't-1', step: 2, service: 's' });
  });
});
