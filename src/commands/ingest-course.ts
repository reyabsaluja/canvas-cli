import { CanvasClient } from "../canvas/client.js";
import { getActiveProfile, loadConfig } from "../config/env.js";
import { readStoredConfig } from "../config/store.js";
import { normalizeCourse } from "../domain/normalize.js";
import { matchCourses } from "../domain/matching.js";
import { ingestCourse } from "../ingest/ingest-course.js";
import {
  renderIngestionSummary,
  renderIngestionJson,
} from "../format/render-ingestion-summary.js";
import { handleError, isAbortError } from "../errors.js";
import chalk from "chalk";

const USER_ABORT_EXIT_CODE = 130;

interface IngestOptions {
  refresh?: boolean;
  json?: boolean;
  /** commander sets this to false for `--no-feedback`; undefined/true means on. */
  feedback?: boolean;
}

/**
 * Grader feedback on the student's own submissions is captured by default;
 * `--no-feedback` on the command line or `"ingestSubmissionFeedback": false`
 * in the profile's config.json turns it off.
 */
export function resolveIncludeSubmissionFeedback(options: IngestOptions): boolean {
  if (options.feedback === false) return false;
  let stored: ReturnType<typeof readStoredConfig> = null;
  try {
    stored = readStoredConfig(getActiveProfile());
  } catch {
    stored = null;
  }
  return stored?.ingestSubmissionFeedback !== false;
}

export async function ingestCourseCommand(
  courseQuery: string,
  options: IngestOptions
): Promise<void> {
  const config = loadConfig();
  const client = new CanvasClient(config);

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Fetch and normalize courses
  let rawCourses;
  try {
    rawCourses = await client.getCourses();
  } catch (err) {
    handleError(err);
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
      includeSubmissionFeedback: resolveIncludeSubmissionFeedback(options),
      signal: ac.signal,
      onProgress: options.json
        ? null
        : (msg) => {
            process.stderr.write(`\r\x1b[K  ${chalk.dim(msg)}`);
          },
    });
  } catch (err) {
    if (!options.json) {
      process.stderr.write("\r\x1b[K");
    }
    if (isAbortError(err)) {
      console.error("Operation cancelled.");
      process.exit(USER_ABORT_EXIT_CODE);
    }
    if (err instanceof Error) {
      console.error(`Ingestion failed: ${err.message}`);
    } else {
      console.error("Ingestion failed.");
    }
    process.exit(1);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  // Clear progress line before output
  if (!options.json) {
    process.stderr.write("\r\x1b[K");
  }

  // Output
  if (options.json) {
    console.log(JSON.stringify(renderIngestionJson(result), null, 2));
  } else {
    console.log(renderIngestionSummary(result));
  }
}
