import type { CanvasCourse } from "../canvas/types.js";

/**
 * Determine whether a Canvas course is "current/relevant".
 *
 * Heuristics (conservative — when in doubt, include):
 * 1. Workflow state: exclude if "completed" or "deleted"
 * 2. Enrollment state: exclude if all enrollments are "completed" or "inactive"
 * 3. Term end date: exclude if term ended more than 30 days ago
 * 4. Course end date: exclude if course ended more than 30 days ago
 *
 * Users can override with --all to see everything.
 */
export function isCourseRelevant(raw: CanvasCourse): boolean {
  // Concluded or deleted courses are not relevant
  if (raw.workflow_state === "completed" || raw.workflow_state === "deleted") {
    return false;
  }

  // If all enrollments are completed/inactive, the course is done
  if (raw.enrollments && raw.enrollments.length > 0) {
    const allDone = raw.enrollments.every(
      (e) => e.enrollment_state === "completed" || e.enrollment_state === "inactive"
    );
    if (allDone) return false;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Check term end date
  if (raw.term?.end_at) {
    const termEnd = new Date(raw.term.end_at);
    if (termEnd < cutoff) return false;
  }

  // Check course-level end date
  if (raw.end_at) {
    const courseEnd = new Date(raw.end_at);
    if (courseEnd < cutoff) return false;
  }

  return true;
}
