import chalk from "chalk";
import type { Assignment } from "../domain/models.js";
import type { EnrichedAssignment, EnrichmentSummary } from "../enrich/types.js";

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
  assignments: (Assignment | EnrichedAssignment)[],
  options: { groupByCourse: boolean }
): string {
  if (assignments.length === 0) {
    return chalk.dim("\nNo assignments to show.\n");
  }

  const lines: string[] = [""];

  if (options.groupByCourse) {
    // Group by course, preserving sort order within each group
    const grouped = new Map<string, (Assignment | EnrichedAssignment)[]>();
    for (const a of assignments) {
      const list = grouped.get(a.courseName) ?? [];
      list.push(a);
      grouped.set(a.courseName, list);
    }

    for (const [courseName, courseAssignments] of grouped) {
      lines.push(chalk.bold(courseName));
      for (const a of courseAssignments) {
        lines.push(formatAssignmentLine(a));
        const enrichment = "enrichment" in a ? (a as EnrichedAssignment).enrichment : null;
        if (enrichment) {
          const cues = formatEnrichmentCues(enrichment);
          for (const cue of cues) {
            lines.push(cue);
          }
        }
      }
      lines.push("");
    }
  } else {
    for (const a of assignments) {
      lines.push(formatAssignmentLine(a));
      const enrichment = "enrichment" in a ? (a as EnrichedAssignment).enrichment : null;
      if (enrichment) {
        const cues = formatEnrichmentCues(enrichment);
        for (const cue of cues) {
          lines.push(cue);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatAssignmentLine(a: Assignment): string {
  const parts: string[] = [];
  parts.push(a.name);

  const dateStr = formatDueDate(a.dueAt);
  if (dateStr) parts.push(dateStr);
  parts.push(formatDueLabel(a));

  const prefix = a.status === "overdue" ? chalk.red("  - ") : "  - ";
  return prefix + parts.join(" — ");
}

/**
 * Format compact enrichment cue lines to show below an assignment.
 * Only shows lines when the enrichment adds useful information.
 */
function formatEnrichmentCues(e: EnrichmentSummary): string[] {
  const cues: string[] = [];

  // Show warning for submission shells
  if (e.flags.likelySubmissionShell) {
    cues.push(`    ${chalk.yellow("!")} ${chalk.dim("likely submission shell")}`);
  }

  // Show context confidence + source types (only when there are sources)
  if (e.likelyInstructionSources.length > 0) {
    const sourceTypes = new Set(e.likelyInstructionSources.map((s) => s.type));
    const sourceList = [...sourceTypes].join(", ");
    cues.push(
      `    ${chalk.dim("context:")} ${formatConfidence(e.contextConfidence)} ${chalk.dim("sources:")} ${chalk.dim(sourceList)}`
    );
  } else if (e.flags.hasWeakCanvasDescription) {
    // Only show weak description warning if no sources found either
    cues.push(
      `    ${chalk.dim("context:")} ${formatConfidence(e.contextConfidence)} ${chalk.dim("(no related resources found)")}`
    );
  }

  return cues;
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
