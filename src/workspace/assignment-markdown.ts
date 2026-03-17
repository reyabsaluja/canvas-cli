import type { AssignmentDetail } from "../domain/models.js";
import { htmlToText } from "../format/html-to-text.js";

function formatDate(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatStatus(a: AssignmentDetail): string {
  if (a.submitted) {
    let s = "submitted";
    if (a.submittedAt) s += ` on ${formatDate(a.submittedAt)}`;
    if (a.grade !== null) s += ` — grade: ${a.grade}`;
    if (a.late) s += " (late)";
    return s;
  }
  if (a.status === "overdue") return "overdue";
  if (a.missing) return "missing";
  return "not submitted";
}

/**
 * Generate a clean markdown brief for an assignment.
 */
export function generateAssignmentMarkdown(a: AssignmentDetail): string {
  const lines: string[] = [];

  lines.push(`# ${a.name}`);
  lines.push("");
  lines.push(`- **Course:** ${a.courseName}`);
  lines.push(`- **Assignment ID:** ${a.id}`);
  lines.push(`- **Due:** ${formatDate(a.dueAt)}`);

  if (a.unlockAt) lines.push(`- **Unlocks:** ${formatDate(a.unlockAt)}`);
  if (a.lockAt) lines.push(`- **Locks:** ${formatDate(a.lockAt)}`);

  lines.push(`- **Status:** ${formatStatus(a)}`);

  if (a.pointsPossible !== null) {
    lines.push(`- **Points:** ${a.pointsPossible}`);
  }

  if (a.gradingType && a.gradingType !== "not_graded") {
    lines.push(`- **Grading:** ${a.gradingType.replace(/_/g, " ")}`);
  }

  if (a.submissionTypes.length > 0) {
    const types = a.submissionTypes.map((t) => t.replace(/_/g, " ")).join(", ");
    lines.push(`- **Submission types:** ${types}`);
  }

  if (a.allowedExtensions && a.allowedExtensions.length > 0) {
    lines.push(`- **Allowed file types:** ${a.allowedExtensions.join(", ")}`);
  }

  lines.push(`- **URL:** ${a.htmlUrl}`);

  // Description
  if (a.description) {
    const text = htmlToText(a.description);
    if (text.length > 0) {
      lines.push("");
      lines.push("## Description");
      lines.push("");
      lines.push(text);
    }
  }

  // Attachments / resources
  if (a.attachments.length > 0) {
    lines.push("");
    lines.push("## Resources");
    lines.push("");
    for (const att of a.attachments) {
      lines.push(`- [${att.displayName}](${att.url})`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
