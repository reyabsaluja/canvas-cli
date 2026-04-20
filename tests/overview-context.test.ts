import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContextBundle } from "../src/ai/context-bundle.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-overview-context-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("overview context selects shared course artifacts with explicit priorities and labels", async () => {
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
    await fs.writeFile(
      path.join(coursePath, "extracted", "syllabus-body.txt"),
      "The syllabus says Lab 4 is due on April 20.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "front-page.txt"),
      "Front page reminder about upcoming labs.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "assignments", "42.txt"),
      "Assignment summary with submission rules and the grading breakdown.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "pages", "lab-brief.txt"),
      "Lab Brief page with datapath walkthrough.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      "Specification PDF requiring a waveform screenshot and short analysis.\n",
      "utf-8"
    );

    const bundle = await buildContextBundle(
      {
        id: 42,
        name: "Lab 4",
        courseId: 17,
        courseName: "ECE243",
        dueAt: null,
        unlockAt: null,
        lockAt: null,
        submitted: false,
        submittedAt: null,
        score: null,
        grade: null,
        late: false,
        missing: false,
        status: "upcoming",
        pointsPossible: 100,
        gradingType: "points",
        submissionTypes: ["online_upload"],
        allowedExtensions: null,
        htmlUrl: "https://canvas.example/lab-4",
        description: null,
        attachments: [],
      } as any,
      {
        flags: {
          hasWeakCanvasDescription: true,
          missingDueDate: true,
          likelySubmissionShell: false,
        },
        contextConfidence: "high",
        relatedModuleItems: [],
        relatedPages: [
          {
            pageId: "lab-brief",
            title: "Lab Brief",
            htmlUrl: null,
            matchReason: "page title matched assignment name",
          },
        ],
        relatedFiles: [],
        relatedAttachments: [
          {
            filename: "lab4-spec.pdf",
            localPath: "attachments/lab4-spec.pdf",
            sourceType: "assignment_linked",
            matchReason: "linked from assignment",
          },
        ],
        likelyInstructionSources: [],
        notes: [],
      },
      {
        courseId: 17,
        coursePath,
        assignments: [
          {
            id: 42,
            name: "Lab 4",
            dueAt: null,
            unlockAt: null,
            lockAt: null,
            pointsPossible: 100,
            gradingType: "points",
            submissionTypes: ["online_upload"],
            htmlUrl: "https://canvas.example/lab-4",
            hasDescription: true,
            descriptionLinkCount: 0,
          },
        ],
        modules: [],
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
        ingestion: {
          version: 1,
          ingestedAt: "2026-04-01T12:00:00.000Z",
          courseId: 17,
          courseName: "ECE243",
          courseCode: "ECE243H1",
          refresh: false,
          counts: {
            assignments: 1,
            modules: 0,
            moduleItems: 0,
            files: 0,
            pages: 1,
            syllabusCandidates: 0,
            attachmentsDownloaded: 1,
            attachmentsSkipped: 0,
            attachmentsFailed: 0,
          },
        },
      } as CourseCache
    );

    assert.deepEqual(
      bundle.extractedTexts.map((entry) => entry.source),
      [
        "[syllabus] Course syllabus",
        "[assignment] Lab 4",
        "[attachment] lab4-spec.pdf",
        "[page] Lab Brief",
        "[front_page] Course front page",
      ]
    );
    assert.deepEqual(
      bundle.extractedTexts.map((entry) => entry.selectionReason),
      [
        "course syllabus",
        "ingested assignment instructions",
        "enrichment-related attachment",
        "enrichment-related page",
        "course front page",
      ]
    );
    const assignmentSource = bundle.extractedTexts.find(
      (entry) => entry.source === "[assignment] Lab 4"
    );
    const attachmentSource = bundle.extractedTexts.find(
      (entry) => entry.source === "[attachment] lab4-spec.pdf"
    );
    assert.match(
      assignmentSource?.content ?? "",
      /submission rules and the grading breakdown/
    );
    assert.match(attachmentSource?.content ?? "", /waveform screenshot/);
  });
});
