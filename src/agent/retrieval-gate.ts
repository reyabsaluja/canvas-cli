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
import { hasReadArtifact } from "./run-state.js";
import { searchWorkspaceKnowledge } from "../tui/workspace-knowledge.js";

const MAX_MEMORY_REUSE_ARTIFACTS = 3;
const MIN_MEMORY_REUSE_SCORE = 12;

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

  const eagerDiscoveredArtifactId = selectReusableDiscoveredArtifactId(
    question,
    input.runState
  );
  if (eagerDiscoveredArtifactId) {
    return {
      action: "read_artifact",
      reason: "already_discovered_relevant_artifact",
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

  const unreadRetryableMatches = filterRetryableArtifactMatches(
    promotedMatches,
    input.runState
  );
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
  return /\b(open|launch|pull up|download|list files|show files|search course)\b/i.test(question);
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

function selectReusableMemoryArtifactIds(
  question: string,
  runState: RunState
): string[] {
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

function selectReusableDiscoveredArtifactId(
  question: string,
  runState: RunState
): string | null {
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
    const artifact = candidate.observation.artifacts.find(
      (entry) =>
        !hasReadArtifact(runState, entry.artifactId) &&
        !hasRecentFailedArtifactRead(runState, entry.artifactId)
    );
    if (artifact) {
      return artifact.artifactId;
    }
  }

  return null;
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
