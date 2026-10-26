import { describe, expect, it } from 'vitest';
import type { Clock } from '../ports/clock.js';

/** Contract any Clock adapter must satisfy. */
export function runClockContract(name: string, factory: () => Clock): void {
  describe(`Clock contract: ${name}`, () => {
    it('returns a Date and a UTC ISO string that agree', () => {
      const clock = factory();
      const d = clock.now();
      expect(d).toBeInstanceOf(Date);
      const iso = clock.isoNow();
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Math.abs(Date.parse(iso) - d.getTime())).toBeLessThan(5000);
    });

    it('never goes backwards', () => {
      const clock = factory();
      const a = clock.now().getTime();
      const b = clock.now().getTime();
      expect(b).toBeGreaterThanOrEqual(a);
    });
  });
}
