/**
 * Deterministic title/name matching utilities for enrichment.
 *
 * Strategy:
 * 1. Normalize both strings (lowercase, strip punctuation, collapse whitespace)
 * 2. Check for exact normalized match
 * 3. Check if one contains the other
 * 4. Token overlap: count shared meaningful tokens
 *
 * All matching is case-insensitive and punctuation-insensitive.
 */

/**
 * Normalize a title for comparison.
 * Lowercase, strip punctuation, collapse whitespace.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract meaningful tokens from a normalized title.
 * Filters out very short tokens (1 char) and common stop words.
 */
export function extractTokens(normalizedTitle: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "of", "in", "to", "for",
    "is", "it", "on", "at", "by", "with", "from", "as",
  ]);

  return normalizedTitle
    .split(" ")
    .filter((t) => t.length > 1 && !stopWords.has(t));
}

export interface MatchResult {
  /** 0 = no match, 1 = token overlap, 2 = containment, 3 = exact */
  strength: 0 | 1 | 2 | 3;
  reason: string;
  /** Fraction of assignment tokens found in candidate (0-1) */
  tokenOverlap: number;
}

/**
 * Compare an assignment name against a candidate title (module item, page, file, etc).
 * Returns a match result with strength and explanation.
 */
export function matchTitles(
  assignmentName: string,
  candidateTitle: string
): MatchResult {
  const normA = normalizeTitle(assignmentName);
  const normC = normalizeTitle(candidateTitle);

  if (!normA || !normC) {
    return { strength: 0, reason: "", tokenOverlap: 0 };
  }

  // Exact match
  if (normA === normC) {
    return { strength: 3, reason: "exact title match", tokenOverlap: 1 };
  }

  // Containment: one contains the other
  if (normC.includes(normA)) {
    return {
      strength: 2,
      reason: `candidate contains assignment name`,
      tokenOverlap: 1,
    };
  }
  if (normA.includes(normC)) {
    return {
      strength: 2,
      reason: `assignment name contains candidate`,
      tokenOverlap: 1,
    };
  }

  // Token overlap
  const tokensA = extractTokens(normA);
  const tokensC = extractTokens(normC);

  if (tokensA.length === 0 || tokensC.length === 0) {
    return { strength: 0, reason: "", tokenOverlap: 0 };
  }

  const setC = new Set(tokensC);
  const shared = tokensA.filter((t) => setC.has(t));
  const overlap = shared.length / tokensA.length;

  if (overlap >= 0.5) {
    return {
      strength: 1,
      reason: `token overlap: ${shared.join(", ")}`,
      tokenOverlap: overlap,
    };
  }

  return { strength: 0, reason: "", tokenOverlap: 0 };
}
