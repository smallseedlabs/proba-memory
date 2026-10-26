import { randomUUID } from 'node:crypto';
import { generateSpanId } from '@smallseedlabs/proba-protocol/audit';
import type { Clock, IdGenerator } from '@smallseedlabs/proba-memory-core';

/** Real wall-clock time. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  isoNow(): string {
    return new Date().toISOString();
  }
}

/** Random UUIDs and OpenTelemetry-style span ids. */
export class RandomIdGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }

  spanId(): string {
    return generateSpanId();
  }
}
