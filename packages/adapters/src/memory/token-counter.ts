import type { TokenCounter } from '@smallseedlabs/proba-memory-core';

/**
 * Model-independent estimate: about 4 characters per token for ASCII text, one token per other
 * character. Close enough for packing a context budget; swap in a tokenizer-backed adapter for exact counts.
 */
export class ApproxTokenCounter implements TokenCounter {
  readonly name = 'approx';

  count(text: string): number {
    if (text.length === 0) return 0;
    let ascii = 0;
    let other = 0;
    for (const ch of text) {
      if (ch.charCodeAt(0) < 128) ascii += 1;
      else other += 1;
    }
    return Math.max(1, Math.ceil(ascii / 4) + other);
  }
}
