import type { Observation } from "./observation.js";
import { isGroundedContentObservation } from "./observation-relevance.js";

const MAX_RUN_STATE_OBSERVATIONS = 24;
const MAX_RECENT_TRANSIENT_OBSERVATIONS = 8;

export interface RunState {
  // Arrays keep the state JSON-serializable inside existing chat transcripts.
  observations: Observation[];
  readArtifactIds: string[];
  stepCount: number;
}

export function createEmptyRunState(): RunState {
  return {
    observations: [],
    readArtifactIds: [],
    stepCount: 0,
  };
}

export function appendObservation(
  runState: RunState,
  observation: Observation
): void {
  runState.stepCount += 1;
  if (isDuplicateObservation(runState.observations, observation)) {
    return;
  }
  runState.observations.push(observation);
  compactRunState(runState);
}

export function hasReadArtifact(
  runState: RunState,
  artifactId: string
): boolean {
  return runState.readArtifactIds.includes(artifactId);
}

export function hydrateRunState(
  messages: Array<{ role: string; observation?: Observation }>
): RunState {
  const runState = createEmptyRunState();
  for (const message of messages) {
    if (message.role !== "tool" || !message.observation) {
      continue;
    }
    appendObservation(runState, message.observation);
  }
  compactRunState(runState);
  return runState;
}

export function compactRunState(runState: RunState): void {
  if (runState.observations.length === 0) {
    runState.readArtifactIds = [];
    return;
  }

  const selected = new Set<number>();
  const groundedArtifacts = new Set<string>();

  for (
    let index = runState.observations.length - 1;
    index >= 0 && selected.size < MAX_RECENT_TRANSIENT_OBSERVATIONS;
    index -= 1
  ) {
    selected.add(index);
  }

  for (let index = runState.observations.length - 1; index >= 0; index -= 1) {
    if (selected.size >= MAX_RUN_STATE_OBSERVATIONS) {
      break;
    }

    const observation = runState.observations[index]!;
    if (!isGroundedContentObservation(observation)) {
      continue;
    }

    let shouldKeep = false;
    for (const artifact of observation.artifacts) {
      if (!groundedArtifacts.has(artifact.artifactId)) {
        groundedArtifacts.add(artifact.artifactId);
        shouldKeep = true;
      }
    }

    if (shouldKeep) {
      selected.add(index);
    }
  }

  runState.observations = [...selected]
    .sort((left, right) => left - right)
    .map((index) => runState.observations[index]!);

  runState.readArtifactIds = collectRememberedArtifactIds(runState.observations);
}

function shouldRememberReadArtifact(observation: Observation): boolean {
  return isGroundedContentObservation(observation);
}

function isDuplicateObservation(
  observations: Observation[],
  nextObservation: Observation
): boolean {
  return (
    isDuplicateGroundedObservation(observations, nextObservation) ||
    isDuplicateArtifactFailureObservation(observations, nextObservation)
  );
}

function isDuplicateGroundedObservation(
  observations: Observation[],
  nextObservation: Observation
): boolean {
  if (!shouldRememberReadArtifact(nextObservation)) {
    return false;
  }

  const nextArtifactKey = buildObservationArtifactKey(nextObservation);
  const nextContent = normalizeObservationContent(nextObservation.content);
  if (!nextArtifactKey || !nextContent) {
    return false;
  }

  return observations.some((observation) => {
    if (!shouldRememberReadArtifact(observation)) {
      return false;
    }
    return (
      buildObservationArtifactKey(observation) === nextArtifactKey &&
      normalizeObservationContent(observation.content) === nextContent
    );
  });
}

function isDuplicateArtifactFailureObservation(
  observations: Observation[],
  nextObservation: Observation
): boolean {
  if (!shouldRememberArtifactFailure(nextObservation)) {
    return false;
  }

  const nextArtifactKey = buildObservationArtifactKey(nextObservation);
  const nextSummary = normalizeObservationSummary(nextObservation.summary);
  if (!nextArtifactKey || !nextSummary) {
    return false;
  }

  return observations.some((observation) => {
    if (!shouldRememberArtifactFailure(observation)) {
      return false;
    }
    return (
      observation.status === nextObservation.status &&
      observation.tool === nextObservation.tool &&
      buildObservationArtifactKey(observation) === nextArtifactKey &&
      normalizeObservationSummary(observation.summary) === nextSummary
    );
  });
}

function shouldRememberArtifactFailure(observation: Observation): boolean {
  return (
    observation.status !== "ok" &&
    observation.artifacts.length > 0 &&
    (observation.tool === "read_file" ||
      observation.tool === "download_course_file")
  );
}

function buildObservationArtifactKey(observation: Observation): string {
  return [...new Set(
    observation.artifacts
      .map((artifact) => artifact.artifactId.trim())
      .filter((artifactId) => artifactId.length > 0)
  )]
    .sort()
    .join("|");
}

function normalizeObservationContent(content?: string): string {
  return (content ?? "").replace(/\s+/g, " ").trim();
}

function normalizeObservationSummary(summary?: string): string {
  return (summary ?? "").replace(/\s+/g, " ").trim();
}

function collectRememberedArtifactIds(observations: Observation[]): string[] {
  const remembered: string[] = [];
  for (const observation of observations) {
    if (!shouldRememberReadArtifact(observation)) {
      continue;
    }
    for (const artifact of observation.artifacts) {
      if (!remembered.includes(artifact.artifactId)) {
        remembered.push(artifact.artifactId);
      }
    }
  }
  return remembered;
}
