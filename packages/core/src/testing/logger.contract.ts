import { describe, expect, it } from 'vitest';
import type { LogRecord, Logger } from '../ports/logger.js';

export interface LoggerHarness {
  logger: Logger;
  /** Records emitted so far, in order (parsed from the adapter's output). */
  records: () => LogRecord[];
}

/** Contract any Logger adapter must satisfy. */
export function runLoggerContract(name: string, factory: () => LoggerHarness): void {
  describe(`Logger contract: ${name}`, () => {
    it('records level, message and fields', () => {
      const { logger, records } = factory();
      logger.info('hello', { a: 1 });
      logger.warn('careful');
      logger.error('boom', { err: new Error('bad') });
      const r = records();
      expect(r.map((x) => [x.level, x.msg])).toEqual([
        ['info', 'hello'],
        ['warn', 'careful'],
        ['error', 'boom'],
      ]);
      expect(r[0].fields.a).toBe(1);
      expect(r[0].time).toMatch(/Z$/);
      expect(r[2].fields.err).toBeDefined();
    });

    it('child loggers add bindings (such as traceId) without changing the parent', () => {
      const { logger, records } = factory();
      const traceId = '550e8400-e29b-41d4-a716-446655440000';
      const child = logger.child({ traceId });
      child.info('in trace', { step: 1 });
      logger.info('outside');
      const r = records();
      expect(r[0].fields).toMatchObject({ traceId, step: 1 });
      expect(r[1].fields.traceId).toBeUndefined();
    });

    it('nested children merge bindings', () => {
      const { logger, records } = factory();
      logger.child({ a: 1 }).child({ b: 2 }).info('x');
      expect(records()[0].fields).toMatchObject({ a: 1, b: 2 });
    });
  });
}
