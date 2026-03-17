import chalk from "chalk";
import type { Assignment } from "../domain/models.js";

function formatDueLabel(a: Assignment): string {
  if (a.status === "submitted") return chalk.green("submitted");
  if (!a.dueAt) return chalk.dim("no due date");
  if (a.status === "overdue") return chalk.red.bold("overdue");

  const now = new Date();
  const diffMs = a.dueAt.getTime() - now.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 1) return chalk.yellow(`due in ${diffDays}d`);
  if (diffHours > 1) return chalk.yellow(`due in ${diffHours}h`);
  return chalk.yellow("due soon");
}

function formatDueDate(date: Date | null): string {
  if (!date) return "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Render a flat list of assignments, optionally grouped by course. */
export function renderAssignments(
  assignments: Assignment[],
  options: { groupByCourse: boolean }
): string {
  if (assignments.length === 0) {
    return chalk.dim("\nNo assignments to show.\n");
  }

  const lines: string[] = [""];

  if (options.groupByCourse) {
    // Group by course, preserving sort order within each group
    const grouped = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const list = grouped.get(a.courseName) ?? [];
      list.push(a);
      grouped.set(a.courseName, list);
    }

    for (const [courseName, courseAssignments] of grouped) {
      lines.push(chalk.bold(courseName));
      for (const a of courseAssignments) {
        lines.push(formatAssignmentLine(a, false));
      }
      lines.push("");
    }
  } else {
    for (const a of assignments) {
      lines.push(formatAssignmentLine(a, false));
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatAssignmentLine(a: Assignment, showCourse: boolean): string {
  const parts: string[] = [];
  if (showCourse) parts.push(chalk.dim(a.courseName));
  parts.push(a.name);

  const dateStr = formatDueDate(a.dueAt);
  if (dateStr) parts.push(dateStr);
  parts.push(formatDueLabel(a));

  const prefix = a.status === "overdue" ? chalk.red("  - ") : "  - ";
  return prefix + parts.join(" — ");
}
