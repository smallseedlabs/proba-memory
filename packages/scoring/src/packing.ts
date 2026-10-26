export interface PackItem {
  id: string;
  tokens: number;
}

export interface PackResult {
  /** Items that fit, in the order given, with the tokens charged for each. */
  packed: { id: string; tokens: number; truncated: boolean }[];
  dropped: { id: string; reason: 'over_budget' }[];
  usedTokens: number;
}

/**
 * Greedy token-budget packing in score order: take an item if it fits in what is left, otherwise skip
 * it and keep trying smaller ones further down. An item bigger than `maxItemTokens` is charged
 * `maxItemTokens` and flagged `truncated`: the caller must cut its text to that size.
 */
export function packByTokenBudget(items: readonly PackItem[], budget: number, maxItemTokens = Infinity): PackResult {
  if (!(budget >= 0)) throw new RangeError('budget must not be negative');
  const packed: PackResult['packed'] = [];
  const dropped: PackResult['dropped'] = [];
  let used = 0;
  for (const item of items) {
    const raw = Math.max(0, Math.ceil(item.tokens));
    const truncated = raw > maxItemTokens;
    const cost = truncated ? maxItemTokens : raw;
    if (used + cost <= budget) {
      packed.push({ id: item.id, tokens: cost, truncated });
      used += cost;
    } else {
      dropped.push({ id: item.id, reason: 'over_budget' });
    }
  }
  return { packed, dropped, usedTokens: used };
}
