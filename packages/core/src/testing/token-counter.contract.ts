import { describe, expect, it } from 'vitest';
import type { TokenCounter } from '../ports/token-counter.js';

/** Contract any TokenCounter adapter must satisfy. */
export function runTokenCounterContract(name: string, factory: () => TokenCounter): void {
  describe(`TokenCounter contract: ${name}`, () => {
    it('counts nothing as zero and anything else as a positive whole number', () => {
      const c = factory();
      expect(c.count('')).toBe(0);
      for (const text of ['a', 'hello world', 'Ünïcödé テキスト 😀', 'x'.repeat(500)]) {
        const n = c.count(text);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThan(0);
      }
    });

    it('is deterministic and does not shrink when text is appended', () => {
      const c = factory();
      const base = 'The campaign was paused after the budget approval was rejected.';
      expect(c.count(base)).toBe(c.count(base));
      expect(c.count(`${base} ${base}`)).toBeGreaterThanOrEqual(c.count(base));
      expect(c.count(base.repeat(20))).toBeGreaterThan(c.count(base));
    });

    it('has a name', () => {
      expect(factory().name.length).toBeGreaterThan(0);
    });
  });
}
