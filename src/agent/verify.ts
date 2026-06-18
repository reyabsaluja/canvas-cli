import type { AnswerSource } from "../ask/types.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { ArtifactRef, Observation } from "./observation.js";
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
    ? collectUnsupportedSpecificDetails(
        input.question,
        trimmedAnswer,
        specificClaimEvidence
      )
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
    for (const artifact of selectCitationArtifacts(
      observation.artifacts,
      question,
      answer
    )) {
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
          excerpt: buildSourceExcerpt({
            artifact,
            observation,
            question,
            answer,
            section,
          }),
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

function selectCitationArtifacts(
  artifacts: ArtifactRef[],
  question: string,
  answer: string
): ArtifactRef[] {
  if (artifacts.length <= 1) {
    return artifacts;
  }

  const queryTokens = tokenizeForMatch(`${question}\n${answer}`);
  if (queryTokens.length === 0) {
    return artifacts;
  }

  const ranked = artifacts
    .map((artifact, index) => ({
      artifact,
      index,
      score: scoreArtifactCitationRelevance(artifact, queryTokens),
    }))
    .filter((entry) => entry.score >= minimumArtifactCitationScore(queryTokens));

  if (ranked.length === 0) {
    return artifacts;
  }

  const selectedIndexes = new Set(ranked.map((entry) => entry.index));
  return artifacts.filter((_, index) => selectedIndexes.has(index));
}

function scoreArtifactCitationRelevance(
  artifact: ArtifactRef,
  queryTokens: string[]
): number {
  const titleTokens = new Set(tokenizeForMatch(artifact.title));
  const sectionTokens = new Set(tokenizeForMatch(artifact.sectionLabel ?? ""));
  const excerptTokens = new Set(tokenizeForMatch(artifact.excerpt ?? ""));
  let score = 0;

  for (const token of queryTokens) {
    if (sectionTokens.has(token)) {
      score += 5;
    }
    if (titleTokens.has(token)) {
      score += 4;
    }
    if (excerptTokens.has(token)) {
      score += 3;
    }
  }

  return score;
}

function minimumArtifactCitationScore(queryTokens: string[]): number {
  return queryTokens.length <= 2 ? 3 : 6;
}

function buildSourceExcerpt(input: {
  artifact: ArtifactRef;
  observation: Observation;
  question: string;
  answer: string;
  section: string | null;
}): string | null {
  const artifactExcerpt = buildExcerpt(input.artifact.excerpt ?? undefined);
  const contentExcerpt =
    isGroundedContentObservation(input.observation) && input.observation.content
      ? buildRelevantContentExcerpt(
          input.observation.content,
          input.question,
          input.answer,
          input.section
        )
      : null;

  if (!contentExcerpt) {
    return (
      artifactExcerpt ??
      buildExcerpt(input.observation.content ?? input.observation.summary)
    );
  }
  if (!artifactExcerpt) {
    return contentExcerpt;
  }

  const queryTokens = tokenizeForMatch(
    `${input.question}\n${input.answer}\n${input.section ?? ""}`
  );
  return scoreTextRelevance(contentExcerpt, queryTokens) >=
    scoreTextRelevance(artifactExcerpt, queryTokens)
    ? contentExcerpt
    : artifactExcerpt;
}

function buildRelevantContentExcerpt(
  content: string,
  question: string,
  answer: string,
  section: string | null
): string | null {
  const sectionBody = section ? findSectionBody(content, section) : null;
  const sourceText = sectionBody ?? content;
  const queryTokens = tokenizeForMatch(
    `${question}\n${answer}\n${section ?? ""}`
  );
  if (queryTokens.length === 0) {
    return buildExcerpt(sourceText);
  }

  const chunks = splitEvidenceChunks(sourceText);
  if (chunks.length === 0) {
    return buildExcerpt(sourceText);
  }

  const ranked = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: scoreTextRelevance(chunk, queryTokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    });

  return buildExcerpt(ranked[0]?.chunk ?? sourceText);
}

function findSectionBody(content: string, title: string): string | null {
  const normalizedTitle = normalizeSourceSection(title)?.toLowerCase();
  if (!normalizedTitle) {
    return null;
  }

  const section = extractContentSections(content).find(
    (entry) =>
      normalizeSourceSection(entry.title)?.toLowerCase() === normalizedTitle
  );
  return section?.body.trim() || null;
}

function splitEvidenceChunks(text: string): string[] {
  const chunks: string[] = [];
  const blocks = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^#{1,6}\s+/.test(line));
    const candidates = lines.length > 1 ? lines : splitSentences(lines[0] ?? block);
    for (const candidate of candidates) {
      const cleaned = candidate.replace(/\s+/g, " ").trim();
      if (cleaned) {
        chunks.push(cleaned);
      }
    }
  }

  return chunks;
}

function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 260) {
    return normalized ? [normalized] : [];
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.length > 0 ? sentences : [normalized];
}

function scoreTextRelevance(text: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const textTokens = new Set(tokenizeForMatch(text));
  let score = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      score += 1;
    }
  }
  return score;
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

const SPECIFIC_DETAIL_CONTEXT_STOP_WORDS = new Set([
  "about",
  "and",
  "are",
  "can",
  "did",
  "does",
  "for",
  "from",
  "have",
  "how",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "say",
  "says",
  "should",
  "that",
  "the",
  "this",
  "to",
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
  question: string,
  answer: string,
  evidenceText: string
): string[] {
  if (!answer.trim() || !evidenceText.trim()) {
    return [];
  }

  const normalizedEvidence = normalizeSpecificDetailText(evidenceText);
  const details = collectSpecificDetails(answer);
  const answerContext = buildSpecificDetailAnswerContext(`${question}\n${answer}`);
  const evidenceDetails = collectSpecificDetailRecords(evidenceText);
  const unsupportedDetails = details.filter(
    (detail) =>
      !specificDetailAppearsInEvidence(detail, normalizedEvidence) ||
      !specificDetailIsContextuallySupported(
        detail,
        answer,
        answerContext,
        evidenceText,
        evidenceDetails
      )
  );
  return uniqueUnsupportedDetails([
    ...unsupportedDetails,
    ...collectUnsupportedRequirementClaims(answer, evidenceText),
  ]);
}

interface SpecificDetailRecord {
  value: string;
  key: string;
  category: string;
}

function uniqueUnsupportedDetails(details: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const detail of details) {
    const key = normalizeSpecificDetailText(detail);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(detail);
  }
  return unique;
}

const STRONG_REQUIREMENT_RE =
  /\b(?:must|mandatory|required|requires?|need(?:ed)?\s+to|have\s+to|has\s+to|shall)\b/i;
const WEAK_REQUIREMENT_RE =
  /\b(?:may|can|could|optional|recommended|suggested|encouraged|usually|typically|generally|not\s+required|not\s+mandatory|do(?:es)?\s+not\s+need|don'?t\s+need|need\s+not)\b/i;
const IMPERATIVE_REQUIREMENT_RE =
  /^(?:[-*]\s*)?(?:\d+\.\s*)?(?:submit|include|upload|attach|bring|complete|use|provide|turn\s+in)\b/i;
const REQUIREMENT_CLAIM_STOP_WORDS = new Set([
  ...SPECIFIC_DETAIL_CONTEXT_STOP_WORDS,
  "attach",
  "bring",
  "complete",
  "could",
  "encouraged",
  "have",
  "include",
  "mandatory",
  "may",
  "must",
  "need",
  "needed",
  "optional",
  "provide",
  "recommended",
  "required",
  "requires",
  "shall",
  "submit",
  "suggested",
  "turn",
  "upload",
  "use",
]);

function collectUnsupportedRequirementClaims(
  answer: string,
  evidenceText: string
): string[] {
  const evidenceClauses = splitRequirementClauses(evidenceText);
  if (evidenceClauses.length === 0) {
    return [];
  }

  const unsupported: string[] = [];
  for (const claim of splitRequirementClauses(answer)) {
    if (!isStrongUnqualifiedRequirementClaim(claim)) {
      continue;
    }

    const claimTokens = tokenizeRequirementClaim(claim);
    if (claimTokens.length === 0) {
      continue;
    }

    const threshold = requirementClaimOverlapThreshold(claimTokens);
    const matchingEvidence = evidenceClauses.filter(
      (clause) => countRequirementTokenOverlap(claimTokens, clause) >= threshold
    );
    if (matchingEvidence.length === 0) {
      continue;
    }

    const hasStrongSupport = matchingEvidence.some((clause) =>
      evidenceClauseStronglyRequires(clause)
    );
    if (hasStrongSupport) {
      continue;
    }

    const hasWeakContradiction = matchingEvidence.some((clause) =>
      WEAK_REQUIREMENT_RE.test(clause)
    );
    if (hasWeakContradiction) {
      unsupported.push(claim);
    }
  }

  return unsupported;
}

function splitRequirementClauses(text: string): string[] {
  return splitSpecificDetailSentences(text)
    .flatMap((sentence) =>
      sentence.split(/\s*(?:;|\bbut\b|\bhowever\b)\s*/i)
    )
    .map((clause) => clause.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isStrongUnqualifiedRequirementClaim(claim: string): boolean {
  return STRONG_REQUIREMENT_RE.test(claim) && !WEAK_REQUIREMENT_RE.test(claim);
}

function evidenceClauseStronglyRequires(clause: string): boolean {
  return (
    isStrongUnqualifiedRequirementClaim(clause) ||
    (IMPERATIVE_REQUIREMENT_RE.test(clause) && !WEAK_REQUIREMENT_RE.test(clause))
  );
}

function tokenizeRequirementClaim(claim: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of normalizeSpecificDetailText(claim).split(/\s+/)) {
    if (
      token.length < 3 ||
      REQUIREMENT_CLAIM_STOP_WORDS.has(token) ||
      seen.has(token)
    ) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function countRequirementTokenOverlap(tokens: string[], clause: string): number {
  const clauseTokens = new Set(tokenizeRequirementClaim(clause));
  return tokens.filter((token) => clauseTokens.has(token)).length;
}

function requirementClaimOverlapThreshold(tokens: string[]): number {
  if (tokens.length <= 2) {
    return 1;
  }
  return Math.min(3, Math.max(2, Math.ceil(tokens.length * 0.4)));
}

function collectSpecificDetails(answer: string): string[] {
  return collectSpecificDetailRecords(answer).map((record) => record.value);
}

function collectSpecificDetailRecords(value: string): SpecificDetailRecord[] {
  const patterns: Array<{ category: string; pattern: RegExp }> = [
    { category: "date", pattern: /\b\d{4}-\d{1,2}-\d{1,2}\b/g },
    {
      category: "date",
      pattern:
        /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t\.?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/gi,
    },
    { category: "date", pattern: /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g },
    {
      category: "time",
      pattern: /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/gi,
    },
    {
      category: "quantity",
      pattern:
        /\b\d+(?:\.\d+)?\s*(?:%|(?:percent(?:age)?|points?|pts?|marks?|hours?|hrs?|minutes?|mins?|seconds?|secs?|pages?|words?|files?|attempts?|submissions?|days?|weeks?|ohms?|k(?:ilo)?ohms?|kb|mb|gb)\b)/gi,
    },
    { category: "hex", pattern: /\b0x[0-9a-f]+\b/gi },
    {
      category: "file",
      pattern:
        /\b[\w.-]+\.(?:pdf|docx?|pptx?|xlsx?|zip|txt|md|html?|py|java|c|cpp|js|ts|json|csv)\b/gi,
    },
  ];
  const records: SpecificDetailRecord[] = [];
  const seen = new Set<string>();
  for (const { category, pattern } of patterns) {
    for (const match of value.matchAll(pattern)) {
      const detail = match[0].trim();
      const key = normalizeSpecificDetailKey(detail, category);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      records.push({ value: detail, key, category });
    }
  }
  return records;
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

function specificDetailIsContextuallySupported(
  detail: string,
  answer: string,
  answerContext: SpecificDetailAnswerContext,
  evidenceText: string,
  evidenceDetails: SpecificDetailRecord[]
): boolean {
  if (
    evidenceQualifiesSpecificDetail(detail, evidenceText) &&
    !answerQualifiesSpecificDetail(detail, answer)
  ) {
    return false;
  }

  const category = inferSpecificDetailCategory(detail);
  if (!category || !evidenceHasCompetingDetails(detail, category, evidenceDetails)) {
    return true;
  }

  const detailEvidenceChunks = splitEvidenceChunks(evidenceText).filter((chunk) =>
    specificDetailAppearsInEvidence(detail, normalizeSpecificDetailText(chunk))
  );
  if (detailEvidenceChunks.length === 0) {
    return false;
  }

  if (
    answerContext.anchors.length > 0 &&
    evidenceContainsCompetingAnchoredDetail(
      detail,
      category,
      answerContext.anchors,
      evidenceText,
      evidenceDetails
    )
  ) {
    return false;
  }

  if (answerContext.anchors.length > 0) {
    return detailEvidenceChunks.some((chunk) =>
      answerContext.anchors.some((anchor) =>
        normalizeSpecificDetailText(chunk).includes(anchor)
      )
    );
  }

  if (answerContext.tokens.length === 0) {
    return true;
  }

  return detailEvidenceChunks.some((chunk) => {
    const chunkTokens = new Set(tokenizeSpecificDetailContext(chunk));
    return answerContext.tokens.some((token) => chunkTokens.has(token));
  });
}

function evidenceContainsCompetingAnchoredDetail(
  detail: string,
  category: string,
  anchors: string[],
  evidenceText: string,
  evidenceDetails: SpecificDetailRecord[]
): boolean {
  const detailAmbiguityKey = normalizeSpecificDetailAmbiguityKey(detail, category);
  const competingDetails = evidenceDetails.filter(
    (record) =>
      record.category === category &&
      normalizeSpecificDetailAmbiguityKey(record.value, record.category) !==
        detailAmbiguityKey
  );
  if (competingDetails.length === 0) {
    return false;
  }

  return splitEvidenceChunks(evidenceText).some((chunk) => {
    const normalizedChunk = normalizeSpecificDetailText(chunk);
    if (!anchors.some((anchor) => normalizedChunk.includes(anchor))) {
      return false;
    }
    return competingDetails.some((record) =>
      specificDetailAppearsInEvidence(record.value, normalizedChunk)
    );
  });
}

const SPECIFIC_DETAIL_QUALIFIER_RE =
  /\b(?:approx(?:imate|imately)?|about|around|roughly|usually|typically|generally|normally|estimated?|tentative(?:ly)?|expected|planned|subject to change)\b/;

function evidenceQualifiesSpecificDetail(
  detail: string,
  evidenceText: string
): boolean {
  const detailSentences = splitSpecificDetailSentences(evidenceText).filter(
    (sentence) =>
      specificDetailAppearsInEvidence(detail, normalizeSpecificDetailText(sentence))
  );
  if (detailSentences.length === 0) {
    return false;
  }

  return detailSentences.every((sentence) =>
    sentenceQualifiesSpecificDetail(sentence, detail)
  );
}

function answerQualifiesSpecificDetail(detail: string, answer: string): boolean {
  const detailSentences = splitSpecificDetailSentences(answer).filter((sentence) =>
    specificDetailAppearsInEvidence(detail, normalizeSpecificDetailText(sentence))
  );
  if (detailSentences.length === 0) {
    return false;
  }

  return detailSentences.every((sentence) =>
    sentenceQualifiesSpecificDetail(sentence, detail)
  );
}

function splitSpecificDetailSentences(text: string): string[] {
  return splitEvidenceChunks(text)
    .flatMap((chunk) =>
      chunk
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+/)
    )
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function sentenceQualifiesSpecificDetail(sentence: string, detail: string): boolean {
  const normalizedSentence = normalizeSpecificDetailText(sentence);
  const normalizedDetail = normalizeSpecificDetailText(detail);
  if (!normalizedSentence || !normalizedDetail) {
    return false;
  }

  const detailIndex = normalizedSentence.indexOf(normalizedDetail);
  if (detailIndex < 0) {
    return SPECIFIC_DETAIL_QUALIFIER_RE.test(normalizedSentence);
  }

  const start = Math.max(0, detailIndex - 80);
  const end = Math.min(
    normalizedSentence.length,
    detailIndex + normalizedDetail.length + 80
  );
  return SPECIFIC_DETAIL_QUALIFIER_RE.test(
    normalizedSentence.slice(start, end)
  );
}

interface SpecificDetailAnswerContext {
  anchors: string[];
  tokens: string[];
}

function buildSpecificDetailAnswerContext(answer: string): SpecificDetailAnswerContext {
  return {
    anchors: collectSpecificDetailAnchors(answer),
    tokens: tokenizeSpecificDetailContext(answer),
  };
}

function collectSpecificDetailAnchors(value: string): string[] {
  const anchors: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /\b(?:lab|assignment|homework|hw|project|quiz|module|week|part|task|milestone)\s*#?\s*\d+[a-z]?\b/gi,
    /\b[\w.-]+\.(?:pdf|docx?|pptx?|xlsx?|zip|txt|md|html?|py|java|c|cpp|js|ts|json|csv)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const anchor = normalizeSpecificDetailText(match[0]);
      if (!anchor || seen.has(anchor)) {
        continue;
      }
      seen.add(anchor);
      anchors.push(anchor);
    }
  }
  return anchors;
}

function tokenizeSpecificDetailContext(value: string): string[] {
  const specificDetailText = collectSpecificDetails(value)
    .map(normalizeSpecificDetailText)
    .join(" ");
  const detailTokens = new Set(specificDetailText.split(/\s+/).filter(Boolean));
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const rawToken of normalizeSpecificDetailText(value).split(/\s+/)) {
    if (
      !rawToken ||
      detailTokens.has(rawToken) ||
      SPECIFIC_DETAIL_CONTEXT_STOP_WORDS.has(rawToken) ||
      seen.has(rawToken)
    ) {
      continue;
    }
    if (rawToken.length < 2 && !/^\d+$/.test(rawToken)) {
      continue;
    }
    seen.add(rawToken);
    tokens.push(rawToken);
  }
  return tokens;
}

function evidenceHasCompetingDetails(
  detail: string,
  category: string,
  evidenceDetails: SpecificDetailRecord[]
): boolean {
  const detailKey = normalizeSpecificDetailKey(detail, category);
  const detailAmbiguityKey = normalizeSpecificDetailAmbiguityKey(
    detail,
    category
  );
  const competingKeys = new Set(
    evidenceDetails
      .filter((record) => record.category === category)
      .map((record) =>
        normalizeSpecificDetailAmbiguityKey(record.value, record.category)
      )
      .filter((key) => key.length > 0)
  );
  return (
    competingKeys.size > 1 &&
    (competingKeys.has(detailKey) || competingKeys.has(detailAmbiguityKey))
  );
}

function inferSpecificDetailCategory(detail: string): string | null {
  return collectSpecificDetailRecords(detail)[0]?.category ?? null;
}

function normalizeSpecificDetailKey(value: string, category: string): string {
  if (category === "date") {
    const parsedDate =
      parseMonthDaySpecificDetail(value) ??
      parseIsoSpecificDetail(value) ??
      parseSlashDateSpecificDetail(value);
    if (parsedDate) {
      return [
        parsedDate.year ?? "",
        String(parsedDate.month).padStart(2, "0"),
        String(parsedDate.day).padStart(2, "0"),
      ].join("-");
    }
  }
  return normalizeSpecificDetailText(value);
}

function normalizeSpecificDetailAmbiguityKey(
  value: string,
  category: string
): string {
  if (category === "date") {
    const parsedDate =
      parseMonthDaySpecificDetail(value) ??
      parseIsoSpecificDetail(value) ??
      parseSlashDateSpecificDetail(value);
    if (parsedDate) {
      return [
        String(parsedDate.month).padStart(2, "0"),
        String(parsedDate.day).padStart(2, "0"),
      ].join("-");
    }
  }
  return normalizeSpecificDetailKey(value, category);
}

function normalizeSpecificDetailText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(\d+(?:\.\d+)?)\s*%/g, "$1 percent")
    .replace(/\b(\d+(?:\.\d+)?)\s+percent(?:age)?\b/g, "$1 percent")
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
