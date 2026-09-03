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
  /** True when the read was cut off before the end of the document. */
  truncated?: boolean;
  /** Section labels the read did NOT include (only set on truncated reads). */
  omittedLabels?: string[];
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

export interface StepReflectionInput {
  /** 1-based index of the tool call that just completed within this turn. */
  step: number;
  /** Total tool calls the loop allows for this turn. */
  maxSteps: number;
  observation: Observation;
  /** True when the runtime served a cached result for a repeated call. */
  deduped?: boolean;
  /** Grounded (full-text) reads gathered so far in this turn. */
  groundedReadCount?: number;
  /** True when the question needs at least two grounded sources. */
  needsMultipleSources?: boolean;
}

/** Steps remaining at or below which the note tells the model to wrap up. */
export const STEP_REFLECTION_WRAP_UP_THRESHOLD = 3;

/**
 * Model-facing footer appended to every tool result inside the agent loop.
 *
 * Its job is to force a reflect-then-decide beat between tool calls: state the
 * step budget, classify what kind of evidence just arrived, and say what a
 * sensible next move looks like. It is never shown in the UI and never stored
 * in run-state, so it cannot leak into memory or citations.
 */
export function buildStepReflectionNote(input: StepReflectionInput): string {
  const remaining = Math.max(0, input.maxSteps - input.step);
  const lines: string[] = [
    `[Tool step ${input.step} of ${input.maxSteps}; ${remaining} remaining.`,
  ];

  if (input.deduped) {
    lines.push(
      "You already made this exact call this turn, so this is the same result. Do not call it again; choose a different tool or target."
    );
  }

  const grounded =
    input.observation.status === "ok" &&
    input.observation.artifacts.length > 0 &&
    typeof input.observation.content === "string" &&
    input.observation.content.trim().length > 0;
  const discovery =
    input.observation.status === "ok" &&
    !grounded &&
    input.observation.artifacts.length > 0;

  if (input.observation.status !== "ok") {
    lines.push(
      "Dead end. Do not retry the same target. Change tactics: reword or broaden the search, use list_files to see what actually exists, or switch source class (announcements via list_announcements, course pages via search_course, the syllabus or a sibling document via read_file)."
    );
  } else if (grounded) {
    lines.push(
      "This is full source text. Reflect before acting: which parts of the question does it answer, and which parts are still open? If it does not mention what was asked, that is a dead end too; read the next candidate or switch source class rather than concluding it is unspecified."
    );
  } else if (discovery) {
    lines.push(
      "These are candidate sources, not evidence. Pick the strongest match and read it in full (read_file, read_thread, or download_course_file) before answering."
    );
  } else {
    lines.push(
      "Reflect before acting: note what this told you and what the question still needs, then pick the tool that closes that gap."
    );
  }

  if (
    input.needsMultipleSources &&
    (input.groundedReadCount ?? 0) < 2
  ) {
    lines.push(
      `This question compares or checks for change across sources, and you have ${input.groundedReadCount ?? 0} grounded read(s) so far; read a second relevant source before concluding.`
    );
  }

  if (remaining === 0) {
    lines.push(
      "The tool budget is exhausted. Answer now with what you have, and say precisely which parts you could not confirm."
    );
  } else if (remaining <= STEP_REFLECTION_WRAP_UP_THRESHOLD) {
    lines.push(
      `Only ${remaining} tool call(s) remain. Spend them on the single most valuable read, then answer and state exactly what you could not confirm.`
    );
  } else {
    lines.push(
      "Do not stop because you have already used several tools; stop only when every part of the question is answered from something you actually read.]"
    );
    return lines.join(" ");
  }

  lines[lines.length - 1] = `${lines[lines.length - 1]}]`;
  return lines.join(" ");
}
