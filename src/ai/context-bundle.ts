import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = require("pdf-parse");
import type { AssignmentDetail } from "../domain/models.js";
import type { EnrichmentSummary } from "../enrich/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import { htmlToText } from "../format/html-to-text.js";

/**
 * Assembled context bundle for the AI model.
 * Includes real content from ingested course data — PDFs, syllabus, modules.
 */
export interface ContextBundle {
  assignmentName: string;
  courseName: string;
  dueDate: string | null;
  pointsPossible: number | null;
  gradingType: string;
  submissionTypes: string[];
  canvasDescriptionText: string | null;
  enrichmentFlags: {
    hasWeakCanvasDescription: boolean;
    missingDueDate: boolean;
    likelySubmissionShell: boolean;
  };
  /** Compact module structure for context. */
  moduleStructure: string | null;
  /** Full course assignment list for cross-referencing. */
  assignmentList: string | null;
  /** Extracted text content from sources. */
  extractedTexts: Array<{
    source: string;
    content: string;
  }>;
}

/** Per-source text limit. Generous enough for real instructions. */
const MAX_TEXT_PER_SOURCE = 8000;
/** Max total extracted text across all sources to keep prompt reasonable. */
const MAX_TOTAL_TEXT = 30000;

/**
 * Build a rich context bundle for the AI from assignment detail,
 * enrichment data, and the course cache.
 *
 * Reads PDFs, always includes syllabus, includes module structure
 * and assignment list for cross-referencing due dates.
 */
export async function buildContextBundle(
  detail: AssignmentDetail,
  enrichment: EnrichmentSummary | null,
  cache: CourseCache | null
): Promise<ContextBundle> {
  const canvasText = detail.description
    ? htmlToText(detail.description).trim()
    : null;

  const bundle: ContextBundle = {
    assignmentName: detail.name,
    courseName: detail.courseName,
    dueDate: detail.dueAt?.toISOString() ?? null,
    pointsPossible: detail.pointsPossible,
    gradingType: detail.gradingType,
    submissionTypes: detail.submissionTypes,
    canvasDescriptionText: canvasText && canvasText.length > 0 ? canvasText : null,
    enrichmentFlags: enrichment?.flags ?? {
      hasWeakCanvasDescription: !canvasText || canvasText.length < 30,
      missingDueDate: detail.dueAt === null,
      likelySubmissionShell: false,
    },
    moduleStructure: null,
    assignmentList: null,
    extractedTexts: [],
  };

  if (!cache) return bundle;

  // Build compact module structure
  bundle.moduleStructure = buildModuleStructure(cache);

  // Build assignment list for cross-referencing
  bundle.assignmentList = buildAssignmentList(cache);

  // Load extracted texts: syllabus, then all downloaded attachments
  let totalTextLoaded = 0;

  // 1. Always include syllabus body if it exists
  const syllabusTextPath = path.join(cache.coursePath, "extracted", "syllabus-body.txt");
  const syllabusText = await readTextSafe(syllabusTextPath);
  if (syllabusText && syllabusText.length > 50) {
    const content = truncate(syllabusText, MAX_TEXT_PER_SOURCE);
    bundle.extractedTexts.push({
      source: "Course syllabus",
      content,
    });
    totalTextLoaded += content.length;
  }

  // 2. Read ALL downloaded attachments (PDFs, text, html, etc.)
  for (const att of cache.attachments) {
    if (att.status !== "downloaded" && att.status !== "skipped") continue;
    if (totalTextLoaded >= MAX_TOTAL_TEXT) break;

    const fullPath = path.join(cache.coursePath, att.localPath);
    const text = await extractFileText(fullPath, att.originalFilename);
    if (text && text.length > 20) {
      const content = truncate(text, MAX_TEXT_PER_SOURCE);
      bundle.extractedTexts.push({
        source: att.originalFilename,
        content,
      });
      totalTextLoaded += content.length;
    }
  }

  // 3. Read related attachments from enrichment that aren't already loaded
  if (enrichment) {
    const loadedSources = new Set(bundle.extractedTexts.map((t) => t.source));
    for (const att of enrichment.relatedAttachments) {
      if (totalTextLoaded >= MAX_TOTAL_TEXT) break;
      if (loadedSources.has(att.filename)) continue;

      const fullPath = path.join(cache.coursePath, att.localPath);
      const text = await extractFileText(fullPath, att.filename);
      if (text && text.length > 20) {
        const content = truncate(text, MAX_TEXT_PER_SOURCE);
        bundle.extractedTexts.push({
          source: att.filename,
          content,
        });
        totalTextLoaded += content.length;
      }
    }
  }

  return bundle;
}

/**
 * Build a compact module structure string for context.
 * Shows module names and their items with types.
 */
function buildModuleStructure(cache: CourseCache): string | null {
  if (cache.modules.length === 0) return null;

  const lines: string[] = [];
  for (const mod of cache.modules) {
    lines.push(`Module: ${mod.name}`);
    for (const item of mod.items) {
      lines.push(`  - [${item.type}] ${item.title}`);
    }
  }
  return lines.join("\n");
}

/**
 * Build a compact assignment list for cross-referencing due dates.
 */
function buildAssignmentList(cache: CourseCache): string | null {
  if (cache.assignments.length === 0) return null;

  const lines: string[] = [];
  for (const a of cache.assignments) {
    const due = a.dueAt ? new Date(a.dueAt).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    }) : "no due date";
    const pts = a.pointsPossible !== null ? `${a.pointsPossible}pts` : "";
    lines.push(`- ${a.name} — ${due} ${pts}`.trim());
  }
  return lines.join("\n");
}

/**
 * Extract text from a file. Supports PDF, plain text, HTML, and markdown.
 */
async function extractFileText(
  filePath: string,
  filename: string
): Promise<string | null> {
  const ext = path.extname(filename).toLowerCase();

  try {
    if (ext === ".pdf") {
      return await extractPdfText(filePath);
    }
    if ([".txt", ".md"].includes(ext)) {
      return await readTextSafe(filePath);
    }
    if ([".html", ".htm"].includes(ext)) {
      const raw = await readTextSafe(filePath);
      return raw ? htmlToText(raw) : null;
    }
    // Skip binary/unsupported formats
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract text from a PDF file using pdf-parse.
 */
async function extractPdfText(filePath: string): Promise<string | null> {
  try {
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    return data.text?.trim() || null;
  } catch {
    return null;
  }
}

async function readTextSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n[...truncated]";
}
