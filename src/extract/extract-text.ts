import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { htmlToText } from "../format/html-to-text.js";

const require = createRequire(import.meta.url);
const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = require("pdf-parse");

/**
 * Shared text extraction utility used by ingestion, work agent, and chat agent.
 * Handles: PDF, TXT, MD, HTML, ZIP (extracts text from files inside the zip).
 */

const MAX_TEXT = 30000;
const MAX_ZIP_TEXT = 50000; // Higher limit for zips since they contain multiple files
const MAX_ZIP_FILE_TEXT = 30000; // Per-file limit inside zips

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
        return `[Binary file: ${filename} — cannot extract text]`;
    }
  } catch (err) {
    return `[Error reading "${filename}": ${err instanceof Error ? err.message : "unknown"}]`;
  }
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
      const isTextFile = [
        ".txt", ".md", ".csv", ".py", ".c", ".h", ".java", ".js",
        ".ts", ".s", ".asm", ".html", ".htm", ".xml", ".json",
      ].includes(ext);

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

async function extractPlainText(filePath: string): Promise<string> {
  const text = await fs.readFile(filePath, "utf-8");
  return text.slice(0, MAX_TEXT);
}

async function extractHtml(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf-8");
  return htmlToText(raw).slice(0, MAX_TEXT);
}
