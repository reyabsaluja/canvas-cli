import type { Observation } from "../../agent/observation.js";
import { questionNeedsMultipleSources } from "../../agent/question-intent.js";
import {
  isGroundedContentObservation,
  scoreObservationRelevance,
} from "../../agent/observation-relevance.js";

export function selectSupplementalEvidenceObservations(
  observations: Observation[],
  question?: string
): Observation[] {
  const allCandidates = observations.filter(canObservationSupportAnswerRecovery);
  if (allCandidates.length === 0) {
    return [];
  }

  const grounded = allCandidates.filter((observation) =>
    isGroundedContentObservation(observation)
  );
  const relevantGrounded = selectRelevantObservations(grounded, question, 3);
  if (relevantGrounded.length > 0) {
    return relevantGrounded;
  }

  const relevant = selectRelevantObservations(allCandidates, question, 3);
  if (relevant.length > 0) {
    return relevant;
  }

  const fallbackCandidates = grounded.length > 0 ? grounded : allCandidates;
  if (fallbackCandidates.length <= 3) {
    return fallbackCandidates;
  }

  return fallbackCandidates.slice(-3);
}

export function selectRelevantObservations(
  observations: Observation[],
  question: string | undefined,
  limit: number
): Observation[] {
  const trimmedQuestion = question?.trim();
  if (!trimmedQuestion) {
    return [];
  }

  const ranked = observations
    .map((observation, index) => ({
      observation,
      index,
      score: scoreObservationRelevance(trimmedQuestion, observation),
    }))
    .filter((entry) => entry.score > 0);

  if (ranked.length === 0) {
    return [];
  }

  return ranked
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.index - left.index;
    })
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.observation);
}

export function selectRelevantSearchBreadcrumbObservations(
  question: string,
  observations: Observation[],
  options?: {
    coveredArtifactIds?: Set<string>;
    failedArtifactIds?: Set<string>;
  }
): Observation[] {
  const coveredArtifactIds = options?.coveredArtifactIds ?? new Set<string>();
  const failedArtifactIds = options?.failedArtifactIds ?? new Set<string>();
  const viableCandidates = observations.filter(
    (observation) =>
      isSuccessfulSearchBreadcrumbObservation(observation) &&
      observation.artifacts.some(
        (artifact) =>
          !coveredArtifactIds.has(artifact.artifactId) &&
          !failedArtifactIds.has(artifact.artifactId)
      )
  );
  if (viableCandidates.length > 0) {
    return selectRelevantObservations(viableCandidates, question, 2);
  }

  if (failedArtifactIds.size === 0) {
    return [];
  }

  const fallbackCandidates = observations.filter(
    (observation) =>
      isSuccessfulSearchBreadcrumbObservation(observation) &&
      observation.artifacts.some(
        (artifact) => !coveredArtifactIds.has(artifact.artifactId)
      )
  );
  if (fallbackCandidates.length === 0) {
    return [];
  }
  return selectRelevantObservations(fallbackCandidates, question, 2);
}

export function selectRecoveryReadArtifactId(
  question: string,
  currentTurnObservations: Observation[],
  allObservations: Observation[] = currentTurnObservations
): string | null {
  const groundedCurrentTurn = selectRelevantObservations(
    currentTurnObservations.filter((observation) =>
      isGroundedContentObservation(observation)
    ),
    question,
    1
  );
  if (groundedCurrentTurn.length > 0) {
    return null;
  }

  const failedArtifactIds = collectFailedReadArtifactIds(allObservations);
  const breadcrumbs = selectRelevantSearchBreadcrumbObservations(
    question,
    currentTurnObservations,
    { failedArtifactIds }
  );

  for (const observation of breadcrumbs) {
    for (const artifact of observation.artifacts) {
      if (!failedArtifactIds.has(artifact.artifactId)) {
        return artifact.artifactId;
      }
    }
  }

  return null;
}

export function collectFailedReadArtifactIds(
  observations: Observation[]
): Set<string> {
  const artifactIds = new Set<string>();
  for (const observation of observations) {
    if (
      observation.status === "ok" ||
      (observation.tool !== "read_file" &&
        observation.tool !== "download_course_file")
    ) {
      continue;
    }
    for (const artifact of observation.artifacts) {
      artifactIds.add(artifact.artifactId);
    }
  }
  return artifactIds;
}

export function pruneSearchBreadcrumbArtifacts(
  observation: Observation,
  excludedArtifactIds: Set<string>
): Observation {
  if (
    excludedArtifactIds.size === 0 ||
    !isSuccessfulSearchBreadcrumbObservation(observation)
  ) {
    return observation;
  }

  const filteredArtifacts = observation.artifacts.filter(
    (artifact) => !excludedArtifactIds.has(artifact.artifactId)
  );
  if (
    filteredArtifacts.length === 0 ||
    filteredArtifacts.length === observation.artifacts.length
  ) {
    return observation;
  }

  return {
    ...observation,
    artifacts: filteredArtifacts,
  };
}

export function collectObservationArtifactIds(
  observations: Observation[]
): Set<string> {
  const artifactIds = new Set<string>();
  for (const observation of observations) {
    for (const artifact of observation.artifacts) {
      artifactIds.add(artifact.artifactId);
    }
  }
  return artifactIds;
}

export function resolveToolTurnVerificationObservations(
  observations: Observation[],
  observationStart: number,
  question?: string
): Observation[] {
  const currentTurn = observations.slice(observationStart);
  if (currentTurn.length === 0) {
    return selectSupplementalEvidenceObservations(observations, question);
  }

  const currentTurnGrounded = currentTurn.filter((observation) =>
    isGroundedContentObservation(observation)
  );
  if (
    currentTurnGrounded.length > 0 &&
    (!question ||
      selectRelevantObservations(currentTurnGrounded, question, 1).length > 0)
  ) {
    return currentTurn;
  }

  const priorSupport = selectSupplementalEvidenceObservations(
    observations.slice(0, observationStart),
    question
  );
  if (priorSupport.length === 0) {
    return currentTurn;
  }

  return [...priorSupport, ...currentTurn];
}

export function shouldRecoverFromToolLoop(
  answer: string,
  observations: Observation[]
): boolean {
  if (answer.trim().length > 0) {
    return false;
  }

  return observations.some(canObservationSupportAnswerRecovery);
}

export function shouldContinueToolLoopAfterGateRead(
  question: string,
  observation: Observation,
  allObservations: Observation[] = [observation]
): boolean {
  if (!isGroundedContentObservation(observation)) {
    return true;
  }

  if (!questionNeedsMultipleSources(question)) {
    return false;
  }

  const relevantGrounded = selectRelevantObservations(
    allObservations.filter((entry) => isGroundedContentObservation(entry)),
    question,
    2
  );
  return relevantGrounded.length < 2;
}

export function selectArtifactSupportObservations(
  observations: Observation[],
  artifactIds: string[]
): Observation[] {
  const uniqueArtifactIds = [...new Set(artifactIds)];
  const selected: Observation[] = [];

  for (const artifactId of uniqueArtifactIds) {
    const best = findBestObservationForArtifact(observations, artifactId);
    if (best) {
      selected.push(best);
    }
  }

  return selected;
}

/**
 * Final answer text for the turn. When the loop produced nothing, say so and,
 * if the caller passes the verification's `checkedSources` trail, name what
 * was checked so the student knows how far the search went.
 */
export function finalizeAnswerText(
  answer: string,
  missing: string[],
  checkedSources?: string | null
): string {
  const trimmed = answer.trim();
  if (!trimmed) {
    const trail = checkedSources?.trim();
    return trail
      ? `I wasn't able to find a clear answer after checking: ${trail}.`
      : "I wasn't able to find a clear answer.";
  }
  return trimmed;
}

function canObservationSupportAnswerRecovery(
  observation: Observation
): boolean {
  if (isGroundedContentObservation(observation)) {
    return true;
  }

  if (observation.status !== "ok") {
    return false;
  }

  return (
    observation.artifacts.length > 0 ||
    (typeof observation.content === "string" &&
      observation.content.trim().length > 0)
  );
}

function isSuccessfulSearchBreadcrumbObservation(
  observation: Observation
): boolean {
  return (
    observation.status === "ok" &&
    observation.artifacts.length > 0 &&
    !observation.content &&
    (observation.tool === "search_workspace" ||
      observation.tool === "search_course")
  );
}

function findBestObservationForArtifact(
  observations: Observation[],
  artifactId: string
): Observation | null {
  let fallback: Observation | null = null;

  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index]!;
    if (
      !observation.artifacts.some((artifact) => artifact.artifactId === artifactId)
    ) {
      continue;
    }

    if (!fallback) {
      fallback = observation;
    }

    if (isGroundedContentObservation(observation)) {
      return observation;
    }
  }

  return fallback;
}
