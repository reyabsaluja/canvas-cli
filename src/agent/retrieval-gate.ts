import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { RunState } from "./run-state.js";
import {
  asksForDirectDocumentReading,
  workupExplicitlySupportsQuestion,
} from "./workup-coverage.js";
import {
  isGroundedContentObservation,
  scoreObservationRelevance,
} from "./observation-relevance.js";
import { questionNeedsMultipleSources } from "./question-intent.js";
import { hasReadArtifact } from "./run-state.js";
import { searchWorkspaceKnowledge } from "../tui/workspace-knowledge.js";
import {
  loadArtifactIndex,
  readArtifactContent,
  type ArtifactIndex,
} from "../knowledge/artifact-index.js";

const MAX_MEMORY_REUSE_ARTIFACTS = 3;
const MIN_MEMORY_REUSE_SCORE = 12;
const EXPLICIT_TOOL_REQUEST_RE =
  /\b(open|launch|pull up|download|list files|show files|search course)\b/i;
const COURSE_COMMUNICATION_INTENT_RE =
  /\bannouncements?\b|\bdiscussions\b|\bdiscussion\s+(?:topics?|threads?|boards?|posts?)\b|\bthreads?\b|\breplies\b/i;
const LECTURE_INTENT_RE =
  /\b(?:lectures?|lec|recordings?|slides?)\b/i;
const COURSE_WORKLOAD_INTENT_RE =
  /\b(?:upcoming work|what'?s due|what is due|due (?:today|tomorrow|this week|next week|soon)|list assignments?|show assignments?|other assignments?|all assignments?)\b/i;

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
  const needsMultipleSources = questionNeedsMultipleSources(question);
  if (!question) {
    return { action: "let_model_decide", reason: "empty_question" };
  }

  if (shouldBypassGate(question)) {
    return { action: "let_model_decide", reason: "explicit_tool_request" };
  }

  const freshness = createCurrentArtifactFreshnessChecker(
    input.loaded,
    input.cache
  );

  const reusableMemoryArtifactIds = await selectReusableMemoryArtifactIds(
    question,
    input.runState,
    freshness
  );
  const eagerDiscoveredArtifactId = await selectReusableDiscoveredArtifactId(
    question,
    input.runState,
    freshness
  );

  if (needsMultipleSources && eagerDiscoveredArtifactId) {
    return {
      action: "read_artifact",
      reason:
        reusableMemoryArtifactIds.length > 0
          ? "comparison_question_needs_second_source"
          : "already_discovered_relevant_artifact",
      artifactId: eagerDiscoveredArtifactId,
    };
  }

  if (workupLikelyCoversQuestion(input.loaded, question)) {
    return { action: "answer_from_workup", reason: "covered_by_workup" };
  }

  if (
    reusableMemoryArtifactIds.length > 0 &&
    (!needsMultipleSources || reusableMemoryArtifactIds.length > 1)
  ) {
    return {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: reusableMemoryArtifactIds,
    };
  }

  if (eagerDiscoveredArtifactId) {
    return {
      action: "read_artifact",
      reason:
        needsMultipleSources && reusableMemoryArtifactIds.length > 0
          ? "comparison_question_needs_second_source"
          : "already_discovered_relevant_artifact",
      artifactId: eagerDiscoveredArtifactId,
    };
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
    return { action: "let_model_decide", reason: "weak_knowledge_match" };
  }

  const reusableArtifactIds = await selectReusableReadArtifactIds(
    question,
    promotedMatches,
    input.runState,
    freshness
  );

  if (
    reusableArtifactIds.length > 0 &&
    (!needsMultipleSources || reusableArtifactIds.length > 1)
  ) {
    return {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: reusableArtifactIds,
    };
  }

  const unreadRetryableMatches = filterRetryableArtifactMatches(
    promotedMatches,
    input.runState
  );
  if (
    needsMultipleSources &&
    unreadRetryableMatches.length > 0 &&
    (reusableMemoryArtifactIds.length > 0 || reusableArtifactIds.length > 0)
  ) {
    const complementaryMatch = selectPreferredWorkspaceMatch(
      question,
      unreadRetryableMatches
    );
    if (complementaryMatch) {
      return {
        action: "read_artifact",
        reason: "comparison_question_needs_second_source",
        artifactId: complementaryMatch.artifact.id,
      };
    }
  }

  if (reusableMemoryArtifactIds.length > 0) {
    return {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: reusableMemoryArtifactIds,
    };
  }

  if (reusableArtifactIds.length > 0) {
    return {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: reusableArtifactIds,
    };
  }

  const topMatch = selectPreferredWorkspaceMatch(question, unreadRetryableMatches);
  if (!topMatch) {
    return { action: "let_model_decide", reason: "recent_artifact_read_failed" };
  }

  return {
    action: "read_artifact",
    reason: "top_knowledge_match_needs_read",
    artifactId: topMatch.artifact.id,
  };
}

function shouldBypassGate(question: string): boolean {
  return (
    EXPLICIT_TOOL_REQUEST_RE.test(question) ||
    COURSE_COMMUNICATION_INTENT_RE.test(question) ||
    LECTURE_INTENT_RE.test(question) ||
    COURSE_WORKLOAD_INTENT_RE.test(question)
  );
}

function workupLikelyCoversQuestion(
  loaded: LoadedWorkspace,
  question: string
): boolean {
  if (asksForDirectDocumentReading(question)) {
    return false;
  }

  return workupExplicitlySupportsQuestion(question, loaded.workupJson);
}

function shouldPromoteTopMatch(question: string, score: number): boolean {
  if (asksForDirectDocumentReading(question)) {
    return score > 0;
  }
  return score >= 8;
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

async function selectReusableReadArtifactIds<
  T extends { artifact: { id: string; kind: string }; score: number }
>(
  question: string,
  matches: T[],
  runState: RunState,
  freshness: CurrentArtifactFreshnessChecker
): Promise<string[]> {
  const reusableMatches: T[] = [];
  for (const match of matches) {
    if (
      hasReadArtifact(runState, match.artifact.id) &&
      (await hasFreshReadArtifact(runState, match.artifact.id, freshness))
    ) {
      reusableMatches.push(match);
    }
  }
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

function filterRetryableArtifactMatches<
  T extends { artifact: { id: string } }
>(
  matches: T[],
  runState: RunState
): T[] {
  return matches.filter(
    (match) => !hasRecentFailedArtifactRead(runState, match.artifact.id)
  );
}

async function selectReusableMemoryArtifactIds(
  question: string,
  runState: RunState,
  freshness: CurrentArtifactFreshnessChecker
): Promise<string[]> {
  const scoredArtifacts = new Map<string, { score: number; observationIndex: number }>();

  for (let index = runState.observations.length - 1; index >= 0; index -= 1) {
    const observation = runState.observations[index]!;
    if (!isGroundedContentObservation(observation)) {
      continue;
    }

    const score = scoreObservationRelevance(question, observation);
    if (score < MIN_MEMORY_REUSE_SCORE) {
      continue;
    }

    for (const artifact of observation.artifacts) {
      if (
        !(await isObservationArtifactFresh(
          artifact.artifactId,
          observation.content ?? "",
          freshness
        ))
      ) {
        continue;
      }
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

async function selectReusableDiscoveredArtifactId(
  question: string,
  runState: RunState,
  freshness: CurrentArtifactFreshnessChecker
): Promise<string | null> {
  const candidates = runState.observations
    .map((observation, index) => ({
      observation,
      index,
      score: scoreObservationRelevance(question, observation),
    }))
    .filter(
      (entry) =>
        entry.score >= MIN_MEMORY_REUSE_SCORE &&
        isArtifactDiscoveryObservation(entry.observation)
    )
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.index - left.index;
    });

  for (const candidate of candidates) {
    for (const artifact of candidate.observation.artifacts) {
      if (
        !(await hasFreshReadArtifact(runState, artifact.artifactId, freshness)) &&
        !hasRecentFailedArtifactRead(runState, artifact.artifactId)
      ) {
        return artifact.artifactId;
      }
    }
  }

  return null;
}

interface CurrentArtifactFreshnessChecker {
  getCurrentContent: (artifactId: string) => Promise<string | null | undefined>;
}

function createCurrentArtifactFreshnessChecker(
  loaded: LoadedWorkspace,
  cache: CourseCache | null
): CurrentArtifactFreshnessChecker {
  let indexPromise: Promise<ArtifactIndex> | null = null;
  const contentByArtifactId = new Map<string, Promise<string | null | undefined>>();

  const getIndex = (): Promise<ArtifactIndex> => {
    indexPromise ??= loadArtifactIndex({ workspace: loaded, cache });
    return indexPromise;
  };

  return {
    getCurrentContent(artifactId: string): Promise<string | null | undefined> {
      const trimmed = artifactId.trim();
      if (!trimmed) {
        return Promise.resolve(undefined);
      }
      let cached = contentByArtifactId.get(trimmed);
      if (!cached) {
        cached = getIndex().then(async (index) => {
          if (!index.artifactsById.has(trimmed)) {
            return undefined;
          }
          return (await readArtifactContent(index, trimmed)) ?? null;
        });
        contentByArtifactId.set(trimmed, cached);
      }
      return cached;
    },
  };
}

async function hasFreshReadArtifact(
  runState: RunState,
  artifactId: string,
  freshness: CurrentArtifactFreshnessChecker
): Promise<boolean> {
  if (!hasReadArtifact(runState, artifactId)) {
    return false;
  }

  for (let index = runState.observations.length - 1; index >= 0; index -= 1) {
    const observation = runState.observations[index]!;
    if (!isGroundedContentObservation(observation)) {
      continue;
    }
    if (!observation.artifacts.some((artifact) => artifact.artifactId === artifactId)) {
      continue;
    }
    if (
      await isObservationArtifactFresh(
        artifactId,
        observation.content ?? "",
        freshness
      )
    ) {
      return true;
    }
  }

  return false;
}

async function isObservationArtifactFresh(
  artifactId: string,
  observedContent: string,
  freshness: CurrentArtifactFreshnessChecker
): Promise<boolean> {
  const currentContent = await freshness.getCurrentContent(artifactId);
  if (currentContent === undefined) {
    return true;
  }
  if (currentContent === null) {
    return false;
  }
  return observedContentMatchesCurrent(observedContent, currentContent);
}

function observedContentMatchesCurrent(
  observedContent: string,
  currentContent: string
): boolean {
  const observedWasTruncated = /\n?\[\.\.\.truncated\]\s*$/i.test(observedContent);
  const observed = normalizeGroundedContent(
    observedContent.replace(/\n?\[\.\.\.truncated\]\s*$/i, "")
  );
  const current = normalizeGroundedContent(currentContent);
  if (!observed) {
    return false;
  }
  return observedWasTruncated
    ? current.startsWith(observed)
    : observed === current || current.includes(observed);
}

function normalizeGroundedContent(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isArtifactDiscoveryObservation(
  observation: RunState["observations"][number]
): boolean {
  return (
    observation.status === "ok" &&
    observation.artifacts.length > 0 &&
    !observation.content &&
    (observation.tool === "search_workspace" ||
      observation.tool === "search_course")
  );
}

function hasRecentFailedArtifactRead(
  runState: RunState,
  artifactId: string
): boolean {
  return runState.observations.some((observation) => {
    if (
      observation.status === "ok" ||
      (observation.tool !== "read_file" &&
        observation.tool !== "download_course_file")
    ) {
      return false;
    }

    return observation.artifacts.some(
      (artifact) => artifact.artifactId === artifactId
    );
  });
}
