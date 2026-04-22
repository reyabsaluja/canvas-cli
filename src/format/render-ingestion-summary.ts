import chalk from "chalk";
import path from "node:path";
import type { IngestionResult } from "../ingest/types.js";

/**
 * Render a human-readable ingestion summary for terminal output.
 */
export function renderIngestionSummary(result: IngestionResult): string {
  const lines: string[] = [];
  const relativePath = path.relative(process.cwd(), result.coursePath);

  lines.push("");
  lines.push(chalk.bold.green("Course ingested"));
  lines.push("");
  lines.push(`  ${chalk.dim("Course")}  ${result.courseMeta.name}`);
  lines.push(`  ${chalk.dim("Code  ")}  ${result.courseMeta.courseCode}`);
  if (result.courseMeta.termName) {
    lines.push(`  ${chalk.dim("Term  ")}  ${result.courseMeta.termName}`);
  }
  lines.push(`  ${chalk.dim("Path  ")}  ${relativePath}`);

  // Counts
  const c = result.ingestion.counts;
  lines.push("");
  lines.push("Fetched:");
  lines.push(`  ${chalk.dim("-")} ${c.assignments} assignments`);
  lines.push(`  ${chalk.dim("-")} ${c.modules} modules`);
  lines.push(`  ${chalk.dim("-")} ${c.moduleItems} module items`);
  if (c.files > 0) {
    lines.push(`  ${chalk.dim("-")} ${c.files} files`);
  } else {
    lines.push(`  ${chalk.dim("-")} files ${chalk.dim("(API not accessible)")}`);
  }
  if (c.pages > 0) {
    lines.push(`  ${chalk.dim("-")} ${c.pages} pages`);
  } else {
    lines.push(`  ${chalk.dim("-")} pages ${chalk.dim("(API not accessible)")}`);
  }
  if ((result.announcements?.length ?? 0) > 0) {
    lines.push(
      `  ${chalk.dim("-")} ${result.announcements?.length ?? 0} announcements`
    );
  }
  if ((result.discussions?.length ?? 0) > 0) {
    lines.push(
      `  ${chalk.dim("-")} ${result.discussions?.length ?? 0} discussions`
    );
  }
  if ((result.externalLinks?.length ?? 0) > 0) {
    lines.push(
      `  ${chalk.dim("-")} ${result.externalLinks?.length ?? 0} external resources`
    );
  }

  // Syllabus candidates
  if (result.syllabusCandidates.length > 0) {
    lines.push("");
    lines.push("Likely syllabus sources:");
    for (const candidate of result.syllabusCandidates) {
      const conf =
        candidate.confidence === "high"
          ? chalk.green(candidate.confidence)
          : candidate.confidence === "medium"
            ? chalk.yellow(candidate.confidence)
            : chalk.dim(candidate.confidence);
      lines.push(
        `  ${candidate.rank}. ${candidate.title} ${chalk.dim(`[${candidate.source}]`)} ${conf}`
      );
    }
  } else {
    lines.push("");
    lines.push(chalk.dim("No syllabus candidates detected"));
  }

  // Attachments
  const downloaded = result.attachments.filter((a) => a.status === "downloaded");
  const skipped = result.attachments.filter((a) => a.status === "skipped");
  const failed = result.attachments.filter((a) => a.status === "failed");
  const hasAttachments = result.attachments.length > 0;

  if (hasAttachments) {
    lines.push("");
    lines.push("Attachments:");
    for (const a of downloaded) {
      lines.push(
        `  ${chalk.dim("-")} ${a.originalFilename} ${chalk.green("downloaded")} ${chalk.dim(`(${a.reason})`)}`
      );
    }
    for (const a of skipped) {
      lines.push(
        `  ${chalk.dim("-")} ${a.originalFilename} ${chalk.dim("(already exists)")}`
      );
    }
    for (const a of failed) {
      lines.push(
        `  ${chalk.dim("-")} ${a.originalFilename} ${chalk.red("failed")}`
      );
    }
  }

  // Warnings
  const warnings = result.ingestion.counts.files === 0 || result.ingestion.counts.pages === 0;
  if (warnings) {
    lines.push("");
    lines.push(chalk.dim("Note: some APIs were not accessible. Attachment selection is limited to available file index."));
  }

  // Next
  lines.push("");
  lines.push(chalk.dim("Next:"));
  lines.push(chalk.dim("  - future commands will use this local course cache"));
  lines.push(chalk.dim("  - this ingestion does not yet infer true assignments"));
  lines.push("");

  return lines.join("\n");
}

/**
 * Render a machine-readable JSON summary for --json output.
 * Returns the ingestion metadata plus key summaries, not full data dumps.
 */
export function renderIngestionJson(result: IngestionResult): object {
  return {
    ingestion: result.ingestion,
    coursePath: result.coursePath,
    announcements: result.announcements ?? [],
    discussions: result.discussions ?? [],
    externalLinks: result.externalLinks ?? [],
    syllabusCandidates: result.syllabusCandidates,
    attachments: result.attachments.map((a) => ({
      filename: a.originalFilename,
      sourceType: a.sourceType,
      status: a.status,
      reason: a.reason,
    })),
  };
}
