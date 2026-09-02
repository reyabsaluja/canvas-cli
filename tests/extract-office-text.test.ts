import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractFileText, extractZip } from "../src/extract/extract-text.js";
import { extractOfficeText } from "../src/extract/office-text.js";
import { extractSingleAttachment } from "../src/ingest/attachment-extraction.js";
import type { DownloadedAttachmentEntry } from "../src/ingest/types.js";
import { buildZipBuffer } from "./helpers/build-zip.js";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const RELS_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

function run(text: string, extra = ""): string {
  return `<w:r>${extra}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

function para(inner: string, props = ""): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${inner}</w:p>`;
}

function buildDocx(): Buffer {
  const body = [
    para(run("ECE243 Course Syllabus"), '<w:pStyle w:val="Title"/>'),
    para(run("Grading"), '<w:pStyle w:val="Heading1"/>'),
    para(run("Marks are ") + run("final") + run(" once posted &amp; verified.")),
    para(run("Late policy"), '<w:pStyle w:val="Heading2"/>'),
    para(
      run("Submit via ") +
        '<w:hyperlink r:id="rId7">' +
        run("the portal") +
        "</w:hyperlink>" +
        run(" before midnight.") +
        '<w:r><w:footnoteReference w:id="1"/></w:r>'
    ),
    para(run("Read chapter 1"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
    para(run("Read chapter 2"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
    para(run("Section 2.3 only"), '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr>'),
    para(run("Bring a calculator"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>'),
    para(run("Deleted words: ") + "<w:del><w:r><w:delText>OLD</w:delText></w:r></w:del>"),
    para(
      '<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="Datapath block diagram"/></wp:inline></w:drawing></w:r>'
    ),
    "<w:tbl>",
    "<w:tr><w:trPr><w:tblHeader/></w:trPr>",
    `<w:tc>${para(run("Component"))}</w:tc><w:tc>${para(run("Weight"))}</w:tc>`,
    "</w:tr>",
    `<w:tr><w:tc>${para(run("Labs"))}</w:tc><w:tc>${para(run("30%"))}</w:tc></w:tr>`,
    `<w:tr><w:tc>${para(run("Final Exam"))}</w:tc><w:tc>${para(run("45%"))}</w:tc></w:tr>`,
    "</w:tbl>",
    para(run("Questions? Email the TA.")),
  ].join("");

  const document = `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`;
  const styles = `<w:styles ${W_NS}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`;
  const numbering = `<w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const rels = `<Relationships ${RELS_NS}><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://portal.example.edu/submit" TargetMode="External"/></Relationships>`;
  const footnotes = `<w:footnotes ${W_NS}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p>${run("Midnight Eastern time.")}</w:p></w:footnote></w:footnotes>`;

  return buildZipBuffer([
    { name: "[Content_Types].xml", content: "<Types/>" },
    { name: "word/document.xml", content: document },
    { name: "word/styles.xml", content: styles },
    { name: "word/numbering.xml", content: numbering },
    { name: "word/_rels/document.xml.rels", content: rels },
    { name: "word/footnotes.xml", content: footnotes },
  ]);
}

function sp(type: string | null, paragraphs: string): string {
  const ph = type ? `<p:nvPr><p:ph type="${type}"/></p:nvPr>` : "<p:nvPr/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/>${ph}</p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;
}

function ap(text: string, props = ""): string {
  return `<a:p>${props}<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`;
}

function buildPptx(): Buffer {
  const slide1 = `<p:sld ${P_NS}><p:cSld><p:spTree>${sp("ctrTitle", ap("Pipelining"))}${sp(
    "subTitle",
    ap("Lecture 7")
  )}${sp("sldNum", '<a:p><a:fld id="{X}" type="slidenum"><a:t>1</a:t></a:fld></a:p>')}</p:spTree></p:cSld></p:sld>`;

  const slide2 = `<p:sld ${P_NS}><p:cSld><p:spTree>${sp("title", ap("Hazards"))}${sp(
    "body",
    ap("Data hazards") +
      ap("Forwarding fixes most", '<a:pPr lvl="1"/>') +
      ap("Control hazards") +
      ap("First step", '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>') +
      ap("Second step", '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>') +
      ap("Plain closing line", "<a:pPr><a:buNone/></a:pPr>")
  )}${sp(
    null,
    '<a:p><a:r><a:rPr><a:hlinkClick r:id="rId9"/></a:rPr><a:t>Reading</a:t></a:r></a:p>'
  )}<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 4" descr="Five-stage pipeline diagram"/></p:nvPicPr></p:pic><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="1"/><a:tr><a:tc><a:txBody>${ap(
    "Stage"
  )}</a:txBody></a:tc><a:tc><a:txBody>${ap("Cycles")}</a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody>${ap(
    "IF"
  )}</a:txBody></a:tc><a:tc><a:txBody>${ap("1")}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`;

  const notes2 = `<p:notes ${P_NS}><p:cSld><p:spTree>${sp("sldImg", "")}${sp(
    "body",
    ap("Mention the midterm covers this slide.")
  )}</p:spTree></p:cSld></p:notes>`;

  // Presentation lists slide2 BEFORE slide1 to prove rels ordering is honoured.
  const presentation = `<p:presentation ${P_NS}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`;
  const presentationRels = `<Relationships ${RELS_NS}><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="x/slide" Target="slides/slide2.xml"/></Relationships>`;
  const slide2Rels = `<Relationships ${RELS_NS}><Relationship Id="rId9" Type="x/hyperlink" Target="https://example.edu/reading" TargetMode="External"/><Relationship Id="rId4" Type="x/notesSlide" Target="../notesSlides/notesSlide2.xml"/></Relationships>`;

  return buildZipBuffer([
    { name: "[Content_Types].xml", content: "<Types/>" },
    { name: "ppt/presentation.xml", content: presentation },
    { name: "ppt/_rels/presentation.xml.rels", content: presentationRels },
    { name: "ppt/slides/slide1.xml", content: slide1 },
    { name: "ppt/slides/slide2.xml", content: slide2 },
    { name: "ppt/slides/_rels/slide2.xml.rels", content: slide2Rels },
    { name: "ppt/notesSlides/notesSlide2.xml", content: notes2 },
  ]);
}

function buildXlsx(): Buffer {
  const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Grades" sheetId="1" r:id="rId1"/><sheet name="Schedule" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const rels = `<Relationships ${RELS_NS}><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="x/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const sharedStrings = `<sst count="4" uniqueCount="4"><si><t>Assessment</t></si><si><t>Weight</t></si><si><r><t>Lab </t></r><r><t>Reports</t></r></si><si><t>Week</t></si></sst>`;
  const sheet1 = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>0.3</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Final</t></is></c><c r="B3"><v>0.45</v></c><c r="C3" t="b"><v>1</v></c></row><row r="4"/></sheetData></worksheet>`;
  const sheet2 = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c><c r="B1" t="inlineStr"><is><t>Topic</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>Intro &amp; logistics</t></is></c></row></sheetData></worksheet>`;

  return buildZipBuffer([
    { name: "[Content_Types].xml", content: "<Types/>" },
    { name: "xl/workbook.xml", content: workbook },
    { name: "xl/_rels/workbook.xml.rels", content: rels },
    { name: "xl/sharedStrings.xml", content: sharedStrings },
    { name: "xl/worksheets/sheet1.xml", content: sheet1 },
    { name: "xl/worksheets/sheet2.xml", content: sheet2 },
  ]);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-office-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("DOCX extraction keeps headings, lists, links, tables, footnotes, and alt text", async () => {
  const text = await extractOfficeText(buildDocx(), "syllabus.docx");
  assert.ok(text);

  assert.match(text, /^# ECE243 Course Syllabus$/m);
  assert.match(text, /^## Grading$/m);
  assert.match(text, /^### Late policy$/m);
  assert.match(text, /Marks are final once posted & verified\./);
  assert.match(text, /Submit via the portal \(https:\/\/portal\.example\.edu\/submit\) before midnight\.\[1\]/);
  assert.match(text, /^1\. Read chapter 1\n2\. Read chapter 2\n  1\. Section 2\.3 only$/m);
  assert.match(text, /^- Bring a calculator$/m);
  assert.doesNotMatch(text, /OLD/);
  assert.match(text, /Image: Datapath block diagram/);
  assert.match(text, /Table:\n- Component: Labs \| Weight: 30%\n- Component: Final Exam \| Weight: 45%/);
  assert.match(text, /Footnotes:\n\[1\] Midnight Eastern time\./);
  assert.doesNotMatch(text, /\n{3,}/);
});

test("PPTX extraction emits one heading per slide in presentation order with notes and tables", async () => {
  const text = await extractOfficeText(buildPptx(), "lecture07.pptx");
  assert.ok(text);

  // Slide 2 (Hazards) comes first because presentation.xml orders it first.
  assert.match(text, /^## Slide 1: Hazards$/m);
  assert.match(text, /^## Slide 2: Pipelining$/m);
  assert.ok(text.indexOf("Slide 1: Hazards") < text.indexOf("Slide 2: Pipelining"));

  assert.match(text, /^- Data hazards\n  - Forwarding fixes most\n- Control hazards\n1\. First step\n2\. Second step\nPlain closing line$/m);
  assert.match(text, /Reading \(https:\/\/example\.edu\/reading\)/);
  assert.match(text, /Image: Five-stage pipeline diagram/);
  assert.match(text, /Table:\n- Stage: IF \| Cycles: 1/);
  assert.match(text, /Speaker notes:\nMention the midterm covers this slide\./);
  assert.match(text, /Lecture 7/);
  // Slide-number placeholder must not leak in as content.
  assert.doesNotMatch(text, /Slide 2: Pipelining\n\n1\b/);
});

test("XLSX extraction renders each sheet as a headed table with shared and inline strings", async () => {
  const text = await extractOfficeText(buildXlsx(), "grades.xlsx");
  assert.ok(text);

  assert.match(text, /^## Sheet: Grades$/m);
  assert.match(text, /^## Sheet: Schedule$/m);
  assert.match(text, /Table:\n- Assessment: Lab Reports \| Weight: 0\.3\n- Assessment: Final \| Weight: 0\.45 \| Column 3: TRUE/);
  assert.match(text, /Table:\n- Week: 1 \| Topic: Intro & logistics/);
});

test("extractFileText dispatches Office files and still labels unknown binaries", async () => {
  await withTempDir(async (dir) => {
    const docxPath = path.join(dir, "notes.docx");
    await fs.writeFile(docxPath, buildDocx());
    const docxText = await extractFileText(docxPath, "notes.docx");
    assert.match(docxText, /^## Grading$/m);
    assert.doesNotMatch(docxText, /^\[/);

    const pptxPath = path.join(dir, "deck.pptx");
    await fs.writeFile(pptxPath, buildPptx());
    assert.match(await extractFileText(pptxPath, "deck.pptx"), /## Slide 1: Hazards/);

    const xlsxPath = path.join(dir, "sheet.xlsx");
    await fs.writeFile(xlsxPath, buildXlsx());
    assert.match(await extractFileText(xlsxPath, "sheet.xlsx"), /## Sheet: Grades/);

    const binPath = path.join(dir, "image.png");
    await fs.writeFile(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.match(await extractFileText(binPath, "image.png"), /^\[Binary file: image\.png/);

    const corruptPath = path.join(dir, "broken.docx");
    await fs.writeFile(corruptPath, Buffer.from("not a zip"));
    assert.match(await extractFileText(corruptPath, "broken.docx"), /^\[Error reading "broken\.docx"/);
  });
});

test("zip summaries include text from Office documents inside the archive", async () => {
  await withTempDir(async (dir) => {
    const zipPath = path.join(dir, "bundle.zip");
    await fs.writeFile(
      zipPath,
      buildZipBuffer([
        { name: "readme.md", content: "# Readme\nStart here.\n" },
        { name: "slides/lecture07.pptx", content: buildPptx() },
      ])
    );
    const text = await extractZip(zipPath, "bundle.zip");
    assert.match(text, /ZIP: bundle\.zip \(2 files\)/);
    assert.match(text, /--- readme\.md ---\n# Readme/);
    assert.match(text, /--- slides\/lecture07\.pptx ---\n[\s\S]*## Slide 1: Hazards/);
  });
});

test("ingestion writes a text sidecar for a DOCX attachment and for a DOCX inside a zip", async () => {
  await withTempDir(async (coursePath) => {
    await fs.mkdir(path.join(coursePath, "attachments", "files"), { recursive: true });
    await fs.writeFile(path.join(coursePath, "attachments", "files", "syllabus.docx"), buildDocx());
    await fs.writeFile(
      path.join(coursePath, "attachments", "files", "week1.zip"),
      buildZipBuffer([{ name: "week1/grades.xlsx", content: buildXlsx() }])
    );

    const docx: DownloadedAttachmentEntry = {
      sourceType: "syllabus_file",
      canvasFileId: 1,
      originalFilename: "syllabus.docx",
      localPath: "attachments/files/syllabus.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: null,
      downloadUrl: "https://canvas.example/files/1/download",
      reason: "syllabus",
      status: "downloaded",
    };
    const zip: DownloadedAttachmentEntry = {
      ...docx,
      canvasFileId: 2,
      originalFilename: "week1.zip",
      localPath: "attachments/files/week1.zip",
      contentType: "application/zip",
      downloadUrl: "https://canvas.example/files/2/download",
    };

    await extractSingleAttachment(coursePath, docx);
    await extractSingleAttachment(coursePath, zip);

    const sidecar = await fs.readFile(
      path.join(coursePath, "extracted", "attachments", "files", "syllabus.docx.txt"),
      "utf-8"
    );
    assert.match(sidecar, /^## Grading$/m);
    assert.match(sidecar, /Component: Labs \| Weight: 30%/);

    const entry = (zip.zipEntries ?? []).find((item) => item.filename === "grades.xlsx");
    assert.ok(entry?.extractedTextPath, "xlsx inside zip should get a sidecar");
    const innerSidecar = await fs.readFile(
      path.join(coursePath, entry.extractedTextPath),
      "utf-8"
    );
    assert.match(innerSidecar, /## Sheet: Grades/);
  });
});
