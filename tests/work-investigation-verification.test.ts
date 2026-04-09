import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmptyRunState } from "../src/agent/run-state.js";
import { executeToolDetailed } from "../src/work/tool-handlers.js";
import {
  createInvestigationState,
  renderInvestigationVerificationMessage,
  verifyInvestigationState,
} from "../src/work/orchestrator.js";
import { applyInvestigationVerification } from "../src/work/synthesis.js";
import type { AssignmentWorkup, InvestigationState } from "../src/work/types.js";
import type { AssignmentDetail, Course } from "../src/domain/models.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-work-verification-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function createState(): InvestigationState {
  return {
    assignmentName: "Lab 4",
    courseName: "ECE243",
    visitedSources: [],
    extractedTexts: new Map(),
    evidenceNotes: [],
    toolCallCount: 0,
    runState: createEmptyRunState(),
    primaryInstructionSourceIds: [],
    dueDateSourceIds: [],
  };
}

function createWorkup(): AssignmentWorkup {
  return {
    overview: "Complete the lab.",
    deliverables: ["report"],
    constraints: [],
    relevantResources: [],
    recommendedReadOrder: [],
    actionPlan: [{ step: 1, action: "Read the brief", detail: null }],
    uncertainties: [],
    dueDate: null,
    confidence: "high",
    sourceTrace: [],
  };
}

function createCourse(): Course {
  return {
    id: 17,
    name: "ECE243",
    courseCode: "ECE243H1",
    termName: "Winter 2026",
    isCurrent: true,
  };
}

function createDetail(overrides: Partial<AssignmentDetail> = {}): AssignmentDetail {
  return {
    id: 42,
    name: "Lab 4",
    courseId: 17,
    courseName: "ECE243",
    dueAt: null,
    submitted: false,
    status: "upcoming",
    htmlUrl: "https://canvas.example/lab-4",
    description: null,
    unlockAt: null,
    lockAt: null,
    pointsPossible: null,
    gradingType: "points",
    submissionTypes: [],
    allowedExtensions: null,
    submittedAt: null,
    score: null,
    grade: null,
    late: false,
    missing: false,
    attachments: [],
    ...overrides,
  };
}

test("verification blocks completion until both instruction and syllabus evidence exist", () => {
  const verification = verifyInvestigationState(createState());

  assert.equal(verification.ok, false);
  assert.equal(verification.confidence, "low");
  assert.deepEqual(verification.missing, [
    "primary_instruction",
    "due_date_source",
  ]);

  const message = renderInvestigationVerificationMessage(verification);
  assert.match(message, /read_document/i);
  assert.match(message, /download_module_file/i);
  assert.match(message, /list_assignments/i);
  assert.match(message, /get_syllabus/i);
});

test("applyInvestigationVerification lowers confidence and adds explicit uncertainties", () => {
  const verified = applyInvestigationVerification(createWorkup(), {
    ok: false,
    missing: ["primary_instruction", "due_date_source"],
    confidence: "low",
  });

  assert.equal(verified.confidence, "low");
  assert.match(
    verified.uncertainties.join("\n"),
    /primary instruction document was read/i
  );
  assert.match(
    verified.uncertainties.join("\n"),
    /due-date source/i
  );
});

test("reading a real document is not enough to complete without syllabus evidence", async () => {
  await withTempDir(async (tempDir) => {
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "attachments"), { recursive: true });
    await fs.mkdir(path.join(coursePath, "extracted"), { recursive: true });
    await fs.writeFile(
      path.join(coursePath, "attachments", "lab4.txt"),
      "Read the instruction document carefully.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "syllabus-body.txt"),
      "Week 10 schedule update: Lab 4 is due on April 10, and the course calendar confirms the submission window in detail.\n",
      "utf-8"
    );

    const state = createState();
    const ctx = {
      cache: {
        courseId: 17,
        coursePath,
        assignments: [],
        modules: [],
        files: [],
        pages: [],
        syllabusCandidates: [],
        attachments: [
          {
            canvasFileId: 42,
            originalFilename: "lab4.txt",
            localPath: path.join("attachments", "lab4.txt"),
            contentType: "text/plain",
            size: 32,
            downloadUrl: null,
            reason: "fixture",
            sourceType: "module_linked",
            status: "downloaded",
          },
        ],
        ingestion: {
          version: 1,
          ingestedAt: "2026-04-08T12:00:00.000Z",
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
            attachmentsDownloaded: 1,
            attachmentsSkipped: 0,
            attachmentsFailed: 0,
          },
        },
      },
      state,
      client: {} as any,
      config: {} as any,
      courseId: 17,
    };

    const readResult = await executeToolDetailed("read_document", { filename: "lab4.txt" }, ctx as any);
    assert.equal(readResult.observation.status, "ok");
    assert.equal(state.primaryInstructionSourceIds.length, 1);
    assert.deepEqual(state.dueDateSourceIds, []);

    const verification = verifyInvestigationState(state);
    assert.equal(verification.ok, false);
    assert.deepEqual(verification.missing, ["due_date_source"]);
  });
});

test("reading a rubric does not count as primary instruction evidence", async () => {
  await withTempDir(async (tempDir) => {
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "attachments"), { recursive: true });
    await fs.writeFile(
      path.join(coursePath, "attachments", "lab4-rubric.txt"),
      "Rubric details and grading breakdown.\n",
      "utf-8"
    );

    const state = createState();
    const ctx = {
      cache: {
        courseId: 17,
        coursePath,
        assignments: [],
        modules: [],
        files: [],
        pages: [],
        syllabusCandidates: [],
        attachments: [
          {
            canvasFileId: 42,
            originalFilename: "lab4-rubric.txt",
            localPath: path.join("attachments", "lab4-rubric.txt"),
            contentType: "text/plain",
            size: 32,
            downloadUrl: null,
            reason: "fixture",
            sourceType: "module_linked",
            status: "downloaded",
          },
        ],
        ingestion: null,
      },
      state,
      client: {} as any,
      config: {} as any,
      courseId: 17,
    };

    const readResult = await executeToolDetailed(
      "read_document",
      { filename: "lab4-rubric.txt" },
      ctx as any
    );
    assert.equal(readResult.observation.status, "ok");
    assert.deepEqual(state.primaryInstructionSourceIds, []);
  });
});

test("checking syllabus is not enough to complete without reading a real document", async () => {
  await withTempDir(async (tempDir) => {
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted"), { recursive: true });
    await fs.writeFile(
      path.join(coursePath, "extracted", "syllabus-body.txt"),
      "Week 10 schedule update: Lab 4 is due on April 10, and the course calendar confirms the submission window in detail.\n",
      "utf-8"
    );

    const state = createState();
    const ctx = {
      cache: {
        courseId: 17,
        coursePath,
        assignments: [],
        modules: [],
        files: [],
        pages: [],
        syllabusCandidates: [],
        attachments: [],
        ingestion: {
          version: 1,
          ingestedAt: "2026-04-08T12:00:00.000Z",
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
            attachmentsDownloaded: 0,
            attachmentsSkipped: 0,
            attachmentsFailed: 0,
          },
        },
      },
      state,
      client: {} as any,
      config: {} as any,
      courseId: 17,
    };

    const syllabusResult = await executeToolDetailed("get_syllabus", {}, ctx as any);
    assert.equal(syllabusResult.observation.status, "ok");
    assert.deepEqual(state.primaryInstructionSourceIds, []);
    assert.deepEqual(state.dueDateSourceIds, ["syllabus"]);

    const verification = verifyInvestigationState(state);
    assert.equal(verification.ok, false);
    assert.deepEqual(verification.missing, ["primary_instruction"]);
  });
});

test("listing assignments counts as due-date evidence when the assignment row has a due date", async () => {
  const state = createState();
  state.primaryInstructionSourceIds.push("document:lab4-handout.pdf");
  const cache = {
    courseId: 17,
    coursePath: "/tmp/course",
    assignments: [
      {
        id: 42,
        name: "Lab 4",
        dueAt: "2026-04-10T23:59:00.000Z",
        unlockAt: null,
        lockAt: null,
        pointsPossible: 10,
        gradingType: "points",
        submissionTypes: ["online_upload"],
        htmlUrl: "https://canvas.example/lab-4",
        hasDescription: true,
        descriptionLinkCount: 0,
      },
    ],
    modules: [],
    files: [],
    pages: [],
    syllabusCandidates: [],
    attachments: [],
    ingestion: null,
  };
  const ctx = {
    cache,
    state,
    client: {} as any,
    config: {} as any,
    courseId: 17,
  };

  const listResult = await executeToolDetailed("list_assignments", {}, ctx as any);
  assert.equal(listResult.observation.status, "ok");
  assert.deepEqual(state.dueDateSourceIds, ["assignment:42"]);

  const verification = verifyInvestigationState(state);
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.missing, []);
});

test("listing assignments does not count unrelated due dates as evidence", async () => {
  const state = createState();
  state.primaryInstructionSourceIds.push("document:lab4-handout.pdf");
  const cache = {
    courseId: 17,
    coursePath: "/tmp/course",
    assignments: [
      {
        id: 99,
        name: "Lab 5",
        dueAt: "2026-04-12T23:59:00.000Z",
        unlockAt: null,
        lockAt: null,
        pointsPossible: 10,
        gradingType: "points",
        submissionTypes: ["online_upload"],
        htmlUrl: "https://canvas.example/lab-5",
        hasDescription: true,
        descriptionLinkCount: 0,
      },
    ],
    modules: [],
    files: [],
    pages: [],
    syllabusCandidates: [],
    attachments: [],
    ingestion: null,
  };
  const ctx = {
    cache,
    state,
    client: {} as any,
    config: {} as any,
    courseId: 17,
  };

  const listResult = await executeToolDetailed("list_assignments", {}, ctx as any);
  assert.equal(listResult.observation.status, "ok");
  assert.deepEqual(state.dueDateSourceIds, []);

  const verification = verifyInvestigationState(state);
  assert.equal(verification.ok, false);
  assert.deepEqual(verification.missing, ["due_date_source"]);
});

test("Canvas due dates seed due-date evidence before any extra tool calls", () => {
  const state = createInvestigationState(
    createDetail({ dueAt: new Date("2026-04-10T23:59:00.000Z") }),
    createCourse()
  );

  assert.deepEqual(state.dueDateSourceIds, ["canvas_assignment"]);
});

test("verification succeeds once both evidence checks are satisfied", () => {
  const state = createState();
  state.primaryInstructionSourceIds.push("document:lab4.pdf");
  state.dueDateSourceIds.push("syllabus");

  const verification = verifyInvestigationState(state);

  assert.equal(verification.ok, true);
  assert.equal(verification.confidence, "high");
  assert.deepEqual(verification.missing, []);
});
