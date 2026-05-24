import fs from "node:fs/promises";
import path from "node:path";
import type { AssignmentDetail, Course } from "../domain/models.js";
import type { EnrichmentSummary } from "../enrich/types.js";
import { sanitizeDocumentSegment } from "../sanitize.js";
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
 * If the model's first response can't be parsed even after recovery, retries
 * once with a stricter JSON-only reminder. Persists the offending response to
 * the course directory for debugging before surfacing the error.
 */
export async function synthesizeWorkup(
  config: AIProviderConfig,
  detail: AssignmentDetail,
  course: Course,
  enrichment: EnrichmentSummary | null,
  state: InvestigationState,
  investigationSummary: string,
  verification: WorkVerificationResult,
  options: { coursePath?: string } = {}
): Promise<AssignmentWorkup> {
  const userMessage = buildSynthesisMessage(
    detail,
    state,
    investigationSummary,
    verification
  );

  const firstRaw = await callModel(config, SYNTHESIS_SYSTEM_PROMPT, userMessage);
  const firstAttempt = tryParseSynthesis(firstRaw);
  if (firstAttempt.ok) {
    return applyInvestigationVerification(firstAttempt.workup, verification);
  }

  const retryUserMessage = buildRetryMessage(userMessage, firstRaw);
  const secondRaw = await callModel(
    config,
    SYNTHESIS_RETRY_SYSTEM_PROMPT,
    retryUserMessage
  );
  const secondAttempt = tryParseSynthesis(secondRaw);
  if (secondAttempt.ok) {
    return applyInvestigationVerification(secondAttempt.workup, verification);
  }

  const dumpPath = await persistFailedSynthesisResponses(
    options.coursePath ?? null,
    detail,
    firstRaw,
    secondRaw
  );
  const location = dumpPath ? ` Raw response saved to ${dumpPath}.` : "";
  throw new Error(
    `Synthesis model returned unparseable JSON after one retry.${location}`
  );
}

function tryParseSynthesis(raw: string):
  | { ok: true; workup: AssignmentWorkup }
  | { ok: false; error: unknown } {
  try {
    return { ok: true, workup: parseSynthesisResponse(raw) };
  } catch (error) {
    return { ok: false, error };
  }
}

function buildRetryMessage(originalUserMessage: string, badResponse: string): string {
  const truncatedBad =
    badResponse.length > 2000
      ? `${badResponse.slice(0, 1000)}\n...[${badResponse.length - 2000} chars elided]...\n${badResponse.slice(-1000)}`
      : badResponse;
  return [
    originalUserMessage,
    "",
    "# Retry note",
    "Your previous response could not be parsed as JSON. Return ONLY a single",
    "valid JSON object matching the schema. Do not include markdown fences,",
    "comments, trailing commas, or any prose outside the JSON. Keep the output",
    "short enough to finish inside the response budget — trim long arrays",
    "rather than truncating entries.",
    "",
    "# Previous invalid response (for context; do not repeat it)",
    truncatedBad,
  ].join("\n");
}

const SYNTHESIS_RETRY_SYSTEM_PROMPT = `${SYNTHESIS_SYSTEM_PROMPT}

The previous attempt failed to produce valid JSON. Output ONLY the JSON object. Do not include any markdown fencing, explanatory text, comments (// ... ), or trailing commas. Keep arrays short enough that the full JSON closes cleanly.`;

async function persistFailedSynthesisResponses(
  coursePath: string | null,
  detail: AssignmentDetail,
  firstRaw: string,
  secondRaw: string
): Promise<string | null> {
  if (!coursePath) return null;
  try {
    const dir = path.join(coursePath, "debug", "synthesis-failures");
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = sanitizeDocumentSegment(String(detail.id ?? "assignment"));
    const filePath = path.join(dir, `${stamp}-${safeName}.txt`);
    const body = [
      `Assignment: ${detail.name} (${detail.id})`,
      `Timestamp: ${new Date().toISOString()}`,
      "",
      "=== First response ===",
      firstRaw,
      "",
      "=== Retry response ===",
      secondRaw,
      "",
    ].join("\n");
    await fs.writeFile(filePath, body, "utf-8");
    return filePath;
  } catch {
    return null;
  }
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

  appendExtractedDocumentSections(sections, state.extractedTexts);

  sections.push("\nBased on all of the above, produce the structured assignment workup.");

  return sections.join("\n");
}

/**
 * Budget the extracted-texts block so fresh ingests with many zip entries do
 * not produce a prompt so large it forces the synthesis model to truncate its
 * own JSON output. Primary instruction sources keep their full text; other
 * sources are progressively trimmed if the total would exceed the budget.
 */
const EXTRACTED_TEXTS_TOTAL_BUDGET = 80000;
const EXTRACTED_TEXTS_PER_DOC_MAX = 18000;
const EXTRACTED_TEXTS_PER_DOC_MIN = 2000;

function appendExtractedDocumentSections(
  sections: string[],
  extractedTexts: Map<string, string>
): void {
  if (extractedTexts.size === 0) return;

  const entries = Array.from(extractedTexts.entries()).map(([source, text]) => ({
    source,
    text,
  }));
  const totalLength = entries.reduce((sum, entry) => sum + entry.text.length, 0);

  let perDocLimit = EXTRACTED_TEXTS_PER_DOC_MAX;
  if (totalLength > EXTRACTED_TEXTS_TOTAL_BUDGET) {
    const proportional = Math.floor(
      EXTRACTED_TEXTS_TOTAL_BUDGET / Math.max(entries.length, 1)
    );
    perDocLimit = Math.max(
      EXTRACTED_TEXTS_PER_DOC_MIN,
      Math.min(EXTRACTED_TEXTS_PER_DOC_MAX, proportional)
    );
  }

  sections.push("\n# Extracted document contents");
  let truncatedCount = 0;
  for (const entry of entries) {
    if (entry.text.length <= perDocLimit) {
      sections.push(`\n## ${entry.source}\n${entry.text}`);
      continue;
    }
    truncatedCount += 1;
    sections.push(
      `\n## ${entry.source}\n${entry.text.slice(0, perDocLimit)}\n[...truncated for prompt budget: ${entry.text.length - perDocLimit} more chars in the original extract]`
    );
  }
  if (truncatedCount > 0) {
    sections.push(
      `\n(${truncatedCount} of ${entries.length} extracted document(s) were trimmed to keep the synthesis input within budget.)`
    );
  }
}

export function applyInvestigationVerification(
  workup: AssignmentWorkup,
  verification: WorkVerificationResult
): AssignmentWorkup {
  const uncertainties = [...workup.uncertainties];
  let dueDate = workup.dueDate;

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
    if (dueDate) {
      dueDate = null;
      pushUniqueUncertainty(
        uncertainties,
        "The synthesized due date was dropped because the investigation did not verify any due-date evidence."
      );
    }
  }

  if (workup.deliverables.length > 0 && workup.sourceTrace.length === 0) {
    pushUniqueUncertainty(
      uncertainties,
      "The workup identified deliverables but did not include any source trace, so specific requirements may still need verification."
    );
  }

  const confidenceCap =
    workup.sourceTrace.length > 0
      ? verification.confidence
      : capConfidence(verification.confidence, "medium");

  return {
    ...workup,
    dueDate,
    confidence: capConfidence(workup.confidence, confidenceCap),
    uncertainties,
  };
}

export function parseSynthesisResponse(raw: string): AssignmentWorkup {
  const obj = parseSynthesisJson(raw);

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

/**
 * Parse the model's JSON response, applying progressive recovery passes for
 * common failure modes (markdown fences, trailing prose, line comments,
 * trailing commas, and — most importantly — responses that were truncated
 * because the model hit its output token limit).
 */
function parseSynthesisJson(raw: string): Record<string, unknown> {
  const cleaned = stripMarkdownFences(raw.trim());

  const candidates = buildParseCandidates(cleaned);
  for (const candidate of candidates) {
    const parsed = tryParseObject(candidate);
    if (parsed) {
      return parsed;
    }
  }

  throw new SynthesisParseError(
    "Could not parse synthesis response as JSON",
    raw
  );
}

export class SynthesisParseError extends Error {
  readonly rawResponse: string;

  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = "SynthesisParseError";
    this.rawResponse = rawResponse;
  }
}

function tryParseObject(candidate: string): Record<string, unknown> | null {
  if (!candidate) return null;
  try {
    const value = JSON.parse(candidate);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function stripMarkdownFences(value: string): string {
  if (!value.startsWith("```")) return value;
  return value
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

/**
 * Build an ordered list of parse candidates. Earlier entries preserve more of
 * the model's original output; later entries apply heavier recovery (close
 * unclosed brackets, drop partial trailing entries).
 */
function buildParseCandidates(cleaned: string): string[] {
  const candidates = new Set<string>();

  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed) candidates.add(trimmed);
  };

  add(cleaned);

  const objectStart = cleaned.indexOf("{");
  if (objectStart > 0) {
    add(cleaned.slice(objectStart));
  }

  const balanced = extractBalancedObject(cleaned);
  if (balanced) {
    add(balanced);
  }

  const repaired = repairTruncatedObject(cleaned);
  if (repaired) {
    add(repaired);
    add(stripTrailingCommas(repaired));
  }

  const sanitized = stripLineComments(cleaned);
  if (sanitized !== cleaned) {
    add(sanitized);
    const sanitizedBalanced = extractBalancedObject(sanitized);
    if (sanitizedBalanced) add(sanitizedBalanced);
    const sanitizedRepaired = repairTruncatedObject(sanitized);
    if (sanitizedRepaired) {
      add(sanitizedRepaired);
      add(stripTrailingCommas(sanitizedRepaired));
    }
  }

  return [...candidates];
}

/**
 * Find the longest prefix (starting from the first `{`) that forms a
 * structurally balanced JSON object. Returns null if no complete object fits.
 * Uses a bracket/quote scanner that correctly ignores braces and brackets
 * that appear inside JSON strings.
 */
function extractBalancedObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;

  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = start; i < value.length; i++) {
    const ch = value[i]!;

    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const top = stack.pop();
      if (!top) return null;
      if ((ch === "}" && top !== "{") || (ch === "]" && top !== "[")) {
        return null;
      }
      if (stack.length === 0 && top === "{") {
        return value.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Repair a response that was truncated mid-output (e.g. the model hit its
 * output-token cap inside an array or string). Walks the response tracking
 * bracket/string state. If we end inside an unterminated string, rewinds up
 * the stack to the nearest comma of any ancestor depth, drops the partial
 * trailing sibling, and closes whatever containers are still open.
 */
function repairTruncatedObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;

  const stack: string[] = [];
  let inString = false;
  let escape = false;
  const lastCommaAtDepth = new Map<number, number>();

  for (let i = start; i < value.length; i++) {
    const ch = value[i]!;

    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const top = stack.pop();
      if (!top) return null;
      if ((ch === "}" && top !== "{") || (ch === "]" && top !== "[")) {
        return null;
      }
      // A comma at the depth of the container we just closed is no longer
      // meaningful once that container is done.
      lastCommaAtDepth.delete(stack.length + 1);
      if (stack.length === 0) {
        // Already structurally complete — no repair needed.
        return value.slice(start, i + 1);
      }
      continue;
    }
    if (ch === ",") {
      lastCommaAtDepth.set(stack.length, i);
      continue;
    }
  }

  if (stack.length === 0) {
    return null;
  }

  // Walk from the innermost depth outward looking for the nearest comma that
  // completed a sibling. Truncate to just before that comma and pop deeper
  // containers off the stack so only the container that holds the comma (and
  // all complete siblings before it) remains open.
  //
  // If we ended inside an unterminated string, the innermost container is
  // itself compromised (we were mid-value when truncated), so skip it and
  // rewind past a comma at one of its ancestors.
  const minDepth = inString ? Math.max(1, stack.length - 1) : stack.length;
  let endIndex = value.length - 1;
  let truncated = false;
  for (let depth = minDepth; depth >= 1; depth--) {
    const commaAt = lastCommaAtDepth.get(depth);
    if (typeof commaAt === "number") {
      endIndex = commaAt - 1;
      stack.length = depth;
      truncated = true;
      break;
    }
  }

  if (!truncated) {
    // No comma anywhere to fall back on — the response couldn't produce even a
    // single complete sibling. Nothing salvageable.
    return null;
  }

  let repaired = value.slice(start, endIndex + 1);
  repaired = stripTrailingCommas(repaired);

  for (let depth = stack.length - 1; depth >= 0; depth--) {
    repaired += stack[depth] === "{" ? "}" : "]";
  }

  return repaired;
}

function stripTrailingCommas(value: string): string {
  return value.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Remove `// ...` line comments that appear outside JSON strings. Some models
 * emit them despite the strict-JSON instructions.
 */
function stripLineComments(value: string): string {
  let out = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && value[i + 1] === "/") {
      // Skip through end of line.
      while (i < value.length && value[i] !== "\n") i++;
      if (i < value.length) out += "\n";
      continue;
    }

    out += ch;
  }

  return out;
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
