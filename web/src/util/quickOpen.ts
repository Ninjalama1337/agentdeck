/**
 * Fuzzy matching for quick open (after Orca's quick open): the query's
 * characters appear in order in the text; consecutive runs, word starts and
 * hits in a file's base name score higher. Pure, so the ranking is testable.
 */

/** Score of `query` in `text` (higher is better), or null when it does not match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  const base = t.lastIndexOf('/') + 1;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    score += 1;
    if (at === prev + 1) score += 4; // a run
    const before = t[at - 1];
    if (at === 0 || before === '/' || before === ' ' || before === '-' || before === '_' || before === '.') score += 3; // a word start
    if (at >= base) score += 1; // in the file name, not the folders
    prev = at;
    ti = at + 1;
  }
  // The whole query as one piece of the name beats scattered letters.
  const nameIdx = t.indexOf(q, base);
  if (nameIdx >= 0) score += 10 + (nameIdx === base ? 6 : 0);
  else if (t.includes(q)) score += 5;
  // Shorter texts first among equals.
  return score - t.length * 0.01;
}

export interface Rankable {
  /** Text matched against the query. */
  text: string;
  /** Added to the match score (groups the user reaches for more often rank higher). */
  boost?: number;
}

/** Matching items, best first; an empty query keeps the given order. */
export function rankItems<T extends Rankable>(items: T[], query: string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, item.text) }))
    .filter((x): x is { item: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s + (b.item.boost ?? 0) - (a.s + (a.item.boost ?? 0)) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}
