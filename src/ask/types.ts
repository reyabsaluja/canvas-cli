/**
 * Structured answer to a workspace question.
 */
export interface WorkspaceAnswer {
  question: string;
  answer: string;
  bulletPoints: string[];
  sources: AnswerSource[];
  confidence: "high" | "medium" | "low";
}

export interface AnswerSource {
  title: string;
  kind: string;
  excerpt: string | null;
}

/**
 * A chunk of workspace content used for retrieval.
 */
export interface ContentChunk {
  /** Source file name (e.g., "assignment.md", "extracted/Lab4.txt"). */
  source: string;
  /** Section heading or label within the file. */
  section: string;
  /** The text content. */
  text: string;
  /** Kind for display: "workup", "plan", "notes", "extracted", "assignment". */
  kind: string;
}

/**
 * Loaded workspace data.
 */
export interface LoadedWorkspace {
  path: string;
  sessionSlug: string;
  assignmentId: number | null;
  assignmentName: string;
  courseId: number | null;
  courseName: string;
  courseCode: string | null;
  preparedAt: string | null;
  workspaceState: string | null;
  assignmentMd: string | null;
  planMd: string | null;
  notesMd: string | null;
  workupJson: Record<string, unknown> | null;
  extractedFiles: Array<{ name: string; content: string }>;
}
