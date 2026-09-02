import fs from "node:fs/promises";
import path from "node:path";
import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { ToolExecutionResult } from "../agent/observation.js";
import type { InvestigationState } from "./types.js";
import { extractFileText } from "../extract/extract-text.js";
import { confineToDirectory, sanitizeFilename } from "../sanitize.js";

/** Max text returned per document read. */
const MAX_DOC_TEXT = 15000;
const INSTRUCTION_TITLE_KEYWORDS = [
  "spec",
  "instruction",
  "assignment",
  "lab",
  "project",
  "handout",
] as const;
const NON_INSTRUCTION_TITLE_KEYWORDS = [
  "rubric",
  "schedule",
  "calendar",
  "support",
  "faq",
  "template",
  "starter",
  "solution",
  "example",
] as const;

/**
 * Context passed to tool handlers — includes Canvas API access for on-demand downloads.
 */
export interface ToolContext {
  cache: CourseCache;
  state: InvestigationState;
  client: CanvasClient;
  config: Config;
  courseId: number;
}

export async function executeToolDetailed(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  switch (toolName) {
    case "search_modules":
      return searchModules(input.query as string, ctx.cache);
    case "get_module_items":
      return getModuleItems(input.module_name as string, ctx.cache);
    case "read_document":
      return readDocument(input.filename as string, ctx);
    case "download_module_file":
      return downloadModuleFile(input.item_title as string, ctx);
    case "get_syllabus":
      return getSyllabus(ctx);
    case "list_assignments":
      return listAssignments(ctx.cache, ctx.state);
    case "list_downloaded_files":
      return listDownloadedFiles(ctx.cache);
    case "search_files":
      return searchFiles(input.query as string, ctx.cache);
    default:
      return {
        observation: {
          tool: toolName,
          status: "error",
          summary: `Unknown tool: ${toolName}`,
          artifacts: [],
        },
        modelText: `Unknown tool: ${toolName}`,
        uiText: `Unknown tool: ${toolName}`,
      };
  }
}

function searchModules(query: string, cache: CourseCache): ToolExecutionResult {
  const q = query.toLowerCase();
  const results: string[] = [];

  for (const mod of cache.modules) {
    for (const item of mod.items) {
      if (item.title.toLowerCase().includes(q)) {
        const cid = item.contentId ? ` [contentId=${item.contentId}]` : "";
        results.push(
          `[${item.type}] "${item.title}" in module "${mod.name}"${cid}${item.htmlUrl ? ` (${item.htmlUrl})` : ""}`
        );
      }
    }
    if (mod.name.toLowerCase().includes(q)) {
      results.push(`Module: "${mod.name}" (${mod.items.length} items)`);
    }
  }

  if (results.length === 0) {
    const message = `No module items matching "${query}" found.`;
    return {
      observation: {
        tool: "search_modules",
        status: "not_found",
        summary: message,
        artifacts: [],
      },
      modelText: message,
      uiText: message,
    };
  }

  const rendered = results.join("\n");
  return {
    observation: {
      tool: "search_modules",
      status: "ok",
      summary: `Found ${results.length} module matches for "${query}".`,
      artifacts: [],
    },
    modelText: rendered,
    uiText: rendered,
  };
}

function getModuleItems(moduleName: string, cache: CourseCache): ToolExecutionResult {
  const q = moduleName.toLowerCase();
  const mod = cache.modules.find((m) => m.name.toLowerCase().includes(q));

  if (!mod) {
    const message = `No module matching "${moduleName}" found.`;
    return {
      observation: {
        tool: "get_module_items",
        status: "not_found",
        summary: message,
        artifacts: [],
      },
      modelText: message,
      uiText: message,
    };
  }

  const lines = [`Module: ${mod.name} (${mod.items.length} items)`];
  for (const item of mod.items) {
    const cid = item.contentId ? ` [contentId=${item.contentId}]` : "";
    const downloadable = item.type === "File" ? " [DOWNLOADABLE]" : "";
    lines.push(
      `  ${item.position}. [${item.type}] ${item.title}${cid}${downloadable}`
    );
  }
  const rendered = lines.join("\n");
  return {
    observation: {
      tool: "get_module_items",
      status: "ok",
      summary: `Listed ${mod.items.length} items from module "${mod.name}".`,
      artifacts: [],
    },
    modelText: rendered,
    uiText: rendered,
  };
}

async function readDocument(
  filename: string,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const { cache, state } = ctx;

  // Check if already extracted in this session
  if (state.extractedTexts.has(filename)) {
    const cached = state.extractedTexts.get(filename)!;
    maybeRememberPrimaryInstructionSource(state, filename, filename);
    return {
      observation: {
        tool: "read_document",
        status: "ok",
        summary: `Read ${filename} from cached investigation text.`,
        artifacts: [],
        content: cached,
      },
      modelText: cached,
      uiText: cached,
    };
  }

  // Find the attachment in cache
  const att = cache.attachments.find(
    (a) =>
      (a.originalFilename.toLowerCase() === filename.toLowerCase() ||
        a.originalFilename.toLowerCase().includes(filename.toLowerCase())) &&
      (a.status === "downloaded" || a.status === "skipped")
  );

  if (!att) {
    const message = `File "${filename}" not found in downloaded attachments. Use list_downloaded_files to see available files, or use download_module_file to download a file from a module.`;
    return {
      observation: {
        tool: "read_document",
        status: "not_found",
        summary: message,
        artifacts: [],
      },
      modelText: message,
      uiText: message,
    };
  }

  const fullPath = path.join(cache.coursePath, att.localPath);
  const text = await extractFileText(fullPath, att.originalFilename);

  const truncated =
    text.length > MAX_DOC_TEXT
      ? text.slice(0, MAX_DOC_TEXT) + "\n[...truncated]"
      : text;

  state.extractedTexts.set(filename, truncated);
  state.visitedSources.push(filename);
  maybeRememberPrimaryInstructionSource(
    state,
    att.originalFilename,
    filename
  );

  return {
    observation: {
      tool: "read_document",
      status: "ok",
      summary: `Read ${att.originalFilename}.`,
      artifacts: [],
      content: truncated,
    },
    modelText: truncated,
    uiText: truncated,
  };
}

/**
 * Download a file from a course module on-demand via Canvas API.
 * Finds the module item by title, gets file metadata, downloads, extracts text.
 */
async function downloadModuleFile(
  itemTitle: string,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const { cache, state, client } = ctx;
  const q = itemTitle.toLowerCase();

  // Check if already extracted
  if (state.extractedTexts.has(itemTitle)) {
    const cached = state.extractedTexts.get(itemTitle)!;
    maybeRememberPrimaryInstructionSource(state, itemTitle);
    return {
      observation: {
        tool: "download_module_file",
        status: "ok",
        summary: `Reused previously extracted text for "${itemTitle}".`,
        artifacts: [],
        content: cached,
      },
      modelText: cached,
      uiText: cached,
    };
  }

  // Find the module item
  let foundItem = null;
  let foundModName = "";
  for (const mod of cache.modules) {
    for (const item of mod.items) {
      if (item.type === "File" && item.title.toLowerCase().includes(q)) {
        foundItem = item;
        foundModName = mod.name;
        break;
      }
    }
    if (foundItem) break;
  }

  if (!foundItem || !foundItem.contentId) {
    const message = `No downloadable file matching "${itemTitle}" found in modules. Use search_modules to find available files.`;
    return {
      observation: {
        tool: "download_module_file",
        status: "not_found",
        summary: message,
        artifacts: [],
      },
      modelText: message,
      uiText: message,
    };
  }

  // Check if already downloaded during ingestion
  const existingAtt = cache.attachments.find(
    (a) =>
      a.canvasFileId === foundItem!.contentId &&
      (a.status === "downloaded" || a.status === "skipped")
  );
  if (existingAtt) {
    // Already downloaded — just read it
    return readDocument(existingAtt.originalFilename, ctx);
  }

  // Fetch file metadata from Canvas API
  const fileMeta = await client.getFileSafe(foundItem.contentId);
  if (!fileMeta) {
    const message = `Could not access file metadata for "${itemTitle}" (Canvas file ID ${foundItem.contentId}). The Files API may be blocked for this course.`;
    return {
      observation: {
        tool: "download_module_file",
        status: "error",
        summary: message,
        artifacts: [],
      },
      modelText: message,
      uiText: message,
    };
  }

  // Download the file
  const buffer = await client.downloadFile(fileMeta.url);
  if (!buffer) {
    const message = `Could not download "${fileMeta.display_name}" from Canvas.`;
    return {
      observation: {
        tool: "download_module_file",
        status: "error",
        summary: message,
        artifacts: [],
      },
      modelText: message,
      uiText: message,
    };
  }

  // Save locally in the course cache
  const downloadDir = path.join(cache.coursePath, "attachments", "modules");
  await fs.mkdir(downloadDir, { recursive: true });
  const localFilePath = confineToDirectory(
    downloadDir,
    sanitizeFilename(fileMeta.display_name)
  );
  await fs.writeFile(localFilePath, buffer);

  // Extract text
  const text = await extractFileText(localFilePath, fileMeta.display_name);

  const truncated =
    text.length > MAX_DOC_TEXT
      ? text.slice(0, MAX_DOC_TEXT) + "\n[...truncated]"
      : text;

  state.extractedTexts.set(fileMeta.display_name, truncated);
  state.extractedTexts.set(itemTitle, truncated);
  state.visitedSources.push(fileMeta.display_name);
  maybeRememberPrimaryInstructionSource(
    state,
    fileMeta.display_name,
    foundItem.title,
    itemTitle
  );

  const rendered = `Downloaded and extracted text from "${fileMeta.display_name}" (${buffer.length} bytes):\n\n${truncated}`;
  return {
    observation: {
      tool: "download_module_file",
      status: "ok",
      summary: `Downloaded and read "${fileMeta.display_name}" from module "${foundModName}".`,
      artifacts: [],
      content: truncated,
    },
    modelText: rendered,
    uiText: rendered,
  };
}

async function getSyllabus(ctx: ToolContext): Promise<ToolExecutionResult> {
  const { cache, state } = ctx;
  const syllabusPath = path.join(
    cache.coursePath,
    "extracted",
    "syllabus-body.txt"
  );
  try {
    const text = await fs.readFile(syllabusPath, "utf-8");
    if (text.trim().length < 50) {
      return {
        observation: {
          tool: "get_syllabus",
          status: "missing_text",
          summary: "Course syllabus is empty or trivial.",
          artifacts: [],
        },
        modelText: "Course syllabus is empty or trivial.",
        uiText: "Course syllabus is empty or trivial.",
      };
    }
    state.visitedSources.push("syllabus");
    const truncated =
      text.length > MAX_DOC_TEXT
        ? text.slice(0, MAX_DOC_TEXT) + "\n[...truncated]"
        : text;
    state.extractedTexts.set("syllabus-body.txt", truncated);
    rememberDueDateSource(state, "syllabus");
    return {
      observation: {
        tool: "get_syllabus",
        status: "ok",
        summary: "Read the course syllabus.",
        artifacts: [],
        content: truncated,
      },
      modelText: truncated,
      uiText: truncated,
    };
  } catch {
    const message = "No syllabus text available for this course.";
    return {
      observation: {
        tool: "get_syllabus",
        status: "not_found",
        summary: message,
        artifacts: [],
      },
      modelText: message,
      uiText: message,
    };
  }
}

function listAssignments(
  cache: CourseCache,
  state: InvestigationState
): ToolExecutionResult {
  if (cache.assignments.length === 0)
    return {
      observation: {
        tool: "list_assignments",
        status: "not_found",
        summary: "No assignments found in course cache.",
        artifacts: [],
      },
      modelText: "No assignments found in course cache.",
      uiText: "No assignments found in course cache.",
    };

  const lines: string[] = [];
  for (const a of cache.assignments) {
    const due = a.dueAt
      ? new Date(a.dueAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "no due date";
    const pts = a.pointsPossible !== null ? `(${a.pointsPossible} pts)` : "";
    lines.push(`- ${a.name} — ${due} ${pts}`.trim());
  }
  const matchingDueDateSource = findMatchingAssignmentDueDateSourceId(
    cache,
    state.assignmentName
  );
  if (matchingDueDateSource) {
    rememberDueDateSource(state, matchingDueDateSource);
  }
  const rendered = lines.join("\n");
  return {
    observation: {
      tool: "list_assignments",
      status: "ok",
      summary: `Listed ${cache.assignments.length} course assignments.`,
      artifacts: [],
    },
    modelText: rendered,
    uiText: rendered,
  };
}

function listDownloadedFiles(cache: CourseCache): ToolExecutionResult {
  const downloaded = cache.attachments.filter(
    (a) => a.status === "downloaded" || a.status === "skipped"
  );

  if (downloaded.length === 0)
    return {
      observation: {
        tool: "list_downloaded_files",
        status: "not_found",
        summary: "No files were downloaded during ingestion. Use download_module_file to download files from modules on-demand.",
        artifacts: [],
      },
      modelText:
        "No files were downloaded during ingestion. Use download_module_file to download files from modules on-demand.",
      uiText:
        "No files were downloaded during ingestion. Use download_module_file to download files from modules on-demand.",
    };

  const lines: string[] = [];
  for (const a of downloaded) {
    lines.push(
      `- ${a.originalFilename} [${a.sourceType}] (${a.contentType ?? "unknown type"}) — ${a.reason}`
    );
  }
  const rendered = lines.join("\n");
  return {
    observation: {
      tool: "list_downloaded_files",
      status: "ok",
      summary: `Listed ${downloaded.length} downloaded files.`,
      artifacts: [],
    },
    modelText: rendered,
    uiText: rendered,
  };
}

function searchFiles(query: string, cache: CourseCache): ToolExecutionResult {
  const q = query.toLowerCase();
  const matches = cache.files.filter(
    (f) =>
      f.displayName.toLowerCase().includes(q) ||
      f.filename.toLowerCase().includes(q)
  );

  if (matches.length === 0)
    return {
      observation: {
        tool: "search_files",
        status: "not_found",
        summary: `No files matching "${query}" found in course file index.`,
        artifacts: [],
      },
      modelText: `No files matching "${query}" found in course file index.`,
      uiText: `No files matching "${query}" found in course file index.`,
    };

  const lines: string[] = [];
  for (const f of matches) {
    const size =
      f.size < 1024 * 1024
        ? `${(f.size / 1024).toFixed(0)} KB`
        : `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
    lines.push(`- ${f.displayName} (${f.contentType}, ${size})`);
  }
  const rendered = lines.join("\n");
  return {
    observation: {
      tool: "search_files",
      status: "ok",
      summary: `Found ${matches.length} file index matches for "${query}".`,
      artifacts: [],
    },
    modelText: rendered,
    uiText: rendered,
  };
}

// extractFileText imported from ../extract/extract-text.js
// Handles PDF, text, HTML, ZIP, and code files

function maybeRememberPrimaryInstructionSource(
  state: InvestigationState,
  ...candidateTitles: string[]
): void {
  const matchedTitle = candidateTitles.find((title) =>
    isLikelyPrimaryInstructionDocument(title)
  );
  if (!matchedTitle) {
    return;
  }
  rememberPrimaryInstructionSource(state, `document:${matchedTitle}`);
}

function isLikelyPrimaryInstructionDocument(title: string): boolean {
  const normalized = normalizeComparisonText(title);
  if (!normalized) {
    return false;
  }

  if (
    NON_INSTRUCTION_TITLE_KEYWORDS.some((keyword) =>
      normalized.includes(keyword)
    )
  ) {
    return false;
  }

  return INSTRUCTION_TITLE_KEYWORDS.some((keyword) =>
    normalized.includes(keyword)
  );
}

function findMatchingAssignmentDueDateSourceId(
  cache: CourseCache,
  assignmentName: string
): string | null {
  const match = cache.assignments.find(
    (assignment) =>
      Boolean(assignment.dueAt) &&
      assignmentNamesLikelyMatch(assignment.name, assignmentName)
  );
  if (!match?.dueAt) {
    return null;
  }
  return `assignment:${match.id}`;
}

function assignmentNamesLikelyMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparisonText(left);
  const normalizedRight = normalizeComparisonText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

function normalizeComparisonText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function rememberPrimaryInstructionSource(
  state: InvestigationState,
  sourceId: string
): void {
  if (!state.primaryInstructionSourceIds.includes(sourceId)) {
    state.primaryInstructionSourceIds.push(sourceId);
  }
}

function rememberDueDateSource(
  state: InvestigationState,
  sourceId: string
): void {
  if (!state.dueDateSourceIds.includes(sourceId)) {
    state.dueDateSourceIds.push(sourceId);
  }
}
