/** Tiny full-text engine for the in-memory adapters: lower-case words, stop words dropped, light stemming. */

const STOP = new Set(
  'a an and are as at be but by for from has have if in into is it its of on or that the their then there these they this to was were will with you your we our not no do does did been being than so such'.split(
    ' '
  )
);

export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

/** Scores `docs` against `query` (any matching word counts, rarer words and repeated words count more). Best first, zero-score docs omitted. */
export function rankDocuments(query: string, docs: { id: string; text: string }[]): { id: string; rank: number }[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || docs.length === 0) return [];
  const tokenised = docs.map((d) => ({ id: d.id, tokens: tokenize(d.text) }));
  const df = new Map<string, number>();
  for (const d of tokenised) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const out: { id: string; rank: number }[] = [];
  for (const d of tokenised) {
    const counts = new Map<string, number>();
    for (const t of d.tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term);
      if (!tf) continue;
      score += (1 + Math.log(tf)) * Math.log(1 + docs.length / (df.get(term) ?? 1));
    }
    if (score > 0) out.push({ id: d.id, rank: score / (1 + Math.log(1 + d.tokens.length) / 10) });
  }
  return out.sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1));
}
