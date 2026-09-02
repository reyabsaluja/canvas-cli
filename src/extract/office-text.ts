import path from "node:path";
import { createRequire } from "node:module";
import { decodeEntities } from "../format/html-to-text.js";
import { stripControlChars } from "../sanitize.js";

const require = createRequire(import.meta.url);

/**
 * Structure-preserving text extraction for Office Open XML documents
 * (Word .docx, PowerPoint .pptx, Excel .xlsx). These are zip containers of
 * XML parts, so no extra dependency is needed beyond the zip reader already
 * used for archives.
 *
 * Output deliberately mirrors the conventions of `htmlToText`:
 *   - `#`/`##`/`###` headings (Word heading styles, slide titles, sheet names)
 *   - `- ` / `1. ` list items with two-space indentation per nesting level
 *   - `Table:` blocks rendered as `- Header: value | Header: value`
 *   - `Image: <alt text>` placeholders and `label (url)` hyperlinks
 * so the downstream artifact indexer can section and rank the result exactly
 * like ingested Canvas HTML.
 */

export const OFFICE_EXTENSIONS = new Set([
  ".docx",
  ".docm",
  ".dotx",
  ".pptx",
  ".pptm",
  ".potx",
  ".xlsx",
  ".xlsm",
  ".xltx",
]);

const MAX_SHEET_ROWS = 1000;

export function isOfficeExtension(ext: string): boolean {
  return OFFICE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Extract text from an Office document held in memory. Returns null when the
 * extension is not an Office format. Throws when the container is unreadable.
 */
export async function extractOfficeText(
  buffer: Buffer,
  filename: string
): Promise<string | null> {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".docx":
    case ".docm":
    case ".dotx":
      return extractDocxText(buffer);
    case ".pptx":
    case ".pptm":
    case ".potx":
      return extractPptxText(buffer);
    case ".xlsx":
    case ".xlsm":
    case ".xltx":
      return extractXlsxText(buffer);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Zip container helpers
// ---------------------------------------------------------------------------

async function readZipParts(buffer: Buffer): Promise<Map<string, string>> {
  const yauzl = require("yauzl-promise");
  const zip = await yauzl.fromBuffer(buffer);
  const parts = new Map<string, string>();
  try {
    for await (const entry of zip) {
      const name = String(entry.filename).replace(/^\/+/, "");
      if (name.endsWith("/")) continue;
      if (!isInterestingPart(name)) continue;
      const stream = await entry.openReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      parts.set(name, Buffer.concat(chunks).toString("utf-8"));
    }
  } finally {
    await zip.close();
  }
  return parts;
}

function isInterestingPart(name: string): boolean {
  if (!/\.(xml|rels)$/i.test(name)) return false;
  // Skip binary-heavy or irrelevant parts to keep memory bounded.
  if (/^(docProps|customXml)\//.test(name)) return false;
  if (/\/(theme|media|embeddings|printerSettings)\//.test(name)) return false;
  return true;
}

function parseRels(xml: string | undefined): Map<string, string> {
  const rels = new Map<string, string>();
  if (!xml) return rels;
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = match[1] ?? "";
    const id = xmlAttr(attrs, "Id");
    const target = xmlAttr(attrs, "Target");
    if (id && target) rels.set(id, target);
  }
  return rels;
}

function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  const segments = `${baseDir}/${target}`.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join("/");
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xmlAttr(attrs: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attrs.match(
    new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
  );
  const value = match?.[1] ?? match?.[2];
  if (value === undefined) return null;
  const decoded = decodeEntities(value).trim();
  return decoded.length > 0 ? decoded : null;
}

function decodeXmlText(text: string): string {
  return stripControlChars(decodeEntities(text));
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function finalizeOutput(blocks: string[]): string {
  return stripControlChars(blocks.join("\n"))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function headingPrefix(level: number): string {
  return "#".repeat(Math.max(1, Math.min(level, 6)));
}

/**
 * Render a grid of cell strings using the same "Table:" convention as
 * htmlToText so retrieval treats Office tables like Canvas HTML tables.
 */
function renderTable(rows: string[][], headerRowIndex: number | null): string {
  const nonEmpty = rows.filter((row) => row.some((cell) => cell.length > 0));
  if (nonEmpty.length === 0) return "";

  const lines = ["Table:"];
  if (headerRowIndex !== null && rows[headerRowIndex] && nonEmpty.length > 1) {
    const header = rows[headerRowIndex] ?? [];
    for (let index = 0; index < rows.length; index += 1) {
      if (index === headerRowIndex) continue;
      const row = rows[index] ?? [];
      if (!row.some((cell) => cell.length > 0)) continue;
      const width = Math.max(header.length, row.length);
      const parts: string[] = [];
      for (let column = 0; column < width; column += 1) {
        const key = header[column] || `Column ${column + 1}`;
        const value = row[column] ?? "";
        if (!value && !header[column]) continue;
        parts.push(`${key}: ${value || "—"}`);
      }
      if (parts.length > 0) lines.push(`- ${parts.join(" | ")}`);
    }
  } else {
    for (const row of nonEmpty) {
      const values = row.filter((cell) => cell.length > 0);
      if (values.length > 0) lines.push(`- ${values.join(" | ")}`);
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

interface DocxContext {
  styleNames: Map<string, string>;
  numbering: Map<string, string>; // `${numId}:${ilvl}` -> numFmt
  rels: Map<string, string>;
  counters: Map<string, number>;
  footnoteRefs: number[];
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  const parts = await readZipParts(buffer);
  const document = parts.get("word/document.xml");
  if (!document) {
    throw new Error("word/document.xml missing from document");
  }

  const context: DocxContext = {
    styleNames: parseDocxStyles(parts.get("word/styles.xml")),
    numbering: parseDocxNumbering(parts.get("word/numbering.xml")),
    rels: parseRels(parts.get("word/_rels/document.xml.rels")),
    counters: new Map(),
    footnoteRefs: [],
  };

  const bodyMatch = document.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  const body = bodyMatch?.[1] ?? document;
  const blocks = renderDocxBlocks(body, context);

  const footnotes = renderDocxFootnotes(parts.get("word/footnotes.xml"), context);
  if (footnotes) {
    blocks.push("", "Footnotes:", footnotes);
  }
  const endnotes = renderDocxFootnotes(parts.get("word/endnotes.xml"), context);
  if (endnotes) {
    blocks.push("", "Endnotes:", endnotes);
  }

  return finalizeOutput(blocks);
}

function parseDocxStyles(xml: string | undefined): Map<string, string> {
  const names = new Map<string, string>();
  if (!xml) return names;
  for (const match of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const styleId = xmlAttr(match[1] ?? "", "w:styleId");
    const nameMatch = (match[2] ?? "").match(/<w:name\b([^>]*)\/?>/);
    const name = nameMatch ? xmlAttr(nameMatch[1] ?? "", "w:val") : null;
    if (styleId && name) names.set(styleId, name);
  }
  return names;
}

function parseDocxNumbering(xml: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!xml) return result;

  const abstractFormats = new Map<string, Map<string, string>>();
  for (const match of xml.matchAll(
    /<w:abstractNum\b([^>]*)>([\s\S]*?)<\/w:abstractNum>/g
  )) {
    const abstractId = xmlAttr(match[1] ?? "", "w:abstractNumId");
    if (!abstractId) continue;
    const levels = new Map<string, string>();
    for (const level of (match[2] ?? "").matchAll(
      /<w:lvl\b([^>]*)>([\s\S]*?)<\/w:lvl>/g
    )) {
      const ilvl = xmlAttr(level[1] ?? "", "w:ilvl");
      const fmtMatch = (level[2] ?? "").match(/<w:numFmt\b([^>]*)\/?>/);
      const fmt = fmtMatch ? xmlAttr(fmtMatch[1] ?? "", "w:val") : null;
      if (ilvl) levels.set(ilvl, fmt ?? "decimal");
    }
    abstractFormats.set(abstractId, levels);
  }

  for (const match of xml.matchAll(/<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g)) {
    const numId = xmlAttr(match[1] ?? "", "w:numId");
    const abstractMatch = (match[2] ?? "").match(/<w:abstractNumId\b([^>]*)\/?>/);
    const abstractId = abstractMatch
      ? xmlAttr(abstractMatch[1] ?? "", "w:val")
      : null;
    if (!numId || !abstractId) continue;
    const levels = abstractFormats.get(abstractId);
    if (!levels) continue;
    for (const [ilvl, fmt] of levels) {
      result.set(`${numId}:${ilvl}`, fmt);
    }
  }

  return result;
}

const DOCX_BLOCK_PATTERN =
  /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

function renderDocxBlocks(xml: string, context: DocxContext): string[] {
  const blocks: string[] = [];
  let previousWasListItem = false;

  for (const match of xml.matchAll(DOCX_BLOCK_PATTERN)) {
    const block = match[0];
    if (block.startsWith("<w:tbl")) {
      const table = renderDocxTable(block, context);
      if (table) {
        blocks.push("", table, "");
      }
      previousWasListItem = false;
      continue;
    }

    const rendered = renderDocxParagraph(block, context);
    if (!rendered) continue;

    if (rendered.kind === "heading") {
      blocks.push("", rendered.text, "");
      previousWasListItem = false;
    } else if (rendered.kind === "list") {
      if (!previousWasListItem) blocks.push("");
      blocks.push(rendered.text);
      previousWasListItem = true;
    } else {
      if (previousWasListItem) blocks.push("");
      blocks.push(rendered.text, "");
      previousWasListItem = false;
    }
  }

  return blocks;
}

function renderDocxParagraph(
  paragraphXml: string,
  context: DocxContext
): { kind: "heading" | "list" | "paragraph"; text: string } | null {
  const propsMatch = paragraphXml.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/);
  const props = propsMatch?.[1] ?? "";
  const text = renderDocxRuns(
    paragraphXml.replace(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/, ""),
    context
  );
  const lines = text
    .split("\n")
    .map((line) => collapseWhitespace(line))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const headingLevel = docxHeadingLevel(props, context);
  if (headingLevel !== null) {
    return {
      kind: "heading",
      text: `${headingPrefix(headingLevel)} ${lines.join(" ")}`,
    };
  }

  const numPr = props.match(/<w:numPr\b[^>]*>([\s\S]*?)<\/w:numPr>/)?.[1];
  if (numPr) {
    const ilvlMatch = numPr.match(/<w:ilvl\b([^>]*)\/?>/);
    const numIdMatch = numPr.match(/<w:numId\b([^>]*)\/?>/);
    const ilvl = Number.parseInt(
      (ilvlMatch ? xmlAttr(ilvlMatch[1] ?? "", "w:val") : null) ?? "0",
      10
    );
    const numId = (numIdMatch ? xmlAttr(numIdMatch[1] ?? "", "w:val") : null) ?? "";
    const level = Number.isFinite(ilvl) ? Math.max(0, ilvl) : 0;
    const fmt = context.numbering.get(`${numId}:${level}`) ?? "bullet";
    const indent = "  ".repeat(level);
    let marker = "- ";
    if (fmt !== "bullet" && fmt !== "none") {
      const key = `${numId}:${level}`;
      const next = (context.counters.get(key) ?? 0) + 1;
      context.counters.set(key, next);
      // Restart deeper levels whenever a shallower item advances.
      for (const counterKey of [...context.counters.keys()]) {
        const [counterNumId, counterLevel] = counterKey.split(":");
        if (counterNumId === numId && Number(counterLevel) > level) {
          context.counters.delete(counterKey);
        }
      }
      marker = `${next}. `;
    }
    const [first, ...rest] = lines;
    const continuation = rest.map((line) => `${indent}   ${line}`);
    return {
      kind: "list",
      text: [`${indent}${marker}${first}`, ...continuation].join("\n"),
    };
  }

  return { kind: "paragraph", text: lines.join("\n") };
}

function docxHeadingLevel(props: string, context: DocxContext): number | null {
  const styleMatch = props.match(/<w:pStyle\b([^>]*)\/?>/);
  const styleId = styleMatch ? xmlAttr(styleMatch[1] ?? "", "w:val") : null;
  if (styleId) {
    const styleName = context.styleNames.get(styleId) ?? styleId;
    const candidates = [styleName, styleId];
    for (const candidate of candidates) {
      if (/^title$/i.test(candidate)) return 1;
      const headingMatch = candidate.match(/^heading\s*(\d)$/i);
      if (headingMatch) {
        return Number.parseInt(headingMatch[1] ?? "1", 10) + 1;
      }
    }
  }
  const outlineMatch = props.match(/<w:outlineLvl\b([^>]*)\/?>/);
  if (outlineMatch) {
    const value = Number.parseInt(
      xmlAttr(outlineMatch[1] ?? "", "w:val") ?? "",
      10
    );
    if (Number.isFinite(value) && value >= 0 && value < 9) {
      return value + 2;
    }
  }
  return null;
}

const DOCX_RUN_PATTERN =
  /<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<m:t\b[^>]*>([\s\S]*?)<\/m:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<wp:docPr\b([^>]*?)\/?>|<w:footnoteReference\b([^>]*)\/>|<w:endnoteReference\b([^>]*)\/>/g;

function renderDocxRuns(xml: string, context: DocxContext): string {
  const withoutDeletions = xml.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, "");
  let output = "";

  for (const match of withoutDeletions.matchAll(DOCX_RUN_PATTERN)) {
    const token = match[0];
    if (token.startsWith("<w:hyperlink")) {
      const attrs = match[1] ?? "";
      const label = collapseWhitespace(renderDocxRuns(match[2] ?? "", context));
      const relId = xmlAttr(attrs, "r:id");
      const target = relId ? context.rels.get(relId) ?? null : null;
      if (target && label && label !== target) {
        output += `${label} (${target})`;
      } else {
        output += label || target || "";
      }
      continue;
    }
    if (token.startsWith("<w:t")) {
      if (token.startsWith("<w:tab")) {
        output += "\t";
      } else {
        output += decodeXmlText(match[3] ?? "");
      }
      continue;
    }
    if (token.startsWith("<m:t")) {
      output += decodeXmlText(match[4] ?? "");
      continue;
    }
    if (token.startsWith("<w:br") || token.startsWith("<w:cr")) {
      output += "\n";
      continue;
    }
    if (token.startsWith("<wp:docPr")) {
      const attrs = match[5] ?? "";
      const description = xmlAttr(attrs, "descr") ?? xmlAttr(attrs, "title");
      if (description) {
        output += ` Image: ${collapseWhitespace(description)} `;
      }
      continue;
    }
    if (token.startsWith("<w:footnoteReference") || token.startsWith("<w:endnoteReference")) {
      const attrs = match[6] ?? match[7] ?? "";
      const id = xmlAttr(attrs, "w:id");
      if (id) {
        output += `[${id}]`;
        context.footnoteRefs.push(Number.parseInt(id, 10));
      }
      continue;
    }
  }

  return output;
}

function renderDocxTable(tableXml: string, context: DocxContext): string {
  const rows: string[][] = [];
  let headerRowIndex: number | null = null;

  const rowMatches = [...tableXml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)];
  for (let index = 0; index < rowMatches.length; index += 1) {
    const rowXml = rowMatches[index]?.[1] ?? "";
    if (headerRowIndex === null && /<w:tblHeader\b/.test(rowXml)) {
      headerRowIndex = index;
    }
    const cells = [...rowXml.matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map(
      (cellMatch) => {
        const cellXml = cellMatch[1] ?? "";
        const paragraphs = [...cellXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
          .map((paragraph) =>
            collapseWhitespace(
              renderDocxRuns(
                (paragraph[1] ?? "").replace(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/, ""),
                context
              )
            )
          )
          .filter((text) => text.length > 0);
        return paragraphs.join(" ");
      }
    );
    rows.push(cells);
  }

  if (headerRowIndex === null && rows.length > 1 && isBoldRow(rowMatches[0]?.[1] ?? "")) {
    headerRowIndex = 0;
  }

  return renderTable(rows, headerRowIndex);
}

function isBoldRow(rowXml: string): boolean {
  const runs = [...rowXml.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)].filter((run) =>
    /<w:t\b/.test(run[1] ?? "")
  );
  if (runs.length === 0) return false;
  return runs.every((run) => /<w:rPr\b[^>]*>[\s\S]*?<w:b\b(?![^>]*w:val="(?:0|false)")[\s\S]*?<\/w:rPr>/.test(run[1] ?? ""));
}

function renderDocxFootnotes(
  xml: string | undefined,
  context: DocxContext
): string {
  if (!xml) return "";
  const lines: string[] = [];
  for (const match of xml.matchAll(
    /<w:(?:footnote|endnote)\b([^>]*)>([\s\S]*?)<\/w:(?:footnote|endnote)>/g
  )) {
    const id = xmlAttr(match[1] ?? "", "w:id");
    if (!id || Number.parseInt(id, 10) < 1) continue;
    const text = collapseWhitespace(
      [...(match[2] ?? "").matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
        .map((paragraph) => renderDocxRuns(paragraph[1] ?? "", context))
        .join(" ")
    );
    if (text) lines.push(`[${id}] ${text}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

export async function extractPptxText(buffer: Buffer): Promise<string> {
  const parts = await readZipParts(buffer);
  const slidePaths = orderedSlidePaths(parts);
  if (slidePaths.length === 0) {
    throw new Error("no slides found in presentation");
  }

  const blocks: string[] = [];
  for (let index = 0; index < slidePaths.length; index += 1) {
    const slidePath = slidePaths[index] ?? "";
    const slideXml = parts.get(slidePath);
    if (!slideXml) continue;
    const slideNumber = index + 1;
    const slideRels = parseRels(
      parts.get(
        `${path.posix.dirname(slidePath)}/_rels/${path.posix.basename(slidePath)}.rels`
      )
    );
    const { title, body } = renderPptxSlide(slideXml, slideRels);

    blocks.push("", `## Slide ${slideNumber}${title ? `: ${title}` : ""}`, "");
    if (body.length > 0) {
      blocks.push(...body);
    }

    const notesTarget = [...slideRels.values()].find((target) =>
      /notesSlides\/notesSlide\d+\.xml$/i.test(target)
    );
    if (notesTarget) {
      const notesPath = resolvePartPath(path.posix.dirname(slidePath), notesTarget);
      const notesXml = parts.get(notesPath);
      if (notesXml) {
        const notes = renderPptxNotes(notesXml);
        if (notes.length > 0) {
          blocks.push("", "Speaker notes:", ...notes);
        }
      }
    }
  }

  return finalizeOutput(blocks);
}

function orderedSlidePaths(parts: Map<string, string>): string[] {
  const presentation = parts.get("ppt/presentation.xml");
  const rels = parseRels(parts.get("ppt/_rels/presentation.xml.rels"));
  const ordered: string[] = [];

  if (presentation) {
    for (const match of presentation.matchAll(/<p:sldId\b([^>]*)\/?>/g)) {
      const relId = xmlAttr(match[1] ?? "", "r:id");
      const target = relId ? rels.get(relId) : null;
      if (!target) continue;
      const resolved = resolvePartPath("ppt", target);
      if (parts.has(resolved)) ordered.push(resolved);
    }
  }

  if (ordered.length > 0) return ordered;

  return [...parts.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideIndex(a) - slideIndex(b));
}

function slideIndex(name: string): number {
  const match = name.match(/slide(\d+)\.xml$/i);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

const PPTX_SHAPE_PATTERN =
  /<p:sp\b[^>]*>[\s\S]*?<\/p:sp>|<p:graphicFrame\b[^>]*>[\s\S]*?<\/p:graphicFrame>|<p:pic\b[^>]*>[\s\S]*?<\/p:pic>/g;

function renderPptxSlide(
  slideXml: string,
  rels: Map<string, string>
): { title: string; body: string[] } {
  let title = "";
  const body: string[] = [];

  for (const match of slideXml.matchAll(PPTX_SHAPE_PATTERN)) {
    const shape = match[0];

    if (shape.startsWith("<p:graphicFrame")) {
      const tableMatch = shape.match(/<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/);
      if (tableMatch) {
        const table = renderPptxTable(tableMatch[0]);
        if (table) body.push("", table, "");
      }
      continue;
    }

    if (shape.startsWith("<p:pic")) {
      const propsMatch = shape.match(/<p:cNvPr\b([^>]*)\/?>/);
      const description = propsMatch
        ? xmlAttr(propsMatch[1] ?? "", "descr")
        : null;
      if (description) {
        body.push(`Image: ${collapseWhitespace(description)}`);
      }
      continue;
    }

    const placeholderMatch = shape.match(/<p:ph\b([^>]*)\/?>/);
    const placeholderType = placeholderMatch
      ? xmlAttr(placeholderMatch[1] ?? "", "type") ?? "body"
      : null;
    if (
      placeholderType === "sldNum" ||
      placeholderType === "ftr" ||
      placeholderType === "dt"
    ) {
      continue;
    }

    const textBody = shape.match(/<p:txBody\b[^>]*>([\s\S]*?)<\/p:txBody>/)?.[1];
    if (!textBody) continue;

    const isTitle = placeholderType === "title" || placeholderType === "ctrTitle";
    const paragraphs = renderDrawingParagraphs(textBody, rels, {
      bulletsByDefault: !isTitle && placeholderType !== "subTitle",
    });
    if (paragraphs.length === 0) continue;

    if (isTitle && !title) {
      title = collapseWhitespace(paragraphs.join(" "));
      continue;
    }

    body.push(...paragraphs, "");
  }

  return { title, body };
}

function renderPptxNotes(notesXml: string): string[] {
  const lines: string[] = [];
  for (const match of notesXml.matchAll(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)) {
    const shape = match[0];
    const placeholderMatch = shape.match(/<p:ph\b([^>]*)\/?>/);
    const placeholderType = placeholderMatch
      ? xmlAttr(placeholderMatch[1] ?? "", "type") ?? "body"
      : null;
    if (placeholderType !== "body") continue;
    const textBody = shape.match(/<p:txBody\b[^>]*>([\s\S]*?)<\/p:txBody>/)?.[1];
    if (!textBody) continue;
    lines.push(
      ...renderDrawingParagraphs(textBody, new Map(), { bulletsByDefault: false })
    );
  }
  return lines;
}

/**
 * Render DrawingML `<a:p>` paragraphs (shared by slides, notes, and table cells).
 */
function renderDrawingParagraphs(
  xml: string,
  rels: Map<string, string>,
  options: { bulletsByDefault: boolean }
): string[] {
  const lines: string[] = [];
  const counters = new Map<number, number>();

  for (const match of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const paragraph = match[1] ?? "";
    const props = paragraph.match(/<a:pPr\b([^>]*)(?:\/>|>([\s\S]*?)<\/a:pPr>)/);
    const propsAttrs = props?.[1] ?? "";
    const propsInner = props?.[2] ?? "";
    const level = Number.parseInt(xmlAttr(propsAttrs, "lvl") ?? "0", 10) || 0;

    const text = renderDrawingRuns(paragraph, rels)
      .split("\n")
      .map((line) => collapseWhitespace(line))
      .filter((line) => line.length > 0);
    if (text.length === 0) continue;

    const hasNumbering = /<a:buAutoNum\b/.test(propsInner);
    const hasBulletChar = /<a:buChar\b/.test(propsInner) || /<a:buBlip\b/.test(propsInner);
    const bulletsDisabled = /<a:buNone\b/.test(propsInner);
    const isBullet =
      !bulletsDisabled && (hasNumbering || hasBulletChar || options.bulletsByDefault);

    if (!isBullet) {
      lines.push(...text);
      continue;
    }

    const indent = "  ".repeat(Math.max(0, level));
    let marker = "- ";
    if (hasNumbering) {
      const next = (counters.get(level) ?? 0) + 1;
      counters.set(level, next);
      for (const key of [...counters.keys()]) {
        if (key > level) counters.delete(key);
      }
      marker = `${next}. `;
    }
    const [first, ...rest] = text;
    lines.push(`${indent}${marker}${first}`);
    for (const continuation of rest) {
      lines.push(`${indent}   ${continuation}`);
    }
  }

  return lines;
}

const DRAWING_RUN_PATTERN =
  /<a:r\b[^>]*>([\s\S]*?)<\/a:r>|<a:fld\b([^>]*)>([\s\S]*?)<\/a:fld>|<a:br\b[^>]*\/?>/g;

function renderDrawingRuns(paragraphXml: string, rels: Map<string, string>): string {
  let output = "";
  for (const match of paragraphXml.matchAll(DRAWING_RUN_PATTERN)) {
    const token = match[0];
    if (token.startsWith("<a:br")) {
      output += "\n";
      continue;
    }
    if (token.startsWith("<a:fld")) {
      const fieldType = xmlAttr(match[2] ?? "", "type") ?? "";
      if (/slidenum/i.test(fieldType)) continue;
      output += drawingRunText(match[3] ?? "");
      continue;
    }
    const runXml = match[1] ?? "";
    const text = drawingRunText(runXml);
    const linkMatch = runXml.match(/<a:hlinkClick\b([^>]*)\/?>/);
    const relId = linkMatch ? xmlAttr(linkMatch[1] ?? "", "r:id") : null;
    const target = relId ? rels.get(relId) ?? null : null;
    if (target && text.trim() && text.trim() !== target) {
      output += `${text} (${target})`;
    } else {
      output += text || target || "";
    }
  }
  return output;
}

function drawingRunText(runXml: string): string {
  return [...runXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXmlText(match[1] ?? ""))
    .join("");
}

function renderPptxTable(tableXml: string): string {
  const firstRowIsHeader = /<a:tblPr\b[^>]*\bfirstRow="(?:1|true)"/.test(tableXml);
  const rows = [...tableXml.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map(
    (row) =>
      [...(row[1] ?? "").matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((cell) =>
        collapseWhitespace(
          renderDrawingParagraphs(cell[1] ?? "", new Map(), {
            bulletsByDefault: false,
          }).join(" ")
        )
      )
  );
  return renderTable(rows, firstRowIsHeader && rows.length > 1 ? 0 : null);
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

export async function extractXlsxText(buffer: Buffer): Promise<string> {
  const parts = await readZipParts(buffer);
  const workbook = parts.get("xl/workbook.xml");
  if (!workbook) {
    throw new Error("xl/workbook.xml missing from workbook");
  }

  const rels = parseRels(parts.get("xl/_rels/workbook.xml.rels"));
  const sharedStrings = parseSharedStrings(parts.get("xl/sharedStrings.xml"));
  const blocks: string[] = [];

  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = match[1] ?? "";
    const name = xmlAttr(attrs, "name") ?? "Sheet";
    const relId = xmlAttr(attrs, "r:id");
    const target = relId ? rels.get(relId) : null;
    if (!target) continue;
    const sheetXml = parts.get(resolvePartPath("xl", target));
    if (!sheetXml) continue;

    const rendered = renderSheet(sheetXml, sharedStrings);
    blocks.push("", `## Sheet: ${name}`, "");
    blocks.push(rendered || "(empty sheet)");
  }

  return finalizeOutput(blocks);
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...(match[1] ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((text) => decodeXmlText(text[1] ?? ""))
      .join("")
  );
}

function renderSheet(sheetXml: string, sharedStrings: string[]): string {
  const rows: string[][] = [];
  let omitted = 0;

  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    )) {
      const attrs = cellMatch[1] ?? "";
      const inner = cellMatch[2] ?? "";
      const reference = xmlAttr(attrs, "r") ?? "";
      const column = columnIndexFromReference(reference);
      const value = cellValue(attrs, inner, sharedStrings);
      const index = column ?? cells.length;
      while (cells.length < index) cells.push("");
      cells[index] = value;
    }
    if (!cells.some((cell) => cell.length > 0)) continue;
    if (rows.length >= MAX_SHEET_ROWS) {
      omitted += 1;
      continue;
    }
    rows.push(cells.map((cell) => cell ?? ""));
  }

  if (rows.length === 0) return "";

  const first = rows[0] ?? [];
  const headerLikely =
    rows.length > 1 &&
    first.filter((cell) => cell.length > 0).length >= 2 &&
    first.every((cell) => cell.length === 0 || !isNumericCell(cell));

  const table = renderTable(rows, headerLikely ? 0 : null);
  return omitted > 0 ? `${table}\n(${omitted} more rows omitted)` : table;
}

function cellValue(attrs: string, inner: string, sharedStrings: string[]): string {
  const type = xmlAttr(attrs, "t");
  if (type === "inlineStr") {
    return collapseWhitespace(
      [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((match) => decodeXmlText(match[1] ?? ""))
        .join("")
    );
  }
  const raw = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (raw === undefined) return "";
  const value = decodeXmlText(raw).trim();
  if (type === "s") {
    const index = Number.parseInt(value, 10);
    return collapseWhitespace(sharedStrings[index] ?? "");
  }
  if (type === "b") {
    return value === "1" ? "TRUE" : "FALSE";
  }
  return collapseWhitespace(value);
}

function isNumericCell(value: string): boolean {
  return /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value);
}

function columnIndexFromReference(reference: string): number | null {
  const letters = reference.match(/^([A-Z]+)\d*$/i)?.[1];
  if (!letters) return null;
  let index = 0;
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}
