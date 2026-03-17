import type { Assignment, Course } from "./models.js";

/**
 * Match a user-provided query against courses.
 * Checks course code and name (case-insensitive).
 * Returns exact matches first, then substring matches.
 */
export function matchCourses(query: string, courses: Course[]): Course[] {
  const q = query.toLowerCase().trim();

  const codeExact = courses.filter(
    (c) => c.courseCode.toLowerCase() === q
  );
  if (codeExact.length === 1) return codeExact;

  const nameExact = courses.filter(
    (c) => c.name.toLowerCase() === q
  );
  if (nameExact.length === 1) return nameExact;

  const substring = courses.filter(
    (c) =>
      c.courseCode.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q)
  );

  return substring;
}

/**
 * Match a user-provided query against assignments.
 * Case-insensitive. Tries exact match first, then substring.
 * Returns all matches for the caller to handle disambiguation.
 */
export function matchAssignments(
  query: string,
  assignments: Assignment[]
): Assignment[] {
  const q = query.toLowerCase().trim();

  // Exact name match
  const exact = assignments.filter((a) => a.name.toLowerCase() === q);
  if (exact.length >= 1) return exact;

  // Substring match
  return assignments.filter((a) => a.name.toLowerCase().includes(q));
}
