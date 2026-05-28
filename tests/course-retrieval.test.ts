import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import {
  readCourseDocument,
  renderCourseArtifactSearchResult,
  renderCourseDocumentLookupResult,
  searchCourseArtifacts,
  searchCourseKnowledge,
} from "../src/tui/course-retrieval.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-course-retrieval-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function makeCourseCache(coursePath: string): CourseCache {
  return {
    courseId: 17,
    coursePath,
    assignments: [
      {
        id: 42,
        name: "Lab 4",
        dueAt: "2026-04-18T23:59:00.000Z",
        unlockAt: null,
        lockAt: null,
        pointsPossible: 100,
        gradingType: "points",
        submissionTypes: ["online_upload"],
        htmlUrl: "https://canvas.example/courses/17/assignments/42",
        hasDescription: true,
        descriptionLinkCount: 1,
      },
    ],
    modules: [
      {
        id: 8,
        name: "Lab 4 Module",
        position: 1,
        itemCount: 2,
        items: [
          {
            id: 10,
            title: "Lab Brief",
            type: "Page",
            position: 1,
            contentId: null,
            pageUrl: "lab-brief",
            htmlUrl: null,
            externalUrl: null,
          },
          {
            id: 11,
            title: "lab4-spec.pdf",
            type: "File",
            position: 2,
            contentId: 99,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: null,
          },
        ],
      },
    ],
    files: [
      {
        id: 99,
        displayName: "lab4-spec.pdf",
        filename: "lab4-spec.pdf",
        contentType: "application/pdf",
        size: 1024,
        url: "https://canvas.example/files/99/download",
        updatedAt: "2026-04-01T12:00:00.000Z",
        folderId: null,
      },
    ],
    pages: [
      {
        pageId: "lab-brief",
        title: "Lab Brief",
        htmlUrl: null,
        updatedAt: "2026-04-01T12:00:00.000Z",
        hasBody: true,
      },
    ],
    discussions: [
      {
        id: 88,
        title: "Lab 4 Q&A",
        postedAt: "2026-04-04T09:00:00.000Z",
        lastReplyAt: "2026-04-04T10:00:00.000Z",
        htmlUrl: "https://canvas.example/courses/17/discussion_topics/88",
        userName: "Prof. Ada",
        hasMessage: true,
        threadEntryCount: 2,
        participantCount: 3,
        messageFileLinkCount: 0,
        replyFileLinkCount: 1,
      },
    ],
    syllabusCandidates: [],
    attachments: [
      {
        sourceType: "assignment_linked",
        canvasFileId: 99,
        originalFilename: "lab4-spec.pdf",
        localPath: "attachments/lab4-spec.pdf",
        contentType: "application/pdf",
        size: 1024,
        downloadUrl: "https://canvas.example/files/99/download",
        reason: "linked from assignment",
        status: "downloaded",
      },
      {
        sourceType: "module_linked",
        canvasFileId: 100,
        originalFilename: "starter.zip",
        localPath: "attachments/starter.zip",
        contentType: "application/zip",
        size: 2048,
        downloadUrl: "https://canvas.example/files/100/download",
        reason: "linked from module",
        status: "downloaded",
      },
    ],
    lectures: [],
    ingestion: {
      version: 1,
      ingestedAt: "2026-04-01T12:00:00.000Z",
      courseId: 17,
      courseName: "ECE243",
      courseCode: "ECE243H1",
      refresh: false,
      counts: {
        assignments: 1,
        modules: 1,
        moduleItems: 2,
        files: 1,
        pages: 1,
        syllabusCandidates: 0,
        lectures: 0,
        attachmentsDownloaded: 2,
        attachmentsSkipped: 0,
        attachmentsFailed: 0,
      },
    },
  };
}

test("course retrieval helpers search and read through the shared artifact index", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "assignments"), {
      recursive: true,
    });
    await fs.mkdir(path.join(coursePath, "extracted", "pages"), {
      recursive: true,
    });
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });
    await fs.mkdir(path.join(coursePath, "extracted", "discussions"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "pages", "lab-brief.txt"),
      "Pipeline timing is explained in this lab brief.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      "The specification requires a waveform screenshot and a short analysis.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "starter.zip.txt"),
      [
        "ZIP: starter.zip (2 files)",
        "--- lab4.pdf ---",
        "The lab4.pdf inside the zip explains the datapath steps.",
      ].join("\n"),
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "assignments", "42.txt"),
      [
        "# Lab 4",
        "",
        "Due: 2026-04-18T23:59:00.000Z",
        "Points: 100",
        "Submission types: online_upload",
        "",
        "## Description",
        "",
        "Deliverables include a waveform screenshot and a short analysis.",
      ].join("\n"),
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "discussions", "88.txt"),
      [
        "# Lab 4 Q&A",
        "",
        "## Topic",
        "",
        "Clarifications about saturating add mode and signed overflow detection.",
        "",
        "## Replies",
        "",
        "### Prof. Ada — 2026-04-04T10:00:00.000Z",
        "",
        "Use signed overflow detection when you explain the ALU behavior.",
      ].join("\n"),
      "utf-8"
    );

    const cache = makeCourseCache(coursePath);

    const attachmentMatches = await searchCourseArtifacts(cache, "specification requires");
    assert.equal(attachmentMatches[0]?.artifact.title, "lab4-spec.pdf");

    const pageMatches = await searchCourseArtifacts(cache, "pipeline timing");
    assert.equal(pageMatches[0]?.artifact.title, "Lab Brief");

    const zippedDocument = await readCourseDocument(cache, "inside the zip datapath");
    assert.equal(zippedDocument.status, "ok");
    if (zippedDocument.status === "ok") {
      assert.equal(zippedDocument.document.artifact.title, "starter.zip");
      assert.match(zippedDocument.document.content, /lab4\.pdf inside the zip/);
    }

    const directDocument = await readCourseDocument(cache, "lab4 spec");
    assert.equal(directDocument.status, "ok");
    if (directDocument.status === "ok") {
      assert.match(directDocument.document.content, /waveform screenshot/);
    }

    const assignmentDocument = await readCourseDocument(cache, "Lab 4");
    assert.equal(assignmentDocument.status, "ok");
    if (assignmentDocument.status === "ok") {
      assert.equal(assignmentDocument.document.artifact.kind, "assignment");
      assert.match(assignmentDocument.document.content, /Submission types: online_upload/);
      assert.match(assignmentDocument.document.content, /waveform screenshot/);
    }

    const discussionMatches = await searchCourseArtifacts(
      cache,
      "signed overflow detection"
    );
    assert.equal(discussionMatches[0]?.artifact.kind, "discussion");
    assert.equal(discussionMatches[0]?.artifact.title, "Lab 4 Q&A");

    const discussionDocument = await readCourseDocument(cache, "Lab 4 Q&A");
    assert.equal(discussionDocument.status, "ok");
    if (discussionDocument.status === "ok") {
      assert.equal(discussionDocument.document.artifact.kind, "discussion");
      assert.match(discussionDocument.document.content, /signed overflow detection/);
    }
  });
});

test("course retrieval preserves missing extracted text guidance", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });

    const cache = makeCourseCache(coursePath);

    const result = await readCourseDocument(cache, "lab4 spec");
    assert.equal(result.status, "missing_text");
    if (result.status === "missing_text") {
      assert.equal(result.artifact?.title, "lab4-spec.pdf");
    }

    const rendered = renderCourseDocumentLookupResult(result, "lab4 spec");
    assert.match(rendered, /cached extracted text is missing/);
  });
});

test("course retrieval surfaces captured external course resources", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "external-links"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "external-links", "shared-spec.txt"),
      [
        "# Shared Lab Spec",
        "",
        "Source URL: https://public.example/shared-spec",
        "Capture status: captured",
        "",
        "## Captured content",
        "",
        "Use signed overflow detection for the ALU and include the waveform evidence.",
      ].join("\n"),
      "utf-8"
    );

    const cache = makeCourseCache(coursePath);
    cache.externalLinks = [
      {
        id: "shared-spec",
        title: "Shared Lab Spec",
        url: "https://public.example/shared-spec",
        resolvedUrl: "https://public.example/shared-spec",
        sourceCount: 2,
        sources: [
          'assignment "Homework 1" description',
          'module "Week 4" item "Shared Lab Spec"',
        ],
        contentType: "text/html; charset=utf-8",
        contentStatus: "captured",
      },
    ];

    const matches = await searchCourseArtifacts(cache, "signed overflow detection");
    assert.equal(matches[0]?.artifact.kind, "external_link");
    assert.equal(matches[0]?.artifact.title, "Shared Lab Spec");

    const document = await readCourseDocument(cache, "Shared Lab Spec");
    assert.equal(document.status, "ok");
    if (document.status === "ok") {
      assert.equal(document.document.artifact.kind, "external_link");
      assert.match(document.document.content, /waveform evidence/);
    }
  });
});

test("course retrieval surfaces extracted grading breakdowns", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "grading-breakdown.txt"),
      [
        "# Grading Breakdown",
        "",
        "Grading scheme: weighted (total 100%)",
        "",
        "## Labs (30%)",
        "",
        "Assignments in this category: 4",
        "- Lab 4",
        "",
        "## Final Exam (40%)",
        "",
        "Assignments in this category: 1",
        "- Final exam",
      ].join("\n"),
      "utf-8"
    );

    const cache = makeCourseCache(coursePath);
    const search = await searchCourseKnowledge(
      cache,
      "grading scheme weighted"
    );
    assert.equal(search.status, "ok");
    if (search.status === "ok") {
      assert.equal(search.matches[0]?.artifact.kind, "grading");
      assert.equal(search.matches[0]?.artifact.title, "Grading breakdown");
    }

    const rendered = renderCourseArtifactSearchResult(
      search,
      "grading scheme weighted"
    );
    assert.match(rendered, /\[grading\] Grading breakdown/);
    assert.match(rendered, /weighted \(total 100%\)/);

    const document = await readCourseDocument(cache, "grading breakdown");
    assert.equal(document.status, "ok");
    if (document.status === "ok") {
      assert.equal(document.document.artifact.kind, "grading");
      assert.match(document.document.content, /Final Exam \(40%\)/);
    }
  });
});

test("course search rendering uses structured search results from the shared artifact index", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      "Deliverables include a waveform screenshot and a short analysis.\n",
      "utf-8"
    );

    const cache = makeCourseCache(coursePath);
    const search = await searchCourseKnowledge(cache, "waveform screenshot");
    assert.equal(search.status, "ok");

    const rendered = renderCourseArtifactSearchResult(
      search,
      "waveform screenshot"
    );
    assert.match(rendered, /\[attachment\] lab4-spec\.pdf/);
  });
});

test("course search renders the matching section instead of the document opening", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      [
        "# Lab 4 Specification",
        "",
        "This overview introduces the lab and repeats general setup reminders.",
        "",
        "## Signal Checklist",
        "",
        "Deliverables include a waveform screenshot and a short analysis.",
      ].join("\n"),
      "utf-8"
    );

    const cache = makeCourseCache(coursePath);
    const search = await searchCourseKnowledge(cache, "waveform screenshot");
    assert.equal(search.status, "ok");
    if (search.status === "ok") {
      assert.equal(search.matches[0]?.artifact.title, "lab4-spec.pdf");
      assert.equal(search.matches[0]?.section?.section, "Signal Checklist");
    }

    const rendered = renderCourseArtifactSearchResult(
      search,
      "waveform screenshot"
    );
    assert.match(rendered, /\[attachment\] lab4-spec\.pdf — Signal Checklist/);
    assert.match(rendered, /waveform screenshot/);
    assert.doesNotMatch(rendered, /general setup reminders/);
  });
});

test("course search uses parent headings when ranking nested rubric sections", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "assignments"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "assignments", "42.txt"),
      [
        "# Lab 4",
        "",
        "Due: 2026-04-18T23:59:00.000Z",
        "Points: 100",
        "",
        "## Description",
        "",
        "General Lab 4 instructions mention the datapath deliverables.",
        "",
        "## Rubric",
        "",
        "### Correctness (10 points)",
        "",
        "#### Rating: Excellent (10 points)",
        "",
        "Complete and accurate implementation.",
        "",
        "#### Rating: Needs work (5 points)",
        "",
        "Missing edge cases.",
      ].join("\n"),
      "utf-8"
    );

    const cache = makeCourseCache(coursePath);
    cache.modules = [];
    cache.files = [];
    cache.pages = [];
    cache.discussions = [];
    cache.attachments = [];

    const search = await searchCourseKnowledge(cache, "lab 4 rubric", {
      limit: 2,
    });
    assert.equal(search.status, "ok");
    if (search.status === "ok") {
      assert.equal(search.matches[0]?.artifact.kind, "assignment");
      assert.equal(search.matches[0]?.artifact.title, "Lab 4");
      assert.match(search.matches[0]?.section?.searchContext ?? "", /Rubric/);
    }

    const rendered = renderCourseArtifactSearchResult(search, "lab 4 rubric");
    assert.match(rendered, /\[assignment\] Lab 4 — Rubric > Correctness/);
    assert.doesNotMatch(rendered, /General Lab 4 instructions/);
  });
});

test("course search renders a query-centered excerpt within long sections", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      [
        "# Lab 4 Specification",
        "",
        "## Details",
        "",
        Array.from(
          { length: 160 },
          (_, index) => `boilerplate setup reminder ${index}`
        ).join(" "),
        "The calibration threshold is 0.42 volts before the demo.",
      ].join("\n"),
      "utf-8"
    );

    const cache = makeCourseCache(coursePath);
    const search = await searchCourseKnowledge(cache, "calibration threshold");
    assert.equal(search.status, "ok");

    const rendered = renderCourseArtifactSearchResult(
      search,
      "calibration threshold"
    );
    assert.match(rendered, /calibration threshold is 0\.42/i);
    assert.doesNotMatch(rendered, /boilerplate setup reminder 0/);
  });
});

test("course search ignores generic question scaffolding when ranking sections", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "assignments"), {
      recursive: true,
    });
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "assignments", "42.txt"),
      [
        "# Lab 4",
        "",
        "## Assignment Overview",
        "",
        Array.from(
          { length: 80 },
          () =>
            "What does the assignment say about the course assignment overview?"
        ).join(" "),
      ].join("\n"),
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      [
        "# Lab 4 Specification",
        "",
        "## Calibration",
        "",
        "The calibration threshold is 0.42 volts before the demo.",
      ].join("\n"),
      "utf-8"
    );

    const cache = makeCourseCache(coursePath);
    const search = await searchCourseKnowledge(
      cache,
      "what does the assignment say about the calibration threshold"
    );
    assert.equal(search.status, "ok");
    if (search.status === "ok") {
      assert.equal(search.matches[0]?.artifact.title, "lab4-spec.pdf");
      assert.equal(search.matches[0]?.section?.section, "Calibration");
    }

    const rendered = renderCourseArtifactSearchResult(
      search,
      "what does the assignment say about the calibration threshold"
    );
    assert.match(rendered, /\[attachment\] lab4-spec\.pdf — Calibration/);
    assert.match(rendered, /calibration threshold is 0\.42/i);
    assert.doesNotMatch(rendered, /course assignment overview/);
  });
});

test("course search keeps strongly relevant sibling sections together", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "assignments"), {
      recursive: true,
    });
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "assignments", "42.txt"),
      [
        "# Lab 4",
        "",
        "## Due date",
        "",
        "Due date: April 18 at 11:59 PM.",
        "",
        "## Submission format",
        "",
        "Submission format: upload report.pdf to Canvas.",
      ].join("\n"),
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      "This course reminder mentions submission logistics in passing.\n",
      "utf-8"
    );

    const cache = makeCourseCache(coursePath);
    const search = await searchCourseKnowledge(
      cache,
      "due date submission format report pdf",
      { limit: 2 }
    );

    assert.equal(search.status, "ok");
    if (search.status === "ok") {
      assert.equal(search.matches.length, 2);
      assert.deepEqual(
        search.matches.map((match) => match.section?.section).sort(),
        ["Due date", "Submission format"]
      );
      assert.ok(search.matches.every((match) => match.artifact.title === "Lab 4"));
    }
  });
});
