import type { AnswerSource } from "../ask/types.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { Observation } from "./observation.js";
import { questionExplicitlyComparesSources } from "./question-intent.js";
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
}

export interface VerifyWorkspaceAnswerInput {
  question: string;
  answer: string;
  observations: Observation[];
  usedWorkup: boolean;
  loaded: LoadedWorkspace;
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
  const specificClaimEvidence = buildSpecificClaimEvidenceText(input);
  const unsupportedSpecificDetails = specificClaimEvidence
    ? collectUnsupportedSpecificDetails(trimmedAnswer, specificClaimEvidence)
    : [];
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
  if (unsupportedSpecificDetails.length > 0) {
    missing.push("support");
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
  const confidence =
    unsupportedSpecificDetails.length > 0
      ? "low"
      : applyComparisonEvidenceConfidenceCap(baseConfidence, {
          expectsComparisonEvidence,
          hasEnoughComparisonSources,
          hasDirectReadInEvidence,
        });
  const note = buildVerificationNote({
    missing,
    sources,
    unsupportedSpecificDetails,
    usedWorkup: input.usedWorkup,
    workupSupportsQuestion,
    hasDirectReadInEvidence,
    hasCitationCapableObservation,
    expectsComparisonEvidence,
    hasEnoughComparisonSources,
  });

  return {
    ok: missing.length === 0,
    confidence,
    sources,
    missing,
    note,
  };
}

function buildVerificationNote(input: {
  missing: string[];
  sources: AnswerSource[];
  unsupportedSpecificDetails: string[];
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

  if (input.unsupportedSpecificDetails.length > 0) {
    return `This answer may include specific details I could not verify in the cited evidence: ${formatUnsupportedSpecificDetails(input.unsupportedSpecificDetails)}.`;
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

  for (const observation of citationObservations) {
    if (observation.status !== "ok") {
      continue;
    }
    for (const artifact of observation.artifacts) {
      const explicitSection = normalizeSourceSection(artifact.sectionLabel);
      const inferredSections =
        !explicitSection && isGroundedContentObservation(observation)
          ? inferSectionsFromContent(question, answer, observation.content!)
          : [];
      const sections =
        explicitSection
          ? [explicitSection]
          : inferredSections.length > 0
            ? inferredSections
            : [null];

      for (const section of sections) {
        const key = `${artifact.kind}:${artifact.title}:${section ?? ""}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        resolved.push({
          title: artifact.title,
          kind: artifact.kind,
          ...(section ? { section } : {}),
          excerpt: artifact.excerpt ?? buildExcerpt(observation.content ?? observation.summary),
        });
      }
    }
  }

  if (resolved.length === 0 && usedWorkup && loaded.workupJson) {
    const traceSources = collectWorkupTraceSources(loaded.workupJson);
    if (traceSources.length > 0) {
      for (const traceSource of traceSources) {
        resolved.push(traceSource);
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

function inferSectionsFromContent(
  question: string,
  answer: string,
  content: string
): string[] {
  const sections = extractContentSections(content);
  if (sections.length === 0) {
    return [];
  }

  const queryTokens = tokenizeForMatch(`${question}\n${answer}`);
  if (queryTokens.length === 0) {
    return [];
  }

  const scored: Array<{ title: string; score: number; level: number }> = [];

  for (const section of sections) {
    const headingTokens = new Set(tokenizeForMatch(section.title));
    const bodyTokens = new Set(tokenizeForMatch(section.body));
    let score = 0;
    for (const token of queryTokens) {
      if (headingTokens.has(token)) {
        score += 4;
      }
      if (bodyTokens.has(token)) {
        score += 2;
      }
    }
    if (score > 0) {
      scored.push({ title: section.title, score, level: section.level });
    }
  }

  if (scored.length === 0) {
    return [];
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.level - a.level;
  });

  const best = scored[0]!;
  const threshold = best.score * 0.6;
  const relevant = scored.filter((entry) => entry.score >= threshold);
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const entry of relevant.slice(0, 3)) {
    if (!seen.has(entry.title)) {
      seen.add(entry.title);
      titles.push(entry.title);
    }
  }

  return titles;
}

function inferSectionFromContent(
  question: string,
  answer: string,
  content: string
): string | null {
  const sections = inferSectionsFromContent(question, answer, content);
  return sections.length > 0 ? sections[0]! : null;
}

interface ContentSection {
  level: number;
  title: string;
  body: string;
}

function extractContentSections(content: string): ContentSection[] {
  const sections: ContentSection[] = [];
  let current:
    | { level: number; title: string; bodyLines: string[] }
    | null = null;

  for (const line of content.split("\n")) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      if (current) {
        sections.push({
          level: current.level,
          title: current.title,
          body: current.bodyLines.join("\n").trim(),
        });
      }

      const title = match[2]!.replace(/\s+#+\s*$/, "").trim();
      current =
        title.length > 0 && title.length <= 80
          ? { level: match[1]!.length, title, bodyLines: [] }
          : null;
      continue;
    }

    if (current) {
      current.bodyLines.push(line);
    }
  }

  if (current) {
    sections.push({
      level: current.level,
      title: current.title,
      body: current.bodyLines.join("\n").trim(),
    });
  }

  return sections;
}

const SECTION_MATCH_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "because",
  "before",
  "does",
  "from",
  "have",
  "how",
  "into",
  "should",
  "that",
  "the",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function tokenizeForMatch(value: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of value.toLowerCase().split(/[^a-z0-9]+/)) {
    if (
      token.length >= 3 &&
      !SECTION_MATCH_STOP_WORDS.has(token) &&
      !seen.has(token)
    ) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
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

  const relevant = selectRelevantCitationObservations(
    question,
    answer,
    observations
  );
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

  return observations.filter((observation) =>
    isObservationRelevantToQuestionOrAnswer(
      trimmedQuestion,
      trimmedAnswer,
      observation
    )
  );
}

function isObservationRelevantToQuestionOrAnswer(
  question: string,
  answer: string,
  observation: Observation
): boolean {
  if (question && scoreObservationRelevance(question, observation) > 0) {
    return true;
  }
  return Boolean(answer && scoreObservationRelevance(answer, observation) > 0);
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

function collectWorkupTraceSources(
  workupJson: Record<string, unknown>
): AnswerSource[] {
  const trace = (workupJson.sourceTrace ?? workupJson.source_trace) as
    | Array<{ conclusion?: string; source?: string }>
    | undefined;
  if (!trace || !Array.isArray(trace) || trace.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const sources: AnswerSource[] = [];
  for (const entry of trace) {
    const source = (typeof entry.source === "string" ? entry.source : "").trim();
    if (!source || seen.has(source.toLowerCase())) {
      continue;
    }
    seen.add(source.toLowerCase());
    const conclusion = (typeof entry.conclusion === "string" ? entry.conclusion : "").trim();
    sources.push({
      title: source,
      kind: inferSourceKind(source),
      excerpt: conclusion || null,
    });
  }
  return sources.slice(0, 4);
}

function inferSourceKind(source: string): string {
  const lower = source.toLowerCase();
  if (/\.pdf\b/.test(lower)) return "attachment";
  if (/syllabus/i.test(lower)) return "syllabus";
  if (/assignment\s*description/i.test(lower)) return "assignment";
  if (/announcement/i.test(lower)) return "announcement";
  if (/discussion/i.test(lower)) return "discussion";
  if (/\bpage\b/i.test(lower) || /\bmodule\b/i.test(lower)) return "page";
  return "document";
}

function buildSpecificClaimEvidenceText(input: VerifyWorkspaceAnswerInput): string {
  const parts: string[] = [];
  for (const observation of selectCitationObservations(
    input.question,
    input.answer,
    input.observations
  )) {
    if (observation.status !== "ok") {
      continue;
    }
    parts.push(observation.summary);
    if (observation.content) {
      parts.push(observation.content);
    }
    for (const artifact of observation.artifacts) {
      parts.push(artifact.title);
      if (artifact.sectionLabel) {
        parts.push(artifact.sectionLabel);
      }
      if (artifact.excerpt) {
        parts.push(artifact.excerpt);
      }
    }
  }

  if (input.usedWorkup && input.loaded.workupJson) {
    parts.push(JSON.stringify(input.loaded.workupJson));
  }

  return parts.join("\n").trim();
}

function collectUnsupportedSpecificDetails(
  answer: string,
  evidenceText: string
): string[] {
  if (!answer.trim() || !evidenceText.trim()) {
    return [];
  }

  const normalizedEvidence = normalizeSpecificDetailText(evidenceText);
  const details = collectSpecificDetails(answer);
  return details.filter(
    (detail) =>
      !specificDetailAppearsInEvidence(detail, normalizedEvidence)
  );
}

function collectSpecificDetails(answer: string): string[] {
  const patterns = [
    /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t\.?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/gi,
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
    /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/gi,
    /\b\d+(?:\.\d+)?\s*(?:%|points?|pts?|marks?|hours?|hrs?|minutes?|mins?|seconds?|secs?|pages?|words?|files?|attempts?|submissions?|days?|weeks?|ohms?|k(?:ilo)?ohms?|kb|mb|gb)\b/gi,
    /\b0x[0-9a-f]+\b/gi,
    /\b[\w.-]+\.(?:pdf|docx?|pptx?|xlsx?|zip|txt|md|html?|py|java|c|cpp|js|ts|json|csv)\b/gi,
  ];
  const details: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of answer.matchAll(pattern)) {
      const detail = match[0].trim();
      const key = normalizeSpecificDetailText(detail);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      details.push(detail);
    }
  }
  return details;
}

function specificDetailAppearsInEvidence(
  detail: string,
  normalizedEvidence: string
): boolean {
  const normalizedDetail = normalizeSpecificDetailText(detail);
  if (!normalizedDetail) {
    return true;
  }
  if (normalizedEvidence.includes(normalizedDetail)) {
    return true;
  }

  const parsedDate =
    parseMonthDaySpecificDetail(detail) ??
    parseIsoSpecificDetail(detail) ??
    parseSlashDateSpecificDetail(detail);
  if (!parsedDate) {
    return false;
  }

  return dateAppearsInEvidence(parsedDate, normalizedEvidence);
}

function normalizeSpecificDetailText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, "$1")
    .replace(/\ba\.?m\.?\b/g, "am")
    .replace(/\bp\.?m\.?\b/g, "pm")
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMonthDaySpecificDetail(
  value: string
): { month: number; day: number; year?: number } | null {
  const match = value.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t\.?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/i
  );
  if (!match) {
    return null;
  }
  const month = MONTHS.get(normalizeMonthName(match[1]!));
  const day = Number.parseInt(match[2]!, 10);
  const year = match[3] ? Number.parseInt(match[3], 10) : undefined;
  return month && isValidMonthDay(month, day) ? { month, day, year } : null;
}

function parseIsoSpecificDetail(
  value: string
): { month: number; day: number; year?: number } | null {
  const match = value.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  return isValidMonthDay(month, day) ? { month, day, year } : null;
}

function parseSlashDateSpecificDetail(
  value: string
): { month: number; day: number; year?: number } | null {
  const match = value.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (!match) {
    return null;
  }
  const month = Number.parseInt(match[1]!, 10);
  const day = Number.parseInt(match[2]!, 10);
  const year = match[3] ? Number.parseInt(match[3], 10) : undefined;
  return isValidMonthDay(month, day) ? { month, day, year } : null;
}

function dateAppearsInEvidence(
  date: { month: number; day: number; year?: number },
  normalizedEvidence: string
): boolean {
  const month = String(date.month);
  const day = String(date.day);
  const dayPadded = day.padStart(2, "0");
  const yearPrefix = date.year ? `${date.year}\\s+` : "(?:\\d{4}\\s+)?";
  const numericDatePattern = new RegExp(
    `\\b${yearPrefix}0?${month}\\s+0?${day}\\b`
  );
  if (numericDatePattern.test(normalizedEvidence)) {
    return true;
  }

  if (date.year) {
    return monthNamesFor(date.month).some(
      (monthName) =>
        normalizedEvidence.includes(`${monthName} ${day} ${date.year}`) ||
        normalizedEvidence.includes(`${monthName} ${dayPadded} ${date.year}`)
    );
  }

  return monthNamesFor(date.month).some((monthName) =>
    normalizedEvidence.includes(`${monthName} ${day}`) ||
    normalizedEvidence.includes(`${monthName} ${dayPadded}`)
  );
}

function isValidMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function normalizeMonthName(value: string): string {
  return value.toLowerCase().replace(/\./g, "");
}

function monthNamesFor(month: number): string[] {
  return [...MONTHS.entries()]
    .filter(([, value]) => value === month)
    .map(([name]) => name);
}

function formatUnsupportedSpecificDetails(details: string[]): string {
  const shown = details.slice(0, 3).map((detail) => `"${detail}"`);
  const suffix =
    details.length > shown.length ? `, and ${details.length - shown.length} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

const MONTHS = new Map<string, number>([
  ["jan", 1],
  ["january", 1],
  ["feb", 2],
  ["february", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
]);
