import type { AnswerSource } from "../ask/types.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { Observation } from "./observation.js";
import { questionExplicitlyComparesSources } from "./question-intent.js";
import {
  collectUnsupportedRequirementClaims,
  findContextuallyUnsupportedClaims,
} from "./claim-context.js";
import { extractDateClaims, type DateClaim } from "./date-claims.js";

export { extractDateClaims } from "./date-claims.js";
import { workupExplicitlySupportsQuestion } from "./workup-coverage.js";
import {
  isGroundedContentObservation,
  scoreObservationRelevance,
} from "./observation-relevance.js";

export interface VerificationResult {
  ok: boolean;
  confidence: "high" | "medium" | "low";
  sources: AnswerSource[];
  missing: string[];
  note: string | null;
  /**
   * Human-readable trail of what the turn actually checked ("Lab4.pdf (read in
   * full); course search for "late policy" (no matches)"), or null when no
   * source was consulted. Always populated so callers can attach it to
   * not-found answers; `note` already carries it when the answer says the
   * information was not found.
   */
  checkedSources: string | null;
}

export interface VerifyWorkspaceAnswerInput {
  question: string;
  answer: string;
  observations: Observation[];
  usedWorkup: boolean;
  loaded: LoadedWorkspace;
  /**
   * Grounded observations from earlier turns of the same conversation. The
   * prompt tells the model not to re-read documents it already has, so a
   * figure it correctly remembers from an earlier read counts as supported.
   * Used only for the numeric-claim check, never for citations or confidence.
   */
  priorObservations?: Observation[];
}

export function verifyWorkspaceAnswer(
  input: VerifyWorkspaceAnswerInput
): VerificationResult {
  const trimmedAnswer = input.answer.trim();
  const relevantGroundedObservations = selectRelevantGroundedObservations(
    input.question,
    trimmedAnswer,
    input.observations
  );
  const sources = collectSources(
    input.question,
    trimmedAnswer,
    input.observations,
    input.usedWorkup,
    input.loaded
  );
  const missing: string[] = [];
  const hasCitationCapableObservation = input.observations.some((observation) =>
    canObservationProduceCitation(observation)
  );
  const expectsComparisonEvidence = questionExplicitlyComparesSources(
    input.question
  );
  const hasEnoughComparisonSources = !expectsComparisonEvidence || sources.length >= 2;

  if (!trimmedAnswer) {
    missing.push("answer");
  }

  // Action-only tools like list_files/open_resource intentionally return no
  // artifacts, so they should not trigger a missing-source warning.
  if (hasCitationCapableObservation && sources.length === 0) {
    missing.push("source");
  }

  const hasDirectReadInEvidence = relevantGroundedObservations.length > 0;
  const workupSupportsQuestion = !input.usedWorkup
    ? false
    : workupExplicitlySupportsQuestion(input.question, input.loaded.workupJson);
  const baseConfidence = hasDirectReadInEvidence
    ? "high"
    : sources.length > 0
      ? input.usedWorkup && !workupSupportsQuestion
        ? "low"
        : "medium"
      : "low";
  const comparisonCappedConfidence = applyComparisonEvidenceConfidenceCap(
    baseConfidence,
    {
      expectsComparisonEvidence,
      hasEnoughComparisonSources,
      hasDirectReadInEvidence,
    }
  );

  // Relevance says the evidence is *about* the question; it does not say the
  // answer's figures came from it. A read of Lab4.pdf that says "March 27"
  // must not back an answer that says "March 20" at high confidence.
  const evidenceText = collectEvidenceText(input.observations);
  const priorEvidenceText = input.priorObservations?.length
    ? collectEvidenceText(
        input.priorObservations.filter((observation) => !input.observations.includes(observation))
      )
    : "";
  const claimEvidenceText = [evidenceText, priorEvidenceText].filter(Boolean).join("\n");
  const unsupportedClaims = claimEvidenceText
    ? findUnsupportedAnswerClaims(trimmedAnswer, claimEvidenceText, input.question)
    : [];
  const confidence =
    unsupportedClaims.length > 0
      ? lowerConfidence(comparisonCappedConfidence)
      : comparisonCappedConfidence;

  const baseNote = buildVerificationNote({
    missing,
    sources,
    usedWorkup: input.usedWorkup,
    workupSupportsQuestion,
    hasDirectReadInEvidence,
    hasCitationCapableObservation,
    expectsComparisonEvidence,
    hasEnoughComparisonSources,
  });
  // A "not found" answer is only as honest as the search behind it. When the
  // answer says the information is missing, tell the student exactly which
  // sources were read and which searches came back empty, so "not specified"
  // after reading the handout, the syllabus and the announcements reads very
  // differently from "not specified" after one failed search.
  const checkedSources = formatCheckedSourcesNote(
    collectCheckedSources(input.observations)
  );
  const notFoundNote =
    trimmedAnswer && checkedSources && answerLooksLikeNotFound(trimmedAnswer)
      ? `Not found after checking: ${checkedSources}.`
      : null;
  const unsupportedNote =
    unsupportedClaims.length > 0
      ? buildUnsupportedClaimsNote(unsupportedClaims, sources)
      : null;
  // The trail replaces the generic "tentative, no citable source" note: for a
  // not-found answer the trail *is* the support.
  const note = [unsupportedNote, notFoundNote ?? baseNote]
    .filter((part): part is string => Boolean(part))
    .join(" ");

  return {
    ok: missing.length === 0,
    confidence,
    sources,
    missing,
    note: note.length > 0 ? note : null,
    checkedSources,
  };
}

function lowerConfidence(
  confidence: "high" | "medium" | "low"
): "high" | "medium" | "low" {
  return confidence === "high" ? "medium" : "low";
}

/** Everything a successful observation actually showed the model. */
function collectEvidenceText(observations: Observation[]): string {
  const parts: string[] = [];
  for (const observation of observations) {
    if (observation.status !== "ok") {
      continue;
    }
    if (typeof observation.content === "string") {
      parts.push(observation.content);
    }
    for (const artifact of observation.artifacts) {
      if (artifact.excerpt) {
        parts.push(artifact.excerpt);
      }
      if (artifact.sectionLabel) {
        parts.push(artifact.sectionLabel);
      }
    }
    if (observation.content === undefined && observation.summary) {
      parts.push(observation.summary);
    }
  }
  return parts.join("\n").trim();
}

export function buildUnsupportedClaimsNote(
  claims: string[],
  sources: AnswerSource[]
): string {
  const shown = claims.slice(0, MAX_UNSUPPORTED_CLAIMS_IN_NOTE);
  const more = claims.length - shown.length;
  const listed = `${shown.map((claim) => `"${claim}"`).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  const titles = [...new Set(sources.map((source) => source.title))].slice(0, 2);
  const where =
    titles.length > 0
      ? `Check ${titles.join(" and ")} before relying on them.`
      : "Check the original document before relying on them.";
  return `This answer includes details I could not confirm in the sources I read (${listed}). ${where}`;
}

function buildVerificationNote(input: {
  missing: string[];
  sources: AnswerSource[];
  usedWorkup: boolean;
  workupSupportsQuestion: boolean;
  hasDirectReadInEvidence: boolean;
  hasCitationCapableObservation: boolean;
  expectsComparisonEvidence: boolean;
  hasEnoughComparisonSources: boolean;
}): string | null {
  if (input.missing.includes("source")) {
    return "This answer is tentative because I do not have a reliable, citable source for it yet.";
  }

  if (input.expectsComparisonEvidence && !input.hasEnoughComparisonSources) {
    return input.hasDirectReadInEvidence
      ? "This answer may be incomplete because the question compares multiple sources, but I only grounded it in one cited source so far."
      : "This answer is tentative because the question compares multiple sources, but I do not have grounded evidence from both sides yet.";
  }

  if (input.hasDirectReadInEvidence) {
    return null;
  }

  if (input.usedWorkup) {
    return input.workupSupportsQuestion
      ? "This answer is based on the pre-loaded workup summary rather than a fresh document read."
      : "This answer is tentative because the pre-loaded workup does not explicitly cover this question.";
  }

  if (input.sources.length > 0 && input.hasCitationCapableObservation) {
    return "This answer is based on matched search evidence, not a full document read. Use the cited source for exact wording.";
  }

  return null;
}

function applyComparisonEvidenceConfidenceCap(
  confidence: "high" | "medium" | "low",
  input: {
    expectsComparisonEvidence: boolean;
    hasEnoughComparisonSources: boolean;
    hasDirectReadInEvidence: boolean;
  }
): "high" | "medium" | "low" {
  if (!input.expectsComparisonEvidence || input.hasEnoughComparisonSources) {
    return confidence;
  }

  if (!input.hasDirectReadInEvidence) {
    return "low";
  }

  return confidence === "high" ? "medium" : confidence;
}

function collectSources(
  question: string,
  answer: string,
  observations: Observation[],
  usedWorkup: boolean,
  loaded: LoadedWorkspace
): AnswerSource[] {
  const resolved: AnswerSource[] = [];
  const seen = new Set<string>();
  const citationObservations = selectCitationObservations(
    question,
    answer,
    observations
  );
  const attributionText = answer.trim() || question.trim();
  const pushSource = (source: AnswerSource): void => {
    const key = `${source.kind}:${source.title}:${source.section ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    resolved.push(source);
  };

  for (const observation of citationObservations) {
    // Only successful tool observations count as evidence. Failed lookups like
    // missing_text/not_found should never create grounding-looking citations.
    if (observation.status !== "ok") {
      continue;
    }
    for (const artifact of observation.artifacts) {
      const section = normalizeSourceSection(artifact.sectionLabel);

      // A full-document read has no section label of its own. Attribute the
      // answer to the specific sections of the document that support it so
      // the citation is "Lab4.pdf — Part 3: Interrupts", not just "Lab4.pdf".
      if (
        !section &&
        observation.artifacts.length === 1 &&
        isGroundedContentObservation(observation)
      ) {
        const attributed = attributeAnswerToSections(
          attributionText,
          observation.content ?? "",
          artifact
        );
        if (attributed.length > 0) {
          for (const source of attributed) {
            pushSource(source);
          }
          continue;
        }
      }

      pushSource({
        title: artifact.title,
        kind: artifact.kind,
        ...(section ? { section } : {}),
        excerpt: artifact.excerpt ?? buildExcerpt(observation.content ?? observation.summary),
      });
    }
  }

  if (resolved.length === 0 && usedWorkup && loaded.workupJson) {
    // The workup records where each of its conclusions came from; cite those
    // documents rather than the workup file, which the student never reads.
    const traceSources = collectWorkupTraceSources(loaded.workupJson);
    if (traceSources.length > 0) {
      for (const traceSource of traceSources) {
        pushSource(traceSource);
      }
    } else {
      const overview = (loaded.workupJson.overview as string | undefined) ?? null;
      resolved.push({
        title: "workup.json",
        kind: "workup",
        excerpt: overview ?? "Pre-loaded assignment workup context.",
      });
    }
  }

  return resolved;
}

const MAX_WORKUP_TRACE_SOURCES = 4;

/** One citation per distinct `sourceTrace` document, with its conclusion as the excerpt. */
function collectWorkupTraceSources(
  workupJson: Record<string, unknown>
): AnswerSource[] {
  const trace = workupJson.sourceTrace ?? workupJson.source_trace;
  if (!Array.isArray(trace) || trace.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const sources: AnswerSource[] = [];
  for (const entry of trace as Array<{ conclusion?: unknown; source?: unknown }>) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const source = (typeof entry.source === "string" ? entry.source : "").trim();
    if (!source || seen.has(source.toLowerCase())) {
      continue;
    }
    seen.add(source.toLowerCase());
    const conclusion = (
      typeof entry.conclusion === "string" ? entry.conclusion : ""
    ).trim();
    sources.push({
      title: source,
      kind: inferWorkupTraceSourceKind(source),
      excerpt: conclusion || null,
    });
  }
  return sources.slice(0, MAX_WORKUP_TRACE_SOURCES);
}

function inferWorkupTraceSourceKind(source: string): string {
  const lower = source.toLowerCase();
  if (/\.pdf\b/.test(lower)) return "attachment";
  if (/syllabus/.test(lower)) return "syllabus";
  if (/assignment\s*description/.test(lower)) return "assignment";
  if (/announcement/.test(lower)) return "announcement";
  if (/discussion/.test(lower)) return "discussion";
  if (/\bpage\b/.test(lower) || /\bmodule\b/.test(lower)) return "page";
  return "document";
}

function selectCitationObservations(
  question: string,
  answer: string,
  observations: Observation[]
): Observation[] {
  const relevantGrounded = selectRelevantGroundedObservations(
    question,
    answer,
    observations
  );
  if (relevantGrounded.length > 0) {
    return relevantGrounded;
  }

  const relevant = selectRelevantCitationObservations(question, answer, observations);
  if (relevant.length > 0) {
    return relevant;
  }

  const grounded = observations.filter((observation) =>
    isGroundedContentObservation(observation)
  );
  return grounded.length > 0 ? grounded : observations;
}

function selectRelevantGroundedObservations(
  question: string,
  answer: string,
  observations: Observation[]
): Observation[] {
  return selectRelevantCitationObservations(
    question,
    answer,
    observations.filter((observation) => isGroundedContentObservation(observation))
  );
}

/**
 * Observations worth citing: those relevant to the question, or to the
 * answer. The student asks in their own words ("hand it in on Saturday")
 * while the document that supports the answer uses the course's words
 * ("late", "10% per day"); scoring against the answer keeps that read as
 * direct evidence instead of downgrading it to "matched search evidence".
 * The question is checked first so its matches keep priority.
 */
function selectRelevantCitationObservations(
  question: string,
  answer: string,
  observations: Observation[]
): Observation[] {
  const trimmedQuestion = question.trim();
  const trimmedAnswer = answer.trim();
  if (!trimmedQuestion && !trimmedAnswer) {
    return [];
  }

  return observations.filter(
    (observation) =>
      (trimmedQuestion.length > 0 &&
        scoreObservationRelevance(trimmedQuestion, observation) > 0) ||
      (trimmedAnswer.length > 0 &&
        scoreObservationRelevance(trimmedAnswer, observation) > 0)
  );
}

function canObservationProduceCitation(observation: Observation): boolean {
  return observation.artifacts.length > 0;
}

function buildExcerpt(value: string | undefined): string | null {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return null;
  }
  if (cleaned.length <= 160) {
    return cleaned;
  }
  return `${cleaned.slice(0, 157)}...`;
}

function normalizeSourceSection(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim();
  if (!normalized || normalized === "Full text" || normalized === "Top") {
    return null;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Section-level attribution for full-document reads.
//
// read_file / download_course_file observations carry the whole document but
// no section label, so without this pass a fully grounded answer is cited as
// just "Lab4.pdf". Here we split the read content into sections using the
// same heading conventions the knowledge index uses (plus the numbered /
// "Part N" / ALL-CAPS headings common in extracted assignment PDFs), score
// each section against the *answer* text, and cite the sections that actually
// support the answer, each with the sentence that supports it.
// ---------------------------------------------------------------------------

export interface DocumentSection {
  /** Heading text, or null for un-headed preamble / unsectioned documents. */
  label: string | null;
  text: string;
  /** Zero-based order of the section in the document. */
  position: number;
}

export interface SupportingSection extends DocumentSection {
  score: number;
  matchedTokens: number;
}

const MAX_SUPPORTING_SECTIONS_PER_DOCUMENT = 3;
const MIN_SECTION_TEXT_LENGTH = 30;
const MAX_HEADING_LENGTH = 100;
const MAX_HEADING_WORDS = 10;

const HEADING_KEYWORD_PATTERN =
  /^(?:part|section|task|question|problem|exercise|step|appendix|chapter|module|lab|milestone|phase|stage|week|unit)\s+[a-z0-9]+(?:\s*[:.\-–—]\s*.{0,80})?$/i;
const NUMBERED_HEADING_PATTERN = /^(\d+(?:\.\d+)*)[.)]?\s+([A-Z][^\n]{1,90})$/;
const ALL_CAPS_HEADING_PATTERN = /^[A-Z][A-Z0-9 &/:(),\-]{2,70}$/;
const COLON_TITLE_PATTERN = /^[A-Z][A-Za-z0-9 ,&/()\-]{2,60}:$/;

const ANSWER_SUPPORT_STOP_WORDS = new Set([
  "about", "above", "after", "again", "against", "all", "also", "and", "any",
  "are", "around", "assignment", "based", "because", "been", "before", "being",
  "below", "between", "both", "but", "can", "could", "did", "does", "doing",
  "done", "down", "during", "each", "either", "else", "for", "from", "further",
  "had", "has", "have", "having", "here", "how", "into", "its", "just", "like",
  "may", "might", "more", "most", "must", "need", "needs", "not", "off", "once",
  "only", "other", "our", "out", "over", "own", "per", "same", "say", "says",
  "see", "shall", "she", "should", "since", "some", "such", "than", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "those",
  "through", "too", "under", "until", "use", "used", "using", "very", "want",
  "was", "well", "were", "what", "when", "where", "which", "while", "who",
  "whom", "why", "will", "with", "would", "you", "your", "yours",
]);

export function splitDocumentIntoSections(content: string): DocumentSection[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const raw: Array<{ label: string | null; lines: string[] }> = [
    { label: null, lines: [] },
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed === "[...truncated]") {
      continue;
    }

    const underlineHeading = detectUnderlinedHeading(trimmed, lines[index + 1]);
    if (underlineHeading) {
      raw.push({ label: underlineHeading, lines: [] });
      index += 1;
      continue;
    }

    const heading = detectHeadingLabel(trimmed);
    if (heading) {
      raw.push({ label: heading, lines: [] });
      continue;
    }

    raw[raw.length - 1]!.lines.push(line);
  }

  // Fold headings whose body is too short to stand alone (e.g. consecutive
  // heading lines, or a numbered list item mistaken for a heading) into the
  // section that follows, so every emitted section carries real evidence.
  const merged: Array<{ label: string | null; text: string }> = [];
  let pendingPrefix: string[] = [];
  for (const entry of raw) {
    const body = entry.lines.join("\n").trim();
    const text = [...pendingPrefix, body].filter((part) => part.length > 0).join("\n");
    if (text.length < MIN_SECTION_TEXT_LENGTH) {
      pendingPrefix = [...pendingPrefix, entry.label ?? "", body].filter(
        (part) => part.length > 0
      );
      continue;
    }
    pendingPrefix = [];
    merged.push({ label: entry.label, text });
  }
  if (pendingPrefix.length > 0) {
    const tail = pendingPrefix.join("\n").trim();
    const last = merged[merged.length - 1];
    if (last) {
      last.text = `${last.text}\n${tail}`.trim();
    } else if (tail.length > 0) {
      merged.push({ label: null, text: tail });
    }
  }

  return merged
    .filter((section) => section.text.trim().length > 0)
    .map((section, position) => ({
      label: section.label,
      text: section.text,
      position,
    }));
}

function detectUnderlinedHeading(
  line: string,
  nextLine: string | undefined
): string | null {
  if (!line || line.length > MAX_HEADING_LENGTH || !nextLine) {
    return null;
  }
  const underline = nextLine.trim();
  if (!/^(={3,}|-{3,})$/.test(underline)) {
    return null;
  }
  if (countWords(line) > MAX_HEADING_WORDS || /[.;,]$/.test(line)) {
    return null;
  }
  return normalizeHeadingLabel(line);
}

function detectHeadingLabel(line: string): string | null {
  if (!line || line.length > MAX_HEADING_LENGTH) {
    return null;
  }

  const markdown = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
  if (markdown) {
    return normalizeHeadingLabel(markdown[1] ?? "");
  }

  const bold = line.match(/^\*\*(.+?)\*\*:?$/);
  if (bold && countWords(bold[1] ?? "") <= MAX_HEADING_WORDS) {
    return normalizeHeadingLabel(bold[1] ?? "");
  }

  if (/[.;,]$/.test(line)) {
    return null;
  }

  if (HEADING_KEYWORD_PATTERN.test(line) && countWords(line) <= MAX_HEADING_WORDS + 2) {
    return normalizeHeadingLabel(line);
  }

  const numbered = line.match(NUMBERED_HEADING_PATTERN);
  if (numbered && countWords(numbered[2] ?? "") <= MAX_HEADING_WORDS) {
    return normalizeHeadingLabel(line);
  }

  if (
    ALL_CAPS_HEADING_PATTERN.test(line) &&
    (line.match(/[A-Z]/g) ?? []).length >= 4 &&
    countWords(line) <= MAX_HEADING_WORDS
  ) {
    return normalizeHeadingLabel(line);
  }

  if (COLON_TITLE_PATTERN.test(line) && countWords(line) <= 6) {
    return normalizeHeadingLabel(line);
  }

  return null;
}

function normalizeHeadingLabel(value: string): string | null {
  const cleaned = value
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[:\s]+$/, "")
    .trim();
  if (!cleaned) {
    return null;
  }
  return cleaned.length > 80 ? `${cleaned.slice(0, 77).trimEnd()}...` : cleaned;
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Rank a document's sections by how strongly they support the answer text and
 * return the ones that carry the answer's claims, in document order.
 */
export function selectSupportingSections(
  answer: string,
  sections: DocumentSection[],
  limit: number = MAX_SUPPORTING_SECTIONS_PER_DOCUMENT
): SupportingSection[] {
  const answerTokens = collectSupportTokens(answer);
  if (answerTokens.size === 0 || sections.length === 0) {
    return [];
  }
  const answerBigrams = collectSupportBigrams(answer);

  const scored = sections
    .map((section) => {
      const { score, matchedTokens } = scoreSupport(
        answerTokens,
        answerBigrams,
        section.text
      );
      return { ...section, score, matchedTokens };
    })
    .filter((section) => {
      const minimumMatched = answerTokens.size === 1 ? 1 : 2;
      return section.matchedTokens >= minimumMatched && section.score >= 3;
    });

  if (scored.length === 0) {
    return [];
  }

  const best = Math.max(...scored.map((section) => section.score));
  return scored
    .filter((section) => section.score >= best * 0.35)
    .sort((left, right) => right.score - left.score || left.position - right.position)
    .slice(0, limit)
    .sort((left, right) => left.position - right.position);
}

/**
 * Pick the sentence in `text` that best supports the answer, trimmed to an
 * excerpt. Falls back to the opening of the text when nothing overlaps.
 */
export function selectSupportingExcerpt(answer: string, text: string): string | null {
  const answerTokens = collectSupportTokens(answer);
  const answerBigrams = collectSupportBigrams(answer);
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= 20);

  let bestSentence: string | null = null;
  let bestScore = 0;
  for (const sentence of sentences) {
    const { score } = scoreSupport(answerTokens, answerBigrams, sentence);
    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence;
    }
  }

  return buildExcerpt(bestSentence ?? text);
}

/**
 * Turn a full-document read into section-level answer sources. Returns an
 * empty array when the document has headings but none of them support the
 * answer, so callers can fall back to a document-level citation.
 */
export function attributeAnswerToSections(
  answer: string,
  content: string,
  artifact: { title: string; kind: string; excerpt?: string | null }
): AnswerSource[] {
  const sections = splitDocumentIntoSections(content);
  if (sections.length === 0) {
    return [];
  }

  const supporting = selectSupportingSections(answer, sections);
  if (supporting.length === 0) {
    if (sections.length === 1) {
      return [
        {
          title: artifact.title,
          kind: artifact.kind,
          excerpt: artifact.excerpt ?? buildExcerpt(content),
        },
      ];
    }
    return [];
  }

  return supporting.map((section) => ({
    title: artifact.title,
    kind: artifact.kind,
    ...(section.label ? { section: section.label } : {}),
    excerpt: selectSupportingExcerpt(answer, section.text),
  }));
}

function scoreSupport(
  answerTokens: Set<string>,
  answerBigrams: Set<string>,
  text: string
): { score: number; matchedTokens: number } {
  const tokens = tokenizeSupportText(text);
  const tokenSet = new Set(tokens);
  let score = 0;
  let matchedTokens = 0;
  for (const token of answerTokens) {
    if (!tokenSet.has(token)) {
      continue;
    }
    matchedTokens += 1;
    // Identifiers, numbers, addresses and long technical words are far more
    // discriminating than short common words.
    score += /\d/.test(token) || token.length >= 7 ? 2 : 1;
  }
  if (answerBigrams.size > 0) {
    const bigrams = new Set<string>();
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      bigrams.add(`${tokens[index]} ${tokens[index + 1]}`);
    }
    for (const bigram of answerBigrams) {
      if (bigrams.has(bigram)) {
        score += 2;
      }
    }
  }
  return { score, matchedTokens };
}

function collectSupportTokens(text: string): Set<string> {
  return new Set(tokenizeSupportText(text));
}

function collectSupportBigrams(text: string): Set<string> {
  const tokens = tokenizeSupportText(text);
  const bigrams = new Set<string>();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    bigrams.add(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return bigrams;
}

function tokenizeSupportText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(
      (token) => token.length > 2 && !ANSWER_SUPPORT_STOP_WORDS.has(token)
    );
}

// ---------------------------------------------------------------------------
// Answer-support check.
//
// Numbers are where a confidently worded wrong answer hurts a student most: a
// due date, a time, a penalty, a register address. Every digit-bearing token
// in the answer must appear somewhere in the evidence the answer was verified
// against (in any common spelling: "27th", "200,000,000", "10 percent"),
// unless the question itself introduced it. Anything else is an unsupported
// claim and is surfaced to the student instead of silently trusted.
// ---------------------------------------------------------------------------

const MAX_UNSUPPORTED_CLAIMS_IN_NOTE = 3;
const LIST_MARKER_PATTERN = /^[ \t]*(?:[-*+]\s+)?\d{1,3}[.)](?=\s)/gm;
const THOUSANDS_SEPARATOR_PATTERN = /(\d),(?=\d{3}(?!\d))/g;
const ORDINAL_SUFFIX_PATTERN = /(\d)(?:st|nd|rd|th)\b/gi;
const NUMERIC_CLAIM_PATTERN = /\b0x[0-9a-f]+\b|\b\d+(?:[.:]\d+)*\b/gi;
const CLAIM_LEADING_WORDS =
  "jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|week|lab|page|part|section|chapter|question|room";
const CLAIM_TRAILING_WORDS =
  "am|pm|a\\.m\\.|p\\.m\\.|percent|points?|pts|marks?|days?|weeks?|hours?|hrs?|minutes?|mins?|seconds?|mhz|khz|ghz|ms|kb|mb|gb|pages?|words?";

/**
 * Return the digit-bearing claims in `answer` that never appear in
 * `evidenceText`, each rendered with a little context ("March 20", "15%",
 * "11:59 PM") so a note can show the student exactly what to double-check.
 */
export function findUnsupportedAnswerClaims(
  answer: string,
  evidenceText: string,
  question: string = ""
): string[] {
  const normalizedAnswer = normalizeClaimText(answer);
  const normalizedEvidence = normalizeClaimText(evidenceText);
  const normalizedQuestion = normalizeClaimText(question);
  const unsupported: string[] = [];

  // Dates are checked as month + day pairs. A bare "20" from "style 20 marks"
  // must not vouch for "March 20"; only a March 20 in the evidence can.
  const answerDates = extractDateClaims(normalizedAnswer);
  const evidenceDateKeys = new Set(extractDateClaims(normalizedEvidence).map((date) => date.key));
  const questionDateKeys = new Set(extractDateClaims(normalizedQuestion).map((date) => date.key));
  const dateCoveredTokens = new Set<string>();
  const seenDates = new Set<string>();
  const evidenceYears = collectYearHints(normalizedEvidence);
  for (const date of answerDates) {
    for (const token of date.tokens) dateCoveredTokens.add(token);
    if (seenDates.has(date.key) || questionDateKeys.has(date.key)) continue;
    seenDates.add(date.key);
    if (!evidenceDateKeys.has(date.key)) {
      unsupported.push(date.label);
      continue;
    }
    // "Thursday, March 27" when March 27 falls on a Friday: the date is
    // supported but the weekday is an inference, and a wrong one sends the
    // student to the wrong day.
    const weekdayProblem = checkWeekdayNextToDate(normalizedAnswer, date, evidenceYears);
    if (weekdayProblem) {
      unsupported.push(weekdayProblem);
    }
  }

  const answerTokens = extractNumericClaimTokens(normalizedAnswer);
  if (answerTokens.length > 0) {
    const evidenceTokens = collectNumericEvidenceTokens(evidenceText);
    const questionTokens = new Set(extractNumericClaimTokens(normalizedQuestion));

    const seen = new Set<string>();
    for (const token of answerTokens) {
      if (seen.has(token) || questionTokens.has(token) || dateCoveredTokens.has(token)) {
        continue;
      }
      seen.add(token);
      if (isClaimTokenSupported(token, evidenceTokens)) {
        continue;
      }
      unsupported.push(describeClaim(token, normalizedAnswer));
    }
  }

  // Presence is not support when the evidence lists several values of the
  // same kind: "March 20" is in a schedule that lists every lab, but the Lab
  // 4 line says March 27. Likewise "must" against a source that says "may".
  if (normalizedEvidence.trim()) {
    unsupported.push(
      ...findContextuallyUnsupportedClaims(normalizedAnswer, normalizedEvidence, normalizedQuestion),
      ...collectUnsupportedRequirementClaims(normalizedAnswer, normalizedEvidence)
    );
  }
  return unsupported;
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_PATTERN = "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?";

function weekdayIndex(word: string): number {
  const lower = word.toLowerCase();
  return WEEKDAY_NAMES.findIndex((name) => name.startsWith(lower.slice(0, 3)));
}

/** Four-digit years mentioned in the evidence, most frequent first. */
function collectYearHints(normalizedEvidence: string): number[] {
  const counts = new Map<number, number>();
  for (const match of normalizedEvidence.matchAll(/\b(20\d{2})\b/g)) {
    const year = Number(match[1]);
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([year]) => year);
}

/**
 * If the answer writes a weekday immediately before or after this date
 * ("Friday March 27", "March 27 (Thursday)"), verify it against the calendar.
 * Returns a description of the mismatch, or null. The year comes from the
 * claim itself, else the evidence, else the current year. Exported for tests.
 */
export function checkWeekdayNextToDate(
  normalizedAnswer: string,
  date: DateClaim,
  yearHints: number[],
  now: Date = new Date()
): string | null {
  const escaped = escapeRegExp(date.label);
  const pattern = new RegExp(
    `\\b(${WEEKDAY_PATTERN})\\.?,?\\s+(?:the\\s+)?${escaped}|${escaped}\\s*[,(]?\\s*(${WEEKDAY_PATTERN})\\b`,
    "i"
  );
  const match = normalizedAnswer.match(pattern);
  const weekdayWord = match?.[1] ?? match?.[2];
  if (!weekdayWord) return null;
  const claimed = weekdayIndex(weekdayWord);
  if (claimed < 0) return null;
  const [monthText, dayText] = date.key.split("-");
  const month = Number(monthText);
  const day = Number(dayText);
  const yearInClaim = date.tokens.find((token) => /^20\d{2}$/.test(token));
  const year = yearInClaim ? Number(yearInClaim) : (yearHints[0] ?? now.getFullYear());
  const actual = new Date(year, month - 1, day).getDay();
  if (actual === claimed) return null;
  const actualName = WEEKDAY_NAMES[actual]!;
  return `${weekdayWord} ${date.label} (${date.label}, ${year} is a ${actualName[0]!.toUpperCase()}${actualName.slice(1)})`;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const TENS_WORDS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
const UNIT_WORDS = "one|two|three|four|five|six|seven|eight|nine";
const TEEN_WORDS = "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
// "twenty-five", "twenty five", "fifteen", "ten", "one hundred" → digits, so a
// spelled-out figure is checked against a numeric one and vice versa. Standalone
// "one" is left alone ("one of the labs" is not a number claim).
const NUMBER_WORD_PATTERN = new RegExp(
  `\\b(?:(${TENS_WORDS})(?:[\\s-]+(${UNIT_WORDS}))?|(${TEEN_WORDS})|(${UNIT_WORDS}))(?:\\s+hundred)?\\b(?=\\s*(?:percent|%|points?|pts|marks?|days?|weeks?|hours?|hrs?|minutes?|mins?|seconds?|pages?|words?|attempts?|questions?|labs?|assignments?|submissions?|times|late|per\\b))`,
  "gi"
);

/** Replace spelled-out numbers that precede a unit-like word with digits. Exported for tests. */
export function spellOutNumbersToDigits(text: string): string {
  return text.replace(NUMBER_WORD_PATTERN, (match, tens, unit, teen, single) => {
    let value: number | null = null;
    if (tens) value = (NUMBER_WORDS[tens.toLowerCase()] ?? 0) + (unit ? NUMBER_WORDS[unit.toLowerCase()] ?? 0 : 0);
    else if (teen) value = NUMBER_WORDS[teen.toLowerCase()] ?? null;
    else if (single) value = NUMBER_WORDS[single.toLowerCase()] ?? null;
    if (value === null) return match;
    if (/hundred\s*$/i.test(match)) value *= 100;
    return String(value);
  });
}

function normalizeClaimText(text: string): string {
  return spellOutNumbersToDigits(text)
    .replace(/\r\n?/g, "\n")
    .replace(LIST_MARKER_PATTERN, " ")
    .replace(THOUSANDS_SEPARATOR_PATTERN, "$1")
    .replace(ORDINAL_SUFFIX_PATTERN, "$1");
}

function extractNumericClaimTokens(normalizedText: string): string[] {
  const tokens: string[] = [];
  for (const match of normalizedText.matchAll(NUMERIC_CLAIM_PATTERN)) {
    const token = match[0].toLowerCase();
    // Bare single digits ("3 parts", "step 2") are too ambiguous to check.
    if (token.length < 2) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

function collectNumericEvidenceTokens(evidenceText: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of normalizeClaimText(evidenceText).matchAll(NUMERIC_CLAIM_PATTERN)) {
    const token = match[0].toLowerCase();
    tokens.add(token);
    for (const part of token.split(/[.:]/)) {
      tokens.add(part);
    }
  }
  return tokens;
}

function isClaimTokenSupported(token: string, evidenceTokens: Set<string>): boolean {
  if (evidenceTokens.has(token)) {
    return true;
  }
  if (/[.:]/.test(token)) {
    return token.split(/[.:]/).every((part) => evidenceTokens.has(part));
  }
  return false;
}

function describeClaim(token: string, normalizedAnswer: string): string {
  const pattern = new RegExp(
    `(?:\\b(${CLAIM_LEADING_WORDS})\\.?\\s+)?(${escapeRegExp(token)})(?![\\d.:])(?:(%)|\\s?(${CLAIM_TRAILING_WORDS})\\b)?`,
    "i"
  );
  const match = normalizedAnswer.match(pattern);
  if (!match) {
    return token;
  }
  const leading = match[1] ? `${match[1]} ` : "";
  const trailing = match[3] ? "%" : match[4] ? ` ${match[4]}` : "";
  return `${leading}${match[2] ?? token}${trailing}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Checked-sources trail.
//
// "I couldn't find a late policy" means nothing unless the student knows what
// was looked at. This turns the turn's observations into a compact list of
// what was read, what was searched (and whether it matched), and what could
// not be read, so a not-found answer can say "after checking X, Y, Z".
// ---------------------------------------------------------------------------

export type CheckedSourceKind =
  | "read"
  | "search"
  | "announcements"
  | "thread"
  | "failed_read";

export interface CheckedSource {
  kind: CheckedSourceKind;
  /** Ready-to-print fragment, e.g. `course search for "late policy" (no matches)`. */
  label: string;
}

const MAX_CHECKED_SOURCES_IN_NOTE = 10;
const READ_TOOL_NAMES = new Set(["read_file", "download_course_file"]);
const SEARCH_TOOL_NAMES = new Set(["search_workspace", "search_course"]);
const TRUNCATION_MARKER_PATTERN = /\[\.\.\.truncated\]|\[\.\.\. ?cut off/i;

const NOT_FOUND_ANSWER_PATTERNS: RegExp[] = [
  // "couldn't find", "does not mention", "was unable to locate", "never states"
  /\b(?:could\s*n[o']t|can\s*n[o']t|did\s*n[o']t|do(?:es)?\s*n[o']t|was\s*n[o']t|were\s*n[o']t|unable to|not able to|never)\s+(?:\w+\s+){0,3}?(?:find|locate|see|mention|state|specify|specifies|list|include|contain|say|give|provide|confirm|address|cover)\b/i,
  // "is not specified", "aren't mentioned anywhere"
  /\b(?:is|are|was|were)\s*n[o']t\s+(?:\w+\s+)?(?:specified|mentioned|stated|listed|given|provided|found|available|included|documented|covered|addressed)\b/i,
  // "no mention of", "there is no information about"
  /\bno\s+(?:\w+\s+){0,2}?(?:mention|information|details?|reference|indication|record|sign)\b/i,
  // "none of the sources I read state a penalty"
  /\bnone of the\s+(?:\w+\s+){0,3}?(?:mention|state|specify|list|include|say|give|provide|cover)/i,
  // "not specified", "not mentioned in the handout"
  /\bnot\s+(?:specified|mentioned|stated|listed|documented|covered|addressed|found)\b/i,
];

/** True when the answer tells the student the information could not be found. */
export function answerLooksLikeNotFound(answer: string): boolean {
  const trimmed = answer.trim();
  if (!trimmed) {
    return false;
  }
  return NOT_FOUND_ANSWER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Reduce an observation trail to the sources that were actually consulted,
 * in order, deduped. Action-only tools (list_files, open_resource, ...) and
 * within-turn cache hits do not add entries.
 */
export function collectCheckedSources(observations: Observation[]): CheckedSource[] {
  const checked: CheckedSource[] = [];
  const seen = new Set<string>();
  const push = (entry: CheckedSource): void => {
    const key = `${entry.kind}:${entry.label.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    checked.push(entry);
  };

  for (const observation of observations) {
    if (READ_TOOL_NAMES.has(observation.tool)) {
      if (observation.status === "ok") {
        const grounded = isGroundedContentObservation(observation);
        const truncated =
          grounded && TRUNCATION_MARKER_PATTERN.test(observation.content ?? "");
        for (const artifact of observation.artifacts) {
          const section = normalizeSourceSection(artifact.sectionLabel);
          const title = section ? `${artifact.title} — ${section}` : artifact.title;
          const how = section
            ? "read"
            : truncated
              ? "read, cut off"
              : grounded
                ? "read in full"
                : "read";
          push({ kind: "read", label: `${title} (${how})` });
        }
        continue;
      }
      const title =
        observation.artifacts[0]?.title ?? extractQuotedFragment(observation.summary);
      if (title) {
        push({
          kind: "failed_read",
          label: `${title} (could not read: ${describeReadFailure(observation.status)})`,
        });
      }
      continue;
    }

    if (SEARCH_TOOL_NAMES.has(observation.tool)) {
      const query = extractQuotedFragment(observation.summary);
      if (!query) {
        continue;
      }
      const scope = observation.tool === "search_course" ? "course" : "workspace";
      const outcome =
        observation.status === "ok"
          ? describeMatchCount(observation)
          : observation.status === "error"
            ? "search failed"
            : "no matches";
      push({ kind: "search", label: `${scope} search for "${query}" (${outcome})` });
      continue;
    }

    if (observation.tool === "list_announcements" && observation.status === "ok") {
      const query = extractQuotedFragment(observation.summary);
      push({
        kind: "announcements",
        label: query ? `the announcements matching "${query}"` : "the announcements",
      });
      continue;
    }

    if (observation.tool === "read_thread") {
      const topic = extractQuotedFragment(observation.summary);
      if (observation.status === "ok") {
        push({
          kind: "thread",
          label: topic ? `the discussion thread "${topic}"` : "the discussion thread",
        });
      } else if (topic) {
        push({
          kind: "failed_read",
          label: `discussion thread "${topic}" (not found)`,
        });
      }
    }
  }

  return checked;
}

/** Join a trail into one printable fragment, or null when nothing was checked. */
export function formatCheckedSourcesNote(checked: CheckedSource[]): string | null {
  if (checked.length === 0) {
    return null;
  }
  const shown = checked.slice(0, MAX_CHECKED_SOURCES_IN_NOTE);
  const more = checked.length - shown.length;
  const joined = shown.map((entry) => entry.label).join("; ");
  return more > 0 ? `${joined}; and ${more} more` : joined;
}

function describeReadFailure(status: Observation["status"]): string {
  switch (status) {
    case "missing_text":
      return "no extracted text";
    case "not_found":
      return "not found";
    default:
      return "error";
  }
}

function describeMatchCount(observation: Observation): string {
  const fromSummary = observation.summary.match(/\bFound (\d+)\b/i);
  const count = fromSummary
    ? Number.parseInt(fromSummary[1]!, 10)
    : observation.artifacts.length;
  return `${count} match${count === 1 ? "" : "es"}`;
}

function extractQuotedFragment(text: string): string | null {
  const match = text.match(/"([^"]+)"/);
  return match?.[1]?.trim() || null;
}
