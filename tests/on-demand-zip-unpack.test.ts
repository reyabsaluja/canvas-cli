import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import {
  executeToolCallForTurn,
} from "../src/tui/chat-agent.js";
import { createChatContext } from "../src/tui/services.js";
import {
  readWorkspaceKnowledgeArtifact,
} from "../src/tui/workspace-knowledge.js";
import { buildZipBuffer } from "./helpers/build-zip.js";

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-on-demand-zip-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createWorkspace(tempDir: string): Promise<LoadedWorkspace> {
  const workspacePath = path.join(tempDir, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, "assignment.md"),
    "# Assignment\nImplement the datapath.\n",
    "utf-8"
  );
  return {
    path: workspacePath,
    sessionSlug: "lab-4",
    assignmentId: 42,
    assignmentName: "Lab 4",
    courseId: 17,
    courseName: "ECE243",
    courseCode: "ECE243H1",
    preparedAt: "2026-04-02T09:00:00.000Z",
    workspaceState: "ready",
    assignmentMd: "# Assignment\nImplement the datapath.\n",
    planMd: null,
    notesMd: null,
    workupJson: null,
    extractedFiles: [],
    extractedFileCache: new Map<string, string>(),
  };
}

function createCourseCache(coursePath: string): CourseCache {
  return {
    courseId: 17,
    coursePath,
    assignments: [],
    modules: [],
    files: [],
    pages: [],
    syllabusCandidates: [],
    attachments: [],
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
        modules: 0,
        moduleItems: 0,
        files: 0,
        pages: 0,
        syllabusCandidates: 0,
        lectures: 0,
        attachmentsDownloaded: 1,
        attachmentsSkipped: 0,
        attachmentsFailed: 0,
      },
    },
  };
}

test("download_course_file unpacks a cached zip and exposes inner files", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    const zipDir = path.join(coursePath, "attachments", "modules");
    await fs.mkdir(zipDir, { recursive: true });

    const zipBuffer = buildZipBuffer([
      {
        name: "2024/final_exam_2024.md",
        content:
          "# 2024 Final Exam\nQ3. Convert the Nios II datapath to Nios V.\n",
      },
      {
        name: "2022/final_exam_2022.md",
        content: "# 2022 Final Exam\nSome older question text.\n",
      },
    ]);
    const zipPath = path.join(zipDir, "exams.zip");
    await fs.writeFile(zipPath, zipBuffer);

    const cache = createCourseCache(coursePath);
    cache.modules = [
      {
        id: 8,
        name: "Past Exams",
        position: 1,
        itemCount: 1,
        items: [
          {
            id: 10,
            title: "exams.zip",
            type: "File",
            position: 1,
            contentId: 555,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: null,
          },
        ],
      },
    ];
    cache.attachments = [
      {
        sourceType: "module_linked",
        canvasFileId: 555,
        originalFilename: "exams.zip",
        localPath: "attachments/modules/exams.zip",
        contentType: "application/zip",
        size: zipBuffer.length,
        downloadUrl: "https://canvas.example/files/555/download",
        reason: "downloaded on demand from module item \"exams.zip\"",
        status: "downloaded",
        // Intentionally NO zipEntries — this is the backfill scenario.
      },
    ];

    const attachmentsJsonPath = path.join(coursePath, "attachments.json");
    await fs.writeFile(
      attachmentsJsonPath,
      JSON.stringify(cache.attachments, null, 2) + "\n",
      "utf-8"
    );

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );

    const result = await executeToolCallForTurn(
      new Map(),
      "download_course_file",
      { title: "exams.zip" },
      ctx
    );

    assert.equal(result.result.observation.status, "ok");

    // attachments.json should now contain zipEntries for both inner PDFs.
    const persisted = JSON.parse(
      await fs.readFile(attachmentsJsonPath, "utf-8")
    ) as typeof cache.attachments;
    assert.equal(persisted.length, 1);
    const zipEntries = persisted[0]?.zipEntries ?? [];
    assert.equal(zipEntries.length, 2);
    const filenames = zipEntries.map((entry) => entry.filename).sort();
    assert.deepEqual(filenames, ["final_exam_2022.md", "final_exam_2024.md"]);

    // The inner files should now be addressable via read_file.
    const readResult = await readWorkspaceKnowledgeArtifact(
      loaded,
      cache,
      "final_exam_2024.md",
      30000
    );
    assert.equal(readResult.status, "ok");
    if (readResult.status === "ok") {
      assert.match(readResult.content, /Nios II datapath to Nios V/);
      assert.equal(readResult.artifact.title, "final_exam_2024.md");
    }

    const otherRead = await readWorkspaceKnowledgeArtifact(
      loaded,
      cache,
      "final_exam_2022.md",
      30000
    );
    assert.equal(otherRead.status, "ok");
    if (otherRead.status === "ok") {
      assert.match(otherRead.content, /older question text/);
    }
  });
});

test("download_course_file unpacks nested zips and exposes deeply nested files", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    const zipDir = path.join(coursePath, "attachments", "modules");
    await fs.mkdir(zipDir, { recursive: true });

    const innerZip = buildZipBuffer([
      {
        name: "docs/deep-spec.md",
        content:
          "# Deep Spec\nThe buried starter archive requires branch hazard tests.\n",
      },
    ]);
    const outerZip = buildZipBuffer([
      {
        name: "README.md",
        content: "# Starter Bundle\nLook inside starter-files.zip.\n",
      },
      {
        name: "starter-files.zip",
        content: innerZip,
      },
    ]);
    const zipPath = path.join(zipDir, "starter-bundle.zip");
    await fs.writeFile(zipPath, outerZip);

    const cache = createCourseCache(coursePath);
    cache.modules = [
      {
        id: 8,
        name: "Lab 4 Module",
        position: 1,
        itemCount: 1,
        items: [
          {
            id: 10,
            title: "starter-bundle.zip",
            type: "File",
            position: 1,
            contentId: 555,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: null,
          },
        ],
      },
    ];
    cache.attachments = [
      {
        sourceType: "module_linked",
        canvasFileId: 555,
        originalFilename: "starter-bundle.zip",
        localPath: "attachments/modules/starter-bundle.zip",
        contentType: "application/zip",
        size: outerZip.length,
        downloadUrl: "https://canvas.example/files/555/download",
        reason: "downloaded on demand from module item \"starter-bundle.zip\"",
        status: "downloaded",
      },
    ];

    const attachmentsJsonPath = path.join(coursePath, "attachments.json");
    await fs.writeFile(
      attachmentsJsonPath,
      JSON.stringify(cache.attachments, null, 2) + "\n",
      "utf-8"
    );

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );

    const result = await executeToolCallForTurn(
      new Map(),
      "download_course_file",
      { title: "starter-bundle.zip" },
      ctx
    );

    assert.equal(result.result.observation.status, "ok");

    const persisted = JSON.parse(
      await fs.readFile(attachmentsJsonPath, "utf-8")
    ) as typeof cache.attachments;
    const zipEntries = persisted[0]?.zipEntries ?? [];
    assert.ok(
      zipEntries.some(
        (entry) =>
          entry.entryName === "starter-files.zip.unpacked/docs/deep-spec.md"
      )
    );

    const readResult = await readWorkspaceKnowledgeArtifact(
      loaded,
      cache,
      "deep-spec.md",
      30000
    );
    assert.equal(readResult.status, "ok");
    if (readResult.status === "ok") {
      assert.match(readResult.content, /branch hazard tests/);
      assert.equal(readResult.artifact.title, "deep-spec.md");
    }
  });
});

test("download_course_file unpacks a freshly downloaded zip from Canvas", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(coursePath, { recursive: true });

    const zipBuffer = buildZipBuffer([
      {
        name: "spec.md",
        content: "# Lab Spec\nImplement the bypass path.\n",
      },
    ]);

    const cache = createCourseCache(coursePath);
    cache.modules = [
      {
        id: 8,
        name: "Lab 4 Module",
        position: 1,
        itemCount: 1,
        items: [
          {
            id: 10,
            title: "starter.zip",
            type: "File",
            position: 1,
            contentId: 777,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: null,
          },
        ],
      },
    ];

    const attachmentsJsonPath = path.join(coursePath, "attachments.json");
    await fs.writeFile(attachmentsJsonPath, "[]\n", "utf-8");

    // Fake Canvas client that serves our hand-built zip buffer.
    const fakeClient = {
      getFileSafe: async (contentId: number) => {
        assert.equal(contentId, 777);
        return {
          id: 777,
          display_name: "starter.zip",
          url: "https://canvas.example/files/777/download",
          content_type: "application/zip",
          size: zipBuffer.length,
        };
      },
      downloadFile: async (url: string) => {
        assert.match(url, /files\/777/);
        return zipBuffer;
      },
    };

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      {
        cache,
        client: fakeClient as unknown as Parameters<typeof createChatContext>[2]["client"],
        config: null,
        courseId: 17,
      }
    );

    const result = await executeToolCallForTurn(
      new Map(),
      "download_course_file",
      { title: "starter.zip" },
      ctx
    );

    assert.equal(result.result.observation.status, "ok");
    assert.match(
      result.result.observation.summary,
      /unpacked starter\.zip \(1 inner files\)/i
    );

    const persisted = JSON.parse(
      await fs.readFile(attachmentsJsonPath, "utf-8")
    ) as typeof cache.attachments;
    assert.equal(persisted.length, 1);
    const zipEntries = persisted[0]?.zipEntries ?? [];
    assert.equal(zipEntries.length, 1);
    assert.equal(zipEntries[0]?.filename, "spec.md");

    const readResult = await readWorkspaceKnowledgeArtifact(
      loaded,
      cache,
      "spec.md",
      30000
    );
    assert.equal(readResult.status, "ok");
    if (readResult.status === "ok") {
      assert.match(readResult.content, /Implement the bypass path/);
    }
  });
});
