import type { AssignmentDetail, Course } from "../domain/models.js";
import type { EnrichmentSummary } from "../enrich/types.js";
import type {
  AssignmentWorkup,
  InvestigationState,
  WorkVerificationResult,
} from "./types.js";
import { callModel, type AIProviderConfig } from "../ai/provider.js";
import { htmlToText } from "../format/html-to-text.js";

const SYNTHESIS_SYSTEM_PROMPT = `You are an academic assignment analyst. You have just completed an investigation of a course assignment by reading relevant documents, checking the syllabus, and exploring the course structure.

Now produce a structured JSON workup of the assignment based on everything you learned.

Rules:
- Base your analysis on the evidence provided — do not invent requirements.
- Be specific and actionable. Extract real deliverables from the instruction documents.
- If you read the actual instruction PDF, cite specific requirements from it.
- If the due date is missing from Canvas, try to provide it from the syllabus/schedule.
- Keep the overview concise (3-5 sentences).
- Action plan should be practical steps a student would actually follow.
- Only list real uncertainties — things you genuinely couldn't determine.

Return valid JSON matching this exact schema:
{
  "overview": "string — what this assignment is and what's expected",
  "deliverables": ["string — each concrete thing to submit/build/write"],
  "constraints": ["string — format, technical, timing, rubric constraints"],
  "relevant_resources": [{"title": "string", "type": "pdf|page|module_item|file|syllabus|assignment_description", "location": "string — where to find it", "why": "string — why it matters"}],
  "recommended_read_order": ["string — what to read first, second, etc"],
  "action_plan": [{"step": 1, "action": "string — what to do", "detail": "string or null — additional info"}],
  "uncertainties": ["string — what remains genuinely unclear"],
  "due_date": "string or null — due date from syllabus if Canvas didn't have it",
  "confidence": "high | medium | low",
  "source_trace": [{"conclusion": "string — a key finding", "source": "string — where you got it"}]
}

Return ONLY the JSON object.`;

/**
 * Take the investigation evidence and produce a structured AssignmentWorkup.
 */
export async function synthesizeWorkup(
  config: AIProviderConfig,
  detail: AssignmentDetail,
  course: Course,
  enrichment: EnrichmentSummary | null,
  state: InvestigationState,
  investigationSummary: string,
  verification: WorkVerificationResult
): Promise<AssignmentWorkup> {
  const userMessage = buildSynthesisMessage(
    detail,
    state,
    investigationSummary,
    verification
  );
  const rawResponse = await callModel(config, SYNTHESIS_SYSTEM_PROMPT, userMessage);
  const parsed = parseSynthesisResponse(rawResponse);
  return applyInvestigationVerification(parsed, verification);
}

function buildSynthesisMessage(
  detail: AssignmentDetail,
  state: InvestigationState,
  investigationSummary: string,
  verification: WorkVerificationResult
): string {
  const sections: string[] = [];

  sections.push("# Assignment metadata");
  sections.push(`Name: ${detail.name}`);
  sections.push(`Course: ${detail.courseName}`);
  sections.push(`Canvas due date: ${detail.dueAt?.toISOString() ?? "NOT SET"}`);
  if (detail.pointsPossible !== null) sections.push(`Points: ${detail.pointsPossible}`);
  sections.push(`Submission types: ${detail.submissionTypes.join(", ") || "none"}`);
  sections.push(`URL: ${detail.htmlUrl}`);

  if (detail.description) {
    const text = htmlToText(detail.description).trim();
    if (text.length > 0) {
      sections.push(`\n# Canvas description\n${text}`);
    }
  }

  if (investigationSummary) {
    sections.push(`\n# Investigation summary\n${investigationSummary}`);
  }

  sections.push(`\n# Sources visited: ${state.visitedSources.join(", ") || "none"}`);

  sections.push("\n# Investigation verification");
  sections.push(`Complete: ${verification.ok ? "yes" : "no"}`);
  sections.push(`Confidence cap: ${verification.confidence}`);
  sections.push(
    `Missing evidence: ${verification.missing.join(", ") || "none"}`
  );

  // Include all extracted texts
  if (state.extractedTexts.size > 0) {
    sections.push("\n# Extracted document contents");
    for (const [source, text] of state.extractedTexts) {
      sections.push(`\n## ${source}\n${text}`);
    }
  }

  sections.push("\nBased on all of the above, produce the structured assignment workup.");

  return sections.join("\n");
}

export function applyInvestigationVerification(
  workup: AssignmentWorkup,
  verification: WorkVerificationResult
): AssignmentWorkup {
  const uncertainties = [...workup.uncertainties];

  if (verification.missing.includes("primary_instruction")) {
    pushUniqueUncertainty(
      uncertainties,
      "The investigation did not confirm that a primary instruction document was read, so some requirements may be incomplete."
    );
  }

  if (verification.missing.includes("due_date_source")) {
    pushUniqueUncertainty(
      uncertainties,
      "The investigation did not confirm a due-date source, so schedule details may be incomplete."
    );
  }

  return {
    ...workup,
    confidence: capConfidence(workup.confidence, verification.confidence),
    uncertainties,
  };
}

function parseSynthesisResponse(raw: string): AssignmentWorkup {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error("Could not parse synthesis response as JSON");
    }
  }

  const obj = parsed as Record<string, unknown>;

  return {
    overview: asString(obj.overview, "Unable to generate overview."),
    deliverables: asStringArray(obj.deliverables),
    constraints: asStringArray(obj.constraints),
    relevantResources: asResourceArray(obj.relevant_resources),
    recommendedReadOrder: asStringArray(obj.recommended_read_order),
    actionPlan: asActionPlanArray(obj.action_plan),
    uncertainties: asStringArray(obj.uncertainties),
    dueDate: typeof obj.due_date === "string" ? obj.due_date : null,
    confidence: ["high", "medium", "low"].includes(obj.confidence as string)
      ? (obj.confidence as "high" | "medium" | "low")
      : "medium",
    sourceTrace: asSourceTraceArray(obj.source_trace),
  };
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asResourceArray(v: unknown): AssignmentWorkup["relevantResources"] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object")
    .map((x: any) => ({
      title: asString(x.title, ""),
      type: x.type ?? "file",
      location: asString(x.location, ""),
      why: asString(x.why, ""),
    }));
}

function asActionPlanArray(v: unknown): AssignmentWorkup["actionPlan"] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object")
    .map((x: any, i: number) => ({
      step: typeof x.step === "number" ? x.step : i + 1,
      action: asString(x.action, ""),
      detail: typeof x.detail === "string" ? x.detail : null,
    }));
}

function asSourceTraceArray(v: unknown): AssignmentWorkup["sourceTrace"] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object")
    .map((x: any) => ({
      conclusion: asString(x.conclusion, ""),
      source: asString(x.source, ""),
    }));
}

function capConfidence(
  current: AssignmentWorkup["confidence"],
  cap: WorkVerificationResult["confidence"]
): AssignmentWorkup["confidence"] {
  const rank = {
    high: 3,
    medium: 2,
    low: 1,
  };
  return rank[current] <= rank[cap] ? current : cap;
}

function pushUniqueUncertainty(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}
