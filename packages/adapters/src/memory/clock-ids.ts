import type { Clock, IdGenerator } from '@smallseedlabs/proba-memory-core';

/** Clock the tests control: starts at a fixed instant and moves only when told to. */
export class ManualClock implements Clock {
  private ms: number;

  constructor(start: string | Date = '2026-10-25T10:00:00.000Z') {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  isoNow(): string {
    return new Date(this.ms).toISOString();
  }

  advance(ms: number): void {
    this.ms += ms;
  }

  set(time: string | Date): void {
    this.ms = new Date(time).getTime();
  }
}

/** Deterministic ids for tests: counters rendered as valid UUIDs and span ids. */
export class SequentialIdGenerator implements IdGenerator {
  private u = 0;
  private s = 0;

  uuid(): string {
    this.u += 1;
    return `00000000-0000-4000-8000-${this.u.toString(16).padStart(12, '0')}`;
  }

  spanId(): string {
    this.s += 1;
    return this.s.toString(16).padStart(16, '0');
  }
}

