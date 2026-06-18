import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { decodeEntities, htmlToText } from "../format/html-to-text.js";

const require = createRequire(import.meta.url);
const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = require("pdf-parse");

/**
 * Shared text extraction utility used by ingestion, work agent, and chat agent.
 * Handles: PDF, Office Open XML, TXT, MD, HTML, and ZIP contents.
 */

const MAX_TEXT = 30000;
const MAX_ZIP_TEXT = 50000; // Higher limit for zips since they contain multiple files
const MAX_ZIP_FILE_TEXT = 30000; // Per-file limit inside zips
const MAX_ZIP_DEPTH = 3;
const MAX_ZIP_ENTRY_COUNT = 1000;
const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 250 * 1024 * 1024;

const TEXTUAL_ZIP_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".py", ".c", ".h", ".java", ".js",
  ".ts", ".s", ".asm", ".html", ".htm", ".xml", ".json",
]);
const OFFICE_OPEN_XML_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx"]);

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
      case ".docx":
        return await extractDocx(filePath, filename);
      case ".pptx":
        return await extractPptx(filePath, filename);
      case ".xlsx":
        return await extractXlsx(filePath, filename);
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
 * Extract text from an in-memory file buffer. Used for one-time ingestion of
 * exported external resources, such as Google Slides decks converted to PPTX.
 */
export async function extractFileBufferText(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  try {
    switch (ext) {
      case ".pdf": {
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
      case ".txt":
      case ".md":
      case ".csv":
      case ".html":
      case ".htm": {
        const text = buffer.toString("utf-8");
        return (ext === ".html" || ext === ".htm" ? htmlToText(text) : text).slice(
          0,
          MAX_TEXT
        );
      }
      case ".docx":
      case ".pptx":
      case ".xlsx":
        return (await extractOfficeOpenXmlBuffer(buffer, filename)).slice(0, MAX_TEXT);
      case ".zip":
        return (await extractZipSource(buffer, filename, 0)).slice(0, MAX_ZIP_TEXT);
      default:
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
  let entryCount = 0;
  let totalWritten = 0;

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

      entryCount += 1;
      if (entryCount > MAX_ZIP_ENTRY_COUNT) {
        break;
      }

      const reportedSize = getZipEntrySize(entry);
      if (
        reportedSize > MAX_ZIP_ENTRY_BYTES ||
        totalWritten >= MAX_ZIP_TOTAL_BYTES ||
        (reportedSize > 0 && totalWritten + reportedSize > MAX_ZIP_TOTAL_BYTES)
      ) {
        continue;
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      let writtenBytes = 0;
      try {
        writtenBytes = await writeEntryToFile(
          entry,
          targetPath,
          Math.min(MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES - totalWritten)
        );
      } catch {
        continue;
      }
      totalWritten += writtenBytes;

      results.push({
        entryName: normalized,
        absolutePath: targetPath,
        size: writtenBytes,
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
  return (await extractZipSource(zipPath, zipName, 0)).slice(0, MAX_ZIP_TEXT);
}

async function extractZipSource(
  zipSource: string | Buffer,
  zipName: string,
  depth: number
): Promise<string> {
  const yauzl = require("yauzl-promise");

  const zip = Buffer.isBuffer(zipSource)
    ? await yauzl.fromBuffer(zipSource)
    : await yauzl.open(zipSource);
  const entries: Array<{ name: string; size: number }> = [];
  const textContents: Array<{ name: string; content: string }> = [];
  let totalText = 0;
  let entryCount = 0;
  let totalReadBytes = 0;
  const limitNotes: string[] = [];

  try {
    for await (const entry of zip) {
      // Skip directories
      if (entry.filename.endsWith("/")) continue;

      entryCount += 1;
      if (entryCount > MAX_ZIP_ENTRY_COUNT) {
        limitNotes.push(
          `Skipped remaining files after ${MAX_ZIP_ENTRY_COUNT} entries.`
        );
        break;
      }

      const entrySize = getZipEntrySize(entry);
      entries.push({ name: entry.filename, size: entrySize });

      if (entrySize > MAX_ZIP_ENTRY_BYTES) {
        limitNotes.push(
          `Skipped ${entry.filename}: entry exceeds ${formatZipSize(MAX_ZIP_ENTRY_BYTES)}.`
        );
        continue;
      }

      if (
        totalReadBytes >= MAX_ZIP_TOTAL_BYTES ||
        (entrySize > 0 && totalReadBytes + entrySize > MAX_ZIP_TOTAL_BYTES)
      ) {
        limitNotes.push(
          `Skipped remaining readable files after ${formatZipSize(MAX_ZIP_TOTAL_BYTES)}.`
        );
        break;
      }

      // Only extract text from readable files, stop if we have enough
      if (totalText >= MAX_ZIP_TEXT) continue;

      const ext = path.extname(entry.filename).toLowerCase();
      const isTextFile = TEXTUAL_ZIP_EXTENSIONS.has(ext);
      const isOfficeFile = OFFICE_OPEN_XML_EXTENSIONS.has(ext);
      const isZipFile = ext === ".zip";

      if (isTextFile) {
        try {
          const buffer = await readEntryBuffer(
            entry,
            MAX_ZIP_TOTAL_BYTES - totalReadBytes
          );
          totalReadBytes += buffer.length;
          let text = buffer.toString("utf-8");
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

      if (isOfficeFile) {
        try {
          const buffer = await readEntryBuffer(
            entry,
            MAX_ZIP_TOTAL_BYTES - totalReadBytes
          );
          totalReadBytes += buffer.length;
          const text = await extractOfficeOpenXmlBuffer(buffer, entry.filename);
          if (text.trim().length > 0 && !text.startsWith("[")) {
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
          const buffer = await readEntryBuffer(
            entry,
            MAX_ZIP_TOTAL_BYTES - totalReadBytes
          );
          totalReadBytes += buffer.length;
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

      if (isZipFile && depth < MAX_ZIP_DEPTH) {
        try {
          const buffer = await readEntryBuffer(
            entry,
            MAX_ZIP_TOTAL_BYTES - totalReadBytes
          );
          totalReadBytes += buffer.length;
          const text = await extractZipSource(buffer, entry.filename, depth + 1);
          if (text.trim().length > 0) {
            const truncated = text.slice(0, MAX_ZIP_FILE_TEXT);
            textContents.push({ name: entry.filename, content: truncated });
            totalText += truncated.length;
          }
        } catch {
          // Skip unreadable nested zips
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
    const size = formatZipSize(e.size);
    lines.push(`  ${e.name} (${size})`);
  }
  for (const note of limitNotes) {
    lines.push(`  [${note}]`);
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

async function extractDocx(filePath: string, filename: string): Promise<string> {
  const entries = await readZipTextEntries(filePath, (name) =>
    isWordTextOrRelationshipEntry(name)
  );
  return renderDocxEntries(filename, entries).slice(0, MAX_TEXT);
}

async function extractPptx(filePath: string, filename: string): Promise<string> {
  const entries = await readZipTextEntries(filePath, (name) =>
    isPowerPointTextOrRelationshipEntry(name)
  );
  return renderPptxEntries(filename, entries).slice(0, MAX_TEXT);
}

async function extractXlsx(filePath: string, filename: string): Promise<string> {
  const entries = await readZipTextEntries(filePath, (name) =>
    isWorkbookTextEntry(name)
  );
  return renderXlsxEntries(filename, entries).slice(0, MAX_TEXT);
}

async function extractOfficeOpenXmlBuffer(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  const entries = await readZipTextEntries(buffer, (name) => {
    if (ext === ".docx") {
      return isWordTextOrRelationshipEntry(name);
    }
    if (ext === ".pptx") {
      return isPowerPointTextOrRelationshipEntry(name);
    }
    if (ext === ".xlsx") {
      return isWorkbookTextEntry(name);
    }
    return false;
  });

  if (ext === ".docx") return renderDocxEntries(filename, entries);
  if (ext === ".pptx") return renderPptxEntries(filename, entries);
  if (ext === ".xlsx") return renderXlsxEntries(filename, entries);
  return `[Binary file: ${filename} — cannot extract text]`;
}

async function readZipTextEntries(
  zipSource: string | Buffer,
  shouldRead: (entryName: string) => boolean
): Promise<Map<string, string>> {
  const yauzl = require("yauzl-promise");
  const zip = Buffer.isBuffer(zipSource)
    ? await yauzl.fromBuffer(zipSource)
    : await yauzl.open(zipSource);
  const entries = new Map<string, string>();
  let entryCount = 0;
  let totalReadBytes = 0;

  try {
    for await (const entry of zip) {
      const entryName = String(entry.filename ?? "");
      if (entryName.endsWith("/")) {
        continue;
      }
      entryCount += 1;
      if (entryCount > MAX_ZIP_ENTRY_COUNT) {
        break;
      }
      if (!shouldRead(entryName)) {
        continue;
      }
      const entrySize = getZipEntrySize(entry);
      if (
        entrySize > MAX_ZIP_ENTRY_BYTES ||
        totalReadBytes >= MAX_ZIP_TOTAL_BYTES ||
        (entrySize > 0 && totalReadBytes + entrySize > MAX_ZIP_TOTAL_BYTES)
      ) {
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = await readEntryBuffer(entry, MAX_ZIP_TOTAL_BYTES - totalReadBytes);
      } catch {
        continue;
      }
      totalReadBytes += buffer.length;
      entries.set(entryName, buffer.toString("utf-8"));
    }
  } finally {
    await zip.close();
  }

  return entries;
}

async function readEntryBuffer(entry: {
  openReadStream: () => Promise<AsyncIterable<unknown>>;
  uncompressedSize?: number;
}, maxBytes = MAX_ZIP_ENTRY_BYTES): Promise<Buffer> {
  const reportedSize = getZipEntrySize(entry);
  const allowedBytes = Math.min(maxBytes, MAX_ZIP_ENTRY_BYTES);
  if (reportedSize > allowedBytes) {
    throw new Error(`ZIP entry exceeds ${formatZipSize(allowedBytes)}`);
  }
  const stream = await entry.openReadStream();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buffer.length;
    if (totalBytes > allowedBytes) {
      throw new Error(`ZIP entry exceeds ${formatZipSize(allowedBytes)}`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function writeEntryToFile(
  entry: {
    openReadStream: () => Promise<AsyncIterable<unknown>>;
    uncompressedSize?: number;
  },
  targetPath: string,
  maxBytes: number
): Promise<number> {
  const reportedSize = getZipEntrySize(entry);
  const allowedBytes = Math.min(maxBytes, MAX_ZIP_ENTRY_BYTES);
  if (reportedSize > allowedBytes) {
    throw new Error(`ZIP entry exceeds ${formatZipSize(allowedBytes)}`);
  }

  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const stream = await entry.openReadStream();
  const handle = await fs.open(tmpPath, "w");
  let totalBytes = 0;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      totalBytes += buffer.length;
      if (totalBytes > allowedBytes) {
        throw new Error(`ZIP entry exceeds ${formatZipSize(allowedBytes)}`);
      }
      await handle.write(buffer);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmpPath, { force: true });
    throw error;
  }

  await handle.close();
  await fs.rename(tmpPath, targetPath);
  return totalBytes;
}

function getZipEntrySize(entry: { uncompressedSize?: number }): number {
  const size = Number(entry.uncompressedSize ?? 0);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function formatZipSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)}KB`;
  return `${(size / (1024 * 1024)).toFixed(0)}MB`;
}

function renderDocxEntries(
  filename: string,
  entries: Map<string, string>
): string {
  const lines = [`# ${filename}`, ""];
  const body = entries.get("word/document.xml");
  if (body) {
    const relationshipTargets = relationshipTargetsForPart(
      entries,
      "word/document.xml"
    );
    appendSection(
      lines,
      "Body",
      extractOfficeParagraphs(stripOfficeTables(body), relationshipTargets)
    );
    appendSection(lines, "Tables", extractOfficeTables(body, relationshipTargets));
    appendSection(
      lines,
      "Media",
      extractOfficeMediaDescriptions(body, relationshipTargets)
    );
  }

  const supplementalEntries = [...entries.entries()]
    .filter(
      ([name]) => name !== "word/document.xml" && !isOfficeRelationshipEntry(name)
    )
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [name, xml] of supplementalEntries) {
    const relationshipTargets = relationshipTargetsForPart(entries, name);
    const heading = formatOfficeEntryHeading(name);
    appendSection(
      lines,
      heading,
      extractOfficeParagraphs(stripOfficeTables(xml), relationshipTargets)
    );
    appendSection(
      lines,
      `${heading} Tables`,
      extractOfficeTables(xml, relationshipTargets)
    );
    appendSection(
      lines,
      `${heading} Media`,
      extractOfficeMediaDescriptions(xml, relationshipTargets)
    );
  }

  return finishOfficeText(lines, filename);
}

function renderPptxEntries(
  filename: string,
  entries: Map<string, string>
): string {
  const lines = [`# ${filename}`, ""];
  const slides = [...entries.entries()]
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(compareNumberedOfficeEntries);
  const notes = new Map(
    [...entries.entries()].filter(([name]) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name)
    )
  );
  const comments = new Map(
    [...entries.entries()].filter(([name]) => isPowerPointCommentEntry(name))
  );
  const renderedComments = new Set<string>();

  for (let index = 0; index < slides.length; index += 1) {
    const [name, xml] = slides[index]!;
    const slideNumber = extractTrailingNumber(name) ?? index + 1;
    appendSection(lines, `Slide ${slideNumber}`, extractOfficeParagraphs(xml));
    appendSection(
      lines,
      `Slide ${slideNumber} Media`,
      extractOfficeMediaDescriptions(
        xml,
        relationshipTargetsForPart(entries, name)
      )
    );

    const noteXml = notes.get(`ppt/notesSlides/notesSlide${slideNumber}.xml`);
    if (noteXml) {
      const noteName = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
      appendSection(
        lines,
        `Speaker Notes ${slideNumber}`,
        extractOfficeParagraphs(noteXml)
      );
      appendSection(
        lines,
        `Speaker Notes ${slideNumber} Media`,
        extractOfficeMediaDescriptions(
          noteXml,
          relationshipTargetsForPart(entries, noteName)
        )
      );
    }

    const slideCommentEntries = powerPointCommentsForPart(entries, name, comments);
    for (const [commentName, commentXml] of slideCommentEntries) {
      appendSection(
        lines,
        `Slide ${slideNumber} Comments`,
        extractPowerPointComments(commentXml)
      );
      renderedComments.add(commentName);
    }
  }

  for (const [name, xml] of [...notes.entries()].sort(compareNumberedOfficeEntries)) {
    const noteNumber = extractTrailingNumber(name);
    if (noteNumber && entries.has(`ppt/slides/slide${noteNumber}.xml`)) {
      continue;
    }
    appendSection(
      lines,
      noteNumber ? `Speaker Notes ${noteNumber}` : formatOfficeEntryHeading(name),
      extractOfficeParagraphs(xml)
    );
    appendSection(
      lines,
      noteNumber
        ? `Speaker Notes ${noteNumber} Media`
        : `${formatOfficeEntryHeading(name)} Media`,
      extractOfficeMediaDescriptions(
        xml,
        relationshipTargetsForPart(entries, name)
      )
    );
  }

  for (const [name, xml] of [...comments.entries()].sort(compareNumberedOfficeEntries)) {
    if (renderedComments.has(name)) {
      continue;
    }
    const commentNumber = extractTrailingNumber(name);
    appendSection(
      lines,
      commentNumber ? `Comments ${commentNumber}` : formatOfficeEntryHeading(name),
      extractPowerPointComments(xml)
    );
  }

  return finishOfficeText(lines, filename);
}

function renderXlsxEntries(
  filename: string,
  entries: Map<string, string>
): string {
  const lines = [`# ${filename}`, ""];
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml") ?? "");
  const sheetNames = parseWorkbookSheetNames(entries);
  const worksheets = [...entries.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(compareNumberedOfficeEntries);

  for (const [name, xml] of worksheets) {
    const title = sheetNames.get(name) ?? formatOfficeEntryHeading(name);
    const rows = renderWorksheetRows(xml, sharedStrings);
    appendSection(lines, title, rows);
  }

  return finishOfficeText(lines, filename);
}

function extractOfficeParagraphs(
  xml: string,
  relationshipTargets: Map<string, string> = new Map()
): string[] {
  const blocks = [
    ...xml.matchAll(/<(?:[a-z]+:)?p\b[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?p>/gi),
  ].map((match) => extractOfficeBlockText(match[1] ?? "", relationshipTargets));
  const paragraphs = blocks
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (paragraphs.length > 0) {
    return paragraphs;
  }

  const fallback = extractOfficeBlockText(xml, relationshipTargets)
    .replace(/\s+/g, " ")
    .trim();
  return fallback ? [fallback] : [];
}

function stripOfficeTables(xml: string): string {
  return xml.replace(
    /<(?:[a-z]+:)?tbl\b[^>]*>[\s\S]*?<\/(?:[a-z]+:)?tbl>/gi,
    ""
  );
}

function extractOfficeTables(
  xml: string,
  relationshipTargets: Map<string, string> = new Map()
): string[] {
  const rendered: string[] = [];
  let tableNumber = 1;

  for (const tableMatch of xml.matchAll(
    /<(?:[a-z]+:)?tbl\b[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?tbl>/gi
  )) {
    const rows = extractOfficeTableRows(tableMatch[1] ?? "", relationshipTargets);
    if (rows.length === 0) {
      continue;
    }

    rendered.push(`Table ${tableNumber}:`);
    rendered.push(...renderOfficeTableRows(rows));
    tableNumber += 1;
  }

  return rendered;
}

function extractOfficeMediaDescriptions(
  xml: string,
  relationshipTargets: Map<string, string> = new Map()
): string[] {
  const rendered: string[] = [];
  const seen = new Set<string>();

  for (const match of xml.matchAll(
    /<(?:[a-z]+:)?(?:docPr|cNvPr)\b([^>]*?)\/?>/gi
  )) {
    const attrs = match[1] ?? "";
    const description = extractXmlAttr(attrs, "descr");
    const title = extractXmlAttr(attrs, "title");
    const name = extractXmlAttr(attrs, "name");
    const usefulName = name && !isGenericOfficeMediaName(name) ? name : null;
    const label = description || title || usefulName;
    const target = extractNearbyOfficeMediaTarget(
      xml,
      match.index ?? 0,
      relationshipTargets
    );

    if (!label && !target) {
      continue;
    }

    const kind = inferOfficeMediaKind(target ?? usefulName ?? label ?? "");
    const details: string[] = [];
    if (label) details.push(label);
    if (title && title !== label) details.push(`title: ${title}`);
    if (usefulName && usefulName !== label && usefulName !== title) {
      details.push(`name: ${usefulName}`);
    }
    if (target) details.push(`target: ${target}`);

    const line = `- ${kind}: ${details.join(" | ")}`;
    if (!seen.has(line)) {
      seen.add(line);
      rendered.push(line);
    }
  }

  return rendered;
}

function powerPointCommentsForPart(
  entries: Map<string, string>,
  partName: string,
  comments: Map<string, string>
): Array<[string, string]> {
  const relationshipTargets = relationshipTargetsForPart(entries, partName);
  const matches: Array<[string, string]> = [];
  for (const target of relationshipTargets.values()) {
    const commentXml = comments.get(target);
    if (commentXml) {
      matches.push([target, commentXml]);
    }
  }
  return matches;
}

function extractPowerPointComments(xml: string): string[] {
  const comments = [
    ...xml.matchAll(/<(?:[a-z]+:)?cm\b[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?cm>/gi),
  ]
    .map((match) => extractPowerPointCommentText(match[1] ?? ""))
    .filter(Boolean);

  if (comments.length > 0) {
    return comments;
  }

  const fallback = extractPowerPointCommentText(xml);
  return fallback ? [fallback] : [];
}

function extractPowerPointCommentText(xml: string): string {
  const explicitText = [
    ...xml.matchAll(
      /<(?:[a-z]+:)?text\b[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?text>/gi
    ),
  ].map((match) => {
    const inner = match[1] ?? "";
    const runText = extractOfficeTextRuns(inner);
    return runText || decodeEntities(inner.replace(/<[^>]+>/g, " "));
  });
  const runText = extractOfficeTextRuns(xml);
  const uniqueText = new Set([...explicitText, runText]);
  return [...uniqueText]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function extractNearbyOfficeMediaTarget(
  xml: string,
  fromIndex: number,
  relationshipTargets: Map<string, string>
): string | null {
  const window = xml.slice(fromIndex, fromIndex + 3000);
  const blipMatch = window.match(/<(?:[a-z]+:)?blip\b([^>]*?)\/?>/i);
  const attrs = blipMatch?.[1] ?? "";
  const relId =
    extractXmlAttr(attrs, "r:embed") ??
    extractXmlAttr(attrs, "embed") ??
    extractXmlAttr(attrs, "r:link") ??
    extractXmlAttr(attrs, "link");
  if (!relId) {
    return null;
  }
  return relationshipTargets.get(relId) ?? relId;
}

function inferOfficeMediaKind(value: string): string {
  const normalized = value.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|tiff?|bmp|svg)(?:$|[?#])/i.test(normalized)) {
    return "Image";
  }
  if (/\.(mp4|mov|webm|m4v|avi|wmv)(?:$|[?#])/i.test(normalized)) {
    return "Video";
  }
  if (/\.(mp3|m4a|wav|aac|ogg)(?:$|[?#])/i.test(normalized)) {
    return "Audio";
  }
  if (/\b(chart|graph|plot)\b/i.test(normalized)) {
    return "Chart";
  }
  return "Media";
}

function isGenericOfficeMediaName(value: string): boolean {
  return /^(?:picture|image|graphic|media|object|ole object|diagram|chart|shape)\s*\d*$/i.test(
    value.trim()
  );
}

function extractOfficeTableRows(
  tableXml: string,
  relationshipTargets: Map<string, string>
): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of tableXml.matchAll(
    /<(?:[a-z]+:)?tr\b[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?tr>/gi
  )) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(
      /<(?:[a-z]+:)?tc\b[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?tc>/gi
    )) {
      const text = extractOfficeParagraphs(cellMatch[1] ?? "", relationshipTargets)
        .join(" / ")
        .replace(/\s+/g, " ")
        .trim();
      cells.push(text);
    }
    if (cells.some((cell) => cell.length > 0)) {
      rows.push(trimTrailingEmptyCells(cells));
    }
  }
  return rows;
}

function renderOfficeTableRows(rows: string[][]): string[] {
  const nonEmptyRows = rows
    .map((row) => trimTrailingEmptyCells(row.map((cell) => cell.trim())))
    .filter((row) => row.some((cell) => cell.length > 0));
  if (nonEmptyRows.length === 0) {
    return [];
  }

  const headerRow = nonEmptyRows[0] ?? [];
  if (
    nonEmptyRows.length > 1 &&
    headerRow.length > 1 &&
    isLikelyOfficeHeaderRow(headerRow)
  ) {
    return renderOfficeRowsWithHeader(headerRow, nonEmptyRows.slice(1));
  }

  if (nonEmptyRows.every((row) => row.length === 2 && row[0] && row[1])) {
    return nonEmptyRows.map((row) => `- ${row[0]}: ${row[1]}`);
  }

  if (nonEmptyRows.length > 1 && headerRow.length > 1) {
    return renderOfficeRowsWithHeader(headerRow, nonEmptyRows.slice(1));
  }

  return nonEmptyRows.map(
    (row, index) => `- Row ${index + 1}: ${row.filter(Boolean).join(" | ")}`
  );
}

function renderOfficeRowsWithHeader(
  headerRow: string[],
  rows: string[][]
): string[] {
  return rows.map((row) => {
    const width = Math.max(headerRow.length, row.length);
    const parts: string[] = [];
    for (let index = 0; index < width; index += 1) {
      const header = headerRow[index] || `Column ${index + 1}`;
      const value = row[index] || "-";
      parts.push(`${header}: ${value}`);
    }
    return `- ${parts.join(" | ")}`;
  });
}

function isLikelyOfficeHeaderRow(row: string[]): boolean {
  return row.every((cell) => isLikelyOfficeHeaderCell(cell));
}

function isLikelyOfficeHeaderCell(cell: string): boolean {
  const normalized = cell
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || /\d/.test(normalized) || normalized.length > 40) {
    return false;
  }

  return normalized
    .split(" ")
    .every((token) => OFFICE_TABLE_HEADER_WORDS.has(token));
}

function trimTrailingEmptyCells(cells: string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1]?.trim().length === 0) {
    end -= 1;
  }
  return cells.slice(0, end);
}

const OFFICE_TABLE_HEADER_WORDS = new Set([
  "category",
  "criterion",
  "criteria",
  "date",
  "deadline",
  "deliverable",
  "description",
  "due",
  "evidence",
  "grade",
  "item",
  "milestone",
  "notes",
  "outcome",
  "points",
  "reading",
  "requirement",
  "score",
  "task",
  "topic",
  "weight",
  "week",
]);

function extractOfficeBlockText(
  xml: string,
  relationshipTargets: Map<string, string>
): string {
  const withFieldLinks = xml.replace(
    /<(?:[a-z]+:)?fldSimple\b([^>]*)>([\s\S]*?)<\/(?:[a-z]+:)?fldSimple>/gi,
    (_match, attrs, inner) =>
      officeTextElement(
        formatLinkedText(
          extractOfficeTextRuns(inner ?? ""),
          extractHyperlinkFieldTarget(String(attrs ?? ""))
        )
      )
  );
  const withRelationshipLinks = withFieldLinks.replace(
    /<(?:[a-z]+:)?hyperlink\b([^>]*)>([\s\S]*?)<\/(?:[a-z]+:)?hyperlink>/gi,
    (_match, attrs, inner) => {
      const relId =
        extractXmlAttr(String(attrs ?? ""), "r:id") ??
        extractXmlAttr(String(attrs ?? ""), "id");
      const anchor =
        extractXmlAttr(String(attrs ?? ""), "w:anchor") ??
        extractXmlAttr(String(attrs ?? ""), "anchor");
      const target = relId
        ? relationshipTargets.get(relId) ?? null
        : anchor
          ? `#${anchor}`
          : null;
      return officeTextElement(
        formatLinkedText(extractOfficeTextRuns(inner ?? ""), target)
      );
    }
  );

  return extractOfficeTextRuns(withRelationshipLinks);
}

function extractOfficeTextRuns(xml: string): string {
  const prepared = xml
    .replace(/<(?:[a-z]+:)?br\b[^>]*\/>/gi, "\n")
    .replace(/<(?:[a-z]+:)?tab\b[^>]*\/>/gi, "\t");
  const runs = [
    ...prepared.matchAll(/<(?:[a-z]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?t>/gi),
  ].map((match) => decodeEntities(match[1] ?? ""));
  return runs.join("");
}

function officeTextElement(value: string): string {
  return `<w:t>${encodeXmlText(value)}</w:t>`;
}

function encodeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatLinkedText(label: string, target: string | null): string {
  const cleanedLabel = label.replace(/\s+/g, " ").trim();
  const cleanedTarget = target?.trim() ?? "";
  if (!cleanedLabel) {
    return cleanedTarget;
  }
  if (!cleanedTarget || cleanedLabel === cleanedTarget) {
    return cleanedLabel;
  }
  return `${cleanedLabel} (${cleanedTarget})`;
}

function extractHyperlinkFieldTarget(attrs: string): string | null {
  const instruction =
    extractXmlAttr(attrs, "w:instr") ?? extractXmlAttr(attrs, "instr") ?? "";
  const match = instruction.match(/HYPERLINK\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function parseSharedStrings(xml: string): string[] {
  if (!xml.trim()) {
    return [];
  }
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) =>
    extractOfficeTextRuns(match[1] ?? "").replace(/\s+/g, " ").trim()
  );
}

function parseWorkbookSheetNames(entries: Map<string, string>): Map<string, string> {
  const workbook = entries.get("xl/workbook.xml") ?? "";
  const rels = entries.get("xl/_rels/workbook.xml.rels") ?? "";
  const targetByRelId = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b([^>]*)\/?>/gi)) {
    const attrs = match[1] ?? "";
    const id = extractXmlAttr(attrs, "Id");
    const target = extractXmlAttr(attrs, "Target");
    if (!id || !target) {
      continue;
    }
    const normalizedTarget = target.startsWith("/")
      ? target.replace(/^\/+/, "")
      : `xl/${target.replace(/^\/+/, "")}`;
    targetByRelId.set(id, normalizeZipEntryName(normalizedTarget));
  }

  const names = new Map<string, string>();
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/gi)) {
    const attrs = match[1] ?? "";
    const name = extractXmlAttr(attrs, "name");
    const relId = extractXmlAttr(attrs, "r:id");
    if (!name || !relId) {
      continue;
    }
    const target = targetByRelId.get(relId);
    if (target) {
      names.set(target, name);
    }
  }
  return names;
}

function renderWorksheetRows(xml: string, sharedStrings: string[]): string[] {
  const rows: string[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const values: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(
      /<c\b([^>]*)>([\s\S]*?)<\/c>/gi
    )) {
      const attrs = cellMatch[1] ?? "";
      const cellXml = cellMatch[2] ?? "";
      const cellRef = extractXmlAttr(attrs, "r");
      const value = extractWorksheetCellValue(attrs, cellXml, sharedStrings);
      if (!value) {
        continue;
      }
      values.push(cellRef ? `${cellRef}: ${value}` : value);
    }
    if (values.length > 0) {
      rows.push(`- ${values.join(" | ")}`);
    }
  }
  return rows;
}

function extractWorksheetCellValue(
  attrs: string,
  cellXml: string,
  sharedStrings: string[]
): string {
  const formula = extractWorksheetFormula(cellXml);
  const value = extractWorksheetCellDisplayValue(attrs, cellXml, sharedStrings);
  if (!formula) {
    return value;
  }
  if (!value) {
    return `formula: ${formula}`;
  }
  return `${value} (formula: ${formula})`;
}

function extractWorksheetCellDisplayValue(
  attrs: string,
  cellXml: string,
  sharedStrings: string[]
): string {
  const type = extractXmlAttr(attrs, "t");
  if (type === "s") {
    const sharedIndex = Number.parseInt(extractXmlValue(cellXml) ?? "", 10);
    return sharedStrings[sharedIndex] ?? "";
  }
  if (type === "inlineStr") {
    return extractOfficeTextRuns(cellXml).replace(/\s+/g, " ").trim();
  }
  return decodeEntities(extractXmlValue(cellXml) ?? "").trim();
}

function extractWorksheetFormula(cellXml: string): string | null {
  const match = cellXml.match(/<f\b[^>]*>([\s\S]*?)<\/f>/i);
  const formula = decodeEntities(match?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!formula) {
    return null;
  }
  return formula.startsWith("=") ? formula : `=${formula}`;
}

function extractXmlValue(xml: string): string | null {
  const match = xml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i);
  return match?.[1] ?? null;
}

function extractXmlAttr(attrs: string, attr: string): string | null {
  const regex = new RegExp(
    `${attr.replace(":", "\\:")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i"
  );
  const match = attrs.match(regex);
  const value = match?.[1] ?? match?.[2] ?? "";
  return value ? decodeEntities(value) : null;
}

function relationshipTargetsForPart(
  entries: Map<string, string>,
  partName: string
): Map<string, string> {
  const relsName = relationshipEntryNameForPart(partName);
  const relsXml = entries.get(relsName) ?? "";
  const targets = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/gi)) {
    const attrs = match[1] ?? "";
    const id = extractXmlAttr(attrs, "Id");
    const target = extractXmlAttr(attrs, "Target");
    if (!id || !target) {
      continue;
    }
    targets.set(id, resolveOfficeRelationshipTarget(partName, target));
  }
  return targets;
}

function relationshipEntryNameForPart(partName: string): string {
  const normalized = normalizeZipEntryName(partName);
  const dir = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized);
  return normalizeZipEntryName(path.posix.join(dir, "_rels", `${base}.rels`));
}

function resolveOfficeRelationshipTarget(partName: string, target: string): string {
  const decodedTarget = decodeEntities(target).trim();
  if (
    !decodedTarget ||
    decodedTarget.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(decodedTarget)
  ) {
    return decodedTarget;
  }
  if (decodedTarget.startsWith("/")) {
    return normalizeZipEntryName(decodedTarget.replace(/^\/+/, ""));
  }
  return normalizeZipEntryName(
    path.posix.join(path.posix.dirname(partName), decodedTarget)
  );
}

function appendSection(lines: string[], title: string, values: string[]): void {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return;
  }
  lines.push(`## ${title}`, "");
  lines.push(...cleaned);
  lines.push("");
}

function finishOfficeText(lines: string[], filename: string): string {
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || `[Could not extract text from Office document: ${filename}]`;
}

function formatOfficeEntryHeading(entryName: string): string {
  return path.basename(entryName, path.extname(entryName)).replace(/[-_]+/g, " ");
}

function compareNumberedOfficeEntries(
  left: [string, string],
  right: [string, string]
): number {
  return (extractTrailingNumber(left[0]) ?? 0) - (extractTrailingNumber(right[0]) ?? 0);
}

function extractTrailingNumber(value: string): number | null {
  const match = value.match(/(\d+)\.xml$/i);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeZipEntryName(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function isWorkbookTextEntry(name: string): boolean {
  return (
    /^xl\/(?:worksheets\/sheet\d+|sharedStrings|workbook)\.xml$/i.test(name) ||
    /^xl\/_rels\/workbook\.xml\.rels$/i.test(name)
  );
}

function isWordTextOrRelationshipEntry(name: string): boolean {
  return (
    /^word\/(?:document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/i.test(
      name
    ) ||
    /^word\/_rels\/(?:document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml\.rels$/i.test(
      name
    )
  );
}

function isPowerPointTextOrRelationshipEntry(name: string): boolean {
  return (
    /^ppt\/(?:slides|notesSlides)\/(?:slide|notesSlide)\d+\.xml$/i.test(name) ||
    isPowerPointCommentEntry(name) ||
    /^ppt\/(?:slides|notesSlides)\/_rels\/(?:slide|notesSlide)\d+\.xml\.rels$/i.test(
      name
    )
  );
}

function isPowerPointCommentEntry(name: string): boolean {
  return /^ppt\/(?:comments\/comment|threadedComments\/threadedComment)\d+\.xml$/i.test(
    name
  );
}

function isOfficeRelationshipEntry(name: string): boolean {
  return /\/_rels\/[^/]+\.xml\.rels$/i.test(name);
}
