import { CanvasClient } from "../canvas/client.js";
import { loadConfig } from "../config/env.js";
import { normalizeAssignment, normalizeCourse } from "../domain/normalize.js";
import { filterRelevantAssignments } from "../domain/assignment-relevance.js";
import { matchCourses } from "../domain/matching.js";
import { sortByUrgency } from "../domain/sorting.js";
import { renderAssignments } from "../format/renderAssignments.js";
import { handleError } from "../errors.js";
import type { Assignment } from "../domain/models.js";
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
    return;
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

  if (options.json) {
    console.log(JSON.stringify(sorted, null, 2));
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
  console.log(renderAssignments(sorted, { groupByCourse }));
}
