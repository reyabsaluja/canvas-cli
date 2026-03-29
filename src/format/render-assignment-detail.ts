import chalk from "chalk";
import type { AssignmentDetail } from "../domain/models.js";
import type { EnrichedAssignmentDetail, EnrichmentSummary } from "../enrich/types.js";
import type { AssignmentRealOverview } from "../ai/types.js";
import { htmlToText } from "./html-to-text.js";

function formatDate(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatStatus(a: AssignmentDetail): string {
  if (a.submitted) {
    let s = chalk.green("submitted");
    if (a.submittedAt) {
      s += chalk.dim(` on ${formatDate(a.submittedAt)}`);
    }
    if (a.grade !== null) {
      s += chalk.dim(` — grade: ${a.grade}`);
    }
    if (a.late) {
      s += chalk.yellow(" (late)");
    }
    return s;
  }
  if (a.status === "overdue") return chalk.red.bold("overdue");
  if (a.missing) return chalk.red("missing");
  return chalk.dim("not submitted");
}

function formatSubmissionTypes(types: string[]): string {
  return types
    .map((t) => t.replace(/_/g, " "))
    .join(", ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderAssignmentDetail(
  a: AssignmentDetail | EnrichedAssignmentDetail,
  aiOverview?: AssignmentRealOverview | null,
  aiError?: string | null
): string {
  const lines: string[] = [""];

  // Title
  lines.push(chalk.bold(a.name));
  lines.push("");

  // Metadata table
  const fields: [string, string][] = [
    ["Course", a.courseName],
    ["ID", String(a.id)],
    ["Due", formatDate(a.dueAt)],
  ];

  if (a.unlockAt) fields.push(["Unlocks", formatDate(a.unlockAt)]);
  if (a.lockAt) fields.push(["Locks", formatDate(a.lockAt)]);

  fields.push(["Status", formatStatus(a)]);

  if (a.pointsPossible !== null) {
    fields.push(["Points", String(a.pointsPossible)]);
  }

  if (a.gradingType && a.gradingType !== "not_graded") {
    fields.push(["Grading", a.gradingType.replace(/_/g, " ")]);
  }

  if (a.submissionTypes.length > 0) {
    fields.push(["Submit via", formatSubmissionTypes(a.submissionTypes)]);
  }

  if (a.allowedExtensions && a.allowedExtensions.length > 0) {
    fields.push(["File types", a.allowedExtensions.join(", ")]);
  }

  fields.push(["URL", a.htmlUrl]);

  // Align the label column
  const maxLabel = Math.max(...fields.map(([label]) => label.length));
  for (const [label, value] of fields) {
    const paddedLabel = chalk.dim(label.padEnd(maxLabel) + "  ");
    lines.push(`  ${paddedLabel}${value}`);
  }

  // Description
  if (a.description) {
    const text = htmlToText(a.description);
    if (text.length > 0) {
      lines.push("");
      lines.push(chalk.bold("Description"));
      lines.push("");
      // Indent description body
      const indented = text
        .split("\n")
        .map((line) => (line ? `  ${line}` : ""))
        .join("\n");
      lines.push(indented);
    }
  }

  // Attachments
  if (a.attachments.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Attachments"));
    lines.push("");
    for (const att of a.attachments) {
      const size = chalk.dim(`(${formatSize(att.size)})`);
      lines.push(`  - ${att.displayName} ${size}`);
      lines.push(chalk.dim(`    ${att.url}`));
    }
  }

  // Enrichment section
  const enrichment = "enrichment" in a ? (a as EnrichedAssignmentDetail).enrichment : null;
  if (enrichment) {
    lines.push(...renderEnrichmentSection(enrichment));
  }

  // AI overview section
  if (aiOverview) {
    lines.push(...renderAIOverview(aiOverview));
  } else if (aiError) {
    lines.push("");
    lines.push(chalk.dim(aiError));
  }

  lines.push("");
  return lines.join("\n");
}

function renderEnrichmentSection(e: EnrichmentSummary): string[] {
  const lines: string[] = [];

  // Context section
  lines.push("");
  lines.push(chalk.bold("Context"));
  lines.push("");

  const confLabel = formatConfidence(e.contextConfidence);
  lines.push(`  ${chalk.dim("Confidence           ")} ${confLabel}`);

  if (e.flags.likelySubmissionShell) {
    lines.push(`  ${chalk.dim("Submission shell     ")} ${chalk.yellow("yes")}`);
  }
  if (e.flags.hasWeakCanvasDescription) {
    lines.push(`  ${chalk.dim("Weak description     ")} ${chalk.yellow("yes")}`);
  }
  if (e.flags.missingDueDate) {
    lines.push(`  ${chalk.dim("Missing due date     ")} ${chalk.yellow("yes")}`);
  }

  // Instruction sources
  if (e.likelyInstructionSources.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Likely instruction sources"));
    lines.push("");
    for (const src of e.likelyInstructionSources) {
      const typeLabel = chalk.dim(`[${src.type}]`);
      const location = src.localPath
        ? chalk.dim(` (${src.localPath})`)
        : src.url
          ? chalk.dim(` (${src.url})`)
          : "";
      lines.push(`  - ${src.title} ${typeLabel}${location}`);
    }
  }

  // Warnings / notes
  const warnings = e.notes.filter(
    (n) =>
      n.includes("incomplete") ||
      n.includes("submission-only") ||
      n.includes("elsewhere")
  );
  if (warnings.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Warnings"));
    lines.push("");
    for (const w of warnings) {
      lines.push(`  ${chalk.yellow("!")} ${w}`);
    }
  }

  return lines;
}

function formatConfidence(confidence: string): string {
  switch (confidence) {
    case "high":
      return chalk.green(confidence);
    case "medium":
      return chalk.yellow(confidence);
    case "low":
      return chalk.red(confidence);
    default:
      return chalk.dim(confidence);
  }
}

function renderAIOverview(o: AssignmentRealOverview): string[] {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold.cyan("Real overview"));
  lines.push("");

  // Overview paragraph — indent each line
  const overviewLines = o.overview.split("\n");
  for (const line of overviewLines) {
    lines.push(line ? `  ${line}` : "");
  }

  // Due date from syllabus (if AI found one and Canvas didn't have it)
  if (o.dueDate) {
    lines.push("");
    lines.push(`  ${chalk.bold("Due date (from syllabus):")} ${chalk.yellow(o.dueDate)}`);
  }

  // Tasks
  if (o.likelyTasks.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Tasks"));
    lines.push("");
    for (const task of o.likelyTasks) {
      lines.push(`  - ${task}`);
    }
  }

  // Primary sources
  if (o.primarySources.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Sources"));
    lines.push("");
    for (const src of o.primarySources) {
      lines.push(`  ${chalk.dim("-")} ${src}`);
    }
  }

  // Next steps (only if there are genuinely missing things)
  if (o.nextSteps.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Next steps"));
    lines.push("");
    for (const step of o.nextSteps) {
      lines.push(`  - ${step}`);
    }
  }

  // Confidence
  lines.push("");
  lines.push(`  ${chalk.dim("Confidence:")} ${formatConfidence(o.confidence)}`);

  return lines;
}
