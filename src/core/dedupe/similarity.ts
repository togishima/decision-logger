/**
 * Text similarity used for deduplication and proposal matching.
 *
 * Deliberately not embeddings. Token overlap plus SQLite search is enough to
 * catch "the same decision, phrased differently" at this scale, it is
 * inspectable, it needs no model call, and it never silently changes behaviour
 * because a vendor updated a model. Revisit only if real usage shows it
 * failing.
 */

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "been", "but", "by", "for", "from",
  "had", "has", "have", "if", "in", "instead", "into", "is", "it", "its", "not", "of", "on",
  "or", "our", "over", "rather", "so", "than", "that", "the", "their", "then", "there",
  "these", "they", "this", "to", "use", "using", "was", "we", "were", "will", "with", "would",
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** Jaccard index over content tokens. 0 = nothing in common, 1 = identical. */
export function jaccard(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  return intersection / (ta.size + tb.size - intersection);
}

/** Jaccard index over two id sets — used to compare proposal evidence. */
export function setOverlap(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const id of sa) if (sb.has(id)) intersection += 1;
  return intersection / (sa.size + sb.size - intersection);
}
