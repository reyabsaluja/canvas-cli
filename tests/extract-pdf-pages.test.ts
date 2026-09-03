import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import PDFDocument from "pdfkit";
import { extractFileText, extractPdfText, extractZip } from "../src/extract/extract-text.js";
import { extractSingleAttachment } from "../src/ingest/attachment-extraction.js";
import type { DownloadedAttachmentEntry } from "../src/ingest/types.js";
import { splitDocumentIntoSections } from "../src/agent/verify.js";
import { buildZipBuffer } from "./helpers/build-zip.js";

/**
 * Build a multi-page lecture-style PDF with pdfkit. Every page carries a
 * unique marker sentence so a test can prove which pages survived extraction.
 */
async function buildLecturePdf(pageCount: number, charsPerPage: number): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: 50, autoFirstPage: false });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  for (let page = 1; page <= pageCount; page += 1) {
    doc.addPage();
    doc.fontSize(12).text(`Lecture slide ${page}: topic marker T${page}X.`);
    doc.moveDown();
    const filler = `Slide ${page} discusses concept number ${page} in detail. `;
    let body = "";
    while (body.length < charsPerPage) body += filler;
    doc.fontSize(10).text(body, { width: 500 });
  }
  doc.end();
  return done;
}

async function buildSinglePagePdf(text: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: 50 });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.fontSize(12).text(text);
  doc.end();
  return done;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-extract-pdf-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("long lecture PDFs keep every page and label each page as a citable heading", async () => {
  await withTempDir(async (dir) => {
    // 40 pages x ~1100 chars = ~44k chars: well past the old 30k cap.
    const pdf = await buildLecturePdf(40, 1100);
    const pdfPath = path.join(dir, "Lecture12.pdf");
    await fs.writeFile(pdfPath, pdf);

    const text = await extractFileText(pdfPath, "Lecture12.pdf");

    assert.ok(
      text.length > 30000,
      `expected the full 40-page text, got ${text.length} chars (old 30k cap)`
    );
    assert.match(text, /topic marker T1X/, "page 1 content present");
    assert.match(text, /topic marker T35X/, "page 35 content lost past the old cap");
    assert.match(text, /topic marker T40X/, "last page content present");

    // Page markers use a heading form the knowledge index splits sections on.
    assert.match(text, /^## Page 1$/m);
    assert.match(text, /^## Page 35$/m);
    assert.match(text, /^## Page 40$/m);
    assert.doesNotMatch(text, /^## Page 41$/m);
    assert.ok(text.startsWith("## Page 1\n"), "text starts with the first page heading");

    // Page 35's marker sentence sits under the "Page 35" heading, not another page.
    const page35 = text.slice(
      text.indexOf("## Page 35"),
      text.indexOf("## Page 36")
    );
    assert.match(page35, /topic marker T35X/);
    assert.doesNotMatch(page35, /topic marker T34X|topic marker T36X/);

    // Downstream section detection (verification + read outline) sees pages.
    const sections = splitDocumentIntoSections(text);
    const labels = sections.map((section) => section.label);
    assert.ok(labels.includes("Page 1"));
    assert.ok(labels.includes("Page 35"));
    assert.ok(labels.includes("Page 40"));
    assert.equal(labels.filter((label) => label?.startsWith("Page ")).length, 40);
  });
});

test("attachment sidecar for a long PDF stores the full page-marked text", async () => {
  await withTempDir(async (dir) => {
    const coursePath = path.join(dir, "course");
    await fs.mkdir(path.join(coursePath, "attachments"), { recursive: true });
    const pdf = await buildLecturePdf(40, 1100);
    await fs.writeFile(path.join(coursePath, "attachments", "Lecture12.pdf"), pdf);

    const attachment: DownloadedAttachmentEntry = {
      canvasFileId: 9001,
      originalFilename: "Lecture12.pdf",
      localPath: "attachments/Lecture12.pdf",
      contentType: "application/pdf",
      size: pdf.length,
      status: "downloaded",
      sourceType: "file",
      reason: null,
    } as DownloadedAttachmentEntry;

    await extractSingleAttachment(coursePath, attachment);

    const sidecar = await fs.readFile(
      path.join(coursePath, "extracted", "attachments", "Lecture12.pdf.txt"),
      "utf-8"
    );
    assert.ok(sidecar.length > 30000, `sidecar is ${sidecar.length} chars`);
    assert.match(sidecar, /^## Page 40$/m);
    assert.match(sidecar, /topic marker T40X/);
  });
});

test("single-page PDFs are extracted without page markers (unchanged)", async () => {
  await withTempDir(async (dir) => {
    const pdf = await buildSinglePagePdf("Syllabus: office hours are Tuesdays at 2pm.");
    const pdfPath = path.join(dir, "Syllabus.pdf");
    await fs.writeFile(pdfPath, pdf);

    const text = await extractFileText(pdfPath, "Syllabus.pdf");
    assert.match(text, /office hours are Tuesdays at 2pm/);
    assert.doesNotMatch(text, /^## Page \d+$/m);
  });
});

test("PDFs inside a zip get page markers too", async () => {
  await withTempDir(async (dir) => {
    const pdf = await buildLecturePdf(3, 200);
    const zipPath = path.join(dir, "lectures.zip");
    await fs.writeFile(zipPath, buildZipBuffer([{ name: "week3/Lecture3.pdf", content: pdf }]));

    const text = await extractZip(zipPath, "lectures.zip");
    assert.match(text, /--- week3\/Lecture3\.pdf ---/);
    assert.match(text, /^## Page 3$/m);
    assert.match(text, /topic marker T3X/);
  });
});

test("PDFs with no extractable text still report the unreadable marker", async () => {
  await withTempDir(async (dir) => {
    const doc = new PDFDocument({ size: "LETTER" });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve) => {
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
    });
    doc.rect(50, 50, 200, 200).stroke();
    doc.addPage();
    doc.rect(50, 50, 100, 100).stroke();
    doc.end();
    const pdfPath = path.join(dir, "scan.pdf");
    await fs.writeFile(pdfPath, await done);

    const text = await extractFileText(pdfPath, "scan.pdf");
    assert.equal(text, "[Could not extract text from PDF]");
  });
});

test("over-budget PDFs are cut on a page boundary with a note naming the omitted pages", async () => {
  const pdf = await buildLecturePdf(5, 200);
  const text = await extractPdfText(pdf, 700);

  assert.match(text, /^## Page 1$/m);
  assert.match(text, /^## Page 2$/m);
  assert.doesNotMatch(text, /^## Page 3$/m);
  assert.doesNotMatch(text, /topic marker T3X/);
  assert.match(text, /\[Text truncated: pages 3-5 of 5 omitted because the document exceeds 700 characters\]$/);
  // No page is cut mid-sentence: every kept page ends with its filler sentence.
  const body = text.slice(0, text.indexOf("[Text truncated"));
  assert.match(body.trim(), /detail\.$/);
});

test("image-only pages inside a text PDF keep their page heading with an explicit note", async () => {
  const doc = new PDFDocument({ size: "LETTER", margin: 50, autoFirstPage: false });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
  doc.addPage().fontSize(12).text("Slide one: topic marker T1X.");
  doc.addPage().rect(50, 50, 200, 200).stroke(); // diagram-only slide
  doc.addPage().fontSize(12).text("Slide three: topic marker T3X.");
  doc.end();

  const text = await extractPdfText(await done);
  assert.match(text, /^## Page 1$/m);
  assert.match(text, /^## Page 2$/m, "the image-only page must keep its heading");
  assert.match(text, /^## Page 3$/m);
  assert.ok(text.includes("[No extractable text on this page"), "image-only page carries the note");
  const labels = splitDocumentIntoSections(text).map((section) => section.label);
  assert.ok(labels.includes("Page 2"), "the note gives the page enough body to stay a section of its own");
  assert.ok(text.indexOf("T1X") < text.indexOf("## Page 2") && text.indexOf("## Page 2") < text.indexOf("T3X"));
});
