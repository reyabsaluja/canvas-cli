import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { Observation } from "../src/agent/observation.js";
import type { CourseCache } from "../src/ingest/types.js";
import type { CanvasClient } from "../src/canvas/client.js";
import {
  findUnsupportedAnswerClaims,
  verifyWorkspaceAnswer,
} from "../src/agent/verify.js";
import { parseWorkspaceAnswerResponse } from "../src/ask/answer.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { executeToolCallForTurn } from "../src/tui/chat-agent.js";
import { MAX_DOC_TEXT } from "../src/tui/chat-agent/tool-execution.js";
import { createChatContext } from "../src/tui/services.js";

const LAB_HANDOUT = `ECE243 Lab 4: Interrupts and Timers
Winter 2026

Part 1: Configuring the private timer
Set the private timer load register at address 0xFFFEC600 to 200,000,000 so that
it counts one second at the 200 MHz clock.

SUBMISSION
Submit a single zip file named lab4_<studentnumber>.zip containing your C source
and a two-page PDF report. The zip is due on Canvas by Friday March 27 at 11:59 PM.
Late submissions lose 10% per day.

Grading:
The demo is worth 60% and the report is worth 40%.
`;

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-grounding-answer-support-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createWorkspace(tempDir: string): Promise<LoadedWorkspace> {
  const workspacePath = path.join(tempDir, "workspace");
  await fs.mkdir(path.join(workspacePath, "extracted"), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, "assignment.md"),
    "# Lab 4\nInterrupts and timers on the DE1-SoC.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "extracted", "lab4.txt"),
    LAB_HANDOUT,
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
    preparedAt: "2026-03-20T09:00:00.000Z",
    workspaceState: "ready",
    assignmentMd: "# Lab 4\nInterrupts and timers on the DE1-SoC.\n",
    planMd: null,
    notesMd: null,
    workupJson: null,
    extractedFiles: [
      { name: "lab4.txt", relativePath: path.join("extracted", "lab4.txt") },
    ],
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
        attachmentsDownloaded: 0,
        attachmentsSkipped: 0,
        attachmentsFailed: 0,
      },
    },
  };
}

function createReadObservation(content: string, title = "lab4.txt"): Observation {
  return {
    tool: "read_file",
    status: "ok",
    summary: `Read ${title}.`,
    artifacts: [
      {
        artifactId: `workspace:extracted:${title}`,
        title,
        kind: "extracted",
        excerpt: "ECE243 Lab 4: Interrupts and Timers Winter 2026",
      },
    ],
    content,
  };
}

const loadedStub = { workupJson: null } as unknown as LoadedWorkspace;

test("findUnsupportedAnswerClaims flags numbers, dates and times that the evidence never states", () => {
  const unsupported = findUnsupportedAnswerClaims(
    "Lab 4 is due Friday March 20 at 11:59 PM and late work loses 15% per day.",
    LAB_HANDOUT,
    "When is lab 4 due?"
  );
  assert.deepEqual(unsupported, ["March 20", "15%"]);
});

test("findUnsupportedAnswerClaims accepts paraphrased numbers that the evidence supports", () => {
  const answer = [
    "The zip is due March 27th at 11:59 PM; late submissions lose 10 percent per day.",
    "Load the timer with 200,000,000 (the 200 MHz clock) at 0xFFFEC600.",
    "Grading:",
    "1. Demo, worth 60%",
    "2. Report, worth 40%",
  ].join("\n");
  assert.deepEqual(findUnsupportedAnswerClaims(answer, LAB_HANDOUT), []);
});

test("findUnsupportedAnswerClaims ignores numbers the question itself introduced and list markers", () => {
  const answer = [
    "For Lab 4 you have 3 parts to complete:",
    "10. Timer setup",
    "11. The ISR",
    "12. HEX display",
  ].join("\n");
  assert.deepEqual(
    findUnsupportedAnswerClaims(answer, LAB_HANDOUT, "What are the 3 parts of Lab 4?"),
    []
  );
});

test("verification downgrades a grounded answer whose date is not in the document it cites", () => {
  const observations = [createReadObservation(LAB_HANDOUT)];

  const wrong = verifyWorkspaceAnswer({
    question: "When is the lab 4 zip due and what is the late penalty?",
    answer:
      "The zip is due on Canvas by Friday March 20 at 11:59 PM. Late submissions lose 10% per day.",
    observations,
    usedWorkup: false,
    loaded: loadedStub,
  });
  assert.equal(wrong.confidence, "medium");
  assert.equal(wrong.sources[0]?.title, "lab4.txt");
  assert.match(wrong.note ?? "", /could not confirm/i);
  assert.match(wrong.note ?? "", /"March 20"/);
  assert.match(wrong.note ?? "", /lab4\.txt/);
  assert.doesNotMatch(wrong.note ?? "", /11:59/);

  const right = verifyWorkspaceAnswer({
    question: "When is the lab 4 zip due and what is the late penalty?",
    answer:
      "The zip is due on Canvas by Friday March 27 at 11:59 PM. Late submissions lose 10% per day.",
    observations,
    usedWorkup: false,
    loaded: loadedStub,
  });
  assert.equal(right.confidence, "high");
  assert.equal(right.note, null);
});

test("verification drops search-only evidence to low when the answer adds an unsupported figure", () => {
  const result = verifyWorkspaceAnswer({
    question: "What is the late penalty for lab 4?",
    answer: "Late submissions lose 25% per day.",
    observations: [
      {
        tool: "search_workspace",
        status: "ok",
        summary: 'Found 1 relevant workspace match for "late penalty".',
        artifacts: [
          {
            artifactId: "workspace:extracted:lab4.txt",
            title: "lab4.txt",
            kind: "extracted",
            excerpt: "Late submissions lose 10% per day.",
            sectionLabel: "SUBMISSION",
          },
        ],
      },
    ],
    usedWorkup: false,
    loaded: loadedStub,
  });
  assert.equal(result.confidence, "low");
  assert.match(result.note ?? "", /"25%"/);
  assert.match(result.note ?? "", /matched search evidence/);
});

test("/ask answers with figures missing from the context are capped at medium with a grounding note", () => {
  const context = [
    {
      source: "extracted/lab4.txt",
      section: "SUBMISSION",
      text: "The zip is due on Canvas by Friday March 27 at 11:59 PM.",
      kind: "extracted",
      sectionId: "lab4:submission",
    },
  ];
  const wrong = parseWorkspaceAnswerResponse(
    "When is the zip due?",
    JSON.stringify({
      answer: "The zip is due Friday March 20 at 11:59 PM.",
      bullet_points: [],
      source_ids: ["lab4:submission"],
      confidence: "high",
    }),
    context
  );
  assert.equal(wrong.confidence, "medium");
  assert.match(wrong.verificationNote ?? "", /"March 20"/);

  const right = parseWorkspaceAnswerResponse(
    "When is the zip due?",
    JSON.stringify({
      answer: "The zip is due Friday March 27 at 11:59 PM.",
      bullet_points: [],
      source_ids: ["lab4:submission"],
      confidence: "high",
    }),
    context
  );
  assert.equal(right.confidence, "high");
  assert.equal(right.verificationNote, null);
});

test("search_course observations carry the matched passage and its section label for citations", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "pages"), {
      recursive: true,
    });
    const cache = createCourseCache(coursePath);
    cache.pages = [
      {
        pageId: "course-policies",
        title: "Course Policies",
        htmlUrl: null,
        updatedAt: null,
        hasBody: true,
      },
    ];
    await fs.writeFile(
      path.join(coursePath, "extracted", "pages", "course-policies.txt"),
      [
        "# Course Policies",
        "Welcome to the course. Office hours are on Tuesdays.",
        "",
        "## Collaboration",
        "You may discuss ideas but must write your own code.",
        "",
        "## Late Penalty",
        "Late submissions lose 10% per day up to three days, after which they are not accepted.",
        "",
      ].join("\n"),
      "utf-8"
    );

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );
    const { result } = await executeToolCallForTurn(
      new Map(),
      "search_course",
      { query: "late penalty per day" },
      ctx
    );

    assert.equal(result.observation.status, "ok");
    const artifact = result.observation.artifacts[0]!;
    assert.equal(artifact.sectionLabel, "Late Penalty");
    assert.ok(artifact.sectionIds?.length === 1);
    assert.match(artifact.excerpt ?? "", /lose 10% per day/);

    const verified = verifyWorkspaceAnswer({
      question: "What is the late penalty?",
      answer: "Late submissions lose 10% per day for up to three days.",
      observations: [result.observation],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verified.sources[0]?.section, "Late Penalty");
    assert.equal(verified.confidence, "medium");
  });
});

test("download_course_file fresh downloads get the same windowed read as read_file", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "attachments", "modules"), {
      recursive: true,
    });
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
            title: "lab4-notes.txt",
            type: "File",
            position: 1,
            contentId: 99,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: null,
          },
        ],
      },
    ];

    const pages: string[] = [];
    for (let page = 1; page <= 70; page += 1) {
      const filler = `Page ${page} discusses interrupt latency on the DE1-SoC. `.repeat(45);
      pages.push(`## Page ${page}\n${filler}`);
    }
    const bigText = pages.join("\n\n");
    assert.ok(bigText.length > MAX_DOC_TEXT);

    const client = {
      getFileSafe: async () => ({
        id: 99,
        url: "https://canvas.example/files/99/download",
        display_name: "lab4-notes.txt",
        content_type: "text/plain",
        size: bigText.length,
      }),
      downloadFile: async () => Buffer.from(bigText, "utf-8"),
    };
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      {
        cache,
        client: client as unknown as CanvasClient,
        config: null,
        courseId: 17,
      }
    );

    const { result } = await executeToolCallForTurn(
      new Map(),
      "download_course_file",
      { title: "lab4-notes.txt" },
      ctx
    );

    assert.equal(result.observation.status, "ok");
    assert.match(result.observation.summary, /Downloaded and extracted lab4-notes\.txt/);
    const content = result.observation.content ?? "";
    assert.ok(content.length <= MAX_DOC_TEXT + 20, `content ${content.length} exceeds window`);
    assert.match(content, /\[\.\.\.truncated\]$/);
    assert.match(result.modelText, /Sections in this document: Page 1–70\./);
    assert.match(result.modelText, /Not included in this read: Page 5\d–70/);
  });
});
