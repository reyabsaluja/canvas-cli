import { CanvasClient } from "../canvas/client.js";
import {
  normalizeAssignment,
  normalizeAssignmentDetail,
  normalizeCourse,
} from "./normalize.js";
import { matchAssignments, matchCourses } from "./matching.js";
import { handleError } from "../errors.js";
import type { Assignment, AssignmentDetail, Course } from "./models.js";
import type { CanvasCourse } from "../canvas/types.js";
import chalk from "chalk";

export interface ResolveOptions {
  course?: string;
  id?: string;
}

export interface ResolvedAssignment {
  detail: AssignmentDetail;
  course: Course;
}

/**
 * Shared assignment resolution logic used by both `show` and `do`.
 * Resolves a single assignment by name (or --id), optionally scoped to a course.
 * Exits with a helpful error on no match or ambiguity.
 */
export async function resolveAssignment(
  name: string,
  options: ResolveOptions,
  client: CanvasClient,
  rawCourses: CanvasCourse[]
): Promise<ResolvedAssignment> {
  const allCourses = rawCourses.map(normalizeCourse);
  let targetCourses = allCourses.filter((c) => c.isCurrent);

  // Resolve --course if provided
  if (options.course) {
    const matches = matchCourses(options.course, targetCourses);

    if (matches.length === 0) {
      const allMatches = matchCourses(options.course, allCourses);
      if (allMatches.length > 0) {
        console.error(
          `No current course matching "${options.course}". Found in past courses — try without course filter or check the course name.`
        );
      } else {
        console.error(`No course matching "${options.course}" found.`);
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
    console.error("No current courses found.");
    process.exit(1);
  }

  // If --id is provided, fetch directly
  if (options.id) {
    const assignmentId = parseInt(options.id, 10);
    if (isNaN(assignmentId)) {
      console.error(`Invalid assignment ID: "${options.id}"`);
      process.exit(1);
    }

    for (const course of targetCourses) {
      try {
        const raw = await client.getAssignmentDetail(course.id, assignmentId);
        const detail = normalizeAssignmentDetail(raw, course.name);
        return { detail, course };
      } catch {
        continue;
      }
    }

    console.error(
      `Assignment with ID ${assignmentId} not found in ${options.course ? `course "${options.course}"` : "your current courses"}.`
    );
    process.exit(1);
  }

  // Name-based resolution
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

  const matches = matchAssignments(name, allAssignments);

  if (matches.length === 0) {
    console.error(`No assignment matching "${name}" found.`);
    console.error(
      chalk.dim(
        options.course
          ? `Try: canvas-cli assignments --course ${options.course}`
          : "Try: canvas-cli assignments"
      )
    );
    process.exit(1);
  }

  if (matches.length > 1) {
    console.error(`Multiple assignments match "${name}":\n`);
    for (const m of matches) {
      console.error(`  - ${m.name}  ${chalk.dim(m.courseName)}`);
    }
    console.error(
      chalk.dim("\nUse --course to narrow, or use a more specific name.")
    );
    process.exit(1);
  }

  const match = matches[0];
  const raw = await client.getAssignmentDetail(match.courseId, match.id);
  const detail = normalizeAssignmentDetail(raw, match.courseName);

  // Find the course object
  const course = targetCourses.find((c) => c.id === match.courseId) ??
    allCourses.find((c) => c.id === match.courseId)!;

  return { detail, course };
}
