import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import {
  clearArtifactIndexCache,
  loadArtifactIndex,
  readArtifactContent,
  searchArtifacts,
  searchArtifactSections,
} from "../src/knowledge/artifact-index.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-artifact-index-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

test("artifact index builds a shared course and workspace graph", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();

    const coursePath = path.join(tempDir, "course");
    const workspacePath = path.join(tempDir, "workspace");

    await fs.mkdir(path.join(coursePath, "extracted", "pages"), {
      recursive: true,
    });
    await fs.mkdir(path.join(coursePath, "extracted", "announcements"), {
      recursive: true,
    });
    await fs.mkdir(path.join(coursePath, "extracted", "discussions"), {
      recursive: true,
    });
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });
    await fs.mkdir(path.join(workspacePath, "extracted", "docs"), {
      recursive: true,
    });

    await fs.writeFile(
      path.join(coursePath, "extracted", "syllabus-body.txt"),
      "Course policies and grading rubric.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "pages", "lab-brief.txt"),
      "Pipeline timing is explained in this lab brief.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "announcements", "77.txt"),
      "# Exam update\n\nThe final exam keeps the waveform analysis requirement.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "discussions", "88.txt"),
      "# Lab 4 Q&A\n\nSigned overflow detection is required in the ALU explanation.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      "Deliverables include a waveform screenshot and a short analysis.\n",
      "utf-8"
    );

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
      path.join(workspacePath, "notes.md"),
      "# Notes\nThe stall cycles appear before the hazard clears.\n",
      "utf-8"
    );
    await writeJson(path.join(workspacePath, "workup.json"), {
      overview: "Focus on the pipeline timing and waveform evidence.",
      deliverables: ["Waveform screenshot", "Short analysis"],
      sourceTrace: [
        {
          conclusion: "Need a waveform screenshot",
          source: "lab4-spec.pdf",
        },
      ],
    });
    await fs.writeFile(
      path.join(workspacePath, "extracted", "docs", "reference.txt"),
      "The waveform must show stall cycles around the branch hazard.\n",
      "utf-8"
    );

    const cache: CourseCache = {
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
          htmlUrl: "https://canvas.example/lab-4",
          hasDescription: true,
          descriptionLinkCount: 1,
        },
      ],
      modules: [
        {
          id: 8,
          name: "Lab 4 Module",
          position: 1,
          itemCount: 1,
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
          ],
        },
      ],
      files: [],
      pages: [
        {
          pageId: "lab-brief",
          title: "Lab Brief",
          htmlUrl: null,
          updatedAt: "2026-04-01T12:00:00.000Z",
          hasBody: true,
        },
      ],
      announcements: [
        {
          id: 77,
          title: "Exam update",
          postedAt: "2026-04-03T08:00:00.000Z",
          htmlUrl: "https://canvas.example/courses/17/discussion_topics/77",
          userName: "Prof. Ada",
          hasMessage: true,
          messageFileLinkCount: 0,
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
          moduleItems: 1,
          files: 0,
          pages: 1,
          syllabusCandidates: 0,
          lectures: 0,
          attachmentsDownloaded: 1,
          attachmentsSkipped: 0,
          attachmentsFailed: 0,
        },
      },
    };

    const workspace: LoadedWorkspace = {
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
      notesMd: await fs.readFile(path.join(workspacePath, "notes.md"), "utf-8"),
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

    const index = await loadArtifactIndex({ cache, workspace });

    assert.ok(index.courseKey);
    assert.ok(index.workspaceKey);
    assert.ok(index.artifacts.some((artifact) => artifact.scope === "course"));
    assert.ok(index.artifacts.some((artifact) => artifact.scope === "workspace"));

    const attachmentResult = searchArtifacts(index, "waveform screenshot", {
      scope: "course",
      kinds: ["attachment"],
      limit: 1,
    });
    assert.equal(attachmentResult[0]?.artifact.title, "lab4-spec.pdf");

    const announcementResult = searchArtifacts(index, "final exam waveform", {
      scope: "course",
      kinds: ["announcement"],
      limit: 1,
    });
    assert.equal(announcementResult[0]?.artifact.title, "Exam update");

    const discussionResult = searchArtifacts(index, "signed overflow detection", {
      scope: "course",
      kinds: ["discussion"],
      limit: 1,
    });
    assert.equal(discussionResult[0]?.artifact.title, "Lab 4 Q&A");

    const workspaceResult = searchArtifactSections(index, "branch hazard", {
      scope: "workspace",
      kinds: ["extracted", "notes"],
      limit: 1,
    });
    assert.equal(
      workspaceResult[0]?.section.source,
      "extracted/docs/reference.txt"
    );

    const attachmentText = await readArtifactContent(
      index,
      "course:attachment:attachments/lab4-spec.pdf:lab4-spec.pdf"
    );
    assert.match(attachmentText ?? "", /waveform screenshot/);

    const announcementText = await readArtifactContent(
      index,
      "course:announcement:77"
    );
    assert.match(announcementText ?? "", /final exam/);

    const discussionText = await readArtifactContent(
      index,
      "course:discussion:88"
    );
    assert.match(discussionText ?? "", /Signed overflow detection/);

    const workupText = await readArtifactContent(index, "workspace:workup:workup.json");
    assert.match(workupText ?? "", /pipeline timing/);
  });
});

test("artifact index cache invalidates when extracted workspace content changes", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();

    const workspacePath = path.join(tempDir, "workspace");
    const extractedPath = path.join(
      workspacePath,
      "extracted",
      "notes",
      "lab.txt"
    );
    await fs.mkdir(path.dirname(extractedPath), { recursive: true });
    await fs.writeFile(
      extractedPath,
      "Initial extracted notes about the waveform.\n",
      "utf-8"
    );

    const workspace: LoadedWorkspace = {
      path: workspacePath,
      sessionSlug: "lab-4",
      assignmentId: 42,
      assignmentName: "Lab 4",
      courseId: 17,
      courseName: "ECE243",
      courseCode: "ECE243H1",
      preparedAt: "2026-04-02T09:00:00.000Z",
      workspaceState: "ready",
      assignmentMd: "# Assignment\nBuild the datapath.\n",
      planMd: "# Plan\nRecord the waveform.\n",
      notesMd: null,
      workupJson: null,
      extractedFiles: [
        {
          name: "notes/lab.txt",
          relativePath: path.join("extracted", "notes", "lab.txt"),
        },
      ],
      extractedFileCache: new Map<string, string>(),
    };

    const firstIndex = await loadArtifactIndex({ workspace });
    const repeatedIndex = await loadArtifactIndex({ workspace });
    assert.strictEqual(repeatedIndex, firstIndex);

    const firstText = await readArtifactContent(
      firstIndex,
      "workspace:extracted:notes/lab.txt"
    );
    assert.match(firstText ?? "", /Initial extracted notes/);

    await fs.writeFile(
      extractedPath,
      "Updated extracted notes with the final waveform evidence.\n",
      "utf-8"
    );
    const updatedTime = new Date(Date.now() + 2000);
    await fs.utimes(extractedPath, updatedTime, updatedTime);

    const secondIndex = await loadArtifactIndex({ workspace });
    assert.notStrictEqual(secondIndex, firstIndex);
    assert.notEqual(secondIndex.key, firstIndex.key);

    const secondText = await readArtifactContent(
      secondIndex,
      "workspace:extracted:notes/lab.txt"
    );
    assert.match(secondText ?? "", /final waveform evidence/);
  });
});
