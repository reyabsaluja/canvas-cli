import type { Assignment } from "./models.js";

/**
 * Sort assignments by urgency:
 * 1. Overdue (nearest due date first — most recently overdue at top)
 * 2. Upcoming (nearest due date first)
 * 3. No due date
 * 4. Submitted
 *
 * Ties broken by name for determinism.
 */
export function sortByUrgency(assignments: Assignment[]): Assignment[] {
  return [...assignments].sort((a, b) => {
    const pa = statusPriority(a);
    const pb = statusPriority(b);
    if (pa !== pb) return pa - pb;

    if (a.dueAt && b.dueAt) {
      const diff = a.dueAt.getTime() - b.dueAt.getTime();
      if (diff !== 0) return diff;
    } else if (a.dueAt && !b.dueAt) {
      return -1;
    } else if (!a.dueAt && b.dueAt) {
      return 1;
    }

    return a.name.localeCompare(b.name);
  });
}

function statusPriority(a: Assignment): number {
  if (a.status === "overdue") return 0;
  if (a.status === "upcoming") return 1;
  if (a.status === "no_date") return 2;
  return 3;
}
