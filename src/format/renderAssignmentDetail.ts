import chalk from "chalk";
import type { AssignmentDetail } from "../domain/models.js";
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

export function renderAssignmentDetail(a: AssignmentDetail): string {
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

  lines.push("");
  return lines.join("\n");
}
