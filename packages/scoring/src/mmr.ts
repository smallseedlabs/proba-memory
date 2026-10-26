export interface MmrItem {
  id: string;
  /** Relevance score in 0..1 (the profile score). */
  score: number;
}

export interface MmrSelection<T extends MmrItem> {
  item: T;
  /** The MMR value that won this pick. */
  mmrScore: number;
  /** Highest similarity to an item picked earlier (0 for the first pick). */
  maxSimilarity: number;
}

/**
 * Maximal marginal relevance: repeatedly pick the item maximising
 * lambda * score - (1 - lambda) * max similarity to the items already picked.
 * lambda = 1 keeps the pure score order, lambda = 0 maximises diversity.
 * `similarity` must return 0..1 and be symmetric. Deterministic: ties go to the earlier item.
 */
export function mmrSelect<T extends MmrItem>(
  items: readonly T[],
  options: { lambda: number; limit: number; similarity: (a: T, b: T) => number }
): MmrSelection<T>[] {
  const { lambda, limit, similarity } = options;
  if (!(lambda >= 0 && lambda <= 1)) throw new RangeError('lambda must be within 0..1');
  const remaining = [...items];
  const picked: MmrSelection<T>[] = [];
  while (remaining.length > 0 && picked.length < limit) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    let bestSim = 0;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      let maxSim = 0;
      for (const p of picked) maxSim = Math.max(maxSim, Math.min(1, Math.max(0, similarity(candidate, p.item))));
      const value = lambda * candidate.score - (1 - lambda) * maxSim;
      if (value > bestValue + 1e-12) {
        bestValue = value;
        bestIndex = i;
        bestSim = maxSim;
      }
    }
    const [item] = remaining.splice(bestIndex, 1);
    picked.push({ item, mmrScore: bestValue, maxSimilarity: bestSim });
  }
  return picked;
}

/** Cosine similarity of two vectors; 0 when either has no length or the sizes differ. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Jaccard similarity of the word sets of two texts: the fallback when a vector is not available. */
export function jaccardSimilarity(a: string, b: string): number {
  const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const sa = words(a);
  const sb = words(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}
