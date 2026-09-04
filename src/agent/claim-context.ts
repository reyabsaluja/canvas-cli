/**
 * Contextual claim checks.
 *
 * The figure check in verify.ts asks "does this date or number appear in the
 * evidence at all?". That is enough when the evidence carries one value, but
 * a schedule that lists every lab makes any listed date look supported. The
 * checks here run only when the evidence carries several competing values
 * of the same kind and, in that case, ask the tighter question: does the
 * figure sit in an evidence chunk that shares an anchor ("Lab 4",
 * "lab4.pdf") with the answer, and does the anchored chunk say something
 * else? The requirement check does the same for strength of wording: an
 * answer that says "must" is flagged when every overlapping evidence clause
 * only says "may", "optional", or "recommended".
 */

import { extractDateClaims } from "./date-claims.js";

// ---------------------------------------------------------------------------
// Anchored figure check.

interface FigureClaim {
  /** Category the figure competes within: "date" or a unit such as "percent". */
  category: string;
  /** Comparable form: "3-20" for a date, "10 percent" for a quantity. */
  key: string;
  /** How the text wrote it, for the note. */
  label: string;
}

const QUANTITY_UNITS: Array<[pattern: string, unit: string]> = [
  ["%|percent", "percent"],
  ["points?|pts", "points"],
  ["marks?", "marks"],
  ["hours?|hrs?", "hours"],
  ["minutes?|mins?", "minutes"],
  ["days?", "days"],
  ["weeks?", "weeks"],
  ["pages?", "pages"],
  ["words?", "words"],
  ["attempts?", "attempts"],
];

const QUANTITY_PATTERN = new RegExp(
  `\\b(\\d+(?:\\.\\d+)?)\\s*(${QUANTITY_UNITS.map(([pattern]) => pattern).join("|")})(?![a-z])`,
  "gi"
);

/** "Lab 4", "Assignment #2", "week 3", "Milestone 1b". */
const LABELLED_ANCHOR_PATTERN =
  /\b(lab|assignment|homework|hw|project|quiz|test|exam|midterm|milestone|module|week|part|task|checkpoint)\s*#?\s*(\d{1,3}[a-z]?)\b/gi;

/** "lab4.pdf", "rubric-v2.docx" — anchored by their stem. */
const FILENAME_ANCHOR_PATTERN =
  /\b([\w-]+)\.(?:pdf|docx?|pptx?|xlsx?|txt|md|zip|html?)\b/gi;

/**
 * Figures in `answer` that the evidence does contain, but only in chunks
 * about something else, when the evidence lists several values of that
 * kind. Each entry names the claimed figure and the figure the anchored
 * evidence actually carries, so the note can say "Lab 4 is listed with
 * March 27". Figures already absent from the evidence are the caller's
 * business and are not repeated here.
 */
export function findContextuallyUnsupportedClaims(
  answer: string,
  evidenceText: string,
  question: string = ""
): string[] {
  if (!answer.trim() || !evidenceText.trim()) {
    return [];
  }

  const chunks = splitEvidenceChunks(evidenceText).map((chunk) => ({
    anchors: new Set(collectAnchors(chunk)),
    figures: collectFigureClaims(chunk),
  }));
  const evidenceKeysByCategory = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    for (const figure of chunk.figures) {
      const keys = evidenceKeysByCategory.get(figure.category) ?? new Set<string>();
      keys.add(figure.key);
      evidenceKeysByCategory.set(figure.category, keys);
    }
  }

  const fallbackAnchors = collectAnchors(`${question}\n${answer}`);
  const flagged: string[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(answer)) {
    const sentenceAnchors = collectAnchors(sentence);
    const anchors = sentenceAnchors.length > 0 ? sentenceAnchors : fallbackAnchors;
    if (anchors.length === 0) {
      continue;
    }

    for (const claim of collectFigureClaims(sentence)) {
      const evidenceKeys = evidenceKeysByCategory.get(claim.category);
      // Gate: only when the evidence carries competing values of this kind,
      // and the claimed one is among them (otherwise the plain check owns it).
      if (!evidenceKeys || evidenceKeys.size < 2 || !evidenceKeys.has(claim.key)) {
        continue;
      }
      if (seen.has(`${claim.category}:${claim.key}`)) {
        continue;
      }

      const anchoredChunks = chunks.filter((chunk) =>
        anchors.some((anchor) => chunk.anchors.has(anchor))
      );
      const anchoredFigures = anchoredChunks.flatMap((chunk) =>
        chunk.figures.filter((figure) => figure.category === claim.category)
      );
      if (anchoredFigures.length === 0) {
        continue;
      }
      if (anchoredFigures.some((figure) => figure.key === claim.key)) {
        continue;
      }

      seen.add(`${claim.category}:${claim.key}`);
      const anchor = anchors.find((entry) =>
        anchoredChunks.some((chunk) => chunk.anchors.has(entry))
      );
      const competing = anchoredFigures[0]!;
      flagged.push(
        `${claim.label} (${describeAnchor(anchor ?? anchors[0]!)} is listed with ${competing.label})`
      );
    }
  }

  return flagged;
}

/** Dates and unit-bearing quantities in `text`, deduped by key. */
function collectFigureClaims(text: string): FigureClaim[] {
  const claims: FigureClaim[] = [];
  const seen = new Set<string>();
  const push = (claim: FigureClaim): void => {
    const id = `${claim.category}:${claim.key}`;
    if (!seen.has(id)) {
      seen.add(id);
      claims.push(claim);
    }
  };

  const normalized = text.replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1");
  for (const date of extractDateClaims(normalized)) {
    push({ category: "date", key: date.key, label: date.label });
  }
  for (const match of normalized.matchAll(QUANTITY_PATTERN)) {
    const value = match[1]!;
    const unitText = match[2]!.toLowerCase();
    const unit =
      QUANTITY_UNITS.find(([pattern]) => new RegExp(`^(?:${pattern})$`, "i").test(unitText))?.[1] ??
      unitText;
    push({ category: unit, key: `${Number(value)} ${unit}`, label: match[0].trim() });
  }
  return claims;
}

/** Normalised anchors ("lab4", "rubric-v2") found in `text`. */
function collectAnchors(text: string): string[] {
  const anchors: string[] = [];
  const seen = new Set<string>();
  const add = (anchor: string): void => {
    const key = anchor.toLowerCase();
    if (key.length >= 3 && !seen.has(key)) {
      seen.add(key);
      anchors.push(key);
    }
  };
  for (const match of text.matchAll(LABELLED_ANCHOR_PATTERN)) {
    add(`${match[1]}${match[2]}`);
  }
  for (const match of text.matchAll(FILENAME_ANCHOR_PATTERN)) {
    add(match[1]!.replace(/[_-]+/g, ""));
  }
  return anchors;
}

function describeAnchor(anchor: string): string {
  const labelled = anchor.match(/^([a-z]+)(\d{1,3}[a-z]?)$/);
  if (labelled) {
    const label = labelled[1]!;
    return `${label[0]!.toUpperCase()}${label.slice(1)} ${labelled[2]}`;
  }
  return anchor;
}

/** Lines, bullets, and sentences: the unit an anchor and a figure share. */
function splitEvidenceChunks(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .flatMap((line) => splitSentences(line))
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

// ---------------------------------------------------------------------------
// Requirement strength check.

const STRONG_REQUIREMENT_PATTERN =
  /\b(?:must|mandatory|required|requires?|need(?:s|ed)?\s+to|ha(?:ve|s)\s+to|shall)\b/i;
const WEAK_REQUIREMENT_PATTERN =
  /\b(?:may|can|could|optional(?:ly)?|recommended|suggested|encouraged|not\s+required|not\s+mandatory|do(?:es)?\s+not\s+need|don'?t\s+need|need\s+not)\b/i;
/** A bare instruction ("Include a waveform screenshot.") is as strong as "must". */
const IMPERATIVE_PATTERN =
  /^(?:[-*•]\s*)?(?:\d+[.)]\s*)?(?:submit|include|upload|attach|bring|complete|use|provide|turn\s+in|write|cite|list|show|ensure)\b/i;

const REQUIREMENT_STOP_WORDS = new Set([
  "the", "and", "for", "you", "your", "that", "this", "with", "are", "will",
  "all", "any", "each", "from", "into", "not", "have", "has", "been", "also",
  "must", "may", "can", "could", "should", "shall", "need", "needs", "needed",
  "required", "requires", "require", "mandatory", "optional", "recommended",
  "suggested", "encouraged", "submit", "include", "upload", "attach", "bring",
  "complete", "use", "provide", "turn", "write", "cite", "list", "show", "ensure",
]);

/**
 * Answer clauses that state a hard requirement ("must", "required") whose
 * overlapping evidence clauses only ever soften it ("may", "optional",
 * "recommended"). A clause with no overlapping evidence is not flagged:
 * there is nothing to contradict it. Each entry quotes the claim and the
 * softer word the evidence used.
 */
export function collectUnsupportedRequirementClaims(
  answer: string,
  evidenceText: string
): string[] {
  const evidenceClauses = splitClauses(evidenceText);
  if (evidenceClauses.length === 0) {
    return [];
  }

  const flagged: string[] = [];
  for (const claim of splitClauses(answer)) {
    if (!STRONG_REQUIREMENT_PATTERN.test(claim) || WEAK_REQUIREMENT_PATTERN.test(claim)) {
      continue;
    }
    const tokens = tokenizeClause(claim);
    if (tokens.length === 0) {
      continue;
    }
    const threshold = tokens.length <= 2 ? 1 : Math.min(3, Math.max(2, Math.ceil(tokens.length * 0.4)));

    // The evidence clause that matches the claim best decides: a softer
    // clause about the same thing outranks a stronger clause that merely
    // shares a word with it.
    let bestStrong = 0;
    let bestWeak = 0;
    let softener: string | null = null;
    for (const clause of evidenceClauses) {
      const clauseTokens = new Set(tokenizeClause(clause));
      const overlap = tokens.filter((token) => clauseTokens.has(token)).length;
      if (overlap < threshold) {
        continue;
      }
      const weakWord = clause.match(WEAK_REQUIREMENT_PATTERN)?.[0];
      if (weakWord) {
        if (overlap > bestWeak) {
          bestWeak = overlap;
          softener = weakWord.toLowerCase();
        }
      } else if (STRONG_REQUIREMENT_PATTERN.test(clause) || IMPERATIVE_PATTERN.test(clause)) {
        bestStrong = Math.max(bestStrong, overlap);
      }
    }
    if (!softener || bestWeak <= bestStrong) {
      continue;
    }
    flagged.push(`${truncateClaim(claim)} (the source says "${softener}")`);
  }
  return flagged;
}

function splitClauses(text: string): string[] {
  return splitEvidenceChunks(text)
    .flatMap((chunk) => chunk.split(/\s*(?:;|,?\s+but\b|,?\s+however\b|:\s+)\s*/i))
    .map((clause) => clause.replace(/^[-*•]\s*/, "").replace(/\s+/g, " ").trim())
    .filter((clause) => clause.length > 0);
}

function tokenizeClause(clause: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const token of clause.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (token.length < 3 || REQUIREMENT_STOP_WORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function truncateClaim(claim: string): string {
  const trimmed = claim.replace(/[.!?]+$/, "");
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 77).trimEnd()}...`;
}
