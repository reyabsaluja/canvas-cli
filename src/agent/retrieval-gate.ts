import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { RunState } from "./run-state.js";
import { hasReadArtifact } from "./run-state.js";
import { searchWorkspaceKnowledge } from "../tui/workspace-knowledge.js";

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

const WORKUP_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "assignment",
  "been",
  "does",
  "from",
  "have",
  "into",
  "just",
  "need",
  "part",
  "that",
  "their",
  "there",
  "these",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
]);

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

  const topMatch = (await searchWorkspaceKnowledge(
    input.loaded,
    input.cache,
    question,
    1
  ))[0];

  if (!topMatch) {
    return { action: "let_model_decide", reason: "no_workspace_match" };
  }

  if (!shouldPromoteTopMatch(question, topMatch.score)) {
    return { action: "let_model_decide", reason: "weak_workspace_match" };
  }

  if (hasReadArtifact(input.runState, topMatch.artifact.id)) {
    return {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: [topMatch.artifact.id],
    };
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

  // Deadline questions are higher-risk: if the workup does not have an explicit
  // due-date field, do not let generic token overlap short-circuit retrieval.
  if (isDueDateQuestion(question)) {
    return Boolean(getWorkupDueDate(workup));
  }

  const questionTokens = tokenize(question).filter(
    (token) => !WORKUP_STOP_WORDS.has(token)
  );
  if (questionTokens.length === 0) {
    return true;
  }

  const workupText = JSON.stringify(workup).toLowerCase();
  const overlap = questionTokens.filter((token) => workupText.includes(token));
  if (overlap.length >= Math.min(2, questionTokens.length)) {
    return true;
  }

  if (/\b(deliverable|submit|submission|turn in)\b/i.test(question)) {
    const deliverables = (workup as Record<string, unknown>).deliverables;
    return Array.isArray(deliverables) && deliverables.length > 0;
  }

  if (/\b(constraint|restriction|format|rubric)\b/i.test(question)) {
    const constraints = (workup as Record<string, unknown>).constraints;
    return Array.isArray(constraints) && constraints.length > 0;
  }

  return false;
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
  return score >= 12;
}

function asksForDirectDocumentReading(question: string): boolean {
  return /\b(exact|quote|quoted|section|document|pdf|file|spec|read|detail|in depth|deep dive|requirement)\b/i.test(
    question
  );
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);
}
