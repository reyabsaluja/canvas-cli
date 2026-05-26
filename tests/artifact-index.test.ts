import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import {
  buildQueryMatchedExcerpt,
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

test("section search discriminates numbered course items by single-digit tokens", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();

    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "assignments"), {
      recursive: true,
    });

    await fs.writeFile(
      path.join(coursePath, "extracted", "assignments", "1.txt"),
      "# Lab 3: Pipelining\n\nPoints: 80\nDue: March 1\n\nImplement forwarding logic for the 5-stage pipeline.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "assignments", "2.txt"),
      "# Lab 4: Cache Memory\n\nPoints: 100\nDue: March 15\n\nImplement a direct-mapped cache simulator.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "assignments", "3.txt"),
      "# Lab 5: I/O Devices\n\nPoints: 90\nDue: March 29\n\nProgram device registers for UART communication.\n",
      "utf-8"
    );

    const cache: CourseCache = {
      courseId: 17,
      coursePath,
      assignments: [
        {
          id: 1,
          name: "Lab 3: Pipelining",
          dueAt: "2026-03-01T23:59:00.000Z",
          unlockAt: null,
          lockAt: null,
          pointsPossible: 80,
          gradingType: "points",
          submissionTypes: ["online_upload"],
          htmlUrl: "https://canvas.example/assignments/1",
          hasDescription: true,
          descriptionLinkCount: 0,
        },
        {
          id: 2,
          name: "Lab 4: Cache Memory",
          dueAt: "2026-03-15T23:59:00.000Z",
          unlockAt: null,
          lockAt: null,
          pointsPossible: 100,
          gradingType: "points",
          submissionTypes: ["online_upload"],
          htmlUrl: "https://canvas.example/assignments/2",
          hasDescription: true,
          descriptionLinkCount: 0,
        },
        {
          id: 3,
          name: "Lab 5: I/O Devices",
          dueAt: "2026-03-29T23:59:00.000Z",
          unlockAt: null,
          lockAt: null,
          pointsPossible: 90,
          gradingType: "points",
          submissionTypes: ["online_upload"],
          htmlUrl: "https://canvas.example/assignments/3",
          hasDescription: true,
          descriptionLinkCount: 0,
        },
      ],
      modules: [],
      files: [],
      pages: [],
      announcements: [],
      discussions: [],
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
          assignments: 3,
          modules: 0,
          moduleItems: 0,
          files: 0,
          pages: 0,
          syllabusCandidates: 0,
          lectures: 0,
          attachmentsDownloaded: 0,
          attachmentsSkipped: 0,
          attachmentsFailed: 0,
        },
      },
    };

    const index = await loadArtifactIndex({ cache });

    const lab4Results = searchArtifactSections(index, "lab 4", {
      scope: "course",
      limit: 3,
    });
    assert.ok(lab4Results.length >= 1);
    assert.equal(lab4Results[0]!.section.source, "Lab 4: Cache Memory");

    const lab3Results = searchArtifactSections(index, "lab 3", {
      scope: "course",
      limit: 3,
    });
    assert.ok(lab3Results.length >= 1);
    assert.equal(lab3Results[0]!.section.source, "Lab 3: Pipelining");

    const lab5Results = searchArtifactSections(index, "lab 5", {
      scope: "course",
      limit: 3,
    });
    assert.ok(lab5Results.length >= 1);
    assert.equal(lab5Results[0]!.section.source, "Lab 5: I/O Devices");

    // Verify score separation — correct lab should score much higher
    const lab4Score = lab4Results[0]!.score;
    const lab4SecondScore = lab4Results[1]?.score ?? 0;
    assert.ok(
      lab4Score > lab4SecondScore * 1.5,
      `Lab 4 should score much higher than other labs (${lab4Score} vs ${lab4SecondScore})`
    );
  });
});

test("section search matches morphological variants through stemming", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();

    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "assignments"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "assignments", "1.txt"),
      [
        "# Homework 1",
        "",
        "## Submission Guidelines",
        "",
        "Submit your report as a PDF. All submissions must include a cover page.",
        "Files submitted after the deadline receive a 10% penalty.",
      ].join("\n"),
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "assignments", "2.txt"),
      [
        "# Homework 2",
        "",
        "## Requirements",
        "",
        "Students are required to implement the algorithm described in lecture.",
        "Each requirement must be satisfied for full marks.",
      ].join("\n"),
      "utf-8"
    );

    const cache: CourseCache = {
      coursePath,
      courseId: 10,
      courseName: "CS101",
      courseCode: "CS101",
      assignments: [
        {
          id: 1,
          name: "Homework 1",
          dueAt: null,
          pointsPossible: 100,
          gradingType: "points",
          submissionTypes: ["online_upload"],
        },
        {
          id: 2,
          name: "Homework 2",
          dueAt: null,
          pointsPossible: 100,
          gradingType: "points",
          submissionTypes: ["online_upload"],
        },
      ],
      pages: [],
      modules: [],
      moduleItems: [],
      files: [],
      attachments: [],
      quizzes: [],
      calendarEvents: [],
      announcements: [],
      discussions: [],
      externalLinks: [],
      lectures: [],
      ingestion: {
        version: 1,
        ingestedAt: "2026-04-01T12:00:00.000Z",
        courseId: 10,
        courseName: "CS101",
        courseCode: "CS101",
        refresh: false,
        counts: {
          assignments: 2,
          modules: 0,
          moduleItems: 0,
          files: 0,
          pages: 0,
          syllabusCandidates: 0,
          lectures: 0,
          attachmentsDownloaded: 0,
          attachmentsSkipped: 0,
          attachmentsFailed: 0,
        },
      },
    };

    const index = await loadArtifactIndex({ cache });

    // "submitting" should match content containing "submit", "submissions", "submitted"
    const submitResults = searchArtifactSections(index, "submitting", {
      scope: "course",
      limit: 5,
    });
    assert.ok(
      submitResults.length > 0,
      "should find results for 'submitting' matching 'submit/submissions/submitted'"
    );
    assert.equal(submitResults[0]!.section.source, "Homework 1");

    // "required" should match content containing "requirements", "required", "requirement"
    const requireResults = searchArtifactSections(index, "required", {
      scope: "course",
      limit: 5,
    });
    assert.ok(
      requireResults.length > 0,
      "should find results for 'required' matching 'requirements/required/requirement'"
    );
    assert.equal(requireResults[0]!.section.source, "Homework 2");
  });
});

test("buildQueryMatchedExcerpt returns full text when within budget", () => {
  const short = "This is a short text about grading.";
  assert.equal(buildQueryMatchedExcerpt(short, "grading", { maxLength: 500 }), short);
});

test("buildQueryMatchedExcerpt surfaces multiple windows for scattered matches", () => {
  const padding = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ".repeat(6);
  const text = `The grading policy requires 80% for an A. ${padding}The grading rubric uses holistic assessment for essays. ${padding}Final grading decisions are made by the instructor.`;

  const excerpt = buildQueryMatchedExcerpt(text, "grading", { maxLength: 500 });

  const segments = excerpt.split(" ... ");
  assert.ok(
    segments.length >= 2,
    `expected multiple windows but got ${segments.length} segment(s) in text of length ${text.length}: ${excerpt.slice(0, 120)}...`
  );
  const matchCount = (excerpt.match(/grading/gi) ?? []).length;
  assert.ok(
    matchCount >= 2,
    `expected at least 2 'grading' mentions in excerpt but got ${matchCount}`
  );
});

test("buildQueryMatchedExcerpt falls back to single window for short text", () => {
  const text = "The deadline is Friday. Submit by 11:59 PM. Late penalty applies after the deadline.";
  const excerpt = buildQueryMatchedExcerpt(text, "deadline", { maxLength: 500 });
  assert.equal(excerpt, text);
});

test("buildQueryMatchedExcerpt falls back to prefix when no match found", () => {
  const text = "A".repeat(600);
  const excerpt = buildQueryMatchedExcerpt(text, "xyz", { maxLength: 100 });
  assert.ok(excerpt.endsWith("..."));
  assert.ok(excerpt.length <= 100);
});
