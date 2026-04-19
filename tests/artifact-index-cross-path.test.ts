import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContextBundle } from "../src/ai/context-bundle.js";
import {
  buildWorkspaceRetrievalContext,
  retrieveRelevant,
} from "../src/ask/retrieve.js";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { AssignmentDetail } from "../src/domain/models.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import type { EnrichmentSummary } from "../src/enrich/types.js";
import {
  clearArtifactIndexCache,
  loadArtifactIndex,
} from "../src/knowledge/artifact-index.js";
import {
  renderCourseArtifactSearchResult,
  searchCourseArtifacts,
  searchCourseKnowledge,
} from "../src/tui/course-retrieval.js";
import {
  listWorkspaceKnowledgeArtifacts,
  readWorkspaceKnowledgeArtifact,
  searchWorkspaceKnowledge,
} from "../src/tui/workspace-knowledge.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-artifact-index-cross-path-")
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
    "# Assignment\nImplement the datapath and capture the waveform.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "plan.md"),
    "# Plan\nCapture the waveform before writing the analysis.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "notes.md"),
    "# Notes\nRemember to annotate the final screenshot before submission.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "workup.json"),
    JSON.stringify(
      {
        overview: "Use the extracted reference and assignment brief together.",
        deliverables: ["Waveform screenshot", "Short analysis"],
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "extracted", "docs", "reference.txt"),
    "The waveform must show stall cycles around the branch hazard before the pipeline recovers.\n",
    "utf-8"
  );

  return loadWorkspaceFixture(workspacePath);
}

async function loadWorkspaceFixture(
  workspacePath: string
): Promise<LoadedWorkspace> {
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
        attachmentsDownloaded: 1,
        attachmentsSkipped: 0,
        attachmentsFailed: 0,
      },
    },
  };
}

function createAssignmentDetail(): AssignmentDetail {
  return {
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
    attachments: [
      {
        id: 99,
        displayName: "lab4-spec.pdf",
        filename: "lab4-spec.pdf",
        url: "https://canvas.example/files/99/download",
        contentType: "application/pdf",
        size: 1024,
      },
    ],
  };
}

function createEnrichment(): EnrichmentSummary {
  return {
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
  };
}

async function seedCourseExtractedFiles(coursePath: string): Promise<void> {
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
    path.join(coursePath, "extracted", "pages", "lab-brief.txt"),
    "Lab Brief page with datapath walkthrough and timing notes.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
    "Deliverables include a waveform screenshot and a short analysis of the datapath behaviour.\n",
    "utf-8"
  );
}

test("artifact index keeps ask, course search, workspace chat, and overview aligned on the same artifacts", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspace = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await seedCourseExtractedFiles(coursePath);
    const cache = createCourseCache(coursePath);
    const detail = createAssignmentDetail();
    const enrichment = createEnrichment();

    const askContext = await buildWorkspaceRetrievalContext(workspace);
    const askIndexAgain = await loadArtifactIndex({ workspace });
    assert.equal(askContext.index, askIndexAgain);

    const askRelevant = retrieveRelevant(
      "branch hazard stall cycles",
      askContext,
      3
    );
    assert.equal(askRelevant[0]?.source, "extracted/docs/reference.txt");
    assert.ok(askRelevant[0]?.artifactId);
    assert.ok(askRelevant[0]?.sectionId);

    const combinedIndex = await loadArtifactIndex({ workspace, cache });
    const chatMatches = await searchWorkspaceKnowledge(
      workspace,
      cache,
      "branch hazard stall cycles",
      3
    );
    assert.equal(await loadArtifactIndex({ workspace, cache }), combinedIndex);
    assert.equal(chatMatches[0]?.artifact.id, askRelevant[0]?.artifactId);
    assert.equal(chatMatches[0]?.section.id, askRelevant[0]?.sectionId);
    assert.equal(chatMatches[0]?.header, "--- [extracted] docs/reference.txt ---");

    const courseIndex = await loadArtifactIndex({ cache });
    const courseMatches = await searchCourseArtifacts(
      cache,
      "waveform screenshot"
    );
    const renderedCourseSearch = renderCourseArtifactSearchResult(
      await searchCourseKnowledge(cache, "waveform screenshot"),
      "waveform screenshot"
    );
    const bundle = await buildContextBundle(detail, enrichment, cache);
    assert.equal(await loadArtifactIndex({ cache }), courseIndex);

    assert.equal(courseMatches[0]?.artifact.title, "lab4-spec.pdf");
    assert.match(renderedCourseSearch, /\[attachment\] lab4-spec\.pdf/);

    const chatRead = await readWorkspaceKnowledgeArtifact(
      workspace,
      cache,
      "lab4 spec",
      30000
    );
    assert.equal(chatRead.status, "ok");
    if (chatRead.status === "ok") {
      assert.equal(chatRead.artifact.id, courseMatches[0]?.artifact.id);
    }

    const fileList = await listWorkspaceKnowledgeArtifacts(workspace, cache);
    assert.ok(
      fileList.courseDocuments.some(
        (entry) => entry.label === "[attachment] lab4-spec.pdf"
      )
    );

    const overviewAttachment = bundle.extractedTexts.find(
      (entry) => entry.source === "[attachment] lab4-spec.pdf"
    );
    assert.ok(overviewAttachment);
    assert.equal(overviewAttachment?.artifactId, courseMatches[0]?.artifact.id);
    assert.match(overviewAttachment?.content ?? "", /waveform screenshot/);
  });
});

test("artifact index invalidation propagates updated workspace and course content across retrieval paths", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspace = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await seedCourseExtractedFiles(coursePath);
    const cache = createCourseCache(coursePath);
    const detail = createAssignmentDetail();
    const enrichment = createEnrichment();

    const workspaceIndexBefore = await loadArtifactIndex({ workspace });
    const courseIndexBefore = await loadArtifactIndex({ cache });
    const combinedIndexBefore = await loadArtifactIndex({ workspace, cache });

    await fs.writeFile(
      path.join(workspace.path, "extracted", "docs", "reference.txt"),
      "The forwarding fix uses the hazard mux update after the scoreboard clears.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      "Deliverables now emphasize a timing diagram and a register map explanation.\n",
      "utf-8"
    );

    const workspaceIndexAfter = await loadArtifactIndex({ workspace });
    const courseIndexAfter = await loadArtifactIndex({ cache });
    const combinedIndexAfter = await loadArtifactIndex({ workspace, cache });

    assert.notEqual(workspaceIndexBefore.key, workspaceIndexAfter.key);
    assert.notEqual(courseIndexBefore.key, courseIndexAfter.key);
    assert.notEqual(combinedIndexBefore.key, combinedIndexAfter.key);
    assert.notEqual(workspaceIndexBefore, workspaceIndexAfter);
    assert.notEqual(courseIndexBefore, courseIndexAfter);
    assert.notEqual(combinedIndexBefore, combinedIndexAfter);

    const askRelevant = retrieveRelevant(
      "forwarding fix hazard mux",
      await buildWorkspaceRetrievalContext(workspace),
      2
    );
    assert.match(askRelevant[0]?.text ?? "", /forwarding fix/);

    const chatMatches = await searchWorkspaceKnowledge(
      workspace,
      cache,
      "forwarding fix hazard mux",
      2
    );
    assert.match(chatMatches[0]?.preview ?? "", /hazard mux update/);

    const courseMatches = await searchCourseArtifacts(cache, "timing diagram");
    assert.equal(courseMatches[0]?.artifact.title, "lab4-spec.pdf");

    const renderedCourseSearch = renderCourseArtifactSearchResult(
      await searchCourseKnowledge(cache, "timing diagram"),
      "timing diagram"
    );
    assert.match(renderedCourseSearch, /\[attachment\] lab4-spec\.pdf/);

    const chatRead = await readWorkspaceKnowledgeArtifact(
      workspace,
      cache,
      "timing diagram",
      30000
    );
    assert.equal(chatRead.status, "ok");
    if (chatRead.status === "ok") {
      assert.match(chatRead.content, /register map explanation/);
    }

    const bundle = await buildContextBundle(detail, enrichment, cache);
    const overviewAttachment = bundle.extractedTexts.find(
      (entry) => entry.source === "[attachment] lab4-spec.pdf"
    );
    assert.match(overviewAttachment?.content ?? "", /timing diagram/);
  });
});
