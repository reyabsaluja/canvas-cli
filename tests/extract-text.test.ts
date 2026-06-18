import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import {
  extractFileText,
  unpackZipToDirectory,
} from "../src/extract/extract-text.js";
import { buildZipBuffer } from "./helpers/build-zip.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-extract-"));
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildDeflatedZipEntry(
  name: string,
  uncompressedContent: Buffer
): Buffer {
  const nameBytes = Buffer.from(name, "utf-8");
  const compressedContent = deflateRawSync(uncompressedContent, { level: 9 });
  const checksum = crc32(uncompressedContent);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(compressedContent.length, 18);
  localHeader.writeUInt32LE(uncompressedContent.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(compressedContent.length, 20);
  centralHeader.writeUInt32LE(uncompressedContent.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const centralDirectory = Buffer.concat([centralHeader, nameBytes]);
  const localContents = Buffer.concat([localHeader, nameBytes, compressedContent]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localContents.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localContents, centralDirectory, eocd]);
}

test("extractFileText extracts searchable text from PowerPoint slides and notes", async () => {
  await withTempDir(async (tempDir) => {
    const pptxPath = path.join(tempDir, "lecture4.pptx");
    await fs.writeFile(
      pptxPath,
      buildZipBuffer([
        {
          name: "ppt/slides/slide1.xml",
          content:
            '<p:sld><p:cSld><p:spTree><a:p><a:r><a:t>Polling and Timers</a:t></a:r></a:p><a:p><a:r><a:t>Use timer interrupts for periodic sampling.</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>',
        },
        {
          name: "ppt/slides/_rels/slide1.xml.rels",
          content: [
            "<Relationships>",
            '<Relationship Id="rIdComments"',
            ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"',
            ' Target="../comments/comment1.xml"/>',
            "</Relationships>",
          ].join(""),
        },
        {
          name: "ppt/comments/comment1.xml",
          content:
            '<p:cmLst><p:cm authorId="0" idx="1"><p:text>Instructor comment: quiz students on timer drift.</p:text></p:cm></p:cmLst>',
        },
        {
          name: "ppt/notesSlides/notesSlide1.xml",
          content:
            '<p:notes><a:p><a:r><a:t>Mention debouncing as a common pitfall.</a:t></a:r></a:p></p:notes>',
        },
        {
          name: "ppt/slides/slide2.xml",
          content:
            '<p:sld><a:p><a:r><a:t>Demo checklist</a:t></a:r></a:p><a:p><a:r><a:t>Show the waveform capture.</a:t></a:r></a:p></p:sld>',
        },
      ])
    );

    const text = await extractFileText(pptxPath, "lecture4.pptx");

    assert.match(text, /^# lecture4\.pptx/m);
    assert.match(text, /## Slide 1/);
    assert.match(text, /Polling and Timers/);
    assert.match(text, /Use timer interrupts for periodic sampling\./);
    assert.match(text, /## Slide 1 Comments/);
    assert.match(text, /Instructor comment: quiz students on timer drift\./);
    assert.match(text, /## Speaker Notes 1/);
    assert.match(text, /Mention debouncing as a common pitfall\./);
    assert.match(text, /## Slide 2/);
    assert.match(text, /Show the waveform capture\./);
    assert.doesNotMatch(text, /Binary file/);
  });
});

test("extractFileText extracts Word paragraphs and spreadsheet shared strings", async () => {
  await withTempDir(async (tempDir) => {
    const docxPath = path.join(tempDir, "rubric.docx");
    await fs.writeFile(
      docxPath,
      buildZipBuffer([
        {
          name: "word/document.xml",
          content:
            '<w:document><w:body><w:p><w:r><w:t>Rubric overview</w:t></w:r></w:p><w:p><w:r><w:t>Correctness is worth 10 points.</w:t></w:r></w:p></w:body></w:document>',
        },
        {
          name: "word/comments.xml",
          content:
            '<w:comments><w:comment><w:p><w:r><w:t>Instructor note: include edge cases.</w:t></w:r></w:p></w:comment></w:comments>',
        },
      ])
    );

    const docText = await extractFileText(docxPath, "rubric.docx");

    assert.match(docText, /## Body/);
    assert.match(docText, /Rubric overview/);
    assert.match(docText, /Correctness is worth 10 points\./);
    assert.match(docText, /Instructor note: include edge cases\./);

    const xlsxPath = path.join(tempDir, "schedule.xlsx");
    await fs.writeFile(
      xlsxPath,
      buildZipBuffer([
        {
          name: "xl/workbook.xml",
          content:
            '<workbook><sheets><sheet name="Schedule" sheetId="1" r:id="rId1"/></sheets></workbook>',
        },
        {
          name: "xl/_rels/workbook.xml.rels",
          content:
            '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        },
        {
          name: "xl/sharedStrings.xml",
          content:
            "<sst><si><t>Due date</t></si><si><t>April 10</t></si><si><t>Points</t></si><si><t>Weighted points</t></si></sst>",
        },
        {
          name: "xl/worksheets/sheet1.xml",
          content:
            '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>25</v></c><c r="C2"><f>B2*0.15</f><v>3.75</v></c></row></sheetData></worksheet>',
        },
      ])
    );

    const sheetText = await extractFileText(xlsxPath, "schedule.xlsx");

    assert.match(sheetText, /## Schedule/);
    assert.match(sheetText, /A1: Due date \| B1: April 10 \| C1: Weighted points/);
    assert.match(sheetText, /A2: Points \| B2: 25 \| C2: 3\.75 \(formula: =B2\*0\.15\)/);
    assert.doesNotMatch(sheetText, /Binary file/);
  });
});

test("extractFileText preserves Word tables as structured rows", async () => {
  await withTempDir(async (tempDir) => {
    const docxPath = path.join(tempDir, "rubric-table.docx");
    await fs.writeFile(
      docxPath,
      buildZipBuffer([
        {
          name: "word/document.xml",
          content: [
            "<w:document><w:body>",
            "<w:p><w:r><w:t>Submission rubric</w:t></w:r></w:p>",
            "<w:tbl>",
            "<w:tr>",
            "<w:tc><w:p><w:r><w:t>Criterion</w:t></w:r></w:p></w:tc>",
            "<w:tc><w:p><w:r><w:t>Points</w:t></w:r></w:p></w:tc>",
            "<w:tc><w:p><w:r><w:t>Evidence</w:t></w:r></w:p></w:tc>",
            "</w:tr>",
            "<w:tr>",
            "<w:tc><w:p><w:r><w:t>Correctness</w:t></w:r></w:p></w:tc>",
            "<w:tc><w:p><w:r><w:t>10</w:t></w:r></w:p></w:tc>",
            "<w:tc><w:p><w:r><w:t>Passes edge-case tests</w:t></w:r></w:p></w:tc>",
            "</w:tr>",
            "<w:tr>",
            "<w:tc><w:p><w:r><w:t>Reflection</w:t></w:r></w:p></w:tc>",
            "<w:tc><w:p><w:r><w:t>5</w:t></w:r></w:p></w:tc>",
            "<w:tc><w:p><w:r><w:t>Explains tradeoffs</w:t></w:r></w:p></w:tc>",
            "</w:tr>",
            "</w:tbl>",
            "<w:tbl>",
            "<w:tr>",
            "<w:tc><w:p><w:r><w:t>Due date</w:t></w:r></w:p></w:tc>",
            "<w:tc><w:p><w:r><w:t>April 10</w:t></w:r></w:p></w:tc>",
            "</w:tr>",
            "<w:tr>",
            "<w:tc><w:p><w:r><w:t>Submission</w:t></w:r></w:p></w:tc>",
            "<w:tc><w:p><w:r><w:t>PDF report</w:t></w:r></w:p></w:tc>",
            "</w:tr>",
            "</w:tbl>",
            "</w:body></w:document>",
          ].join(""),
        },
      ])
    );

    const text = await extractFileText(docxPath, "rubric-table.docx");

    assert.match(text, /## Body\n\nSubmission rubric/);
    assert.match(text, /## Tables/);
    assert.match(text, /Table 1:/);
    assert.match(
      text,
      /- Criterion: Correctness \| Points: 10 \| Evidence: Passes edge-case tests/
    );
    assert.match(
      text,
      /- Criterion: Reflection \| Points: 5 \| Evidence: Explains tradeoffs/
    );
    assert.match(text, /Table 2:/);
    assert.match(text, /- Due date: April 10/);
    assert.match(text, /- Submission: PDF report/);
    assert.doesNotMatch(text, /Submission rubric\nCriterion\nPoints\nEvidence/);
  });
});

test("extractFileText preserves Word document hyperlinks from relationships", async () => {
  await withTempDir(async (tempDir) => {
    const docxPath = path.join(tempDir, "brief.docx");
    await fs.writeFile(
      docxPath,
      buildZipBuffer([
        {
          name: "word/document.xml",
          content: [
            "<w:document><w:body><w:p>",
            "<w:r><w:t>Read the </w:t></w:r>",
            '<w:hyperlink r:id="rIdSpec">',
            "<w:r><w:t>reference spec</w:t></w:r>",
            "</w:hyperlink>",
            "<w:r><w:t> before starting.</w:t></w:r>",
            "</w:p><w:p>",
            '<w:fldSimple w:instr="HYPERLINK &quot;https://docs.example/rubric&quot;">',
            "<w:r><w:t>Rubric link</w:t></w:r>",
            "</w:fldSimple>",
            "</w:p></w:body></w:document>",
          ].join(""),
        },
        {
          name: "word/_rels/document.xml.rels",
          content: [
            "<Relationships>",
            '<Relationship Id="rIdSpec"',
            ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"',
            ' Target="https://docs.example/spec?week=4&amp;view=student"',
            ' TargetMode="External"/>',
            "</Relationships>",
          ].join(""),
        },
      ])
    );

    const text = await extractFileText(docxPath, "brief.docx");

    assert.match(
      text,
      /Read the reference spec \(https:\/\/docs\.example\/spec\?week=4&view=student\) before starting\./
    );
    assert.match(text, /Rubric link \(https:\/\/docs\.example\/rubric\)/);
    assert.doesNotMatch(text, /rIdSpec/);
  });
});

test("extractFileText preserves Office media descriptions and targets", async () => {
  await withTempDir(async (tempDir) => {
    const docxPath = path.join(tempDir, "figures.docx");
    await fs.writeFile(
      docxPath,
      buildZipBuffer([
        {
          name: "word/document.xml",
          content: [
            "<w:document><w:body>",
            "<w:p><w:r><w:t>Study the figure below.</w:t></w:r></w:p>",
            "<w:p><w:r><w:drawing><wp:inline>",
            '<wp:docPr id="1" name="datapath.png" title="Datapath sketch" descr="Pipeline datapath with forwarding arrows"/>',
            "<a:graphic><a:graphicData><pic:pic><pic:blipFill>",
            '<a:blip r:embed="rIdImage1"/>',
            "</pic:blipFill></pic:pic></a:graphicData></a:graphic>",
            "</wp:inline></w:drawing></w:r></w:p>",
            "</w:body></w:document>",
          ].join(""),
        },
        {
          name: "word/_rels/document.xml.rels",
          content: [
            "<Relationships>",
            '<Relationship Id="rIdImage1"',
            ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"',
            ' Target="media/datapath.png"/>',
            "</Relationships>",
          ].join(""),
        },
      ])
    );

    const docText = await extractFileText(docxPath, "figures.docx");

    assert.match(docText, /## Body/);
    assert.match(docText, /Study the figure below\./);
    assert.match(docText, /## Media/);
    assert.match(
      docText,
      /- Image: Pipeline datapath with forwarding arrows \| title: Datapath sketch \| name: datapath\.png \| target: word\/media\/datapath\.png/
    );

    const pptxPath = path.join(tempDir, "lecture-diagrams.pptx");
    await fs.writeFile(
      pptxPath,
      buildZipBuffer([
        {
          name: "ppt/slides/slide1.xml",
          content: [
            "<p:sld><p:cSld><p:spTree>",
            "<a:p><a:r><a:t>Pipeline timing</a:t></a:r></a:p>",
            "<p:pic><p:nvPicPr>",
            '<p:cNvPr id="4" name="Timing diagram" descr="Waveform showing enable pulses"/>',
            "</p:nvPicPr><p:blipFill>",
            '<a:blip r:embed="rId2"/>',
            "</p:blipFill></p:pic>",
            "</p:spTree></p:cSld></p:sld>",
          ].join(""),
        },
        {
          name: "ppt/slides/_rels/slide1.xml.rels",
          content: [
            "<Relationships>",
            '<Relationship Id="rId2"',
            ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"',
            ' Target="../media/image2.png"/>',
            "</Relationships>",
          ].join(""),
        },
      ])
    );

    const deckText = await extractFileText(pptxPath, "lecture-diagrams.pptx");

    assert.match(deckText, /## Slide 1/);
    assert.match(deckText, /Pipeline timing/);
    assert.match(deckText, /## Slide 1 Media/);
    assert.match(
      deckText,
      /- Image: Waveform showing enable pulses \| name: Timing diagram \| target: ppt\/media\/image2\.png/
    );
    assert.doesNotMatch(deckText, /rId2/);
  });
});

test("extractFileText extracts searchable text from zip files inside zips", async () => {
  await withTempDir(async (tempDir) => {
    const innerZip = buildZipBuffer([
      {
        name: "specs/lab-rubric.md",
        content: "# Lab Rubric\nNested archive says timing diagrams are required.\n",
      },
    ]);
    const outerZipPath = path.join(tempDir, "starter-bundle.zip");
    await fs.writeFile(
      outerZipPath,
      buildZipBuffer([
        {
          name: "README.md",
          content: "# Starter Bundle\nOpen the nested archive for the rubric.\n",
        },
        {
          name: "resources/rubric-pack.zip",
          content: innerZip,
        },
      ])
    );

    const text = await extractFileText(outerZipPath, "starter-bundle.zip");

    assert.match(text, /ZIP: starter-bundle\.zip \(2 files\)/);
    assert.match(text, /resources\/rubric-pack\.zip/);
    assert.match(text, /ZIP: resources\/rubric-pack\.zip \(1 files\)/);
    assert.match(text, /--- specs\/lab-rubric\.md ---/);
    assert.match(text, /Nested archive says timing diagrams are required\./);
  });
});

test("extractFileText and unpackZipToDirectory skip oversized zip entries", async () => {
  await withTempDir(async (tempDir) => {
    const oversizedZipPath = path.join(tempDir, "oversized.zip");
    const oversizedZip = buildDeflatedZipEntry(
      "huge.txt",
      Buffer.alloc(64 * 1024 * 1024, "a")
    );
    await fs.writeFile(oversizedZipPath, oversizedZip);

    const text = await extractFileText(oversizedZipPath, "oversized.zip");

    assert.match(text, /huge\.txt \(64MB\)/);
    assert.match(text, /Skipped huge\.txt: entry exceeds 50MB/);
    assert.doesNotMatch(text, /--- huge\.txt ---/);

    const unpackedDir = path.join(tempDir, "oversized.unpacked");
    await fs.mkdir(unpackedDir);
    const unpacked = await unpackZipToDirectory(oversizedZipPath, unpackedDir);

    assert.deepEqual(unpacked, []);
    assert.deepEqual(await fs.readdir(unpackedDir), []);
  });
});
