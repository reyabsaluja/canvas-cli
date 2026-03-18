import { CanvasClient } from "../canvas/client.js";
import { loadConfig } from "../config/env.js";
import { normalizeCourse } from "../domain/normalize.js";
import { matchCourses } from "../domain/matching.js";
import { ingestCourse } from "../ingest/ingest-course.js";
import {
  renderIngestionSummary,
  renderIngestionJson,
} from "../format/render-ingestion-summary.js";
import { handleError } from "../errors.js";
import chalk from "chalk";

interface IngestOptions {
  refresh?: boolean;
  json?: boolean;
}

export async function ingestCourseCommand(
  courseQuery: string,
  options: IngestOptions
): Promise<void> {
  const config = loadConfig();
  const client = new CanvasClient(config);

  // Fetch and normalize courses
  let rawCourses;
  try {
    rawCourses = await client.getCourses();
  } catch (err) {
    handleError(err);
    return;
  }

  const courses = rawCourses.map(normalizeCourse);

  // Match course
  const matches = matchCourses(courseQuery, courses);

  if (matches.length === 0) {
    console.error(
      `No course matching "${courseQuery}".\nUse ${chalk.dim("canvas-cli courses")} to see available courses.`
    );
    process.exit(1);
  }

  if (matches.length > 1) {
    console.error(`Multiple courses match "${courseQuery}":\n`);
    for (const c of matches) {
      console.error(`  ${chalk.bold(c.courseCode)}  ${c.name}`);
    }
    console.error(`\nBe more specific or use the full course code.`);
    process.exit(1);
  }

  const course = matches[0];

  // Run ingestion
  if (!options.json) {
    console.log(`\nIngesting ${chalk.bold(course.name)}...\n`);
  }

  let result;
  try {
    result = await ingestCourse(course, client, config, {
      refresh: options.refresh ?? false,
    });
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Ingestion failed: ${err.message}`);
    } else {
      console.error("Ingestion failed.");
    }
    process.exit(1);
  }

  // Output
  if (options.json) {
    console.log(JSON.stringify(renderIngestionJson(result), null, 2));
  } else {
    console.log(renderIngestionSummary(result));
  }
}
