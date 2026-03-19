import type { AssignmentDetail } from "../domain/models.js";
import type { AssignmentWorkup } from "./types.js";
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

/**
 * Generate assignment.md — a rich readable brief combining metadata,
 * the AI workup, and Canvas data.
 */
export function generateWorkAssignmentMarkdown(
  detail: AssignmentDetail,
  workup: AssignmentWorkup
): string {
  const lines: string[] = [];

  lines.push(`# ${detail.name}`);
  lines.push("");

  // Metadata
  lines.push(`- **Course:** ${detail.courseName}`);
  lines.push(`- **Due:** ${formatDate(detail.dueAt)}${workup.dueDate && !detail.dueAt ? ` (from syllabus: ${workup.dueDate})` : ""}`);
  if (detail.pointsPossible !== null) lines.push(`- **Points:** ${detail.pointsPossible}`);
  if (detail.submissionTypes.length > 0) {
    lines.push(`- **Submit via:** ${detail.submissionTypes.map((t) => t.replace(/_/g, " ")).join(", ")}`);
  }
  lines.push(`- **URL:** ${detail.htmlUrl}`);
  lines.push(`- **Confidence:** ${workup.confidence}`);
  lines.push("");

  // Overview
  lines.push("## Overview");
  lines.push("");
  lines.push(workup.overview);
  lines.push("");

  // Deliverables
  if (workup.deliverables.length > 0) {
    lines.push("## Deliverables");
    lines.push("");
    for (const d of workup.deliverables) {
      lines.push(`- [ ] ${d}`);
    }
    lines.push("");
  }

  // Constraints
  if (workup.constraints.length > 0) {
    lines.push("## Constraints");
    lines.push("");
    for (const c of workup.constraints) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  // Recommended reading
  if (workup.recommendedReadOrder.length > 0) {
    lines.push("## Recommended reading order");
    lines.push("");
    for (let i = 0; i < workup.recommendedReadOrder.length; i++) {
      lines.push(`${i + 1}. ${workup.recommendedReadOrder[i]}`);
    }
    lines.push("");
  }

  // Key resources
  if (workup.relevantResources.length > 0) {
    lines.push("## Key resources");
    lines.push("");
    for (const r of workup.relevantResources) {
      lines.push(`- **${r.title}** (${r.type}) — ${r.why}`);
      if (r.location) lines.push(`  Location: ${r.location}`);
    }
    lines.push("");
  }

  // Canvas description
  if (detail.description) {
    const text = htmlToText(detail.description).trim();
    if (text.length > 0) {
      lines.push("## Canvas description");
      lines.push("");
      lines.push(text);
      lines.push("");
    }
  }

  // Uncertainties
  if (workup.uncertainties.length > 0) {
    lines.push("## Open questions");
    lines.push("");
    for (const u of workup.uncertainties) {
      lines.push(`- ${u}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate plan.md — a practical action plan.
 */
export function generatePlanMarkdown(
  detail: AssignmentDetail,
  workup: AssignmentWorkup
): string {
  const lines: string[] = [];

  lines.push(`# Plan: ${detail.name}`);
  lines.push("");

  if (workup.dueDate || detail.dueAt) {
    lines.push(`**Due:** ${detail.dueAt ? formatDate(detail.dueAt) : workup.dueDate}`);
    lines.push("");
  }

  if (workup.actionPlan.length > 0) {
    lines.push("## Steps");
    lines.push("");
    for (const step of workup.actionPlan) {
      lines.push(`### ${step.step}. ${step.action}`);
      if (step.detail) {
        lines.push("");
        lines.push(step.detail);
      }
      lines.push("");
    }
  }

  if (workup.deliverables.length > 0) {
    lines.push("## Checklist");
    lines.push("");
    for (const d of workup.deliverables) {
      lines.push(`- [ ] ${d}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
