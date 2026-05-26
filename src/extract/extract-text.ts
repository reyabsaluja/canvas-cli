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

      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      try {
        const stream = await entry.openReadStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(chunk as Buffer);
        }
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
      const isOfficeFile = OFFICE_OPEN_XML_EXTENSIONS.has(ext);

      if (isTextFile) {
        try {
          const buffer = await readEntryBuffer(entry);
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
          const buffer = await readEntryBuffer(entry);
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
          const buffer = await readEntryBuffer(entry);
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

async function extractDocx(filePath: string, filename: string): Promise<string> {
  const entries = await readZipTextEntries(filePath, (name) =>
    isWordTextOrRelationshipEntry(name)
  );
  return renderDocxEntries(filename, entries).slice(0, MAX_TEXT);
}

async function extractPptx(filePath: string, filename: string): Promise<string> {
  const entries = await readZipTextEntries(filePath, (name) =>
    /^ppt\/(?:slides|notesSlides)\/(?:slide|notesSlide)\d+\.xml$/i.test(name)
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
      return /^ppt\/(?:slides|notesSlides)\/(?:slide|notesSlide)\d+\.xml$/i.test(
        name
      );
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

  try {
    for await (const entry of zip) {
      const entryName = String(entry.filename ?? "");
      if (entryName.endsWith("/") || !shouldRead(entryName)) {
        continue;
      }
      const buffer = await readEntryBuffer(entry);
      entries.set(entryName, buffer.toString("utf-8"));
    }
  } finally {
    await zip.close();
  }

  return entries;
}

async function readEntryBuffer(entry: {
  openReadStream: () => Promise<AsyncIterable<unknown>>;
}): Promise<Buffer> {
  const stream = await entry.openReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function renderDocxEntries(
  filename: string,
  entries: Map<string, string>
): string {
  const lines = [`# ${filename}`, ""];
  const body = entries.get("word/document.xml");
  if (body) {
    appendSection(
      lines,
      "Body",
      extractOfficeParagraphs(
        body,
        relationshipTargetsForPart(entries, "word/document.xml")
      )
    );
  }

  const supplementalEntries = [...entries.entries()]
    .filter(
      ([name]) => name !== "word/document.xml" && !isOfficeRelationshipEntry(name)
    )
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [name, xml] of supplementalEntries) {
    appendSection(
      lines,
      formatOfficeEntryHeading(name),
      extractOfficeParagraphs(xml, relationshipTargetsForPart(entries, name))
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

  for (let index = 0; index < slides.length; index += 1) {
    const [name, xml] = slides[index]!;
    const slideNumber = extractTrailingNumber(name) ?? index + 1;
    appendSection(lines, `Slide ${slideNumber}`, extractOfficeParagraphs(xml));

    const noteXml = notes.get(`ppt/notesSlides/notesSlide${slideNumber}.xml`);
    if (noteXml) {
      appendSection(
        lines,
        `Speaker Notes ${slideNumber}`,
        extractOfficeParagraphs(noteXml)
      );
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

function isOfficeRelationshipEntry(name: string): boolean {
  return /\/_rels\/[^/]+\.xml\.rels$/i.test(name);
}
