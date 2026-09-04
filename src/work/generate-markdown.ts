import type { AssignmentDetail } from "../domain/models.js";
import type {
  AssignmentWorkup,
  RelevantResource,
  SourceTraceEntry,
} from "./types.js";
import { htmlToText } from "../format/html-to-text.js";

/**
 * Due-date lines for the workup. When Canvas and a course document both
 * state a date and they disagree, say so instead of silently trusting
 * Canvas: a syllabus that says March 20 while Canvas says March 27 is
 * exactly what a student needs to know. Exported for tests.
 */
export function describeDueDate(
  canvasDueAt: Date | null,
  documentDueDate: string | null
): string[] {
  const documentDate = documentDueDate?.trim() || null;
  if (canvasDueAt && documentDate) {
    const agreement = compareDueDates(canvasDueAt, documentDate);
    if (agreement === "conflict") {
      return [
        `**Due:** ${formatDate(canvasDueAt)} *(Canvas)*`,
        `**Due-date conflict:** the syllabus/schedule says **${documentDate}**, which does not match Canvas. Confirm with the instructor before relying on either.`,
      ];
    }
    if (agreement === "unknown") {
      return [`**Due:** ${formatDate(canvasDueAt)} *(Canvas; the syllabus/schedule says "${documentDate}")*`];
    }
    return [`**Due:** ${formatDate(canvasDueAt)} *(Canvas, matches the syllabus/schedule)*`];
  }
  if (canvasDueAt) {
    return [`**Due:** ${formatDate(canvasDueAt)}`];
  }
  if (documentDate) {
    return [`**Due:** ${documentDate} *(inferred from syllabus/schedule)*`];
  }
  return [`**Due:** not set on Canvas`];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Same calendar day → "match"; different day → "conflict"; unparseable → "unknown". */
export function compareDueDates(canvasDueAt: Date, documentDueDate: string): "match" | "conflict" | "unknown" {
  const canvasMonth = canvasDueAt.getMonth();
  const canvasDay = canvasDueAt.getDate();
  const canvasYear = canvasDueAt.getFullYear();
  const text = documentDueDate.toLowerCase();

  // ISO or numeric dates.
  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const [, y, m, d] = iso;
    return Number(y) === canvasYear && Number(m) - 1 === canvasMonth && Number(d) === canvasDay ? "match" : "conflict";
  }
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const [, m, d] = slash;
    return Number(m) - 1 === canvasMonth && Number(d) === canvasDay ? "match" : "conflict";
  }
  // "March 20", "Mar. 20, 2026", "20 March".
  const monthIndex = MONTHS.findIndex((month) => new RegExp(`\\b${month}[a-z]*\\.?\\b`).test(text));
  if (monthIndex >= 0) {
    const dayMatch =
      text.match(new RegExp(`\\b${MONTHS[monthIndex]}[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`)) ??
      text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTHS[monthIndex]}[a-z]*\\b`));
    if (dayMatch) {
      return monthIndex === canvasMonth && Number(dayMatch[1]) === canvasDay ? "match" : "conflict";
    }
  }
  return "unknown";
}

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

// --- Evidence classification helpers ---

/** Keywords that indicate background/optional rather than required. */
const BACKGROUND_KEYWORDS = [
  "background",
  "theory",
  "textbook",
  "lecture",
  "chapter",
  "reference",
  "optional",
  "review",
  "supplementary",
  "recommended reading",
];

/** Keywords in source trace that indicate inference rather than direct evidence. */
const INFERRED_KEYWORDS = [
  "syllabus",
  "schedule",
  "inferred",
  "timeline",
  "pattern",
  "appears",
  "likely",
  "based on",
  "estimated",
  "calendar",
];

function isBackgroundResource(r: RelevantResource): boolean {
  const text = `${r.title} ${r.why} ${r.type}`.toLowerCase();
  return BACKGROUND_KEYWORDS.some((kw) => text.includes(kw));
}

function isInferredTrace(entry: SourceTraceEntry): boolean {
  const text = `${entry.source} ${entry.conclusion}`.toLowerCase();
  return INFERRED_KEYWORDS.some((kw) => text.includes(kw));
}

// --- assignment.md ---

/**
 * Generate assignment.md — a rich readable brief combining metadata,
 * the AI workup, and Canvas data. Includes evidence classification.
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

  // Due date with provenance, surfacing Canvas-vs-document disagreements.
  for (const line of describeDueDate(detail.dueAt, workup.dueDate)) {
    lines.push(`- ${line}`);
  }

  if (detail.pointsPossible !== null)
    lines.push(`- **Points:** ${detail.pointsPossible}`);
  if (detail.submissionTypes.length > 0) {
    lines.push(
      `- **Submit via:** ${detail.submissionTypes.map((t) => t.replace(/_/g, " ")).join(", ")}`
    );
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

  // Required vs optional resources
  if (workup.relevantResources.length > 0) {
    const required = workup.relevantResources.filter(
      (r) => !isBackgroundResource(r)
    );
    const background = workup.relevantResources.filter((r) =>
      isBackgroundResource(r)
    );

    if (required.length > 0) {
      lines.push("## Required resources");
      lines.push("");
      for (const r of required) {
        lines.push(`- **${r.title}** (${r.type}) — ${r.why}`);
        if (r.location) lines.push(`  Location: ${r.location}`);
      }
      lines.push("");
    }

    if (background.length > 0) {
      lines.push("## Background / optional references");
      lines.push("");
      for (const r of background) {
        lines.push(`- **${r.title}** (${r.type}) — ${r.why}`);
        if (r.location) lines.push(`  Location: ${r.location}`);
      }
      lines.push("");
    }
  }

  // Recommended reading order
  if (workup.recommendedReadOrder.length > 0) {
    lines.push("## Recommended reading order");
    lines.push("");
    for (let i = 0; i < workup.recommendedReadOrder.length; i++) {
      lines.push(`${i + 1}. ${workup.recommendedReadOrder[i]}`);
    }
    lines.push("");
  }

  // Evidence & Source Trace
  if (workup.sourceTrace.length > 0) {
    lines.push("## Evidence & Source Trace");
    lines.push("");

    const confirmed = workup.sourceTrace.filter((e) => !isInferredTrace(e));
    const inferred = workup.sourceTrace.filter((e) => isInferredTrace(e));

    if (confirmed.length > 0) {
      lines.push("### Confirmed from sources");
      lines.push("");
      for (const e of confirmed) {
        lines.push(`- ${e.conclusion} — *source: ${e.source}*`);
      }
      lines.push("");
    }

    if (inferred.length > 0) {
      lines.push("### Inferred");
      lines.push("");
      for (const e of inferred) {
        lines.push(`- ${e.conclusion} — *inferred from: ${e.source}*`);
      }
      lines.push("");
    }
  }

  // Canvas description
  if (detail.description) {
    const text = htmlToText(detail.description).trim();
    if (text.length > 0) {
      lines.push("## Canvas description (raw)");
      lines.push("");
      lines.push(text);
      lines.push("");
    }
  }

  // Open questions
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

// --- plan.md ---

/**
 * Generate plan.md — a practical, resource-linked action plan.
 * Each step includes goal, resources, and expected output.
 */
export function generatePlanMarkdown(
  detail: AssignmentDetail,
  workup: AssignmentWorkup
): string {
  const lines: string[] = [];

  lines.push(`# Plan: ${detail.name}`);
  lines.push("");

  for (const line of describeDueDate(detail.dueAt, workup.dueDate)) {
    lines.push(line);
  }
  lines.push("");

  if (workup.actionPlan.length > 0) {
    for (const step of workup.actionPlan) {
      lines.push(`### Step ${step.step}: ${step.action}`);
      lines.push("");

      // Extract goal / resources / output from the detail text
      // The detail field contains the agent's description of the step.
      // We render it in a structured way.
      if (step.detail) {
        const parsed = parseStepDetail(step.detail, workup);
        lines.push("**Goal:**");
        lines.push(parsed.goal);
        lines.push("");

        if (parsed.resources.length > 0) {
          lines.push("**What to use:**");
          for (const r of parsed.resources) {
            lines.push(`- ${r}`);
          }
          lines.push("");
        }

        if (parsed.output) {
          lines.push("**Output:**");
          lines.push(parsed.output);
          lines.push("");
        }
      } else {
        // No detail — just show the action as the goal
        lines.push(`**Goal:** ${step.action}`);
        lines.push("");
      }
    }
  }

  if (workup.deliverables.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Deliverables checklist");
    lines.push("");
    for (const d of workup.deliverables) {
      lines.push(`- [ ] ${d}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Parse a step's detail text into structured goal/resources/output.
 * Uses simple heuristics — looks for resource titles mentioned in the text.
 */
function parseStepDetail(
  detail: string,
  workup: AssignmentWorkup
): { goal: string; resources: string[]; output: string | null } {
  // Find any resource titles mentioned in the detail text
  const resources: string[] = [];
  const detailLower = detail.toLowerCase();

  for (const r of workup.relevantResources) {
    // Check if the resource title (or a significant portion) appears in the detail
    const titleLower = r.title.toLowerCase();
    if (
      detailLower.includes(titleLower) ||
      (titleLower.length > 8 &&
        detailLower.includes(titleLower.slice(0, titleLower.lastIndexOf("."))))
    ) {
      resources.push(r.title);
    }
  }

  // The detail text is the goal. If it contains multiple sentences,
  // the last sentence might describe the output.
  const sentences = detail
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);
  let goal = detail;
  let output: string | null = null;

  if (sentences.length >= 2) {
    const lastSentence = sentences[sentences.length - 1].toLowerCase();
    const outputIndicators = [
      "produce",
      "result",
      "output",
      "submit",
      "write",
      "create",
      "calculate",
      "determine",
      "complete",
      "fill",
      "record",
    ];
    if (outputIndicators.some((kw) => lastSentence.includes(kw))) {
      goal = sentences.slice(0, -1).join(" ");
      output = sentences[sentences.length - 1];
    }
  }

  return { goal, resources, output };
}

// --- notes.md ---

/**
 * Generate a structured notes.md scaffold for the student.
 */
export function generateNotesMarkdown(
  detail: AssignmentDetail,
  workup: AssignmentWorkup
): string {
  const lines: string[] = [];

  lines.push(`# Notes: ${detail.name}`);
  lines.push("");

  lines.push("## What the assignment is asking");
  lines.push("");
  // Pre-fill with the overview to give the student a starting point
  lines.push(
    `> ${workup.overview.split("\n")[0]}`
  );
  lines.push("");
  lines.push("*Edit above with your own understanding:*");
  lines.push("-");
  lines.push("");

  lines.push("## Key tasks / deliverables (my understanding)");
  lines.push("");
  if (workup.deliverables.length > 0) {
    for (const d of workup.deliverables) {
      lines.push(`- [ ] ${d}`);
    }
  } else {
    lines.push("- [ ]");
  }
  lines.push("");

  lines.push("## Things I need to calculate / implement");
  lines.push("");
  lines.push("-");
  lines.push("");

  lines.push("## Important formulas / concepts");
  lines.push("");
  lines.push("-");
  lines.push("");

  lines.push("## Questions / unclear points");
  lines.push("");
  if (workup.uncertainties.length > 0) {
    for (const u of workup.uncertainties) {
      lines.push(`- ${u}`);
    }
  } else {
    lines.push("-");
  }
  lines.push("");

  lines.push("## Progress");
  lines.push("");
  lines.push("- [ ] Read assignment instructions");
  lines.push("- [ ] Understand requirements");
  lines.push("- [ ] Start working");
  lines.push("- [ ] Review and finalize");
  lines.push("- [ ] Submit");
  lines.push("");

  return lines.join("\n");
}
