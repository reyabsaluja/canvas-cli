import assert from "node:assert/strict";
import test from "node:test";
import { extractOfficeText } from "../src/extract/office-text.js";
import { buildZipBuffer } from "./helpers/build-zip.js";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const P188_NS = 'xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"';
const RELS_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

function run(text: string): string {
  return `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
}

function para(inner: string, props = ""): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${inner}</w:p>`;
}

function buildDocxWithExtras(): Buffer {
  const body = [
    para(run("Lab 4 Handout"), '<w:pStyle w:val="Title"/>'),
    para(
      run("The ALU must be ") +
        '<w:commentRangeStart w:id="0"/>' +
        run("single cycle") +
        '<w:commentRangeEnd w:id="0"/>' +
        '<w:r><w:commentReference w:id="0"/></w:r>' +
        run(".")
    ),
    para(run("Submit by Friday.")),
  ].join("");
  const document = `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/></w:sectPr></w:body></w:document>`;
  const header = `<w:hdr ${W_NS}>${para(run("ECE243 — Fall 2026"))}</w:hdr>`;
  const headerFirst = `<w:hdr ${W_NS}>${para(run("ECE243 — Fall 2026"))}</w:hdr>`;
  const footer = `<w:ftr ${W_NS}>${para(run("Confidential draft, do not distribute"))}</w:ftr>`;
  const emptyFooter = `<w:ftr ${W_NS}>${para("")}</w:ftr>`;
  const comments = `<w:comments ${W_NS}><w:comment w:id="0" w:author="Jane Doe" w:date="2026-09-01T10:00:00Z" w:initials="JD">${para(run("Check this against the datasheet."))}${para(run("Two cycles is also acceptable."))}</w:comment><w:comment w:id="1" w:author="Raj Patel">${para(run("Deadline moved?"))}</w:comment></w:comments>`;
  const styles = `<w:styles ${W_NS}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`;
  const rels = `<Relationships ${RELS_NS}><Relationship Id="rId2" Type="x/header" Target="header1.xml"/><Relationship Id="rId3" Type="x/footer" Target="footer1.xml"/></Relationships>`;

  return buildZipBuffer([
    { name: "[Content_Types].xml", content: "<Types/>" },
    { name: "word/document.xml", content: document },
    { name: "word/styles.xml", content: styles },
    { name: "word/_rels/document.xml.rels", content: rels },
    { name: "word/header1.xml", content: header },
    { name: "word/header2.xml", content: headerFirst },
    { name: "word/footer1.xml", content: footer },
    { name: "word/footer2.xml", content: emptyFooter },
    { name: "word/comments.xml", content: comments },
  ]);
}

function sp(type: string | null, paragraphs: string): string {
  const ph = type ? `<p:nvPr><p:ph type="${type}"/></p:nvPr>` : "<p:nvPr/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/>${ph}</p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;
}

function ap(text: string): string {
  return `<a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`;
}

function buildPptxWithComments(): Buffer {
  const slide1 = `<p:sld ${P_NS}><p:cSld><p:spTree>${sp("title", ap("Pipelining"))}${sp("body", ap("Five stages"))}</p:spTree></p:cSld></p:sld>`;
  const slide2 = `<p:sld ${P_NS}><p:cSld><p:spTree>${sp("title", ap("Hazards"))}${sp("body", ap("Forwarding"))}</p:spTree></p:cSld></p:sld>`;
  const slide3 = `<p:sld ${P_NS}><p:cSld><p:spTree>${sp("title", ap("Summary"))}</p:spTree></p:cSld></p:sld>`;

  // Legacy comment part (PowerPoint 2007-2016 style), attached to slide 1.
  const legacyComments = `<p:cmLst ${P_NS}><p:cm authorId="0" dt="2026-09-01T10:00:00" idx="1"><p:pos x="10" y="10"/><p:text>Fix the axis labels.</p:text></p:cm><p:cm authorId="0" dt="2026-09-01T10:05:00" idx="2"><p:pos x="10" y="20"/><p:text>Fix the axis labels.</p:text></p:cm></p:cmLst>`;
  const commentAuthors = `<p:cmAuthorLst ${P_NS}><p:cmAuthor id="0" name="Jane Doe" initials="JD" lastIdx="2" clrIdx="0"/></p:cmAuthorLst>`;

  // Modern threaded comment part (PowerPoint 2019+/365), attached to slide 2.
  const threaded = `<p188:cmLst ${P188_NS} ${P_NS}><p188:cm id="{AAA}" authorId="{GUID-RAJ}" created="2026-09-02T09:00:00"><p188:txBody><a:bodyPr/><a:p><a:r><a:t>Add the timing diagram here.</a:t></a:r></a:p></p188:txBody></p188:cm></p188:cmLst>`;
  const authors = `<p188:authorLst ${P188_NS}><p188:author id="{GUID-RAJ}" name="Raj Patel" initials="RP" userId="rp" providerId="AD"/></p188:authorLst>`;

  // A comment part nothing links to: still worth surfacing, at the end.
  const orphanComments = `<p:cmLst ${P_NS}><p:cm authorId="0" idx="3"><p:text>Orphaned remark.</p:text></p:cm></p:cmLst>`;

  const presentation = `<p:presentation ${P_NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>`;
  const presentationRels = `<Relationships ${RELS_NS}><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="x/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="x/slide" Target="slides/slide3.xml"/></Relationships>`;
  const slide1Rels = `<Relationships ${RELS_NS}><Relationship Id="rId5" Type="x/comments" Target="../comments/comment1.xml"/></Relationships>`;
  const slide2Rels = `<Relationships ${RELS_NS}><Relationship Id="rId6" Type="x/threadedComment" Target="../threadedComments/threadedComment2.xml"/></Relationships>`;

  return buildZipBuffer([
    { name: "[Content_Types].xml", content: "<Types/>" },
    { name: "ppt/presentation.xml", content: presentation },
    { name: "ppt/_rels/presentation.xml.rels", content: presentationRels },
    { name: "ppt/slides/slide1.xml", content: slide1 },
    { name: "ppt/slides/slide2.xml", content: slide2 },
    { name: "ppt/slides/slide3.xml", content: slide3 },
    { name: "ppt/slides/_rels/slide1.xml.rels", content: slide1Rels },
    { name: "ppt/slides/_rels/slide2.xml.rels", content: slide2Rels },
    { name: "ppt/comments/comment1.xml", content: legacyComments },
    { name: "ppt/comments/comment9.xml", content: orphanComments },
    { name: "ppt/commentAuthors.xml", content: commentAuthors },
    { name: "ppt/threadedComments/threadedComment2.xml", content: threaded },
    { name: "ppt/authors.xml", content: authors },
  ]);
}

function buildXlsxWithFormulas(): Buffer {
  const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Weights" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<Relationships ${RELS_NS}><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const sheet = [
    "<worksheet><sheetData>",
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Weight</t></is></c><c r="C1" t="inlineStr"><is><t>Doubled</t></is></c></row>',
    '<row r="2"><c r="A2" t="inlineStr"><is><t>Labs</t></is></c><c r="B2"><v>0.3</v></c><c r="C2"><f t="shared" ref="C2:C3" si="0">B2*2</f><v>0.6</v></c></row>',
    '<row r="3"><c r="A3" t="inlineStr"><is><t>Final</t></is></c><c r="B3"><v>0.45</v></c><c r="C3"><f t="shared" si="0"/><v>0.9</v></c></row>',
    '<row r="4"><c r="A4" t="inlineStr"><is><t>Total</t></is></c><c r="B4"><f>SUM(B2:B3)</f><v>0.75</v></c><c r="C4"><f>IF(B4&lt;1,"under","over")</f></c></row>',
    "</sheetData></worksheet>",
  ].join("");

  return buildZipBuffer([
    { name: "[Content_Types].xml", content: "<Types/>" },
    { name: "xl/workbook.xml", content: workbook },
    { name: "xl/_rels/workbook.xml.rels", content: rels },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ]);
}

test("DOCX extraction includes headers, footers, and reviewer comments with inline markers", async () => {
  const text = await extractOfficeText(buildDocxWithExtras(), "lab4.docx");
  assert.ok(text);

  assert.match(text, /^# Lab 4 Handout$/m);
  assert.match(text, /The ALU must be single cycle\[comment 0\]\./, "the comment anchor is marked inline");
  assert.match(text, /Comments:\n\[0\] Jane Doe: Check this against the datasheet\. Two cycles is also acceptable\.\n\[1\] Raj Patel: Deadline moved\?/);
  assert.match(text, /Headers:\nECE243 — Fall 2026/);
  assert.equal(text.match(/ECE243 — Fall 2026/g)?.length, 1, "identical headers are listed once");
  assert.match(text, /Footers:\nConfidential draft, do not distribute/);
  assert.doesNotMatch(text, /commentRangeStart|w:comment/);
  assert.doesNotMatch(text, /\n{3,}/);
});

test("PPTX extraction attaches legacy and threaded comments to their slide and surfaces orphaned comment parts", async () => {
  const text = await extractOfficeText(buildPptxWithComments(), "lecture07.pptx");
  assert.ok(text);

  const slide1 = text.indexOf("## Slide 1: Pipelining");
  const slide2 = text.indexOf("## Slide 2: Hazards");
  const slide3 = text.indexOf("## Slide 3: Summary");
  assert.ok(slide1 >= 0 && slide2 > slide1 && slide3 > slide2);

  const jane = text.indexOf("Comments:\n- Jane Doe: Fix the axis labels.");
  assert.ok(jane > slide1 && jane < slide2, "the legacy comment sits under slide 1");
  assert.equal(text.match(/Fix the axis labels\./g)?.length, 1, "duplicate comment text is listed once");

  const raj = text.indexOf("Comments:\n- Raj Patel: Add the timing diagram here.");
  assert.ok(raj > slide2 && raj < slide3, "the threaded comment sits under slide 2");

  const orphan = text.indexOf("Orphaned remark.");
  assert.ok(orphan > slide3, "an unattached comment part is appended after the slides");
  assert.match(text, /## Comments\n\n- Jane Doe: Orphaned remark\./);
  assert.doesNotMatch(text, /\{GUID-RAJ\}|authorId/);
});

test("XLSX extraction shows cell formulas next to their cached values", async () => {
  const text = await extractOfficeText(buildXlsxWithFormulas(), "weights.xlsx");
  assert.ok(text);

  assert.match(text, /^## Sheet: Weights$/m);
  assert.match(text, /- Item: Labs \| Weight: 0\.3 \| Doubled: 0\.6 \(formula: =B2\*2\)/);
  // A shared-formula follower carries no formula text of its own: value only.
  assert.match(text, /- Item: Final \| Weight: 0\.45 \| Doubled: 0\.9$/m);
  assert.match(text, /- Item: Total \| Weight: 0\.75 \(formula: =SUM\(B2:B3\)\) \| Doubled: \(formula: =IF\(B4<1,"under","over"\)\)/);
});
