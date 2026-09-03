import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import {
  getExtractedAttachmentPath,
  getExtractedPagePath,
  getExtractedSyllabusPath,
} from "../src/enrich/course-documents.js";
import {
  buildMatchExcerpt,
  clearArtifactIndexCache,
} from "../src/knowledge/artifact-index.js";
import {
  renderCourseArtifactSearchResult,
  searchCourseArtifacts,
  searchCourseKnowledge,
} from "../src/tui/course-retrieval.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-course-passages-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const FILLER_TOPICS = [
  "Amdahl's law and speedup estimates for parallel sections of a program.",
  "Two's complement arithmetic, sign extension, and overflow flags in the ALU.",
  "Single-cycle datapath control signals and the register file write port.",
  "Pipeline hazards: structural, data, and control hazards with forwarding.",
  "Direct-mapped versus set-associative placement and replacement policy.",
  "Virtual memory, page tables, and translation lookaside buffer lookups.",
  "Interrupts, exceptions, and the precise exception model.",
  "Branch prediction with two-bit saturating counters and history tables.",
];

/**
 * A page-sectioned PDF sidecar the way the extractor now produces them:
 * "## Page N" headings, a generic intro on page 1, and the passage the
 * student is asking about buried deep in the deck.
 */
function buildLectureNotes(): string {
  const pages: string[] = [];
  for (let page = 1; page <= 60; page += 1) {
    const topic = FILLER_TOPICS[page % FILLER_TOPICS.length] ?? "";
    const body =
      page === 1
        ? "ECE243 Computer Organization. Course introduction, logistics, and a roadmap of the term. Office hours are posted on the front page."
        : page === 57
          ? [
              "Multiprocessor caches must agree on the value of a shared line.",
              "The MESI protocol keeps each cache line in one of four states: Modified, Exclusive, Shared, or Invalid.",
              "A write to a Shared line broadcasts an invalidate so cache coherence is preserved across cores.",
              "Snooping controllers watch the bus for these transactions.",
            ].join(" ")
          : `${topic} ${topic} Worked example ${page} follows on the next slide.`;
    pages.push(`## Page ${page}`, "", body, "");
  }
  return ["# lecture-notes.pdf", "", ...pages].join("\n");
}

function makeCourseCache(coursePath: string): CourseCache {
  return {
    courseId: 17,
    coursePath,
    assignments: [],
    modules: [],
    files: [
      {
        id: 99,
        displayName: "lecture-notes.pdf",
        filename: "lecture-notes.pdf",
        contentType: "application/pdf",
        size: 4096,
        url: "https://canvas.example/files/99/download",
        updatedAt: "2026-04-01T12:00:00.000Z",
        folderId: null,
      },
      {
        id: 101,
        displayName: "old-midterm.pdf",
        filename: "old-midterm.pdf",
        contentType: "application/pdf",
        size: 4096,
        url: "https://canvas.example/files/101/download",
        updatedAt: "2026-04-01T12:00:00.000Z",
        folderId: null,
      },
    ],
    pages: [
      {
        pageId: "week-10",
        title: "Week 10",
        htmlUrl: null,
        updatedAt: "2026-04-01T12:00:00.000Z",
        hasBody: true,
      },
    ],
    syllabusCandidates: [],
    attachments: [
      {
        sourceType: "course_file",
        canvasFileId: 99,
        originalFilename: "lecture-notes.pdf",
        localPath: "attachments/lecture-notes.pdf",
        contentType: "application/pdf",
        size: 4096,
        downloadUrl: "https://canvas.example/files/99/download",
        reason: "lecture-like file in Files tab",
        status: "downloaded",
      },
    ],
    lectures: [],
    ingestion: null,
  };
}

async function writeFixture(coursePath: string): Promise<CourseCache> {
  const notesPath = getExtractedAttachmentPath(
    coursePath,
    "attachments/lecture-notes.pdf"
  );
  const pagePath = getExtractedPagePath(coursePath, "week-10");
  const syllabusPath = getExtractedSyllabusPath(coursePath);
  await Promise.all(
    [notesPath, pagePath, syllabusPath].map((filePath) =>
      fs.mkdir(path.dirname(filePath), { recursive: true })
    )
  );
  await fs.writeFile(notesPath, buildLectureNotes(), "utf-8");
  await fs.writeFile(
    pagePath,
    [
      "# Week 10",
      "",
      "## Reading",
      "",
      "Read chapter 5 before Thursday. Bring questions about the lab.",
      "",
      "## Lecture",
      "",
      "Thursday covers multiprocessor cache coherence and the MESI protocol; slides are in lecture-notes.pdf.",
    ].join("\n"),
    "utf-8"
  );
  await fs.writeFile(
    syllabusPath,
    [
      "# Course syllabus",
      "",
      "## Late policy",
      "",
      "Late submissions lose 10% per day for up to three days.",
      "",
      "## Topics",
      "",
      "Datapaths, pipelining, memory hierarchy, cache coherence, and I/O.",
    ].join("\n"),
    "utf-8"
  );
  return makeCourseCache(coursePath);
}

test("search_course surfaces the matching page passage of a long PDF instead of its first line", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const cache = await writeFixture(path.join(tempDir, "course"));

    const query = "MESI protocol cache coherence";
    const matches = await searchCourseArtifacts(cache, query);
    const notes = matches.find(
      (match) =>
        match.artifact.kind === "attachment" &&
        match.artifact.title === "lecture-notes.pdf"
    );
    assert.ok(notes, "the lecture notes attachment should match");
    assert.equal(notes.passage?.section, "Page 57");
    assert.match(notes.passage?.excerpt ?? "", /MESI protocol/);
    assert.doesNotMatch(notes.passage?.excerpt ?? "", /Course introduction/);

    const search = await searchCourseKnowledge(cache, query);
    assert.equal(search.status, "ok");
    const rendered = renderCourseArtifactSearchResult(search, query);
    const notesLine = rendered
      .split("\n")
      .find((line) => line.startsWith("[attachment] lecture-notes.pdf"));
    assert.ok(notesLine, `expected a lecture-notes line in:\n${rendered}`);
    assert.match(notesLine, /— Page 57: /);
    assert.match(notesLine, /MESI protocol/);
    assert.doesNotMatch(notesLine, /Course introduction/);

    const pageLine = rendered
      .split("\n")
      .find((line) => line.startsWith("[page] Week 10"));
    assert.ok(pageLine, `expected a Week 10 line in:\n${rendered}`);
    assert.match(pageLine, /— Lecture: /);
    assert.match(pageLine, /MESI protocol/);
    assert.doesNotMatch(pageLine, /Read chapter 5/);
  });
});

test("search_course drops the bare Files-tab entry when the same file is already extracted", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const cache = await writeFixture(path.join(tempDir, "course"));

    const matches = await searchCourseArtifacts(cache, "lecture notes pdf");
    const titles = matches.map(
      (match) => `${match.artifact.kind}:${match.artifact.title}`
    );
    assert.ok(
      titles.includes("attachment:lecture-notes.pdf"),
      `attachment missing from ${titles.join(", ")}`
    );
    assert.ok(
      !titles.includes("file:lecture-notes.pdf"),
      `duplicate file entry present in ${titles.join(", ")}`
    );

    const undownloaded = await searchCourseArtifacts(cache, "old midterm");
    assert.equal(undownloaded[0]?.artifact.kind, "file");
    assert.equal(undownloaded[0]?.artifact.title, "old-midterm.pdf");
  });
});

test("search_course keeps the document head as the excerpt when nothing in the body matches better", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const cache = await writeFixture(path.join(tempDir, "course"));

    const search = await searchCourseKnowledge(cache, "late policy");
    assert.equal(search.status, "ok");
    const rendered = renderCourseArtifactSearchResult(search, "late policy");
    const syllabusLine = rendered
      .split("\n")
      .find((line) => line.startsWith("[syllabus] Course syllabus"));
    assert.ok(syllabusLine, `expected a syllabus line in:\n${rendered}`);
    assert.match(syllabusLine, /— Late policy: Late submissions lose 10% per day/);
  });
});

test("buildMatchExcerpt centres the window on the densest cluster of query terms", () => {
  const filler = "Nothing relevant is said in this sentence at all. ";
  const text = `${filler.repeat(20)}The MESI protocol keeps each cache line in one of four states. ${filler.repeat(20)}`;

  const excerpt = buildMatchExcerpt(text, "MESI protocol states", 160);
  assert.ok(excerpt.length <= 170, `excerpt too long: ${excerpt.length}`);
  assert.match(excerpt, /^\.\.\./);
  assert.match(excerpt, /\.\.\.$/);
  assert.match(excerpt, /MESI protocol keeps each cache line/);

  const head = buildMatchExcerpt(text, "unrelated words", 80);
  assert.match(head, /^Nothing relevant is said/);
  assert.match(head, /\.\.\.$/);

  const short = buildMatchExcerpt("Short note about MESI.", "MESI", 160);
  assert.equal(short, "Short note about MESI.");
});
