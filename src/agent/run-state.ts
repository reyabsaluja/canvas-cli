import type { Observation } from "./observation.js";

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
  runState.observations.push(observation);
  runState.stepCount += 1;

  if (observation.tool !== "read_file" || observation.status !== "ok") {
    return;
  }

  for (const artifact of observation.artifacts) {
    if (!runState.readArtifactIds.includes(artifact.artifactId)) {
      runState.readArtifactIds.push(artifact.artifactId);
    }
  }
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
  return runState;
}
