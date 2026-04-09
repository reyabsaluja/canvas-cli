import type { AnswerSource } from "../ask/types.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { Observation } from "./observation.js";

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
  const sources = collectSources(input.observations, input.usedWorkup, input.loaded);
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

  const hasDirectReadInEvidence = input.observations.some((observation) =>
    isGroundedContentObservation(observation)
  );
  const workupSupportsQuestion = !input.usedWorkup
    ? false
    : workupExplicitlySupportsQuestion(input.question, input.loaded);
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
  observations: Observation[],
  usedWorkup: boolean,
  loaded: LoadedWorkspace
): AnswerSource[] {
  const resolved: AnswerSource[] = [];
  const seen = new Set<string>();
  const citationObservations = selectCitationObservations(observations);

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
  observations: Observation[]
): Observation[] {
  const grounded = observations.filter((observation) =>
    isGroundedContentObservation(observation)
  );
  if (grounded.length > 0) {
    return grounded;
  }
  return observations;
}

function canObservationProduceCitation(observation: Observation): boolean {
  return observation.artifacts.length > 0;
}

function isGroundedContentObservation(observation: Observation): boolean {
  return (
    observation.status === "ok" &&
    observation.artifacts.length > 0 &&
    typeof observation.content === "string" &&
    observation.content.trim().length > 0
  );
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

function workupExplicitlySupportsQuestion(
  question: string,
  loaded: LoadedWorkspace
): boolean {
  const workup = loaded.workupJson;
  if (!workup) {
    return false;
  }

  if (isDueDateQuestion(question)) {
    return Boolean(getWorkupDueDate(workup));
  }

  if (/\b(deliverable|submit|submission|turn in|hand in)\b/i.test(question)) {
    return hasNonEmptyStringArray(workup.deliverables);
  }

  if (/\b(constraint|restriction|format|rubric|grading|policy|policies)\b/i.test(question)) {
    return hasNonEmptyStringArray(workup.constraints);
  }

  if (/\b(start|first|approach|read order|plan)\b/i.test(question)) {
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

  if (
    /\b(overvi?ew|summary|goal|purpose|expected|what is this assignment about|what is this about)\b/i.test(
      question
    )
  ) {
    return typeof workup.overview === "string" && workup.overview.trim().length > 0;
  }

  return false;
}

function isDueDateQuestion(question: string): boolean {
  return /\b(due|deadline)\b/i.test(question);
}

function getWorkupDueDate(workup: Record<string, unknown>): string | null {
  const dueDate = workup.dueDate ?? workup.due_date;
  return typeof dueDate === "string" && dueDate.trim().length > 0
    ? dueDate
    : null;
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
