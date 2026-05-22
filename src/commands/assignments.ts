import { CanvasClient } from "../canvas/client.js";
import { loadConfig } from "../config/env.js";
import { normalizeAssignment, normalizeCourse } from "../domain/normalize.js";
import { filterRelevantAssignments } from "../domain/assignment-relevance.js";
import { matchCourses } from "../domain/matching.js";
import { sortByUrgency } from "../domain/sorting.js";
import { renderAssignments } from "../format/render-assignments.js";
import { handleError } from "../errors.js";
import { loadCourseCache } from "../enrich/cache-loader.js";
import { enrichAssignment } from "../enrich/enrich-assignment.js";
import type { Assignment, Course } from "../domain/models.js";
import type { EnrichedAssignment } from "../enrich/types.js";
import chalk from "chalk";

interface AssignmentsOptions {
  course?: string;
  all?: boolean;
  includeSubmitted?: boolean;
  includeNoDueDate?: boolean;
  json?: boolean;
}

export async function assignmentsCommand(
  options: AssignmentsOptions
): Promise<void> {
  const config = loadConfig();
  const client = new CanvasClient(config);

  let rawCourses;
  try {
    rawCourses = await client.getCourses();
  } catch (err) {
    handleError(err);
  }

  const allCourses = rawCourses.map(normalizeCourse);

  // Default to current courses unless --all
  let targetCourses = options.all
    ? allCourses
    : allCourses.filter((c) => c.isCurrent);

  // If --course is specified, narrow to matching course(s)
  if (options.course) {
    const matches = matchCourses(options.course, targetCourses);

    if (matches.length === 0) {
      console.error(
        `No course matching "${options.course}" found among ${options.all ? "all" : "current"} courses.`
      );
      if (!options.all) {
        console.error(chalk.dim("Try --all to search past courses too."));
      }
      process.exit(1);
    }

    if (matches.length > 1) {
      console.error(`Multiple courses match "${options.course}":`);
      for (const m of matches) {
        console.error(`  - ${m.courseCode}  ${m.name}`);
      }
      console.error("\nPlease be more specific.");
      process.exit(1);
    }

    targetCourses = matches;
  }

  if (targetCourses.length === 0) {
    console.log("No current courses found. Try --all to include past courses.");
    return;
  }

  // Fetch assignments for target courses concurrently
  const allAssignments: Assignment[] = [];
  const results = await Promise.allSettled(
    targetCourses.map(async (course) => {
      const raw = await client.getAssignments(course.id);
      return raw.map((a) => normalizeAssignment(a, course.name));
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      allAssignments.push(...result.value);
    }
  }

  // Apply relevance filtering
  const filtered = filterRelevantAssignments(allAssignments, {
    all: options.all,
    includeSubmitted: options.includeSubmitted,
    includeNoDueDate: options.includeNoDueDate,
  });

  const sorted = sortByUrgency(filtered);

  // Try to enrich with course caches
  const enriched = await enrichAll(sorted, targetCourses);

  if (options.json) {
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }

  if (sorted.length === 0) {
    const hint = options.all
      ? "No assignments found."
      : "No upcoming assignments. Try --all or --include-submitted for more.";
    console.log(chalk.dim("\n" + hint + "\n"));
    return;
  }

  // Group by course when showing multiple courses, flat when scoped to one
  const groupByCourse = !options.course;
  console.log(renderAssignments(enriched, { groupByCourse }));
}

/**
 * Enrich assignments with course cache data where available.
 * Falls back gracefully to unenriched assignments if no cache exists.
 */
async function enrichAll(
  assignments: Assignment[],
  courses: Course[]
): Promise<(Assignment | EnrichedAssignment)[]> {
  // Build a map of courseId → Course for lookup
  const courseMap = new Map<number, Course>();
  for (const c of courses) {
    courseMap.set(c.id, c);
  }

  // Load caches for all relevant courses (deduplicated)
  const courseIds = [...new Set(assignments.map((a) => a.courseId))];
  const cacheMap = new Map<number, Awaited<ReturnType<typeof loadCourseCache>>>();

  await Promise.all(
    courseIds.map(async (courseId) => {
      const course = courseMap.get(courseId);
      if (!course) return;
      const cache = await loadCourseCache(course.courseCode, courseId);
      cacheMap.set(courseId, cache);
    })
  );

  return assignments.map((a) => {
    const cache = cacheMap.get(a.courseId);
    if (!cache) return a;
    return enrichAssignment(a, cache);
  });
}
