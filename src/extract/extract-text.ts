import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { htmlToText } from "../format/html-to-text.js";
import { extractOfficeText, isOfficeExtension } from "./office-text.js";

const require = createRequire(import.meta.url);
const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = require("pdf-parse");

/**
 * Shared text extraction utility used by ingestion, work agent, and chat agent.
 * Handles: PDF, TXT, MD, HTML, Office (DOCX/PPTX/XLSX), ZIP (extracts text
 * from files inside the zip).
 */

const MAX_TEXT = 30000;
const MAX_ZIP_TEXT = 50000; // Higher limit for zips since they contain multiple files
const MAX_ZIP_FILE_TEXT = 30000; // Per-file limit inside zips
const MAX_ZIP_ENTRY_BYTES = 100 * 1024 * 1024; // Per-entry inflated size cap when unpacking

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
 */
export async function unpackZipToDirectory(
  zipPath: string,
  destDir: string
): Promise<ZipUnpackEntry[]> {
  const yauzl = require("yauzl-promise");
  const zip = await yauzl.open(zipPath);
  const results: ZipUnpackEntry[] = [];
  const resolvedDest = path.resolve(destDir);

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
      // inflate to) more than the per-entry limit.
      const declaredSize = Number(entry.uncompressedSize ?? 0);
      if (declaredSize > MAX_ZIP_ENTRY_BYTES) continue;

      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      try {
        const stream = await entry.openReadStream();
        const chunks: Buffer[] = [];
        let total = 0;
        let tooLarge = false;
        for await (const chunk of stream) {
          total += (chunk as Buffer).length;
          if (total > MAX_ZIP_ENTRY_BYTES) {
            tooLarge = true;
            break;
          }
          chunks.push(chunk as Buffer);
        }
        if (tooLarge) continue;
        await fs.writeFile(targetPath, Buffer.concat(chunks));
      } catch {
        continue;
      }

      results.push({
        entryName: normalized,
        absolutePath: targetPath,
        size: Number(entry.uncompressedSize ?? 0),
      });
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
 */
export async function extractZip(
  zipPath: string,
  zipName: string
): Promise<string> {
  const yauzl = require("yauzl-promise");

  const zip = await yauzl.open(zipPath);
  const entries: Array<{ name: string; size: number }> = [];
  const textContents: Array<{ name: string; content: string }> = [];
  let totalText = 0;

  try {
    for await (const entry of zip) {
      // Skip directories
      if (entry.filename.endsWith("/")) continue;

      entries.push({ name: entry.filename, size: entry.uncompressedSize });

      // Only extract text from readable files, stop if we have enough
      if (totalText >= MAX_ZIP_TEXT) continue;

      const ext = path.extname(entry.filename).toLowerCase();
      const isTextFile = TEXTUAL_ZIP_EXTENSIONS.has(ext);

      if (isTextFile) {
        try {
          const stream = await entry.openReadStream();
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
          }
          let text = Buffer.concat(chunks).toString("utf-8");
          if (ext === ".html" || ext === ".htm") {
            text = htmlToText(text);
          }
          if (text.trim().length > 0) {
            const truncated = text.slice(0, MAX_ZIP_FILE_TEXT);
            textContents.push({ name: entry.filename, content: truncated });
            totalText += truncated.length;
          }
        } catch {
          // Skip unreadable entries
        }
      }

      if (isOfficeExtension(ext)) {
        try {
          const stream = await entry.openReadStream();
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
          }
          const text = (await extractOfficeText(Buffer.concat(chunks), entry.filename)) ?? "";
          if (text.trim().length > 0) {
            const truncated = text.slice(0, MAX_ZIP_FILE_TEXT);
            textContents.push({ name: entry.filename, content: truncated });
            totalText += truncated.length;
          }
        } catch {
          // Skip unreadable Office documents
        }
      }

      if (ext === ".pdf") {
        try {
          const stream = await entry.openReadStream();
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
          }
          const buffer = Buffer.concat(chunks);
          const origLog = console.log;
          console.log = () => {};
          try {
            const data = await pdfParse(buffer);
            const text = data.text?.trim() ?? "";
            if (text.length > 0) {
              const truncated = text.slice(0, MAX_ZIP_FILE_TEXT);
              textContents.push({ name: entry.filename, content: truncated });
              totalText += truncated.length;
            }
          } finally {
            console.log = origLog;
          }
        } catch {
          // Skip unreadable PDFs
        }
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
  const origLog = console.log;
  console.log = () => {};
  try {
    const data = await pdfParse(buffer);
    const text = data.text?.trim() ?? "";
    return text.slice(0, MAX_TEXT) || "[Could not extract text from PDF]";
  } finally {
    console.log = origLog;
  }
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
