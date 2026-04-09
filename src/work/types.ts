import type { RunState } from "../agent/run-state.js";

/**
 * Structured result of the agent's investigation and synthesis.
 * This is the primary artifact produced by `canvas-cli work`.
 */
export interface AssignmentWorkup {
  /** What this assignment is really about. */
  overview: string;
  /** Concrete things the student needs to submit/build/write. */
  deliverables: string[];
  /** Format, technical, timing, rubric, or submission constraints. */
  constraints: string[];
  /** Most important files, pages, modules, docs. */
  relevantResources: RelevantResource[];
  /** What the student should read first, second, third. */
  recommendedReadOrder: string[];
  /** Practical first-pass plan for approaching the assignment. */
  actionPlan: ActionStep[];
  /** What remains unclear or conflicting. */
  uncertainties: string[];
  /** Due date found from syllabus if Canvas didn't have one. */
  dueDate: string | null;
  /** Overall confidence. */
  confidence: "high" | "medium" | "low";
  /** Map conclusions back to evidence sources. */
  sourceTrace: SourceTraceEntry[];
}

export interface RelevantResource {
  title: string;
  type: "pdf" | "page" | "module_item" | "file" | "syllabus" | "assignment_description";
  location: string;
  why: string;
}

export interface ActionStep {
  step: number;
  action: string;
  detail: string | null;
}

export interface SourceTraceEntry {
  conclusion: string;
  source: string;
}

/**
 * State accumulated during the investigation loop.
 */
export interface InvestigationState {
  /** The target assignment name. */
  assignmentName: string;
  /** Course name. */
  courseName: string;
  /** Sources the agent has visited/read. */
  visitedSources: string[];
  /** Text extracted from documents during investigation. */
  extractedTexts: Map<string, string>;
  /** Notes the agent has gathered. */
  evidenceNotes: string[];
  /** Number of tool calls made. */
  toolCallCount: number;
  /** Structured observations from the investigation loop. */
  runState: RunState;
  /** Evidence that a real instruction document was read. */
  primaryInstructionSourceIds: string[];
  /** Evidence that a due-date source was checked. */
  dueDateSourceIds: string[];
}

export interface WorkVerificationResult {
  ok: boolean;
  missing: Array<"primary_instruction" | "due_date_source">;
  confidence: "high" | "medium" | "low";
}

/**
 * Result of the full work pipeline.
 */
export interface WorkResult {
  workup: AssignmentWorkup;
  workspacePath: string;
  filesWritten: string[];
  filesSkipped: string[];
  resourcesCopied: string[];
  documentsExtracted: string[];
}
