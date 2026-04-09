export type ObservationStatus =
  | "ok"
  | "not_found"
  | "missing_text"
  | "retryable_error"
  | "fatal_error";

export interface ArtifactRef {
  artifactId: string;
  title: string;
  kind: string;
  excerpt?: string | null;
  sectionIds?: string[];
}

export interface Observation {
  tool: string;
  status: ObservationStatus;
  summary: string;
  artifacts: ArtifactRef[];
  content?: string;
  errorCode?: string;
  retryable?: boolean;
}

export interface ToolExecutionResult {
  observation: Observation;
  modelText: string;
  uiText: string;
}
