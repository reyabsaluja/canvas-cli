import type { Assignment } from "./models.js";

export interface AssignmentFilterOptions {
  all?: boolean;
  includeSubmitted?: boolean;
  includeNoDueDate?: boolean;
}

/**
 * Filter assignments to only what's relevant right now.
 *
 * Default behavior:
 * - Include upcoming assignments (due in the future)
 * - Include overdue assignments from the last 14 days (still actionable)
 * - Exclude submitted assignments
 * - Exclude assignments with no due date
 *
 * All of this is overridable via flags.
 */
export function filterRelevantAssignments(
  assignments: Assignment[],
  options: AssignmentFilterOptions = {}
): Assignment[] {
  if (options.all) return assignments;

  const now = new Date();
  // Only show overdue items from the last 14 days — older ones are stale
  const overdueCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  return assignments.filter((a) => {
    // Submitted: hide unless explicitly requested
    if (a.submitted && !options.includeSubmitted) return false;

    // No due date: hide unless explicitly requested
    if (a.status === "no_date" && !options.includeNoDueDate) return false;

    // Overdue: only include if recent (within 14 days)
    if (a.status === "overdue" && a.dueAt && a.dueAt < overdueCutoff) {
      return false;
    }

    return true;
  });
}
