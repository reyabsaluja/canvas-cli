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
    assignments: [],
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
        assignments: 0,
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
    await fs.mkdir(path.join(coursePath, "extracted", "pages"), {
      recursive: true,
    });
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "pages", "lab-brief.txt"),
      "Pipeline timing is explained in this lab brief.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      "Deliverables include a waveform screenshot and a short analysis.\n",
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

    const cache = makeCourseCache(coursePath);

    const attachmentMatches = await searchCourseArtifacts(
      cache,
      "waveform screenshot"
    );
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
