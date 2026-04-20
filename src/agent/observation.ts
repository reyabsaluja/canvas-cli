export type ObservationStatus =
  | "ok"
  | "not_found"
  | "missing_text"
  | "error";

export interface ArtifactRef {
  artifactId: string;
  title: string;
  kind: string;
  excerpt?: string | null;
  sectionIds?: string[];
  sectionLabel?: string | null;
}

export interface Observation {
  tool: string;
  status: ObservationStatus;
  summary: string;
  artifacts: ArtifactRef[];
  content?: string;
}

export interface ToolExecutionResult {
  observation: Observation;
  modelText: string;
  uiText: string;
}
