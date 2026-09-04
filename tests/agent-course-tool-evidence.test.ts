import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import type { Observation } from "../src/agent/observation.js";
import { isGroundedContentObservation } from "../src/agent/observation-relevance.js";
import { appendObservation, createEmptyRunState, hasReadArtifact } from "../src/agent/run-state.js";
import { collectCheckedSources, verifyWorkspaceAnswer } from "../src/agent/verify.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { executeToolCallForTurn } from "../src/tui/chat-agent.js";
import { buildEvidenceBackedQuestion } from "../src/tui/chat-agent/prompt.js";
import { createChatContext } from "../src/tui/services.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-course-tool-evidence-")
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
    "# Lab 4\nBuild the datapath and explain branch behavior.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "plan.md"),
    "# Plan\nCapture the waveform before writing the analysis.\n",
    "utf-8"
  );
  const workupJson = {
    overview: "Implement the datapath and explain branch behavior.",
    deliverables: ["Waveform screenshot", "Short analysis"],
    dueDate: "2026-03-20",
  };
  await fs.writeFile(
    path.join(workspacePath, "workup.json"),
    `${JSON.stringify(workupJson, null, 2)}\n`,
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
    workupJson,
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
        attachmentsExtracted: 0,
        discussionAttachmentsDownloaded: 0,
      },
      warnings: [],
    },
  } as unknown as CourseCache;
}

const RADAR_ITEM = {
  kind: "announcement" as const,
  topicId: 88,
  courseId: 17,
  courseName: "ECE243",
  title: "Lab 4 Deadline Extension",
  authorName: "Prof. Ada",
  postedAt: new Date("2026-03-15T09:00:00.000Z"),
  lastReplyAt: new Date("2026-03-15T10:00:00.000Z"),
  unreadCount: 0,
  htmlUrl: "https://canvas.example/courses/17/discussion_topics/88",
  locked: false,
};

function createFakeRadar() {
  return {
    getRadarItems: async () => [RADAR_ITEM],
    getThread: async () => ({
      topic: RADAR_ITEM,
      body: "Because of the lab room closure, the Lab 4 deadline has been extended to March 27 at 11:59 PM. The rubric is unchanged.",
      entries: [
        {
          entryId: 1,
          authorName: "Prof. Ada",
          message: "Reminder: the demo slots are unaffected by the extension.",
          createdAt: new Date("2026-03-15T10:00:00.000Z"),
          depth: 0,
        },
      ],
      participantCount: 2,
      totalEntries: 1,
    }),
    resolveTopicByPartialTitle: async (
      _courses: unknown,
      query: string
    ) =>
      RADAR_ITEM.title.toLowerCase().includes(query.trim().toLowerCase())
        ? { status: "found" as const, item: RADAR_ITEM, courseId: 17 }
        : null,
  };
}

test("course-native tools return grounded evidence for assignments and threads but only a listing for announcements", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      {
        cache,
        client: null,
        config: null,
        courseId: 17,
        assignments: [
          {
            id: 42,
            name: "Lab 4",
            courseId: 17,
            courseName: "ECE243",
            dueAt: new Date("2026-03-20T23:59:00.000Z"),
            submitted: false,
            status: "upcoming",
            htmlUrl: "https://canvas.example/courses/17/assignments/42",
          },
        ],
        radar: createFakeRadar() as any,
      }
    );

    const assignmentList = await executeToolCallForTurn(
      new Map(),
      "list_assignments",
      {},
      ctx
    );
    assert.equal(assignmentList.result.observation.status, "ok");
    assert.equal(
      isGroundedContentObservation(assignmentList.result.observation),
      true,
      "list_assignments should be grounded evidence"
    );
    assert.match(assignmentList.result.observation.content ?? "", /Lab 4/);
    assert.equal(
      assignmentList.result.observation.artifacts[0]?.title,
      "Course assignments"
    );
    assert.equal(
      assignmentList.result.observation.artifacts[0]?.artifactId,
      "course:assignments:17"
    );

    const announcementList = await executeToolCallForTurn(
      new Map(),
      "list_announcements",
      { filter: "announcements", query: "Lab 4" },
      ctx
    );
    assert.equal(announcementList.result.observation.status, "ok");
    assert.equal(
      isGroundedContentObservation(announcementList.result.observation),
      false,
      "a listing must never count as a full read"
    );
    assert.match(
      announcementList.result.observation.content ?? "",
      /Lab 4 Deadline Extension/
    );
    assert.equal(
      announcementList.result.observation.artifacts[0]?.title,
      "Course announcements: Lab 4"
    );
    assert.equal(
      announcementList.result.observation.artifacts[0]?.artifactId,
      "course:radar:17:announcements:lab 4"
    );

    const threadRead = await executeToolCallForTurn(
      new Map(),
      "read_thread",
      { topic: "88" },
      ctx
    );
    assert.equal(threadRead.result.observation.status, "ok");
    assert.equal(
      isGroundedContentObservation(threadRead.result.observation),
      true,
      "read_thread should be grounded evidence"
    );
    const threadArtifact = threadRead.result.observation.artifacts[0];
    assert.equal(threadArtifact?.title, "Lab 4 Deadline Extension");
    assert.equal(threadArtifact?.kind, "discussion");
    assert.equal(
      threadArtifact?.artifactId,
      "course:thread:17:lab 4 deadline extension"
    );
    assert.match(threadArtifact?.excerpt ?? "", /Lab 4 Deadline Extension/);
    assert.match(threadRead.result.observation.summary, /"Lab 4 Deadline Extension"/);
    assert.match(
      threadRead.result.observation.content ?? "",
      /extended to March 27/
    );
    assert.match(threadRead.result.observation.content ?? "", /demo slots/);

    // Run-state remembers the thread as a read artifact, so the retrieval
    // gate and memory treat it like any other grounded document.
    const runState = createEmptyRunState();
    appendObservation(runState, announcementList.result.observation);
    appendObservation(runState, threadRead.result.observation);
    assert.equal(hasReadArtifact(runState, threadArtifact!.artifactId), true);
    assert.equal(
      hasReadArtifact(runState, "course:radar:17:announcements:lab 4"),
      false,
      "a listing must not be remembered as a read"
    );

    // The checked-sources trail still names the thread by its title.
    const trail = collectCheckedSources([
      announcementList.result.observation,
      threadRead.result.observation,
    ]);
    assert.deepEqual(
      trail.map((entry) => entry.label),
      [
        'the announcements matching "Lab 4"',
        'the discussion thread "Lab 4 Deadline Extension"',
      ]
    );
  });
});

test("an answer read from a discussion thread is cited and verified at high confidence", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      {
        cache,
        client: null,
        config: null,
        courseId: 17,
        radar: createFakeRadar() as any,
      }
    );

    const announcementList = await executeToolCallForTurn(
      new Map(),
      "list_announcements",
      { filter: "announcements", query: "deadline" },
      ctx
    );
    const threadRead = await executeToolCallForTurn(
      new Map(),
      "read_thread",
      { topic: "Lab 4 Deadline Extension" },
      ctx
    );
    assert.equal(threadRead.result.observation.status, "ok");
    const observations: Observation[] = [
      announcementList.result.observation,
      threadRead.result.observation,
    ];

    const question = "Was the Lab 4 deadline extended?";
    const answer =
      "Yes. According to the announcement, the Lab 4 deadline was extended to March 27 at 11:59 PM; the rubric is unchanged.";
    const verification = verifyWorkspaceAnswer({
      question,
      answer,
      observations,
      usedWorkup: false,
      loaded,
    });

    assert.ok(
      verification.sources.length >= 1,
      "a thread read must yield at least one citable source"
    );
    assert.ok(
      verification.sources.some((source) => source.title === "Lab 4 Deadline Extension"),
      `expected a source titled after the thread, got ${JSON.stringify(verification.sources)}`
    );
    assert.equal(verification.confidence, "high");
    assert.equal(verification.ok, true);
    assert.doesNotMatch(verification.note ?? "", /could not confirm/i);
    assert.doesNotMatch(verification.note ?? "", /tentative/i);

    // The evidence-backed regeneration prompt carries the thread text too.
    const evidencePrompt = buildEvidenceBackedQuestion(question, observations);
    assert.match(evidencePrompt, /\[discussion\] Lab 4 Deadline Extension/);
    assert.match(evidencePrompt, /extended to March 27/);
  });
});
