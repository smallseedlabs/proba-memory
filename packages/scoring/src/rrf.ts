/** One ranked candidate list, best first. */
export interface RankedList {
  name: string;
  weight: number;
  ids: readonly string[];
}

export interface FusedItem {
  id: string;
  score: number;
  /** 1-based rank per list the id appeared in. */
  ranks: Record<string, number>;
}

/**
 * Reciprocal rank fusion: score(id) = sum over lists of weight / (k + rank). Ids missing from a list
 * simply contribute nothing for it. Duplicate ids within a list count once, at their first rank.
 * Ties are broken by the better best-rank, then by id, so the result is deterministic.
 */
export function reciprocalRankFusion(lists: readonly RankedList[], k: number): FusedItem[] {
  if (!(k >= 1)) throw new RangeError('k must be at least 1');
  const fused = new Map<string, FusedItem>();
  for (const list of lists) {
    if (!(list.weight >= 0)) throw new RangeError(`weight of list "${list.name}" must not be negative`);
    const seen = new Set<string>();
    let rank = 0;
    for (const id of list.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      const item = fused.get(id) ?? { id, score: 0, ranks: {} };
      item.score += list.weight / (k + rank);
      item.ranks[list.name] = rank;
      fused.set(id, item);
    }
  }
  const best = (i: FusedItem): number => Math.min(...Object.values(i.ranks));
  return [...fused.values()].sort((a, b) => b.score - a.score || best(a) - best(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
