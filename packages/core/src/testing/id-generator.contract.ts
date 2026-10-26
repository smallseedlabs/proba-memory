import { describe, expect, it } from 'vitest';
import type { IdGenerator } from '../ports/id-generator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Contract any IdGenerator adapter must satisfy. */
export function runIdGeneratorContract(name: string, factory: () => IdGenerator): void {
  describe(`IdGenerator contract: ${name}`, () => {
    it('returns unique UUIDs', () => {
      const ids = factory();
      const seen = new Set(Array.from({ length: 100 }, () => ids.uuid()));
      expect(seen.size).toBe(100);
      for (const id of seen) expect(id).toMatch(UUID);
    });

    it('returns unique OpenTelemetry-style span ids (16 lowercase hex, not all zeros)', () => {
      const ids = factory();
      const seen = new Set(Array.from({ length: 100 }, () => ids.spanId()));
      expect(seen.size).toBe(100);
      for (const id of seen) {
        expect(id).toMatch(/^[0-9a-f]{16}$/);
        expect(id).not.toBe('0000000000000000');
      }
    });
  });
}
