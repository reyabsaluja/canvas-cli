import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import {
  clearArtifactIndexCache,
} from "../src/knowledge/artifact-index.js";
import {
  listWorkspaceKnowledgeArtifacts,
  readWorkspaceKnowledgeArtifact,
  registerDownloadedCourseAttachment,
  searchWorkspaceKnowledge,
} from "../src/tui/workspace-knowledge.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-workspace-knowledge-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createWorkspace(tempDir: string): Promise<LoadedWorkspace> {
  const workspacePath = path.join(tempDir, "workspace");
  await fs.mkdir(path.join(workspacePath, "extracted", "docs"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(workspacePath, "assignment.md"),
    "# Assignment\nImplement the datapath.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "plan.md"),
    "# Plan\nCapture the waveform before writing the analysis.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "workup.json"),
    JSON.stringify(
      {
        overview: "Use the lab brief and extracted reference together.",
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "extracted", "docs", "reference.txt"),
    "The waveform must show stall cycles around the branch hazard.\n",
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
    assignmentMd: await fs.readFile(
      path.join(workspacePath, "assignment.md"),
      "utf-8"
    ),
    planMd: await fs.readFile(path.join(workspacePath, "plan.md"), "utf-8"),
    notesMd: null,
    workupJson: JSON.parse(
      await fs.readFile(path.join(workspacePath, "workup.json"), "utf-8")
    ) as Record<string, unknown>,
    extractedFiles: [
      {
        name: "docs/reference.txt",
        relativePath: path.join("extracted", "docs", "reference.txt"),
      },
    ],
    extractedFileCache: new Map<string, string>(),
  };
}

function createCourseCache(coursePath: string): CourseCache {
  return {
    courseId: 17,
    coursePath,
    assignments: [],
    modules: [
      {
        id: 8,
        name: "Lab 4 Module",
        position: 1,
        itemCount: 1,
        items: [
          {
            id: 10,
            title: "lab4-spec.pdf",
            type: "File",
            position: 1,
            contentId: 99,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: null,
          },
        ],
      },
    ],
    files: [],
    pages: [],
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
        moduleItems: 1,
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

test("workspace chat tools resolve search, reads, and listings through the shared artifact store", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspace = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      "The specification requires a waveform screenshot and short analysis.\n",
      "utf-8"
    );
    const cache = createCourseCache(coursePath);

    const searchMatches = await searchWorkspaceKnowledge(
      workspace,
      cache,
      "branch hazard",
      3
    );
    assert.equal(searchMatches[0]?.header, "--- [extracted] docs/reference.txt ---");
    assert.match(searchMatches[0]?.preview ?? "", /stall cycles/);

    const assignmentRead = await readWorkspaceKnowledgeArtifact(
      workspace,
      cache,
      "assignment.md",
      30000
    );
    assert.equal(assignmentRead.status, "ok");
    if (assignmentRead.status === "ok") {
      assert.match(assignmentRead.content, /Implement the datapath/);
      assert.equal(assignmentRead.artifact.scope, "workspace");
    }

    const courseRead = await readWorkspaceKnowledgeArtifact(
      workspace,
      cache,
      "lab4 spec",
      30000
    );
    assert.equal(courseRead.status, "ok");
    if (courseRead.status === "ok") {
      assert.match(courseRead.content, /waveform screenshot/);
      assert.equal(courseRead.artifact.scope, "course");
    }

    const fileList = await listWorkspaceKnowledgeArtifacts(workspace, cache);
    assert.ok(
      fileList.workspaceFiles.some((entry) => entry.label === "assignment.md")
    );
    assert.ok(
      fileList.extractedDocuments.some((entry) => entry.label === "docs/reference.txt")
    );
    assert.ok(
      fileList.courseDocuments.some(
        (entry) => entry.label === "[attachment] lab4-spec.pdf"
      )
    );
  });
});

test("registerDownloadedCourseAttachment makes new downloads visible to workspace chat", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspace = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "attachments", "modules"), {
      recursive: true,
    });
    const cache = createCourseCache(coursePath);
    cache.attachments = [
      {
        sourceType: "important_file",
        canvasFileId: 55,
        originalFilename: "starter.zip",
        localPath: "attachments/reference/starter.zip",
        contentType: "application/zip",
        size: 1024,
        downloadUrl: "https://canvas.example/files/55/download",
        reason: "reference archive",
        status: "downloaded",
      },
    ];

    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "modules", "starter.zip.txt"),
      "ZIP: starter.zip (2 files)\n--- lab4.pdf ---\nThe lab4.pdf inside the zip explains the register map.\n",
      "utf-8"
    );

    await registerDownloadedCourseAttachment(cache, {
      canvasFileId: 100,
      originalFilename: "starter.zip",
      localPath: "attachments/modules/starter.zip",
      contentType: "application/zip",
      size: 2048,
      downloadUrl: "https://canvas.example/files/100/download",
      reason: "downloaded on demand from module item \"starter.zip\"",
      sourceType: "module_linked",
    });

    const persistedAttachments = JSON.parse(
      await fs.readFile(path.join(coursePath, "attachments.json"), "utf-8")
    ) as CourseCache["attachments"];
    assert.equal(persistedAttachments.length, 2);
    assert.ok(
      persistedAttachments.some(
        (entry) => entry.localPath === "attachments/reference/starter.zip"
      )
    );
    assert.ok(
      persistedAttachments.some(
        (entry) => entry.localPath === "attachments/modules/starter.zip"
      )
    );

    const fileList = await listWorkspaceKnowledgeArtifacts(workspace, cache);
    assert.ok(
      fileList.courseDocuments.some(
        (entry) => entry.label === "[attachment] starter.zip"
      )
    );

    const readResult = await readWorkspaceKnowledgeArtifact(
      workspace,
      cache,
      "lab4.pdf",
      30000
    );
    assert.equal(readResult.status, "ok");
    if (readResult.status === "ok") {
      assert.match(readResult.content, /register map/);
    }
  });
});
