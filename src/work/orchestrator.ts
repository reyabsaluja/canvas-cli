import type { AssignmentDetail, Course } from "../domain/models.js";
import type { EnrichmentSummary } from "../enrich/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { Config } from "../config/env.js";
import type { CanvasClient } from "../canvas/client.js";
import type { AssignmentWorkup, InvestigationState } from "./types.js";
import type { ToolContext } from "./tool-handlers.js";
import {
  generateWithTools,
  type AIProviderConfig,
} from "../ai/provider.js";
import { INVESTIGATION_TOOLS } from "./tools.js";
import { executeTool } from "./tool-handlers.js";
import { synthesizeWorkup } from "./synthesis.js";
import { htmlToText } from "../format/html-to-text.js";

/** Max tool-calling iterations before forcing synthesis. */
const MAX_ITERATIONS = 15;

const INVESTIGATION_SYSTEM_PROMPT = `You are an academic assignment investigator. Your job is to deeply understand what an assignment really requires by examining actual course materials — PDFs, syllabi, module contents, and other documents.

You have tools to search modules, list downloaded files, read documents, download module files on-demand, and check the syllabus.

CRITICAL RULES:
- You MUST actually READ the instruction documents, not just list them. Titles alone are not enough.
- If you find a relevant file (like "Lab4_Second-order-Circuits.pdf"), READ IT using read_document or download_module_file.
- Do NOT call complete_investigation until you have read at least the primary instruction document for this assignment.
- If list_downloaded_files shows the file you need, use read_document to read it.
- If the file isn't downloaded, use download_module_file to fetch it from the module.
- Always check the syllabus for due dates and schedule info.

Strategy:
1. list_downloaded_files — see what's already available locally
2. search_modules with the assignment name — find the instruction PDF or related files
3. get_module_items on the relevant module — see all context around the assignment
4. READ the instruction document (read_document if downloaded, download_module_file if not)
5. READ any rubric or grading document you find
6. get_syllabus — check for due dates and schedule
7. list_assignments — cross-reference timeline
8. ONLY THEN call complete_investigation with a detailed summary of what you learned from reading the documents

Be thorough. The student is depending on you to actually read and understand the assignment instructions.`;

export interface InvestigationResult {
  workup: AssignmentWorkup;
  state: InvestigationState;
}

/**
 * Run the investigation agent loop.
 */
export async function runInvestigation(
  aiConfig: AIProviderConfig,
  detail: AssignmentDetail,
  course: Course,
  enrichment: EnrichmentSummary | null,
  cache: CourseCache,
  client: CanvasClient,
  config: Config,
  onProgress: (phase: string) => void
): Promise<InvestigationResult> {
  const state: InvestigationState = {
    assignmentName: detail.name,
    courseName: course.name,
    visitedSources: [],
    extractedTexts: new Map(),
    evidenceNotes: [],
    toolCallCount: 0,
  };

  const toolCtx: ToolContext = {
    cache,
    state,
    client,
    config,
    courseId: course.id,
  };

  // Build initial context message
  const initialMessage = buildInitialMessage(detail, enrichment, cache);

  onProgress("investigating course materials");

  // Run investigation using AI SDK's built-in tool loop
  let investigationSummary = "";

  const result = await generateWithTools(
    aiConfig,
    INVESTIGATION_SYSTEM_PROMPT,
    [{ role: "user", content: initialMessage }],
    INVESTIGATION_TOOLS,
    async (name, input) => {
      state.toolCallCount++;

      if (name === "complete_investigation") {
        investigationSummary = (input as any).summary ?? "";
        return "Investigation complete. Proceeding to synthesis.";
      }

      const label = input.query ?? input.filename ?? input.item_title ?? input.module_name ?? "";
      onProgress(`${name}${label ? ` (${label})` : ""}`);

      return executeTool(name, input, toolCtx);
    },
    undefined,
    MAX_ITERATIONS
  );

  if (!investigationSummary && result.text) {
    investigationSummary = result.text;
  }

  // Synthesis phase
  onProgress("synthesizing assignment workup");

  const workup = await synthesizeWorkup(
    aiConfig,
    detail,
    course,
    enrichment,
    state,
    investigationSummary
  );

  return { workup, state };
}

/**
 * Build the initial context message — includes full module structure
 * so the agent knows exactly what files exist upfront.
 */
function buildInitialMessage(
  detail: AssignmentDetail,
  enrichment: EnrichmentSummary | null,
  cache: CourseCache
): string {
  const sections: string[] = [];

  sections.push("# Assignment to investigate\n");
  sections.push(`**Name:** ${detail.name}`);
  sections.push(`**Course:** ${detail.courseName}`);
  sections.push(`**Canvas ID:** ${detail.id}`);
  sections.push(`**Due:** ${detail.dueAt?.toISOString() ?? "NOT SET"}`);
  if (detail.pointsPossible !== null) sections.push(`**Points:** ${detail.pointsPossible}`);
  if (detail.submissionTypes.length > 0) {
    sections.push(`**Submission types:** ${detail.submissionTypes.join(", ")}`);
  }
  sections.push(`**URL:** ${detail.htmlUrl}`);

  if (detail.description) {
    const text = htmlToText(detail.description).trim();
    if (text.length > 0) {
      sections.push(`\n## Canvas description\n${text}`);
    } else {
      sections.push("\n## Canvas description\n(empty — instructions likely live in module files)");
    }
  } else {
    sections.push("\n## Canvas description\n(none — instructions likely live in module files)");
  }

  // Full module structure — this is key for the agent to know what's available
  if (cache.modules.length > 0) {
    sections.push("\n## Full course module structure");
    sections.push("(Files marked [File] can be read with read_document or downloaded with download_module_file)\n");
    for (const mod of cache.modules) {
      sections.push(`### ${mod.name}`);
      for (const item of mod.items) {
        const downloadable = item.type === "File" ? " [DOWNLOADABLE]" : "";
        sections.push(`  ${item.position}. [${item.type}] ${item.title}${downloadable}`);
      }
      sections.push("");
    }
  }

  // Downloaded files
  const downloaded = cache.attachments.filter(
    (a) => a.status === "downloaded" || a.status === "skipped"
  );
  if (downloaded.length > 0) {
    sections.push("## Already downloaded files (readable with read_document)");
    for (const a of downloaded) {
      sections.push(`- ${a.originalFilename}`);
    }
    sections.push("");
  }

  if (enrichment) {
    sections.push("## Enrichment analysis");
    if (enrichment.flags.hasWeakCanvasDescription) {
      sections.push("- Canvas description is weak/incomplete — real instructions are elsewhere");
    }
    if (enrichment.flags.likelySubmissionShell) {
      sections.push("- This is likely a submission-only endpoint; instructions live in module files");
    }
    if (enrichment.relatedModuleItems.length > 0) {
      sections.push("- Related module items:");
      for (const item of enrichment.relatedModuleItems) {
        sections.push(`  - [${item.type}] "${item.title}" in "${item.moduleName}"`);
      }
    }
  }

  sections.push("\n## Your task");
  sections.push("Find and READ the actual instruction documents for this assignment. Do not complete investigation until you have read the primary instruction PDF/document.");

  return sections.join("\n");
}
