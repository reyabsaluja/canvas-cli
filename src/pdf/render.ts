import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";

export interface PdfRenderOptions {
  title: string;
  subtitle?: string;
  generatedAt?: string;
}

const PAGE_MARGIN_TOP = 54;
const PAGE_MARGIN_BOTTOM = 54;
const PAGE_MARGIN_X = 56;

const TEXT_COLOR = "#1a1a1a";
const MUTED_COLOR = "#6b7280";
const ACCENT_COLOR = "#b91c1c";
const RULE_COLOR = "#d4d4d8";
const CODE_BG = "#f4f4f5";
const QUOTE_BAR = "#b91c1c";
const QUOTE_BG = "#fafafa";
const TABLE_HEADER_BG = "#f4f4f5";
const TABLE_BORDER = "#e4e4e7";

const BODY_SIZE = 10;
const BODY_LINE_GAP = 3.2;
const LIST_SIZE = 10;
const PARA_SPACING = 6;

type PdfDoc = PDFKit.PDFDocument;

export async function renderMarkdownToPdf(
  markdown: string,
  outputPath: string,
  options: PdfRenderOptions
): Promise<void> {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: {
        top: PAGE_MARGIN_TOP,
        right: PAGE_MARGIN_X,
        bottom: PAGE_MARGIN_BOTTOM,
        left: PAGE_MARGIN_X,
      },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: options.title,
        Creator: "canvas-cli",
        Producer: "canvas-cli",
      },
    });

    const stream = fs.createWriteStream(outputPath);
    stream.once("finish", resolve);
    stream.once("error", reject);
    doc.once("error", reject);
    doc.pipe(stream);

    renderDocument(doc, markdown, options);
    addFooters(doc, options);
    doc.end();
  });
}

function renderDocument(
  doc: PdfDoc,
  markdown: string,
  options: PdfRenderOptions
): void {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let index = 0;
  let skippedDocumentTitle = false;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    renderParagraph(doc, paragraph.join(" "));
    paragraph = [];
  };

  renderTopMatter(doc, options);

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(\w+)?\s*$/);
    if (fence) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (codeLines.length > 0) {
        renderCodeBlock(doc, codeLines.join("\n"));
      }
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const headingText = cleanInlineMarkdown(heading[2] ?? "");
      const level = heading[1]?.length ?? 1;
      if (
        !skippedDocumentTitle &&
        level === 1 &&
        normalizeTitle(headingText) === normalizeTitle(options.title)
      ) {
        skippedDocumentTitle = true;
        index += 1;
        continue;
      }
      skippedDocumentTitle = true;
      renderHeading(doc, headingText, level);
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      renderRule(doc);
      index += 1;
      continue;
    }

    if (looksLikeTableLine(trimmed)) {
      flushParagraph();
      const tableLines: string[] = [];
      while (index < lines.length && looksLikeTableLine((lines[index] ?? "").trim())) {
        tableLines.push((lines[index] ?? "").trim());
        index += 1;
      }
      renderTable(doc, tableLines);
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const quoteLines: string[] = [quote[1] ?? ""];
      index += 1;
      while (index < lines.length) {
        const next = (lines[index] ?? "").trim();
        const nextQuote = next.match(/^>\s?(.*)$/);
        if (!nextQuote) break;
        quoteLines.push(nextQuote[1] ?? "");
        index += 1;
      }
      renderQuote(doc, quoteLines.join(" "));
      continue;
    }

    const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      renderListItem(
        doc,
        listItem[3] ?? "",
        listItem[2] ?? "-",
        listItem[1]?.length ?? 0
      );
      index += 1;
      continue;
    }

    paragraph.push(cleanInlineMarkdown(trimmed));
    index += 1;
  }

  flushParagraph();
}

function renderTopMatter(doc: PdfDoc, options: PdfRenderOptions): void {
  doc.fillColor(ACCENT_COLOR).font("Helvetica-Bold").fontSize(9).text("canvas-cli");
  doc.moveDown(0.35);
  doc
    .fillColor(TEXT_COLOR)
    .font("Helvetica-Bold")
    .fontSize(20)
    .text(options.title, { width: contentWidth(doc), lineGap: 2 });
  if (options.subtitle) {
    doc.moveDown(0.2);
    doc
      .fillColor(MUTED_COLOR)
      .font("Helvetica")
      .fontSize(9)
      .text(options.subtitle, { width: contentWidth(doc) });
  }
  if (options.generatedAt) {
    doc.moveDown(0.15);
    doc
      .fillColor(MUTED_COLOR)
      .font("Helvetica")
      .fontSize(8)
      .text(`Generated ${options.generatedAt}`);
  }
  doc.moveDown(0.6);
  renderRule(doc);
}

function renderHeading(doc: PdfDoc, rawText: string, level: number): void {
  const text = cleanInlineMarkdown(rawText);
  const config = {
    1: { fontSize: 16, before: 14, after: 5, color: ACCENT_COLOR },
    2: { fontSize: 13, before: 12, after: 4, color: ACCENT_COLOR },
    3: { fontSize: 11, before: 9, after: 3, color: TEXT_COLOR },
    4: { fontSize: BODY_SIZE, before: 7, after: 2, color: TEXT_COLOR },
  }[level] ?? { fontSize: BODY_SIZE, before: 7, after: 2, color: TEXT_COLOR };

  ensureSpace(doc, config.fontSize * 2.5);
  doc.moveDown(config.before / 12);
  doc.fillColor(config.color);
  doc.font("Helvetica-Bold").fontSize(config.fontSize).text(text, {
    width: contentWidth(doc),
    lineGap: 1,
  });
  doc.moveDown(config.after / 12);
}

function renderParagraph(doc: PdfDoc, text: string): void {
  const cleaned = cleanInlineMarkdown(text);
  if (!cleaned) return;
  ensureSpace(doc, 28);
  doc.fillColor(TEXT_COLOR).font("Helvetica").fontSize(BODY_SIZE).text(cleaned, {
    width: contentWidth(doc),
    lineGap: BODY_LINE_GAP,
  });
  doc.moveDown(PARA_SPACING / 12);
}

function renderListItem(
  doc: PdfDoc,
  rawText: string,
  marker: string,
  indentSpaces: number
): void {
  const indent = Math.min(Math.floor(indentSpaces / 2), 4) * 13;
  const isNumbered = /^\d/.test(marker);
  const bullet = isNumbered ? marker.replace(/[.)]$/, ".") : "\u2022";
  const markerWidth = isNumbered ? 22 : 12;

  ensureSpace(doc, 20);
  const x = doc.page.margins.left + indent;
  const y = doc.y;
  const width = contentWidth(doc) - indent - markerWidth;

  doc
    .fillColor(MUTED_COLOR)
    .font("Helvetica")
    .fontSize(LIST_SIZE)
    .text(bullet, x, y, { width: markerWidth, align: isNumbered ? "right" : "left" });
  doc
    .fillColor(TEXT_COLOR)
    .font("Helvetica")
    .fontSize(LIST_SIZE)
    .text(cleanInlineMarkdown(rawText), x + markerWidth + 2, y, {
      width: width - 2,
      lineGap: 2.5,
    });
  doc.moveDown(0.15);
}

function renderQuote(doc: PdfDoc, rawText: string): void {
  const text = cleanInlineMarkdown(rawText);
  if (!text) return;

  const width = contentWidth(doc);
  const bodyWidth = width - 16;
  const height = doc.heightOfString(text, {
    width: bodyWidth,
    lineGap: 2,
  });

  ensureSpace(doc, height + 16);
  const x = doc.page.margins.left;
  const y = doc.y;
  doc.roundedRect(x, y, width, height + 12, 3).fill(QUOTE_BG);
  doc.rect(x, y, 3, height + 12).fill(QUOTE_BAR);
  doc
    .fillColor(MUTED_COLOR)
    .font("Helvetica-Oblique")
    .fontSize(9)
    .text(text, x + 12, y + 6, { width: bodyWidth, lineGap: 2 });
  doc.y = y + height + 16;
}

function renderCodeBlock(doc: PdfDoc, code: string): void {
  const text = code.trimEnd();
  if (!text) return;

  const width = contentWidth(doc);
  const padX = 10;
  const padY = 8;
  const codeWidth = width - padX * 2;
  doc.font("Courier").fontSize(8);
  const height = doc.heightOfString(text, {
    width: codeWidth,
    lineGap: 2,
  });

  const blockHeight = height + padY * 2;
  const maxFirstPageBlock = usableHeight(doc) * 0.6;

  if (blockHeight > maxFirstPageBlock) {
    renderCodeBlockFlowing(doc, text, width, padX, padY);
    return;
  }

  ensureSpace(doc, blockHeight);
  const x = doc.page.margins.left;
  const y = doc.y;
  doc.roundedRect(x, y, width, blockHeight, 3).fill(CODE_BG);
  doc
    .fillColor("#374151")
    .font("Courier")
    .fontSize(8)
    .text(text, x + padX, y + padY, {
      width: codeWidth,
      lineGap: 2,
    });
  doc.y = Math.max(doc.y, y + blockHeight + 2);
  doc.moveDown(0.3);
}

function renderCodeBlockFlowing(
  doc: PdfDoc,
  code: string,
  _width: number,
  padX: number,
  padY: number
): void {
  const codeLines = code.split("\n");
  const width = contentWidth(doc);
  const codeWidth = width - padX * 2;

  ensureSpace(doc, 30);
  const x = doc.page.margins.left;

  let bgStartY = doc.y;
  doc.font("Courier").fontSize(8);

  function drawBgRect(startY: number, endY: number): void {
    if (endY <= startY) return;
    doc.save();
    doc.roundedRect(x, startY, width, endY - startY + padY, 3).fill(CODE_BG);
    doc.restore();
  }

  doc.y += padY;

  for (let i = 0; i < codeLines.length; i++) {
    const lineText = codeLines[i] ?? "";
    const lineH = doc.heightOfString(lineText || " ", { width: codeWidth, lineGap: 2 });

    if (doc.y + lineH > pageBottom(doc)) {
      drawBgRect(bgStartY, doc.y);
      doc.addPage();
      bgStartY = doc.page.margins.top;
      doc.y = bgStartY + padY;
    }

    doc.fillColor("#374151").text(lineText, x + padX, doc.y, {
      width: codeWidth,
      lineGap: 2,
    });
  }

  drawBgRect(bgStartY, doc.y);
  doc.y += padY;
  doc.moveDown(0.3);
}

function renderTable(doc: PdfDoc, tableLines: string[]): void {
  const parsed = parseTable(tableLines);
  if (!parsed || parsed.rows.length === 0) {
    renderCodeBlock(doc, tableLines.join("\n"));
    return;
  }

  const { headers, rows } = parsed;
  const totalWidth = contentWidth(doc);
  const cellPadX = 6;
  const cellPadY = 4;
  const colCount = headers.length;

  doc.font("Helvetica").fontSize(8.5);

  const colWidths = computeColumnWidths(doc, headers, rows, totalWidth, cellPadX);
  const x0 = doc.page.margins.left;

  ensureSpace(doc, 40);

  function drawRow(cells: string[], isHeader: boolean): void {
    const cellHeights = cells.map((cell, col) =>
      doc.heightOfString(cell, {
        width: (colWidths[col] ?? 60) - cellPadX * 2,
        lineGap: 1.5,
      })
    );
    const rowHeight = Math.max(...cellHeights) + cellPadY * 2;

    if (doc.y + rowHeight > pageBottom(doc)) {
      doc.addPage();
    }

    let cx = x0;
    const ry = doc.y;

    if (isHeader) {
      doc.save();
      doc.rect(x0, ry, totalWidth, rowHeight).fill(TABLE_HEADER_BG);
      doc.restore();
    }

    doc.save();
    doc.rect(x0, ry, totalWidth, rowHeight).stroke(TABLE_BORDER);
    for (let col = 1; col < colCount; col++) {
      const lineX = x0 + colWidths.slice(0, col).reduce((a, b) => a + b, 0);
      doc
        .moveTo(lineX, ry)
        .lineTo(lineX, ry + rowHeight)
        .stroke(TABLE_BORDER);
    }
    doc.restore();

    cx = x0;
    for (let col = 0; col < colCount; col++) {
      const w = colWidths[col] ?? 60;
      doc
        .fillColor(TEXT_COLOR)
        .font(isHeader ? "Helvetica-Bold" : "Helvetica")
        .fontSize(8.5)
        .text(cells[col] ?? "", cx + cellPadX, ry + cellPadY, {
          width: w - cellPadX * 2,
          lineGap: 1.5,
        });
      cx += w;
    }

    doc.y = ry + rowHeight;
  }

  drawRow(headers, true);
  for (const row of rows) {
    drawRow(row, false);
  }

  doc.moveDown(0.4);
}

function parseTable(
  lines: string[]
): { headers: string[]; rows: string[][] } | null {
  if (lines.length < 2) return null;

  const headerLine = lines[0] ?? "";
  const separatorLine = lines[1] ?? "";

  if (!/^[|\s:-]+$/.test(separatorLine.trim())) return null;

  const splitRow = (line: string): string[] =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cleanInlineMarkdown(cell.trim()));

  const headers = splitRow(headerLine);
  const rows = lines
    .slice(2)
    .filter((l) => l.trim())
    .map((line) => {
      const cells = splitRow(line);
      while (cells.length < headers.length) cells.push("");
      return cells.slice(0, headers.length);
    });

  return { headers, rows };
}

function computeColumnWidths(
  doc: PdfDoc,
  headers: string[],
  rows: string[][],
  totalWidth: number,
  cellPadX: number
): number[] {
  const colCount = headers.length;
  const minWidth = 40;

  const naturalWidths = headers.map((header, col) => {
    let maxW = doc.widthOfString(header) + cellPadX * 2 + 4;
    for (const row of rows.slice(0, 20)) {
      const cellW = doc.widthOfString(row[col] ?? "") + cellPadX * 2 + 4;
      maxW = Math.max(maxW, cellW);
    }
    return Math.max(minWidth, maxW);
  });

  const sumNatural = naturalWidths.reduce((a, b) => a + b, 0);
  if (sumNatural <= totalWidth) {
    const extra = totalWidth - sumNatural;
    return naturalWidths.map((w) => w + extra / colCount);
  }

  return naturalWidths.map(
    (w) => Math.max(minWidth, (w / sumNatural) * totalWidth)
  );
}

function renderRule(doc: PdfDoc): void {
  ensureSpace(doc, 10);
  const y = doc.y;
  doc
    .strokeColor(RULE_COLOR)
    .lineWidth(0.6)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke();
  doc.moveDown(0.6);
}

function addFooters(doc: PdfDoc, options: PdfRenderOptions): void {
  const range = doc.bufferedPageRange();
  for (
    let pageIndex = range.start;
    pageIndex < range.start + range.count;
    pageIndex++
  ) {
    doc.switchToPage(pageIndex);
    const pageNumber = pageIndex + 1 - range.start;
    const y = doc.page.height - 38;
    const width = contentWidth(doc);
    doc
      .fillColor(MUTED_COLOR)
      .font("Helvetica")
      .fontSize(7.5)
      .text(options.title, doc.page.margins.left, y, {
        width: Math.floor(width * 0.65),
        ellipsis: true,
        lineBreak: false,
      });
    doc.text(`Page ${pageNumber} of ${range.count}`, doc.page.margins.left, y, {
      width,
      align: "right",
      lineBreak: false,
    });
  }
}

function ensureSpace(doc: PdfDoc, height: number): void {
  if (doc.y + height > pageBottom(doc)) {
    doc.addPage();
  }
}

function pageBottom(doc: PdfDoc): number {
  return doc.page.height - doc.page.margins.bottom;
}

function usableHeight(doc: PdfDoc): number {
  return doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
}

function contentWidth(doc: PdfDoc): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function looksLikeTableLine(line: string): boolean {
  return line.includes("|") && line.split("|").length >= 3;
}

function cleanInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
