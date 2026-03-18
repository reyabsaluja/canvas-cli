/**
 * Structured AI-generated assignment overview.
 * Grounded in provided context — the model synthesizes from real course data.
 */
export interface AssignmentRealOverview {
  /** Concise explanation of what this assignment is and what is expected. */
  overview: string;
  /** Concrete tasks or deliverables the student needs to complete. */
  likelyTasks: string[];
  /** Due date extracted from syllabus/schedule if Canvas due date is missing. */
  dueDate: string | null;
  /** Sources that informed this interpretation. */
  primarySources: string[];
  /** Actionable next steps if the model couldn't fully determine something. */
  nextSteps: string[];
  /** Overall confidence in this interpretation. */
  confidence: "high" | "medium" | "low";
}
