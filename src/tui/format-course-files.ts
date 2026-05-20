import path from "node:path";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { DownloadedAttachmentEntry } from "../ingest/types.js";

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
    lines.push(...formatCachedFilesTable(cached));
  }

  if (indexed.length > 0) {
    if (lines.length > 0) {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    lines.push(...formatIndexedFilesTable(indexed));
  }

  lines.push("", "Use `/open <name>` to open a file.");
  return lines.join("\n").trim();
}

function formatCachedFilesTable(attachments: DownloadedAttachmentEntry[]): string[] {
  const sorted = [...attachments].sort(compareFilenames);
  const visible = sorted.slice(0, MAX_TABLE_ROWS);
  const hidden = sorted.length - visible.length;

  const lines: string[] = [
    `**Files** · ${sorted.length} cached locally`,
    "",
    formatTypeSummary(sorted),
    "",
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
    lines.push(`… and ${hidden} more file${hidden === 1 ? "" : "s"} — use \`/open <name>\` or ask me to find one.`);
  }

  return lines;
}

function formatIndexedFilesTable(files: CourseCache["files"]): string[] {
  const sorted = [...files].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
  const visible = sorted.slice(0, MAX_INDEX_ROWS);
  const hidden = sorted.length - visible.length;

  const lines: string[] = [
    `**Canvas index** · ${sorted.length} on Canvas`,
    "",
    "| Name | Size |",
    "| --- | --- |",
  ];

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

function formatTypeSummary(attachments: DownloadedAttachmentEntry[]): string {
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    const label = formatTypeCell(attachment.originalFilename);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const order = ["PDF", "ZIP", "CODE", "ASM", "SHEET", "DOC", "SLIDES", "TEXT", "IMAGE"];
  const parts: string[] = [];
  for (const key of order) {
    const count = counts.get(key);
    if (count) parts.push(`**${key}** ${count}`);
  }
  for (const [key, count] of counts) {
    if (!order.includes(key)) parts.push(`**${key}** ${count}`);
  }
  return parts.join("  ·  ");
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

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
