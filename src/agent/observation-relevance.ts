import type { Observation } from "./observation.js";

const OBSERVATION_RELEVANCE_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "does",
  "explain",
  "from",
  "give",
  "into",
  "need",
  "read",
  "say",
  "tell",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

export function isGroundedContentObservation(
  observation: Observation
): boolean {
  return (
    observation.status === "ok" &&
    observation.tool !== "list_announcements" &&
    observation.artifacts.length > 0 &&
    typeof observation.content === "string" &&
    observation.content.trim().length > 0
  );
}

export function scoreObservationRelevance(
  question: string,
  observation: Observation
): number {
  const normalizedQuestion = normalizeObservationRelevanceText(question);
  if (!normalizedQuestion) {
    return 0;
  }

  const titleText = normalizeObservationRelevanceText(
    observation.artifacts.map((artifact) => artifact.title).join(" ")
  );
  const summaryText = normalizeObservationRelevanceText(observation.summary ?? "");
  const excerptText = normalizeObservationRelevanceText(
    observation.artifacts
      .map((artifact) => artifact.excerpt ?? "")
      .join(" ")
  );
  const contentText = normalizeObservationRelevanceText(observation.content ?? "");
  const haystack = `${titleText} ${summaryText} ${excerptText} ${contentText}`.trim();
  if (!haystack) {
    return 0;
  }

  const questionTokens = tokenizeObservationRelevanceText(normalizedQuestion);
  const fullPhraseMatch =
    haystack.includes(normalizedQuestion) || titleText.includes(normalizedQuestion);
  let score = fullPhraseMatch ? 14 : 0;
  let matchedTokens = 0;

  for (const token of questionTokens) {
    if (titleText.includes(token)) {
      score += 8;
      matchedTokens += 1;
      continue;
    }
    if (excerptText.includes(token)) {
      score += 4;
      matchedTokens += 1;
      continue;
    }
    if (summaryText.includes(token)) {
      score += 3;
      matchedTokens += 1;
      continue;
    }
    if (contentText.includes(token)) {
      score += 2;
      matchedTokens += 1;
    }
  }

  if (questionTokens.length > 0 && matchedTokens === questionTokens.length) {
    score += 6;
  }

  if (!fullPhraseMatch) {
    if (questionTokens.length === 0) {
      return 0;
    }
    const minimumMatchedTokens = questionTokens.length === 1 ? 1 : 2;
    if (matchedTokens < minimumMatchedTokens) {
      return 0;
    }
  }

  return score;
}

function normalizeObservationRelevanceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/[^a-z0-9/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeObservationRelevanceText(value: string): string[] {
  return [...new Set(
    value
      .split(/[^a-z0-9/]+/)
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length > 2 && !OBSERVATION_RELEVANCE_STOP_WORDS.has(token)
      )
  )];
}
