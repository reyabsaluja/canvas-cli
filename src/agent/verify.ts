import type { AnswerSource } from "../ask/types.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { Observation } from "./observation.js";
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
    input.observations
  );
  const sources = collectSources(
    input.question,
    input.observations,
    input.usedWorkup,
    input.loaded
  );
  const missing: string[] = [];
  const hasCitationCapableObservation = input.observations.some((observation) =>
    canObservationProduceCitation(observation)
  );

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
  const confidence = hasDirectReadInEvidence
    ? "high"
    : sources.length > 0
      ? input.usedWorkup && !workupSupportsQuestion
        ? "low"
        : "medium"
      : "low";

  return {
    ok: missing.length === 0,
    confidence,
    sources,
    missing,
  };
}

function collectSources(
  question: string,
  observations: Observation[],
  usedWorkup: boolean,
  loaded: LoadedWorkspace
): AnswerSource[] {
  const resolved: AnswerSource[] = [];
  const seen = new Set<string>();
  const citationObservations = selectCitationObservations(question, observations);

  for (const observation of citationObservations) {
    // Only successful tool observations count as evidence. Failed lookups like
    // missing_text/not_found should never create grounding-looking citations.
    if (observation.status !== "ok") {
      continue;
    }
    for (const artifact of observation.artifacts) {
      const key = `${artifact.kind}:${artifact.title}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      resolved.push({
        title: artifact.title,
        kind: artifact.kind,
        excerpt: artifact.excerpt ?? buildExcerpt(observation.content ?? observation.summary),
      });
    }
  }

  if (resolved.length === 0 && usedWorkup && loaded.workupJson) {
    const overview = (loaded.workupJson.overview as string | undefined) ?? null;
    resolved.push({
      title: "workup.json",
      kind: "workup",
      excerpt: overview ?? "Pre-loaded assignment workup context.",
    });
  }

  return resolved;
}

function selectCitationObservations(
  question: string,
  observations: Observation[]
): Observation[] {
  const relevantGrounded = selectRelevantGroundedObservations(question, observations);
  if (relevantGrounded.length > 0) {
    return relevantGrounded;
  }

  const relevant = selectRelevantCitationObservations(question, observations);
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
  observations: Observation[]
): Observation[] {
  return selectRelevantCitationObservations(
    question,
    observations.filter((observation) => isGroundedContentObservation(observation))
  );
}

function selectRelevantCitationObservations(
  question: string,
  observations: Observation[]
): Observation[] {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    return [];
  }

  return observations.filter(
    (observation) => scoreObservationRelevance(trimmedQuestion, observation) > 0
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
