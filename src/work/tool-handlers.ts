import fs from "node:fs/promises";
import path from "node:path";
import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { InvestigationState } from "./types.js";
import { extractFileText } from "../extract/extract-text.js";

/** Max text returned per document read. */
const MAX_DOC_TEXT = 15000;

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

/**
 * Execute a tool call and return the result string.
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
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
      return listAssignments(ctx.cache);
    case "list_downloaded_files":
      return listDownloadedFiles(ctx.cache);
    case "search_files":
      return searchFiles(input.query as string, ctx.cache);
    case "complete_investigation":
      return "Investigation complete. Proceeding to synthesis.";
    default:
      return `Unknown tool: ${toolName}`;
  }
}

function searchModules(query: string, cache: CourseCache): string {
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

  if (results.length === 0) return `No module items matching "${query}" found.`;
  return results.join("\n");
}

function getModuleItems(moduleName: string, cache: CourseCache): string {
  const q = moduleName.toLowerCase();
  const mod = cache.modules.find((m) => m.name.toLowerCase().includes(q));

  if (!mod) return `No module matching "${moduleName}" found.`;

  const lines = [`Module: ${mod.name} (${mod.items.length} items)`];
  for (const item of mod.items) {
    const cid = item.contentId ? ` [contentId=${item.contentId}]` : "";
    const downloadable = item.type === "File" ? " [DOWNLOADABLE]" : "";
    lines.push(
      `  ${item.position}. [${item.type}] ${item.title}${cid}${downloadable}`
    );
  }
  return lines.join("\n");
}

async function readDocument(filename: string, ctx: ToolContext): Promise<string> {
  const { cache, state } = ctx;

  // Check if already extracted in this session
  if (state.extractedTexts.has(filename)) {
    return state.extractedTexts.get(filename)!;
  }

  // Find the attachment in cache
  const att = cache.attachments.find(
    (a) =>
      (a.originalFilename.toLowerCase() === filename.toLowerCase() ||
        a.originalFilename.toLowerCase().includes(filename.toLowerCase())) &&
      (a.status === "downloaded" || a.status === "skipped")
  );

  if (!att) {
    return `File "${filename}" not found in downloaded attachments. Use list_downloaded_files to see available files, or use download_module_file to download a file from a module.`;
  }

  const fullPath = path.join(cache.coursePath, att.localPath);
  const text = await extractFileText(fullPath, att.originalFilename);

  const truncated =
    text.length > MAX_DOC_TEXT
      ? text.slice(0, MAX_DOC_TEXT) + "\n[...truncated]"
      : text;

  state.extractedTexts.set(filename, truncated);
  state.visitedSources.push(filename);

  return truncated;
}

/**
 * Download a file from a course module on-demand via Canvas API.
 * Finds the module item by title, gets file metadata, downloads, extracts text.
 */
async function downloadModuleFile(
  itemTitle: string,
  ctx: ToolContext
): Promise<string> {
  const { cache, state, client } = ctx;
  const q = itemTitle.toLowerCase();

  // Check if already extracted
  if (state.extractedTexts.has(itemTitle)) {
    return state.extractedTexts.get(itemTitle)!;
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
    return `No downloadable file matching "${itemTitle}" found in modules. Use search_modules to find available files.`;
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
    return `Could not access file metadata for "${itemTitle}" (Canvas file ID ${foundItem.contentId}). The Files API may be blocked for this course.`;
  }

  // Download the file
  const buffer = await client.downloadFile(fileMeta.url);
  if (!buffer) {
    return `Could not download "${fileMeta.display_name}" from Canvas.`;
  }

  // Save locally in the course cache
  const downloadDir = path.join(cache.coursePath, "attachments", "modules");
  await fs.mkdir(downloadDir, { recursive: true });
  const localFilePath = path.join(downloadDir, fileMeta.display_name);
  await fs.writeFile(localFilePath, buffer);

  // Extract text
  const text = await extractFileText(localFilePath, fileMeta.display_name);

  const truncated =
    text.length > MAX_DOC_TEXT
      ? text.slice(0, MAX_DOC_TEXT) + "\n[...truncated]"
      : text;

  state.extractedTexts.set(fileMeta.display_name, truncated);
  state.visitedSources.push(fileMeta.display_name);

  return `Downloaded and extracted text from "${fileMeta.display_name}" (${buffer.length} bytes):\n\n${truncated}`;
}

async function getSyllabus(ctx: ToolContext): Promise<string> {
  const { cache, state } = ctx;
  const syllabusPath = path.join(
    cache.coursePath,
    "extracted",
    "syllabus-body.txt"
  );
  try {
    const text = await fs.readFile(syllabusPath, "utf-8");
    if (text.trim().length < 50) return "Course syllabus is empty or trivial.";
    state.visitedSources.push("syllabus");
    const truncated =
      text.length > MAX_DOC_TEXT
        ? text.slice(0, MAX_DOC_TEXT) + "\n[...truncated]"
        : text;
    state.extractedTexts.set("syllabus-body.txt", truncated);
    return truncated;
  } catch {
    return "No syllabus text available for this course.";
  }
}

function listAssignments(cache: CourseCache): string {
  if (cache.assignments.length === 0)
    return "No assignments found in course cache.";

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
  return lines.join("\n");
}

function listDownloadedFiles(cache: CourseCache): string {
  const downloaded = cache.attachments.filter(
    (a) => a.status === "downloaded" || a.status === "skipped"
  );

  if (downloaded.length === 0)
    return "No files were downloaded during ingestion. Use download_module_file to download files from modules on-demand.";

  const lines: string[] = [];
  for (const a of downloaded) {
    lines.push(
      `- ${a.originalFilename} [${a.sourceType}] (${a.contentType ?? "unknown type"}) — ${a.reason}`
    );
  }
  return lines.join("\n");
}

function searchFiles(query: string, cache: CourseCache): string {
  const q = query.toLowerCase();
  const matches = cache.files.filter(
    (f) =>
      f.displayName.toLowerCase().includes(q) ||
      f.filename.toLowerCase().includes(q)
  );

  if (matches.length === 0)
    return `No files matching "${query}" found in course file index.`;

  const lines: string[] = [];
  for (const f of matches) {
    const size =
      f.size < 1024 * 1024
        ? `${(f.size / 1024).toFixed(0)} KB`
        : `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
    lines.push(`- ${f.displayName} (${f.contentType}, ${size})`);
  }
  return lines.join("\n");
}

// extractFileText imported from ../extract/extract-text.js
// Handles PDF, text, HTML, ZIP, and code files
