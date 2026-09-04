import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { htmlToText } from "../format/html-to-text.js";
import { extractOfficeText, isOfficeExtension } from "./office-text.js";
import {
  ZipEntryTooLargeError,
  formatByteCap,
  readZipEntryBounded,
  resolveZipReadLimits,
  writeZipEntryBounded,
  type ZipReadLimits,
} from "./zip-bounds.js";

export {
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_ENTRY_COUNT,
  MAX_ZIP_TOTAL_BYTES,
  ZipEntryTooLargeError,
  readZipEntryBounded,
  type ZipReadLimits,
} from "./zip-bounds.js";

const require = createRequire(import.meta.url);

interface PdfTextItem {
  str: string;
  transform: number[];
}

interface PdfPageProxy {
  pageNumber: number;
  getTextContent(options: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }): Promise<{ items: PdfTextItem[] }>;
}

interface PdfParseOptions {
  pagerender?: (page: PdfPageProxy) => Promise<string>;
  max?: number;
  version?: string;
}

const pdfParse: (
  data: Uint8Array,
  options?: PdfParseOptions
) => Promise<{ text: string; numpages: number; numrender: number }> =
  require("pdf-parse");

/**
 * Shared text extraction utility used by ingestion, work agent, and chat agent.
 * Handles: PDF, TXT, MD, HTML, Office (DOCX/PPTX/XLSX), ZIP (extracts text
 * from files inside the zip).
 */

/**
 * Per-document cap on stored extracted text. Stored sidecars are indexed
 * section-by-section and read through tools that apply their own (smaller)
 * per-read limits, so the stored copy should be as complete as possible: a
 * 150-page lecture deck or a full textbook chapter must not lose its tail.
 */
const MAX_TEXT = 400_000;
// Zip summaries used to stop at 50k total / 30k per file, far below what a
// single PDF now gets (400k); a lab handout inside lab4.zip was silently cut.
// Inner files also get their own sidecars, so this text is the "read the zip"
// view and should be as complete as a direct read.
const MAX_ZIP_TEXT = 400_000;
const MAX_ZIP_FILE_TEXT = 120_000;
// Inflation bounds (per entry, entry count, total) live in ./zip-bounds.ts.
/**
 * How many zips deep the summary follows archives inside archives. A course
 * "starter bundle" that wraps a "resources.zip" that wraps a "rubric.zip" is
 * three levels; anything deeper is listed but not opened.
 */
export const MAX_ZIP_DEPTH = 3;

const TEXTUAL_ZIP_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".py", ".c", ".h", ".java", ".js",
  ".ts", ".s", ".asm", ".html", ".htm", ".xml", ".json",
]);

export interface ZipUnpackEntry {
  /** Path inside the zip (always forward slashes, no leading slash). */
  entryName: string;
  /** Absolute path where the entry was written on disk. */
  absolutePath: string;
  /** Uncompressed size in bytes (as reported by the zip). */
  size: number;
}

/**
 * Extract text from a file by path and filename.
 * Returns extracted text or a descriptive message for unsupported formats.
 */
export async function extractFileText(
  filePath: string,
  filename: string
): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  try {
    switch (ext) {
      case ".pdf":
        return await extractPdf(filePath);
      case ".txt":
      case ".md":
      case ".csv":
      case ".py":
      case ".c":
      case ".h":
      case ".java":
      case ".js":
      case ".ts":
      case ".s":
      case ".asm":
        return await extractPlainText(filePath);
      case ".html":
      case ".htm":
        return await extractHtml(filePath);
      case ".zip":
        return await extractZip(filePath, filename);
      default:
        if (isOfficeExtension(ext)) {
          return await extractOffice(filePath, filename);
        }
        return `[Binary file: ${filename} — cannot extract text]`;
    }
  } catch (err) {
    return `[Error reading "${filename}": ${err instanceof Error ? err.message : "unknown"}]`;
  }
}

/**
 * Unpack every file entry in a zip to a destination directory.
 * Preserves the zip's internal directory structure. Skips entries whose
 * resolved path would escape destDir.
 * Returns metadata for each unpacked entry (directories are not returned).
 *
 * Inflation is bounded: an entry past the per-file cap is skipped (its
 * partial `.tmp-*` file removed), and unpacking stops once the entry-count
 * or total-bytes cap is reached. `limits` exists so tests can use small
 * numbers; production callers get the defaults.
 */
export async function unpackZipToDirectory(
  zipPath: string,
  destDir: string,
  limits?: Partial<ZipReadLimits>
): Promise<ZipUnpackEntry[]> {
  const yauzl = require("yauzl-promise");
  const bounds = resolveZipReadLimits(limits);
  const zip = await yauzl.open(zipPath);
  const results: ZipUnpackEntry[] = [];
  const resolvedDest = path.resolve(destDir);
  let entriesRead = 0;
  let totalBytes = 0;

  try {
    for await (const entry of zip) {
      const rawName = entry.filename as string;
      if (rawName.endsWith("/")) continue;

      const normalized = rawName.replace(/\\/g, "/").replace(/^\/+/, "");
      if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
        continue;
      }

      const targetPath = path.resolve(destDir, normalized);
      if (
        targetPath !== resolvedDest &&
        !targetPath.startsWith(resolvedDest + path.sep)
      ) {
        continue;
      }

      // Guard against zip bombs: skip entries that declare (or actually
      // inflate to) more than the per-entry limit, and stop altogether once
      // the archive has produced more entries or bytes than any course
      // attachment reasonably should.
      const declaredSize = Number(entry.uncompressedSize ?? 0);
      if (declaredSize > bounds.maxEntryBytes) continue;
      if (entriesRead >= bounds.maxEntries) break;
      if (totalBytes + declaredSize > bounds.maxTotalBytes) break;

      let written: number;
      try {
        written = await writeZipEntryBounded(entry, targetPath, bounds.maxEntryBytes);
      } catch {
        // Too large, corrupt, or unwritable: the temp file is already gone.
        continue;
      }

      entriesRead += 1;
      totalBytes += written;
      results.push({
        entryName: normalized,
        absolutePath: targetPath,
        size: declaredSize,
      });
      if (totalBytes >= bounds.maxTotalBytes) break;
    }
  } finally {
    await zip.close();
  }

  return results;
}

/**
 * Extract and list contents of a zip file.
 * Reads text-based files inside the zip and returns their content.
 * For PDFs inside the zip, extracts text. For other binary files, lists them.
 * Zips inside the zip are opened in turn (to MAX_ZIP_DEPTH) and their
 * summaries inlined under the entry, so a rubric buried two archives down is
 * still searchable.
 *
 * Every entry is listed (the central directory is cheap), but bodies are
 * only inflated within the zip bounds: an entry past the per-file cap gets a
 * "[Skipped ...]" note under its listing line, and reading stops with a note
 * once the entry-count or total-bytes cap is reached. The caps are shared
 * across nesting levels, so an inner zip cannot inflate more than the outer
 * archive was allowed to.
 */
export async function extractZip(
  zipPath: string,
  zipName: string,
  limits?: Partial<ZipReadLimits>
): Promise<string> {
  const bounds = resolveZipReadLimits(limits);
  const budget: ZipReadBudget = { entriesRead: 0, totalBytes: 0 };
  return extractZipSource(zipPath, zipName, 0, bounds, budget);
}

/** Running totals shared by an archive and every zip nested inside it. */
interface ZipReadBudget {
  entriesRead: number;
  totalBytes: number;
}

async function extractZipSource(
  zipSource: string | Buffer,
  zipName: string,
  depth: number,
  bounds: ZipReadLimits,
  budget: ZipReadBudget
): Promise<string> {
  const yauzl = require("yauzl-promise");

  const zip = Buffer.isBuffer(zipSource)
    ? await yauzl.fromBuffer(zipSource)
    : await yauzl.open(zipSource);
  const entries: Array<{ name: string; size: number; note?: string }> = [];
  const textContents: Array<{ name: string; content: string }> = [];
  const stopNotes: string[] = [];
  let totalText = 0;
  let stopped = false;

  try {
    for await (const entry of zip) {
      // Skip directories
      if (entry.filename.endsWith("/")) continue;

      const listing: { name: string; size: number; note?: string } = {
        name: entry.filename,
        size: entry.uncompressedSize,
      };
      entries.push(listing);

      // Only extract text from readable files, stop if we have enough
      if (stopped || totalText >= MAX_ZIP_TEXT) continue;

      const ext = path.extname(entry.filename).toLowerCase();
      const isTextFile = TEXTUAL_ZIP_EXTENSIONS.has(ext);
      const isOffice = isOfficeExtension(ext);
      const isPdf = ext === ".pdf";
      const isZip = ext === ".zip";
      if (!isTextFile && !isOffice && !isPdf && !isZip) continue;

      if (isZip && depth >= MAX_ZIP_DEPTH) {
        listing.note = `[Skipped ${entry.filename}: nested more than ${MAX_ZIP_DEPTH} zips deep]`;
        continue;
      }

      const declaredSize = Number(entry.uncompressedSize ?? 0);
      if (declaredSize > bounds.maxEntryBytes) {
        listing.note = `[Skipped ${entry.filename}: inflates past the ${formatByteCap(bounds.maxEntryBytes)} per-file cap]`;
        continue;
      }
      if (budget.entriesRead >= bounds.maxEntries) {
        stopNotes.push(`[Read stopped after ${bounds.maxEntries} entries]`);
        stopped = true;
        continue;
      }
      if (budget.totalBytes + declaredSize > bounds.maxTotalBytes) {
        stopNotes.push(
          `[Read stopped: archive inflates past the ${formatByteCap(bounds.maxTotalBytes)} total cap]`
        );
        stopped = true;
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = await readZipEntryBounded(entry, bounds.maxEntryBytes);
      } catch (error) {
        if (error instanceof ZipEntryTooLargeError) {
          listing.note = `[Skipped ${entry.filename}: inflates past the ${formatByteCap(bounds.maxEntryBytes)} per-file cap]`;
        }
        // Otherwise the entry is unreadable (corrupt, encrypted); skip it.
        continue;
      }
      budget.entriesRead += 1;
      budget.totalBytes += buffer.length;

      if (isTextFile) {
        try {
          let text = buffer.toString("utf-8");
          if (ext === ".html" || ext === ".htm") {
            text = htmlToText(text);
          }
          if (text.trim().length > 0) {
            const truncated = capZipEntryText(text, entry.filename);
            textContents.push({ name: entry.filename, content: truncated });
            totalText += truncated.length;
          }
        } catch {
          // Skip unreadable entries
        }
      } else if (isOffice) {
        try {
          const text = (await extractOfficeText(buffer, entry.filename)) ?? "";
          if (text.trim().length > 0) {
            const truncated = capZipEntryText(text, entry.filename);
            textContents.push({ name: entry.filename, content: truncated });
            totalText += truncated.length;
          }
        } catch {
          // Skip unreadable Office documents
        }
      } else if (isPdf) {
        try {
          const text = await extractPdfText(buffer, MAX_ZIP_FILE_TEXT);
          if (text.length > 0) {
            textContents.push({ name: entry.filename, content: text });
            totalText += text.length;
          }
        } catch {
          // Skip unreadable PDFs
        }
      } else if (isZip) {
        try {
          const text = await extractZipSource(
            buffer,
            entry.filename,
            depth + 1,
            bounds,
            budget
          );
          if (text.trim().length > 0) {
            const truncated = capZipEntryText(text, entry.filename);
            textContents.push({ name: entry.filename, content: truncated });
            totalText += truncated.length;
          }
        } catch {
          // Skip unreadable nested zips
        }
      }

      if (budget.totalBytes >= bounds.maxTotalBytes) {
        stopNotes.push(
          `[Read stopped: archive inflates past the ${formatByteCap(bounds.maxTotalBytes)} total cap]`
        );
        stopped = true;
      }
    }
  } finally {
    await zip.close();
  }

  // Build output
  const lines: string[] = [];
  lines.push(`ZIP: ${zipName} (${entries.length} files)`);
  lines.push("");

  // List all files in the zip
  lines.push("Contents:");
  for (const e of entries) {
    const size = e.size < 1024 ? `${e.size}B` : `${(e.size / 1024).toFixed(0)}KB`;
    lines.push(`  ${e.name} (${size})`);
    if (e.note) lines.push(`    ${e.note}`);
  }
  for (const note of stopNotes) {
    lines.push(`  ${note}`);
  }

  // Show extracted text content
  if (textContents.length > 0) {
    lines.push("");
    for (const tc of textContents) {
      lines.push(`--- ${tc.name} ---`);
      lines.push(tc.content);
      lines.push("");
    }
  }

  return lines.join("\n").slice(0, MAX_ZIP_TEXT);
}

async function extractPdf(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const text = await extractPdfText(buffer, MAX_TEXT);
  return text || "[Could not extract text from PDF]";
}

/** Heading used to mark page boundaries in multi-page PDF text. */
/** Cap one zip entry's text, saying so instead of cutting silently. */
function capZipEntryText(text: string, filename: string): string {
  if (text.length <= MAX_ZIP_FILE_TEXT) return text;
  const omitted = text.length - MAX_ZIP_FILE_TEXT;
  return `${text.slice(0, MAX_ZIP_FILE_TEXT)}\n[Text truncated: ${omitted} more characters of ${filename} omitted; read the extracted file directly for the rest]`;
}

export const PDF_PAGE_HEADING_PREFIX = "## Page ";
/** Body written for a page with no extractable text (scan, diagram, image-only slide). */
export const PDF_IMAGE_PAGE_NOTE =
  "[No extractable text on this page; it is probably an image, diagram or scanned slide.]";

/**
 * Extract the text of a PDF, page by page.
 *
 * Multi-page documents come back with a `## Page N` heading in front of every
 * page that has text. That heading form is what the knowledge index splits
 * sections on and what answer verification recognises, so each page becomes
 * an individually searchable, citable section ("Lecture12.pdf — Page 35").
 * Single-page documents are returned as plain text, unchanged.
 *
 * Text is capped at `maxChars`, cutting on a page boundary and appending a
 * note that names the omitted page range so the model (and the student) can
 * tell the document continues. Returns "" when no page has extractable text
 * (image-only scans).
 */
export async function extractPdfText(
  buffer: Buffer | Uint8Array,
  maxChars: number = MAX_TEXT
): Promise<string> {
  const pages = new Map<number, string>();
  let pageCount = 0;

  // pdf.js chokes on some valid PDFs (notably pdfkit output) when handed a
  // Node Buffer; a plain Uint8Array view over the same bytes always works.
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const origLog = console.log;
  console.log = () => {};
  try {
    const result = await pdfParse(bytes, {
      pagerender: async (page) => {
        const text = await renderPdfPageText(page);
        pages.set(page.pageNumber, text);
        return text;
      },
    });
    pageCount = result.numpages;
  } finally {
    console.log = origLog;
  }

  const blocks: Array<{ pageNumber: number; text: string }> = [];
  let textPages = 0;
  const lastPage = Math.max(pageCount, ...pages.keys(), 0);
  for (let pageNumber = 1; pageNumber <= lastPage; pageNumber += 1) {
    const text = (pages.get(pageNumber) ?? "").trim();
    if (text.length > 0) {
      textPages += 1;
      blocks.push({ pageNumber, text });
    } else {
      // Keep a marker for image-only pages so every page stays addressable
      // ("read page 12") and the model knows the gap is a scan, not a cut.
      blocks.push({ pageNumber, text: PDF_IMAGE_PAGE_NOTE });
    }
  }
  if (textPages === 0) {
    return "";
  }

  if (pageCount <= 1 && blocks.length === 1) {
    return blocks[0]!.text.slice(0, maxChars);
  }

  const parts: string[] = [];
  let used = 0;
  let firstOmittedPage: number | null = null;
  for (const block of blocks) {
    const rendered = `${PDF_PAGE_HEADING_PREFIX}${block.pageNumber}\n\n${block.text}`;
    const separator = parts.length > 0 ? 2 : 0;
    if (used + separator + rendered.length > maxChars) {
      if (parts.length === 0) {
        // A single page larger than the whole budget: keep what fits.
        parts.push(rendered.slice(0, maxChars));
        used = maxChars;
        continue;
      }
      firstOmittedPage = block.pageNumber;
      break;
    }
    parts.push(rendered);
    used += separator + rendered.length;
  }

  let text = parts.join("\n\n");
  if (firstOmittedPage !== null) {
    const lastPage = blocks[blocks.length - 1]!.pageNumber;
    const range =
      firstOmittedPage === lastPage
        ? `page ${lastPage}`
        : `pages ${firstOmittedPage}-${lastPage}`;
    text += `\n\n[Text truncated: ${range} of ${pageCount} omitted because the document exceeds ${maxChars} characters]`;
  }
  return text;
}

/**
 * Mirror pdf-parse's default page renderer: text items on the same baseline
 * are joined, a change in baseline starts a new line.
 */
async function renderPdfPageText(page: PdfPageProxy): Promise<string> {
  const content = await page.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  let lastY: number | undefined;
  let text = "";
  for (const item of content.items) {
    const y = item.transform[5];
    if (lastY === undefined || lastY === y) {
      text += item.str;
    } else {
      text += "\n" + item.str;
    }
    lastY = y;
  }
  return text;
}

async function extractOffice(filePath: string, filename: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const text = (await extractOfficeText(buffer, filename)) ?? "";
  return text.slice(0, MAX_TEXT) || `[Could not extract text from ${filename}]`;
}

async function extractPlainText(filePath: string): Promise<string> {
  const text = await fs.readFile(filePath, "utf-8");
  return text.slice(0, MAX_TEXT);
}

async function extractHtml(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf-8");
  return htmlToText(raw).slice(0, MAX_TEXT);
}
