import { createHash } from 'node:crypto';
import type { Embedder } from '@smallseedlabs/proba-memory-core';
import { tokenize } from '../memory/text-search.js';

export const LOCAL_EMBEDDER_MODEL = 'local-hash';

export interface HashEmbedderOptions {
  dimension: number;
  nodeEnv: string;
  /** ALLOW_LOCAL_EMBEDDER: the explicit opt-in to run this embedder in production. */
  allowLocal: boolean;
}

function bucket(feature: string, dimension: number): { index: number; sign: 1 | -1 } {
  const h = createHash('sha256').update(feature).digest();
  return { index: h.readUInt32BE(0) % dimension, sign: (h[4] & 1) === 0 ? 1 : -1 };
}

/**
 * Deterministic feature-hashing embedder for local runs: words, word pairs and character trigrams are
 * hashed into `dimension` signed buckets and the vector is L2-normalised. Texts that share words land
 * close together, which is enough to exercise retrieval end to end without a model. It has no semantic
 * understanding, labels its rows `local-hash`, and refuses to start in production unless allowed.
 */
export class HashEmbedder implements Embedder {
  readonly name = 'local-hash';
  readonly model = LOCAL_EMBEDDER_MODEL;
  readonly version = '1';

  constructor(private readonly options: HashEmbedderOptions) {
    if (options.nodeEnv === 'production' && !options.allowLocal) {
      throw new Error('The local hash embedder is not available when NODE_ENV=production. Configure EMBEDDER=openai-compatible, or set ALLOW_LOCAL_EMBEDDER=true to run it deliberately.');
    }
    if (!Number.isInteger(options.dimension) || options.dimension < 8) throw new Error('the local hash embedder needs a dimension of at least 8');
  }

  get dimension(): number {
    return this.options.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorOf(t));
  }

  private vectorOf(text: string): number[] {
    const dim = this.options.dimension;
    const v = new Array<number>(dim).fill(0);
    const add = (feature: string, weight: number): void => {
      const { index, sign } = bucket(feature, dim);
      v[index] += sign * weight;
    };
    const words = tokenize(text);
    words.forEach((w, i) => {
      add(`w:${w}`, 1);
      if (i > 0) add(`b:${words[i - 1]}_${w}`, 0.6);
      const padded = `^${w}$`;
      for (let c = 0; c + 3 <= padded.length; c += 1) add(`t:${padded.slice(c, c + 3)}`, 0.25);
    });
    let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm === 0) {
      // Nothing to hash (empty or only stop words): a fixed direction per text keeps the vector valid for cosine search.
      add(`raw:${text}`, 1);
      norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    }
    return v.map((x) => x / norm);
  }

  async ping(): Promise<void> {
    // Always available.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
