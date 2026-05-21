import path from "node:path";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { DownloadedAttachmentEntry } from "../ingest/types.js";
import { escapeTableCell } from "./format-table-utils.js";

const MAX_TABLE_ROWS = 50;
const MAX_INDEX_ROWS = 12;

export function formatCourseFilesList(cache: CourseCache): string {
  const cached = cache.attachments.filter(
    (attachment) =>
      attachment.status === "downloaded" || attachment.status === "skipped"
  );
  const indexed = cache.files;

  if (cached.length === 0 && indexed.length === 0) {
    return "No cached files yet. Open a workspace or run course ingestion first.";
  }

  const lines: string[] = [];

  if (cached.length > 0) {
    lines.push(...buildFilesTable(cached));
  }

  if (indexed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...buildIndexedTable(indexed));
  }

  lines.push("", "Use `/open <name>` to open a file.");
  return lines.join("\n").trim();
}

function buildFilesTable(attachments: DownloadedAttachmentEntry[]): string[] {
  const sorted = [...attachments].sort(compareFilenames);
  const visible = sorted.slice(0, MAX_TABLE_ROWS);
  const hidden = sorted.length - visible.length;

  const lines: string[] = [
    "| Name | Type | Size |",
    "| --- | --- | --- |",
  ];

  for (const attachment of visible) {
    lines.push(
      `| ${escapeTableCell(attachment.originalFilename)} | **${formatTypeCell(attachment.originalFilename)}** | ${formatFileSize(attachment.size)} |`
    );
  }

  if (hidden > 0) {
    lines.push("");
    lines.push(
      `… and ${hidden} more file${hidden === 1 ? "" : "s"} — use \`/open <name>\` or ask me to find one.`
    );
  }

  return lines;
}

function buildIndexedTable(files: CourseCache["files"]): string[] {
  const sorted = [...files].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
  const visible = sorted.slice(0, MAX_INDEX_ROWS);
  const hidden = sorted.length - visible.length;

  const lines: string[] = ["| Name | Size |", "| --- | --- |"];

  for (const file of visible) {
    lines.push(
      `| ${escapeTableCell(file.displayName)} | ${formatFileSize(file.size)} |`
    );
  }

  if (hidden > 0) {
    lines.push("");
    lines.push(`… and ${hidden} more in the Canvas index.`);
  }

  return lines;
}

function formatTypeCell(filename: string): string {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  switch (ext) {
    case "pdf":
      return "PDF";
    case "zip":
      return "ZIP";
    case "xlsx":
    case "xls":
      return "SHEET";
    case "doc":
    case "docx":
      return "DOC";
    case "ppt":
    case "pptx":
      return "SLIDES";
    case "txt":
    case "md":
      return "TEXT";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
      return "IMAGE";
    case "c":
    case "cpp":
    case "cc":
    case "h":
      return "CODE";
    case "s":
    case "asm":
      return "ASM";
    default:
      return (ext || "FILE").toUpperCase().slice(0, 6);
  }
}

function compareFilenames(
  a: DownloadedAttachmentEntry,
  b: DownloadedAttachmentEntry
): number {
  return a.originalFilename.localeCompare(b.originalFilename, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
