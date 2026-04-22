/**
 * Structured answer to a workspace question.
 */
export interface WorkspaceAnswer {
  question: string;
  answer: string;
  bulletPoints: string[];
  sources: AnswerSource[];
  confidence: "high" | "medium" | "low";
  verificationNote?: string | null;
}

export interface AnswerSource {
  title: string;
  kind: string;
  section?: string | null;
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
  /** Short canonical excerpt from the shared knowledge store. */
  excerpt?: string;
  /** Kind for display: "workup", "plan", "notes", "extracted", "assignment". */
  kind: string;
  /** Shared artifact identifier from the knowledge store, when available. */
  artifactId?: string;
  /** Shared section identifier from the knowledge store, when available. */
  sectionId?: string;
  /** Precomputed search tokens from the knowledge store. */
  searchTokens?: string[];
  /** Retrieval weight hint from the knowledge store. */
  scoreBoost?: number;
  /** Shared-section relevance score for the current query, when available. */
  score?: number;
}

export interface ExtractedWorkspaceFile {
  name: string;
  relativePath: string;
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
  extractedFiles: ExtractedWorkspaceFile[];
  extractedFileCache?: Map<string, string>;
}
