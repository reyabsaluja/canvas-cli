import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { RunState } from "./run-state.js";
import { hasReadArtifact } from "./run-state.js";
import { searchWorkspaceKnowledge } from "../tui/workspace-knowledge.js";

const MAX_MEMORY_REUSE_ARTIFACTS = 3;
const MIN_MEMORY_REUSE_SCORE = 12;
const MEMORY_STOP_WORDS = new Set([
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

export type RetrievalDecision =
  | { action: "answer_from_workup"; reason: string }
  | { action: "answer_from_memory"; reason: string; sourceArtifactIds: string[] }
  | { action: "read_artifact"; reason: string; artifactId: string }
  | { action: "let_model_decide"; reason: string };

export interface RetrievalGateInput {
  question: string;
  runState: RunState;
  loaded: LoadedWorkspace;
  cache: CourseCache | null;
}

export async function decideWorkspaceRetrieval(
  input: RetrievalGateInput
): Promise<RetrievalDecision> {
  const question = input.question.trim();
  if (!question) {
    return { action: "let_model_decide", reason: "empty_question" };
  }

  if (shouldBypassGate(question)) {
    return { action: "let_model_decide", reason: "explicit_tool_request" };
  }

  if (workupLikelyCoversQuestion(input.loaded, question)) {
    return { action: "answer_from_workup", reason: "covered_by_workup" };
  }

  const matches = await searchWorkspaceKnowledge(
    input.loaded,
    input.cache,
    question,
    3
  );
  const promotedMatches = matches.filter((match) =>
    shouldPromoteTopMatch(question, match.score)
  );
  if (promotedMatches.length === 0) {
    const reusableMemoryArtifactIds = selectReusableMemoryArtifactIds(
      question,
      input.runState
    );
    if (reusableMemoryArtifactIds.length > 0) {
      return {
        action: "answer_from_memory",
        reason: "already_read_relevant_artifact",
        sourceArtifactIds: reusableMemoryArtifactIds,
      };
    }
    return { action: "let_model_decide", reason: "weak_workspace_match" };
  }

  const reusableArtifactIds = selectReusableReadArtifactIds(
    question,
    promotedMatches,
    input.runState
  );

  if (reusableArtifactIds.length > 0) {
    return {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: reusableArtifactIds,
    };
  }

  const topMatch = selectPreferredWorkspaceMatch(question, promotedMatches);
  if (!topMatch) {
    return { action: "let_model_decide", reason: "weak_workspace_match" };
  }

  return {
    action: "read_artifact",
    reason: "top_workspace_match_needs_read",
    artifactId: topMatch.artifact.id,
  };
}

function shouldBypassGate(question: string): boolean {
  return /\b(open|download|list files|show files|search course)\b/i.test(question);
}

function workupLikelyCoversQuestion(
  loaded: LoadedWorkspace,
  question: string
): boolean {
  const workup = loaded.workupJson;
  if (!workup) {
    return false;
  }

  if (asksForDirectDocumentReading(question)) {
    return false;
  }

  const coverage = classifyWorkupCoverage(question);

  if (coverage === "due_date") {
    return Boolean(getWorkupDueDate(workup));
  }

  if (coverage === "deliverables") {
    return hasNonEmptyStringArray(workup.deliverables);
  }

  if (coverage === "constraints") {
    return hasNonEmptyStringArray(workup.constraints);
  }

  if (coverage === "overview") {
    return typeof workup.overview === "string" && workup.overview.trim().length > 0;
  }

  if (coverage === "plan") {
    return (
      hasNonEmptyStringArray(
        (workup as Record<string, unknown>).recommendedReadOrder ??
          (workup as Record<string, unknown>).recommended_read_order
      ) ||
      hasNonEmptyArray(
        (workup as Record<string, unknown>).actionPlan ??
          (workup as Record<string, unknown>).action_plan
      )
    );
  }

  return false;
}

function classifyWorkupCoverage(
  question: string
): "due_date" | "deliverables" | "constraints" | "overview" | "plan" | null {
  if (isDueDateQuestion(question)) {
    return "due_date";
  }

  if (/\b(deliverable|submit|submission|turn in|hand in)\b/i.test(question)) {
    return "deliverables";
  }

  if (/\b(constraint|restriction|format|rubric|grading|policy|policies)\b/i.test(question)) {
    return "constraints";
  }

  if (/\b(start|first|approach|read order|plan)\b/i.test(question)) {
    return "plan";
  }

  if (/\b(overvi?ew|summary|goal|purpose|expected|what is this assignment about|what is this about)\b/i.test(question)) {
    return "overview";
  }

  return null;
}

function isDueDateQuestion(question: string): boolean {
  return /\b(due|deadline)\b/i.test(question);
}

function getWorkupDueDate(
  workup: Record<string, unknown>
): string | null {
  const dueDate = workup.dueDate ?? workup.due_date;
  return typeof dueDate === "string" && dueDate.trim().length > 0
    ? dueDate
    : null;
}

function shouldPromoteTopMatch(question: string, score: number): boolean {
  if (asksForDirectDocumentReading(question)) {
    return score > 0;
  }
  return score >= 8;
}

function asksForDirectDocumentReading(question: string): boolean {
  return /\b(exact|quote|quoted|section|document|pdf|file|spec|read|detail|in depth|deep dive|requirement)\b/i.test(
    question
  );
}

function hasNonEmptyStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function selectPreferredWorkspaceMatch<
  T extends { artifact: { kind: string }; score: number }
>(question: string, matches: T[]): T | null {
  if (matches.length === 0) {
    return null;
  }

  if (asksForDirectDocumentReading(question)) {
    const nonWorkup = matches.find((match) => match.artifact.kind !== "workup");
    if (nonWorkup) {
      return nonWorkup;
    }
  }

  return matches[0] ?? null;
}

function selectReusableReadArtifactIds<
  T extends { artifact: { id: string; kind: string }; score: number }
>(
  question: string,
  matches: T[],
  runState: RunState
): string[] {
  const reusableMatches = matches.filter((match) =>
    hasReadArtifact(runState, match.artifact.id)
  );
  if (reusableMatches.length === 0) {
    return [];
  }

  const preferred = selectPreferredWorkspaceMatch(question, reusableMatches);
  const ordered = preferred
    ? [
        preferred,
        ...reusableMatches.filter(
          (match) => match.artifact.id !== preferred.artifact.id
        ),
      ]
    : reusableMatches;

  return ordered.slice(0, MAX_MEMORY_REUSE_ARTIFACTS).map((match) => match.artifact.id);
}

function selectReusableMemoryArtifactIds(
  question: string,
  runState: RunState
): string[] {
  const normalizedQuestion = normalizeMemoryText(question);
  if (!normalizedQuestion) {
    return [];
  }

  const questionTokens = tokenizeMemoryText(normalizedQuestion);
  const scoredArtifacts = new Map<string, { score: number; observationIndex: number }>();

  for (let index = runState.observations.length - 1; index >= 0; index -= 1) {
    const observation = runState.observations[index]!;
    if (!isGroundedContentObservation(observation)) {
      continue;
    }

    const score = scoreObservationForMemoryReuse(
      normalizedQuestion,
      questionTokens,
      observation
    );
    if (score < MIN_MEMORY_REUSE_SCORE) {
      continue;
    }

    for (const artifact of observation.artifacts) {
      const previous = scoredArtifacts.get(artifact.artifactId);
      if (
        !previous ||
        score > previous.score ||
        (score === previous.score && index > previous.observationIndex)
      ) {
        scoredArtifacts.set(artifact.artifactId, {
          score,
          observationIndex: index,
        });
      }
    }
  }

  return [...scoredArtifacts.entries()]
    .sort((left, right) => {
      if (right[1].score !== left[1].score) {
        return right[1].score - left[1].score;
      }
      return right[1].observationIndex - left[1].observationIndex;
    })
    .slice(0, MAX_MEMORY_REUSE_ARTIFACTS)
    .map(([artifactId]) => artifactId);
}

function scoreObservationForMemoryReuse(
  normalizedQuestion: string,
  questionTokens: string[],
  observation: RunState["observations"][number]
): number {
  const titleText = normalizeMemoryText(
    observation.artifacts.map((artifact) => artifact.title).join(" ")
  );
  const excerptText = normalizeMemoryText(
    observation.artifacts
      .map((artifact) => artifact.excerpt ?? "")
      .join(" ")
  );
  const contentText = normalizeMemoryText(observation.content ?? "");
  const haystack = `${titleText} ${excerptText} ${contentText}`.trim();
  if (!haystack) {
    return 0;
  }

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
    if (contentText.includes(token)) {
      score += 2;
      matchedTokens += 1;
    }
  }

  if (matchedTokens === questionTokens.length && matchedTokens > 0) {
    score += 6;
  }

  if (!fullPhraseMatch && matchedTokens < 2) {
    return 0;
  }

  return score;
}

function isGroundedContentObservation(
  observation: RunState["observations"][number]
): boolean {
  return (
    observation.status === "ok" &&
    observation.artifacts.length > 0 &&
    typeof observation.content === "string" &&
    observation.content.trim().length > 0
  );
}

function normalizeMemoryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/[^a-z0-9/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeMemoryText(value: string): string[] {
  return [...new Set(
    value
      .split(/[^a-z0-9/]+/)
      .map((token) => token.trim())
      .filter(
        (token) => token.length > 2 && !MEMORY_STOP_WORDS.has(token)
      )
  )];
}
