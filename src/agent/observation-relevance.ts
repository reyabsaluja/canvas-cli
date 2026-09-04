import type { Observation } from "./observation.js";
import { stemSearchToken } from "../knowledge/artifact-index.js";

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
  "instructor",
  "into",
  "need",
  "prof",
  "professor",
  "read",
  "said",
  "say",
  "teacher",
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
    // An announcement listing carries citable titles and dates but is not a
    // full read: it must never satisfy "already read" so the model still
    // follows it with read_thread on the matching post.
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
  // A search hit or section read labelled "Late Penalty" is about the late
  // penalty even when the title ("syllabus.pdf") and excerpt say nothing.
  const sectionText = normalizeObservationRelevanceText(
    observation.artifacts
      .map((artifact) => artifact.sectionLabel ?? "")
      .join(" ")
  );
  const summaryText = normalizeObservationRelevanceText(observation.summary ?? "");
  const excerptText = normalizeObservationRelevanceText(
    observation.artifacts
      .map((artifact) => artifact.excerpt ?? "")
      .join(" ")
  );
  const contentText = normalizeObservationRelevanceText(observation.content ?? "");
  const haystack =
    `${titleText} ${sectionText} ${summaryText} ${excerptText} ${contentText}`.trim();
  if (!haystack) {
    return 0;
  }

  const questionTokens = tokenizeObservationRelevanceText(normalizedQuestion);
  const fullPhraseMatch =
    haystack.includes(normalizedQuestion) ||
    titleText.includes(normalizedQuestion) ||
    sectionText.includes(normalizedQuestion);
  let score = fullPhraseMatch ? 14 : 0;
  let matchedTokens = 0;
  // A question word that names one of the document's headings ("graded" vs
  // "## Grading") is a strong signal on its own, even when the rest of the
  // question ("Lab 4", "how") appears nowhere in the read.
  const headingTokens = tokenizeObservationRelevanceText(
    normalizeObservationRelevanceText(collectHeadingText(observation.content ?? ""))
  );
  let headingMatched = false;

  for (const token of questionTokens) {
    if (headingTokens.some((heading) => heading === token || heading.startsWith(token))) {
      score += 8;
      matchedTokens += 1;
      headingMatched = true;
      continue;
    }
    if (titleText.includes(token)) {
      score += 8;
      matchedTokens += 1;
      continue;
    }
    if (sectionText.includes(token)) {
      score += 6;
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
    if (matchedTokens < minimumMatchedTokens && !headingMatched) {
      return 0;
    }
  }

  return score;
}

/** Markdown heading lines (and "Page N"/section labels) from read content. */
function collectHeadingText(content: string): string {
  const headings: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (match?.[1]) headings.push(match[1]);
  }
  return headings.join(" ");
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
      // Matching below is substring-based, so a stem ("grad") also hits the
      // inflected forms in the haystack ("graded", "grading"). Without this a
      // read of "## Grading" scored 0 for "how is it graded".
      .map((token) => {
        const stem = stemSearchToken(token);
        return stem.length >= 3 ? stem : token;
      })
  )];
}
