import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import type { Observation, ToolExecutionResult } from "../src/agent/observation.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { decideWorkspaceRetrieval } from "../src/agent/retrieval-gate.js";
import { isGroundedContentObservation } from "../src/agent/observation-relevance.js";
import { appendObservation, createEmptyRunState } from "../src/agent/run-state.js";
import { verifyWorkspaceAnswer } from "../src/agent/verify.js";
import {
  buildEvidenceBackedQuestion,
  buildToolPromptMessages,
  executeToolCallForTurn,
  getAvailableChatToolNames,
  resolveToolTurnVerificationObservations,
  seedTurnToolCacheEntry,
  selectArtifactSupportObservations,
  selectComplementaryRecoveryReadArtifactId,
  selectComplementarySearchToolCalls,
  selectNoInfoRecoveryToolCalls,
  selectRecoveryReadArtifactId,
  selectThreadRecoveryTopic,
  selectUngroundedSearchRecoveryReadArtifactId,
  shouldContinueToolLoopAfterGateRead,
  shouldGroundUnverifiedAnswer,
  shouldRecoverFromNoInfoAnswer,
  shouldRegenerateAnswerAfterRecoveryRead,
  shouldRecoverFromToolLoop,
} from "../src/tui/chat-agent.js";
import { buildSystemPrompt } from "../src/tui/chat-agent/prompt.js";
import { buildChatTools } from "../src/tui/chat-agent/tool-defs.js";
import { createChatContext, hydrateConversationHistory } from "../src/tui/services.js";
import { finalizeAnswerText } from "../src/tui/chat-agent/verification.js";
import {
  readWorkspaceKnowledgeArtifactById,
  searchWorkspaceKnowledge,
} from "../src/tui/workspace-knowledge.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-workspace-chat-grounding-")
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
        overview: "Implement the datapath and explain branch behavior.",
        deliverables: ["Waveform screenshot", "Short analysis"],
        dueDate: "2026-04-10",
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

test("hydrateConversationHistory restores persisted workspace chat observations", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded
    );
    const observation: Observation = {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/reference.txt.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      content: "The waveform must show stall cycles around the branch hazard.",
    };

    hydrateConversationHistory(ctx, [
      { role: "user", content: "Explain the branch hazard section." },
      {
        role: "tool",
        content: "The waveform must show stall cycles around the branch hazard.",
        observation,
      },
      { role: "assistant", content: "It wants you to show the stall cycles." },
    ]);

    assert.deepEqual(ctx.conversationHistory, [
      { role: "user", content: "Explain the branch hazard section." },
      { role: "assistant", content: "It wants you to show the stall cycles." },
    ]);
    assert.equal(ctx.runState.observations.length, 1);
    assert.deepEqual(ctx.runState.readArtifactIds, ["artifact-1"]);
  });
});

test("workspace chat exposes only local-first tools when no Canvas client is available", async () => {
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
        courseId: loaded.courseId,
      }
    );

    assert.deepEqual(getAvailableChatToolNames(ctx), [
      "search_workspace",
      "read_file",
      "list_files",
      "search_course",
      "open_resource",
    ]);
  });
});

test("workspace chat only exposes Canvas downloads when a client is available", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      {
        cache,
        client: {} as any,
        config: {} as any,
        courseId: loaded.courseId,
      }
    );

    assert.deepEqual(getAvailableChatToolNames(ctx), [
      "search_workspace",
      "read_file",
      "list_files",
      "search_course",
      "download_course_file",
      "open_resource",
    ]);
  });
});

test("course-native tools distinguish listings from grounded thread evidence", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const radarItem = {
      kind: "announcement" as const,
      topicId: 88,
      courseId: 17,
      courseName: "ECE243",
      title: "Lab 4 Clarification",
      authorName: "Prof. Ada",
      postedAt: new Date("2026-04-04T09:00:00.000Z"),
      lastReplyAt: new Date("2026-04-04T10:00:00.000Z"),
      unreadCount: 0,
      htmlUrl: "https://canvas.example/courses/17/discussion_topics/88",
      locked: false,
    };
    const radar = {
      getRadarItems: async () => [radarItem],
      getThread: async () => ({
        topic: radarItem,
        body: "Instructor clarification: use signed overflow detection in the ALU explanation.",
        entries: [
          {
            entryId: 1,
            authorName: "Prof. Ada",
            message: "Also include the waveform evidence in your report.",
            createdAt: new Date("2026-04-04T10:00:00.000Z"),
            depth: 0,
          },
        ],
        participantCount: 2,
        totalEntries: 1,
      }),
      resolveTopicByPartialTitle: async () => null,
    };
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
            dueAt: new Date("2026-04-10T23:59:00.000Z"),
            submitted: false,
            status: "upcoming",
            htmlUrl: "https://canvas.example/courses/17/assignments/42",
          },
        ],
        radar: radar as any,
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
      true
    );
    assert.match(assignmentList.result.observation.content ?? "", /Lab 4/);
    assert.equal(
      assignmentList.result.observation.artifacts[0]?.title,
      "Course assignments"
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
      false
    );
    assert.match(
      announcementList.result.observation.content ?? "",
      /Lab 4 Clarification/
    );

    const threadRead = await executeToolCallForTurn(
      new Map(),
      "read_thread",
      { topic: "88" },
      ctx
    );
    assert.equal(threadRead.result.observation.status, "ok");
    assert.equal(isGroundedContentObservation(threadRead.result.observation), true);
    assert.equal(
      threadRead.result.observation.artifacts[0]?.title,
      "Lab 4 Clarification"
    );
    assert.match(
      threadRead.result.observation.content ?? "",
      /signed overflow detection/
    );
    assert.match(threadRead.result.observation.content ?? "", /waveform evidence/);
  });
});

test("workspace retrieval gate prefers workup, then direct reads, then prior memory", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const emptyRunState = {
      observations: [],
      readArtifactIds: [],
      stepCount: 0,
    };

    const fromWorkup = await decideWorkspaceRetrieval({
      question: "What do I need to submit?",
      runState: emptyRunState,
      loaded,
      cache,
    });
    assert.equal(fromWorkup.action, "answer_from_workup");

    const matches = await searchWorkspaceKnowledge(
      loaded,
      cache,
      "branch hazard",
      3
    );
    const directDocumentMatch = matches.find(
      (match) => match.artifact.kind !== "workup"
    );
    assert.ok(directDocumentMatch);

    const fromSearch = await decideWorkspaceRetrieval({
      question: "Explain the branch hazard requirement in detail.",
      runState: emptyRunState,
      loaded,
      cache,
    });
    assert.deepEqual(fromSearch, {
      action: "read_artifact",
      reason: "top_knowledge_match_needs_read",
      artifactId: directDocumentMatch!.artifact.id,
    });

    const readResult = await readWorkspaceKnowledgeArtifactById(
      loaded,
      cache,
      directDocumentMatch!.artifact.id,
      30000
    );
    assert.equal(readResult.status, "ok");
    if (readResult.status !== "ok") {
      return;
    }

    const fromMemory = await decideWorkspaceRetrieval({
      question: "Explain the branch hazard requirement in detail.",
      runState: {
        observations: [
          {
            tool: "read_file",
            status: "ok",
            summary: `Read ${readResult.artifact.title}.`,
            artifacts: [
              {
                artifactId: readResult.artifact.id,
                title: readResult.artifact.title,
                kind: readResult.artifact.kind,
                excerpt: readResult.artifact.excerpt,
              },
            ],
            content: readResult.content,
          },
        ],
        readArtifactIds: [readResult.artifact.id],
        stepCount: 1,
      },
      loaded,
      cache,
    });
    assert.deepEqual(fromMemory, {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: [readResult.artifact.id],
    });
  });
});

test("workspace retrieval gate rereads stale memory when current artifact text changed", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const artifactId = "workspace:extracted:docs/reference.txt";
    const oldContent =
      "The waveform must show stall cycles around the branch hazard.\n";

    await fs.writeFile(
      path.join(loaded.path, "extracted", "docs", "reference.txt"),
      "Updated branch hazard requirement: show two flush cycles after branch resolution.\n",
      "utf-8"
    );
    clearArtifactIndexCache();

    const decision = await decideWorkspaceRetrieval({
      question: "Explain the branch hazard requirement in detail.",
      runState: {
        observations: [
          {
            tool: "read_file",
            status: "ok",
            summary: "Read docs/reference.txt.",
            artifacts: [
              {
                artifactId,
                title: "docs/reference.txt",
                kind: "extracted",
                excerpt: oldContent,
              },
            ],
            content: oldContent,
          },
        ],
        readArtifactIds: [artifactId],
        stepCount: 1,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "read_artifact",
      reason: "top_knowledge_match_needs_read",
      artifactId,
    });
  });
});

test("workspace retrieval gate defers course navigation intents to the tool loop", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const runState = createEmptyRunState();

    for (const question of [
      "Any announcements about the branch hazard?",
      "Which lecture covers branch hazard?",
      "What assignments are due this week?",
    ]) {
      const decision = await decideWorkspaceRetrieval({
        question,
        runState,
        loaded,
        cache,
      });

      assert.deepEqual(decision, {
        action: "let_model_decide",
        reason: "explicit_tool_request",
      });
    }
  });
});

test("workspace retrieval gate prefers an already-read strong match over a higher-ranked unread one", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    await fs.writeFile(
      path.join(loaded.path, "extracted", "docs", "branch-hazard-spec.txt"),
      [
        "Branch hazard requirement specification.",
        "Branch hazard requirement specification.",
        "Branch hazard requirement specification.",
      ].join("\n"),
      "utf-8"
    );
    loaded.extractedFiles.push({
      name: "docs/branch-hazard-spec.txt",
      relativePath: path.join("extracted", "docs", "branch-hazard-spec.txt"),
    });
    clearArtifactIndexCache();

    const matches = await searchWorkspaceKnowledge(
      loaded,
      cache,
      "branch hazard requirement",
      3
    );
    assert.equal(matches[0]?.artifact.title, "docs/branch-hazard-spec.txt");

    const decision = await decideWorkspaceRetrieval({
      question: "Explain the branch hazard requirement in detail.",
      runState: {
        observations: [
          {
            tool: "read_file",
            status: "ok",
            summary: "Read docs/reference.txt.",
            artifacts: [
              {
                artifactId: "workspace:extracted:docs/reference.txt",
                title: "docs/reference.txt",
                kind: "extracted",
                excerpt: "The waveform must show stall cycles around the branch hazard.",
              },
            ],
            content: "The waveform must show stall cycles around the branch hazard.",
          },
        ],
        readArtifactIds: ["workspace:extracted:docs/reference.txt"],
        stepCount: 1,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: ["workspace:extracted:docs/reference.txt"],
    });
  });
});

test("workspace retrieval gate skips a recently failed direct-read artifact and tries the next strong match", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    const addedFiles = [
      {
        name: "docs/branch-hazard-spec.txt",
        body: [
          "Branch hazard requirement specification.",
          "Branch hazard requirement specification.",
          "Branch hazard requirement specification.",
        ].join("\n"),
      },
      {
        name: "docs/branch-hazard-walkthrough.txt",
        body: [
          "Branch hazard requirement walkthrough.",
          "Branch hazard requirement walkthrough.",
        ].join("\n"),
      },
    ];

    for (const file of addedFiles) {
      const relativePath = path.join("extracted", file.name);
      await fs.writeFile(path.join(loaded.path, relativePath), file.body, "utf-8");
      loaded.extractedFiles.push({ name: file.name, relativePath });
    }
    clearArtifactIndexCache();

    const matches = await searchWorkspaceKnowledge(
      loaded,
      cache,
      "branch hazard requirement",
      3
    );
    assert.ok(matches.length >= 2);
    const failedMatch = matches[0]!;
    const nextMatch = matches[1]!;

    const decision = await decideWorkspaceRetrieval({
      question: "Explain the branch hazard requirement in detail.",
      runState: {
        observations: [
          {
            tool: "read_file",
            status: "missing_text",
            summary: `Matched ${failedMatch.artifact.title}, but readable text is missing.`,
            artifacts: [
              {
                artifactId: failedMatch.artifact.id,
                title: failedMatch.artifact.title,
                kind: "extracted",
              },
            ],
          },
        ],
        readArtifactIds: [],
        stepCount: 1,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "read_artifact",
      reason: "top_knowledge_match_needs_read",
      artifactId: nextMatch.artifact.id,
    });
  });
});

test("workspace retrieval gate can promote a course artifact when workspace context is weaker", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
      "Use signed overflow detection when you explain the ALU behavior.\n",
      "utf-8"
    );

    const cache = createCourseCache(coursePath);
    cache.attachments.push({
      sourceType: "assignment_linked",
      canvasFileId: 99,
      originalFilename: "lab4-spec.pdf",
      localPath: "attachments/lab4-spec.pdf",
      contentType: "application/pdf",
      size: 1024,
      downloadUrl: "https://canvas.example/files/99/download",
      reason: "linked from assignment",
      status: "downloaded",
    });

    const matches = await searchWorkspaceKnowledge(
      loaded,
      cache,
      "signed overflow detection",
      3
    );
    assert.equal(matches[0]?.artifact.scope, "course");

    const decision = await decideWorkspaceRetrieval({
      question: "Explain signed overflow detection in detail.",
      runState: {
        observations: [],
        readArtifactIds: [],
        stepCount: 0,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "read_artifact",
      reason: "top_knowledge_match_needs_read",
      artifactId: matches[0]!.artifact.id,
    });
  });
});

test("workspace retrieval gate falls back to grounded memory when all strong workspace matches recently failed", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    const relativePath = path.join("extracted", "docs", "saturating-add-notes.txt");
    await fs.writeFile(
      path.join(loaded.path, relativePath),
      [
        "Saturating add mode requirement notes.",
        "Saturating add mode requirement notes.",
        "Saturating add mode requirement notes.",
      ].join("\n"),
      "utf-8"
    );
    loaded.extractedFiles.push({
      name: "docs/saturating-add-notes.txt",
      relativePath,
    });
    clearArtifactIndexCache();

    const matches = await searchWorkspaceKnowledge(
      loaded,
      cache,
      "saturating add mode requirement",
      3
    );
    assert.ok(matches.length >= 1);
    const failedWorkspaceArtifacts = [
      ...matches.map((match) => ({
        artifactId: match.artifact.id,
        title: match.artifact.title,
        kind: "extracted" as const,
      })),
      {
        artifactId: "workspace:assignment:assignment.md",
        title: "assignment.md",
        kind: "assignment" as const,
      },
      {
        artifactId: "workspace:plan:plan.md",
        title: "plan.md",
        kind: "plan" as const,
      },
      {
        artifactId: "workspace:workup:workup.json",
        title: "workup.json",
        kind: "workup" as const,
      },
      {
        artifactId: "workspace:extracted:docs/reference.txt",
        title: "docs/reference.txt",
        kind: "extracted" as const,
      },
    ];

    const decision = await decideWorkspaceRetrieval({
      question: "What does the saturating add mode requirement say?",
      runState: {
        observations: [
          ...failedWorkspaceArtifacts.map((artifact) => ({
            tool: "read_file" as const,
            status: "missing_text" as const,
            summary: `Matched ${artifact.title}, but readable text is missing.`,
            artifacts: [
              {
                artifactId: artifact.artifactId,
                title: artifact.title,
                kind: artifact.kind,
              },
            ],
          })),
          {
            tool: "download_course_file",
            status: "ok",
            summary: "Downloaded and extracted lab4-brief.txt.",
            artifacts: [
              {
                artifactId:
                  "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
                title: "lab4-brief.txt",
                kind: "attachment",
                excerpt:
                  "The ALU must support saturating add mode and signed overflow detection.",
              },
            ],
            content:
              "The ALU must support saturating add mode and signed overflow detection.",
          },
        ],
        readArtifactIds: [
          "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
        ],
        stepCount: failedWorkspaceArtifacts.length + 1,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: [
        "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
      ],
    });
  });
});

test("workspace retrieval gate reuses multiple already-read strong matches before rereading", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    const addedFiles = [
      {
        name: "docs/branch-hazard-spec.txt",
        body: [
          "Branch hazard requirement specification.",
          "Branch hazard requirement specification.",
          "Branch hazard requirement specification.",
        ].join("\n"),
      },
      {
        name: "docs/branch-hazard-walkthrough.txt",
        body: [
          "Branch hazard requirement walkthrough.",
          "Branch hazard requirement walkthrough.",
        ].join("\n"),
      },
      {
        name: "docs/branch-hazard-summary.txt",
        body: [
          "Branch hazard requirement summary.",
          "Branch hazard requirement summary.",
        ].join("\n"),
      },
    ];

    for (const file of addedFiles) {
      const relativePath = path.join("extracted", file.name);
      await fs.writeFile(path.join(loaded.path, relativePath), file.body, "utf-8");
      loaded.extractedFiles.push({ name: file.name, relativePath });
    }
    clearArtifactIndexCache();

    const matches = await searchWorkspaceKnowledge(
      loaded,
      cache,
      "branch hazard requirement",
      3
    );
    assert.ok(
      matches.some(
        (match) => match.artifact.id === "workspace:extracted:docs/branch-hazard-spec.txt"
      )
    );

    const reusableArtifactIds = [
      "workspace:extracted:docs/branch-hazard-walkthrough.txt",
      "workspace:extracted:docs/branch-hazard-summary.txt",
    ];
    const expectedReusableIds = matches
      .filter((match) => reusableArtifactIds.includes(match.artifact.id))
      .map((match) => match.artifact.id);
    assert.equal(expectedReusableIds.length, 2);
    assert.deepEqual(
      [...expectedReusableIds].sort(),
      [...reusableArtifactIds].sort()
    );

    const decision = await decideWorkspaceRetrieval({
      question: "Explain the branch hazard requirement in detail.",
      runState: {
        observations: [
          {
            tool: "read_file",
            status: "ok",
            summary: "Read docs/branch-hazard-walkthrough.txt.",
            artifacts: [
              {
                artifactId: "workspace:extracted:docs/branch-hazard-walkthrough.txt",
                title: "docs/branch-hazard-walkthrough.txt",
                kind: "extracted",
                excerpt: "Branch hazard requirement walkthrough.",
              },
            ],
            content: "Branch hazard requirement walkthrough.",
          },
          {
            tool: "read_file",
            status: "ok",
            summary: "Read docs/branch-hazard-summary.txt.",
            artifacts: [
              {
                artifactId: "workspace:extracted:docs/branch-hazard-summary.txt",
                title: "docs/branch-hazard-summary.txt",
                kind: "extracted",
                excerpt: "Branch hazard requirement summary.",
              },
            ],
            content: "Branch hazard requirement summary.",
          },
        ],
        readArtifactIds: reusableArtifactIds,
        stepCount: 2,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: expectedReusableIds,
    });
  });
});

test("workspace retrieval gate only trusts explicit workup fields, not generic overlap", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const emptyRunState = {
      observations: [],
      readArtifactIds: [],
      stepCount: 0,
    };

    const fromOverview = await decideWorkspaceRetrieval({
      question: "Give me a summary of what this assignment is about.",
      runState: emptyRunState,
      loaded,
      cache,
    });
    assert.equal(fromOverview.action, "answer_from_workup");

    const fromGenericOverlap = await decideWorkspaceRetrieval({
      question: "Explain branch behavior in detail.",
      runState: emptyRunState,
      loaded,
      cache,
    });
    assert.notEqual(fromGenericOverlap.action, "answer_from_workup");
  });
});

test("workspace retrieval gate does not trust token overlap for due-date questions when workup has no due date", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const emptyRunState = {
      observations: [],
      readArtifactIds: [],
      stepCount: 0,
    };

    loaded.workupJson = {
      overview: "Implement the datapath and explain branch behavior.",
      deliverables: ["Waveform screenshot", "Short analysis"],
    };

    const decision = await decideWorkspaceRetrieval({
      question: "When is it due, and what do I need to submit?",
      runState: emptyRunState,
      loaded,
      cache,
    });

    assert.notEqual(decision.action, "answer_from_workup");
  });
});

test("workspace retrieval gate reuses grounded course-file memory when workspace search has no strong match", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    const decision = await decideWorkspaceRetrieval({
      question: "What does the lab brief say about saturating add mode?",
      runState: {
        observations: [
          {
            tool: "download_course_file",
            status: "ok",
            summary: "Downloaded and extracted lab4-brief.txt.",
            artifacts: [
              {
                artifactId:
                  "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
                title: "lab4-brief.txt",
                kind: "attachment",
                excerpt: "The ALU must support saturating add mode and signed overflow detection.",
              },
            ],
            content:
              "The ALU must support saturating add mode and signed overflow detection.",
          },
        ],
        readArtifactIds: [
          "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
        ],
        stepCount: 1,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: [
        "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
      ],
    });
  });
});

test("workspace retrieval gate reuses remembered search breadcrumbs when no strong workspace match exists", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    const decision = await decideWorkspaceRetrieval({
      question: "What does the lab brief say about saturating add mode?",
      runState: {
        observations: [
          {
            tool: "search_course",
            status: "ok",
            summary: 'Found 1 relevant course match for "saturating add mode".',
            artifacts: [
              {
                artifactId:
                  "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
                title: "lab4-brief.txt",
                kind: "attachment",
                excerpt:
                  "The ALU must support saturating add mode and signed overflow detection.",
              },
            ],
          },
        ],
        readArtifactIds: [],
        stepCount: 1,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "read_artifact",
      reason: "already_discovered_relevant_artifact",
      artifactId:
        "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
    });
  });
});

test("workspace retrieval gate reuses remembered workspace discoveries before re-searching", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    const decision = await decideWorkspaceRetrieval({
      question: "Explain the branch hazard requirement in detail.",
      runState: {
        observations: [
          {
            tool: "search_workspace",
            status: "ok",
            summary: 'Found 1 relevant workspace match for "branch hazard".',
            artifacts: [
              {
                artifactId: "workspace:extracted:docs/reference.txt",
                title: "docs/reference.txt",
                kind: "extracted",
                excerpt:
                  "The branch hazard requirement is to show the stall cycles clearly in the waveform.",
              },
            ],
          },
        ],
        readArtifactIds: [],
        stepCount: 1,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "read_artifact",
      reason: "already_discovered_relevant_artifact",
      artifactId: "workspace:extracted:docs/reference.txt",
    });
  });
});

test("workspace retrieval gate reads a second source for comparison questions before answering from one grounded read", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    const decision = await decideWorkspaceRetrieval({
      question: "Compare the branch hazard walkthrough to the reference.",
      runState: {
        observations: [
          {
            tool: "read_file",
            status: "ok",
            summary: "Read docs/reference.txt.",
            artifacts: [
              {
                artifactId: "artifact-reference",
                title: "docs/reference.txt",
                kind: "extracted",
                excerpt:
                  "The branch hazard requirement is to show the stall cycles clearly in the waveform.",
              },
            ],
            content:
              "The branch hazard requirement is to show the stall cycles clearly in the waveform.",
          },
          {
            tool: "search_workspace",
            status: "ok",
            summary: 'Found 1 relevant workspace match for "branch hazard walkthrough".',
            artifacts: [
              {
                artifactId: "artifact-walkthrough",
                title: "docs/walkthrough.txt",
                kind: "extracted",
                excerpt:
                  "The walkthrough explains each branch hazard stall step-by-step.",
              },
            ],
          },
        ],
        readArtifactIds: ["artifact-reference"],
        stepCount: 2,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "read_artifact",
      reason: "comparison_question_needs_second_source",
      artifactId: "artifact-walkthrough",
    });
  });
});

test("workspace retrieval gate reads a second source for joined evidence topics", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    const decision = await decideWorkspaceRetrieval({
      question: "What are the due date and submission format?",
      runState: {
        observations: [
          {
            tool: "read_file",
            status: "ok",
            summary: "Read assignment.md.",
            artifacts: [
              {
                artifactId: "artifact-due",
                title: "assignment.md",
                kind: "assignment",
                excerpt: "The report is due on April 10 at 11:59 PM.",
                sectionLabel: "Due date",
              },
            ],
            content: "The report is due on April 10 at 11:59 PM.",
          },
          {
            tool: "search_workspace",
            status: "ok",
            summary: "Found 1 workspace match for 'submission format'.",
            artifacts: [
              {
                artifactId: "artifact-submission",
                title: "submission-guidelines.pdf",
                kind: "attachment",
                excerpt: "Submit a single PDF report through Canvas.",
                sectionLabel: "Submission format",
              },
            ],
          },
        ],
        readArtifactIds: ["artifact-due"],
        stepCount: 2,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "read_artifact",
      reason: "comparison_question_needs_second_source",
      artifactId: "artifact-submission",
    });
  });
});

test("workspace retrieval gate prefers grounded memory over later discovered artifacts", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const currentReference =
      "The branch hazard requirement is to show stall cycles around the branch hazard waveform.";
    await fs.writeFile(
      path.join(loaded.path, "extracted", "docs", "reference.txt"),
      `${currentReference}\n`,
      "utf-8"
    );
    clearArtifactIndexCache();

    const decision = await decideWorkspaceRetrieval({
      question: "Explain the branch hazard requirement in detail.",
      runState: {
        observations: [
          {
            tool: "read_file",
            status: "ok",
            summary: "Read docs/reference.txt.",
            artifacts: [
              {
                artifactId: "workspace:extracted:docs/reference.txt",
                title: "docs/reference.txt",
                kind: "extracted",
                excerpt: currentReference,
              },
            ],
            content: currentReference,
          },
          {
            tool: "search_workspace",
            status: "ok",
            summary: 'Found 1 relevant workspace match for "branch hazard".',
            artifacts: [
              {
                artifactId: "workspace:extracted:docs/reference.txt",
                title: "docs/reference.txt",
                kind: "extracted",
                excerpt: currentReference,
              },
              {
                artifactId: "workspace:assignment:assignment.md",
                title: "assignment.md",
                kind: "assignment",
                excerpt: "Explain branch behavior and show the relevant waveform details.",
              },
            ],
          },
        ],
        readArtifactIds: ["workspace:extracted:docs/reference.txt"],
        stepCount: 2,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: ["workspace:extracted:docs/reference.txt"],
    });
  });
});

test("workspace retrieval gate ignores weak remembered course evidence when the question is unrelated", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    const decision = await decideWorkspaceRetrieval({
      question: "What resistor values should I use?",
      runState: {
        observations: [
          {
            tool: "download_course_file",
            status: "ok",
            summary: "Downloaded and extracted lab4-brief.txt.",
            artifacts: [
              {
                artifactId:
                  "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
                title: "lab4-brief.txt",
                kind: "attachment",
                excerpt: "The ALU must support saturating add mode and signed overflow detection.",
              },
            ],
            content:
              "The ALU must support saturating add mode and signed overflow detection.",
          },
        ],
        readArtifactIds: [
          "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
        ],
        stepCount: 1,
      },
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "let_model_decide",
      reason: "weak_knowledge_match",
    });
  });
});

test("workspace answer verification derives sources and confidence deterministically", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);

    const verifiedFromRead = verifyWorkspaceAnswer({
      question: "Explain the branch hazard requirement in detail.",
      answer: "You need to show the stall cycles around the branch hazard.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read docs/reference.txt.",
          artifacts: [
            {
              artifactId: "artifact-1",
              title: "docs/reference.txt",
              kind: "extracted",
              excerpt: "The waveform must show stall cycles around the branch hazard.",
            },
          ],
          content: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromRead.ok, true);
    assert.equal(verifiedFromRead.confidence, "high");
    assert.equal(verifiedFromRead.sources[0]?.title, "docs/reference.txt");
    assert.equal(verifiedFromRead.note, null);

    const verifiedFromDownload = verifyWorkspaceAnswer({
      question: "What does the downloaded brief say about the waveform?",
      answer: "It says to show the stall cycles around the branch hazard.",
      observations: [
        {
          tool: "download_course_file",
          status: "ok",
          summary: "Downloaded and extracted lab4-brief.txt.",
          artifacts: [
            {
              artifactId: "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
              title: "lab4-brief.txt",
              kind: "attachment",
              excerpt: "The waveform must show stall cycles around the branch hazard.",
            },
          ],
          content: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromDownload.ok, true);
    assert.equal(verifiedFromDownload.confidence, "high");
    assert.equal(verifiedFromDownload.sources[0]?.title, "lab4-brief.txt");
    assert.equal(verifiedFromDownload.note, null);

    const verifiedFromWorkup = verifyWorkspaceAnswer({
      question: "What do I need to submit?",
      answer: "You need to submit a waveform screenshot and short analysis.",
      observations: [],
      usedWorkup: true,
      loaded,
    });
    assert.equal(verifiedFromWorkup.ok, true);
    assert.equal(verifiedFromWorkup.confidence, "medium");
    assert.equal(verifiedFromWorkup.sources[0]?.title, "workup.json");
    assert.equal(
      verifiedFromWorkup.note,
      "This answer is based on the pre-loaded workup summary rather than a fresh document read."
    );

    const verifiedFromMissingText = verifyWorkspaceAnswer({
      question: "What does the spec say about the waveform screenshot?",
      answer: "I think the spec might mention a waveform screenshot.",
      observations: [
        {
          tool: "read_file",
          status: "missing_text",
          summary: "Matched lab4-spec.pdf, but the cached extracted text is missing.",
          artifacts: [
            {
              artifactId: "artifact-2",
              title: "lab4-spec.pdf",
              kind: "attachment",
              excerpt: "The specification requires a waveform screenshot and short analysis.",
            },
          ],
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromMissingText.ok, false);
    assert.equal(verifiedFromMissingText.confidence, "low");
    assert.deepEqual(verifiedFromMissingText.sources, []);
    assert.deepEqual(verifiedFromMissingText.missing, ["source"]);
    assert.equal(
      verifiedFromMissingText.note,
      "This answer is tentative because I do not have a reliable, citable source for it yet."
    );

    const verifiedFromActionOnlyTool = verifyWorkspaceAnswer({
      question: "List the files I have available.",
      answer: "I listed the available files for you.",
      observations: [
        {
          tool: "list_files",
          status: "ok",
          summary: "Listed workspace and course files available to chat.",
          artifacts: [],
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromActionOnlyTool.ok, true);
    assert.equal(verifiedFromActionOnlyTool.confidence, "low");
    assert.deepEqual(verifiedFromActionOnlyTool.sources, []);
    assert.deepEqual(verifiedFromActionOnlyTool.missing, []);
    assert.equal(verifiedFromActionOnlyTool.note, null);

    const verifiedFromSearchOnly = verifyWorkspaceAnswer({
      question: "What does the branch hazard section mention?",
      answer: "It mentions the branch hazard section.",
      observations: [
        {
          tool: "search_workspace",
          status: "ok",
          summary: "Found a workspace match for branch hazard.",
          artifacts: [
            {
              artifactId: "artifact-1",
              title: "docs/reference.txt",
              kind: "extracted",
              excerpt: "The waveform must show stall cycles around the branch hazard.",
              sectionLabel: "Branch hazard walkthrough",
            },
          ],
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromSearchOnly.confidence, "medium");
    assert.deepEqual(verifiedFromSearchOnly.sources, [
      {
        title: "docs/reference.txt",
        kind: "extracted",
        section: "Branch hazard walkthrough",
        excerpt: "The waveform must show stall cycles around the branch hazard.",
      },
    ]);
    assert.equal(
      verifiedFromSearchOnly.note,
      "This answer is based on matched search evidence, not a full document read. Use the cited source for exact wording."
    );

    const verifiedFromNoisySearch = verifyWorkspaceAnswer({
      question: "What does the branch hazard section require?",
      answer: "It requires showing stall cycles around the branch hazard.",
      observations: [
        {
          tool: "search_workspace",
          status: "ok",
          summary: "Found workspace matches for branch hazard.",
          artifacts: [
            {
              artifactId: "artifact-branch",
              title: "docs/reference.txt",
              kind: "extracted",
              excerpt: "The waveform must show stall cycles around the branch hazard.",
              sectionLabel: "Branch hazard walkthrough",
            },
            {
              artifactId: "artifact-resistor",
              title: "docs/resistor-table.txt",
              kind: "extracted",
              excerpt: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
              sectionLabel: "Parts list",
            },
          ],
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.deepEqual(verifiedFromNoisySearch.sources, [
      {
        title: "docs/reference.txt",
        kind: "extracted",
        section: "Branch hazard walkthrough",
        excerpt: "The waveform must show stall cycles around the branch hazard.",
      },
    ]);

    const verifiedComparisonFromNoisySearch = verifyWorkspaceAnswer({
      question: "Compare the branch hazard walkthrough to the reference.",
      answer: "The reference says the waveform must show stall cycles.",
      observations: [
        {
          tool: "search_workspace",
          status: "ok",
          summary: "Found workspace matches for branch hazard.",
          artifacts: [
            {
              artifactId: "artifact-reference",
              title: "docs/reference.txt",
              kind: "extracted",
              excerpt: "The waveform must show stall cycles around the branch hazard.",
              sectionLabel: "Reference",
            },
            {
              artifactId: "artifact-resistor",
              title: "docs/resistor-table.txt",
              kind: "extracted",
              excerpt: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
              sectionLabel: "Parts list",
            },
          ],
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedComparisonFromNoisySearch.confidence, "low");
    assert.deepEqual(verifiedComparisonFromNoisySearch.sources, [
      {
        title: "docs/reference.txt",
        kind: "extracted",
        section: "Reference",
        excerpt: "The waveform must show stall cycles around the branch hazard.",
      },
    ]);

    const verifiedFromMultipleSections = verifyWorkspaceAnswer({
      question: "What do the assignment sections say about submission and due date?",
      answer: "Submit a PDF, and the report is due on April 10.",
      observations: [
        {
          tool: "search_workspace",
          status: "ok",
          summary: "Found assignment matches for submission and due date.",
          artifacts: [
            {
              artifactId: "artifact-submission",
              title: "assignment.md",
              kind: "assignment",
              excerpt: "Submit a single PDF report through Canvas.",
              sectionLabel: "Submission format",
            },
            {
              artifactId: "artifact-due",
              title: "assignment.md",
              kind: "assignment",
              excerpt: "The report is due on April 10 at 11:59 PM.",
              sectionLabel: "Due date",
            },
          ],
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.deepEqual(verifiedFromMultipleSections.sources, [
      {
        title: "assignment.md",
        kind: "assignment",
        section: "Submission format",
        excerpt: "Submit a single PDF report through Canvas.",
      },
      {
        title: "assignment.md",
        kind: "assignment",
        section: "Due date",
        excerpt: "The report is due on April 10 at 11:59 PM.",
      },
    ]);

    const verifiedFromAnswerOnlySupportingDetail = verifyWorkspaceAnswer({
      question: "What should I submit?",
      answer: "Submit the PDF report by April 10 at 11:59 PM.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read assignment submission details.",
          artifacts: [
            {
              artifactId: "artifact-submission-read",
              title: "assignment.md",
              kind: "assignment",
              excerpt: "Submit a PDF report through Canvas.",
              sectionLabel: "Submission format",
            },
          ],
          content: "Submit a PDF report through Canvas.",
        },
        {
          tool: "read_file",
          status: "ok",
          summary: "Read assignment due date details.",
          artifacts: [
            {
              artifactId: "artifact-due-read",
              title: "assignment.md",
              kind: "assignment",
              excerpt: "The report is due on April 10 at 11:59 PM.",
              sectionLabel: "Due date",
            },
          ],
          content: "The report is due on April 10 at 11:59 PM.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromAnswerOnlySupportingDetail.ok, true);
    assert.equal(verifiedFromAnswerOnlySupportingDetail.confidence, "high");
    assert.deepEqual(verifiedFromAnswerOnlySupportingDetail.missing, []);
    assert.deepEqual(verifiedFromAnswerOnlySupportingDetail.sources, [
      {
        title: "assignment.md",
        kind: "assignment",
        section: "Submission format",
        excerpt: "Submit a PDF report through Canvas.",
      },
      {
        title: "assignment.md",
        kind: "assignment",
        section: "Due date",
        excerpt: "The report is due on April 10 at 11:59 PM.",
      },
    ]);

    const verifiedFromIsoWorkupDate = verifyWorkspaceAnswer({
      question: "When is the assignment due?",
      answer: "The assignment is due on April 10.",
      observations: [],
      usedWorkup: true,
      loaded,
    });
    assert.equal(verifiedFromIsoWorkupDate.confidence, "medium");
    assert.deepEqual(verifiedFromIsoWorkupDate.missing, []);

    const verifiedFromUnsupportedSpecificDetail = verifyWorkspaceAnswer({
      question: "When is the report due?",
      answer: "The report is due on April 11 at 11:59 PM.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read assignment.md.",
          artifacts: [
            {
              artifactId: "artifact-due",
              title: "assignment.md",
              kind: "assignment",
              excerpt: "The report is due on April 10 at 11:59 PM.",
              sectionLabel: "Due date",
            },
          ],
          content: "The report is due on April 10 at 11:59 PM.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromUnsupportedSpecificDetail.ok, false);
    assert.equal(verifiedFromUnsupportedSpecificDetail.confidence, "low");
    assert.deepEqual(verifiedFromUnsupportedSpecificDetail.missing, ["support"]);
    assert.match(
      verifiedFromUnsupportedSpecificDetail.note ?? "",
      /could not verify.*April 11/i
    );

    const verifiedFromOverstatedApproximateDetail = verifyWorkspaceAnswer({
      question: "What is the late penalty?",
      answer: "Late assignments receive a 10% deduction per day.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read syllabus.txt.",
          artifacts: [
            {
              artifactId: "artifact-late-policy",
              title: "syllabus.txt",
              kind: "syllabus",
              excerpt:
                "Late assignments usually receive a 10% deduction per day.",
              sectionLabel: "Late Policy",
            },
          ],
          content:
            "## Late Policy\nLate assignments usually receive a 10% deduction per day.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromOverstatedApproximateDetail.ok, false);
    assert.equal(verifiedFromOverstatedApproximateDetail.confidence, "low");
    assert.deepEqual(verifiedFromOverstatedApproximateDetail.missing, [
      "support",
    ]);
    assert.match(
      verifiedFromOverstatedApproximateDetail.note ?? "",
      /could not verify.*10%/i
    );

    const verifiedFromPreservedApproximateDetail = verifyWorkspaceAnswer({
      question: "What is the late penalty?",
      answer: "Late assignments usually receive a 10% deduction per day.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read syllabus.txt.",
          artifacts: [
            {
              artifactId: "artifact-late-policy",
              title: "syllabus.txt",
              kind: "syllabus",
              excerpt:
                "Late assignments usually receive a 10% deduction per day.",
              sectionLabel: "Late Policy",
            },
          ],
          content:
            "## Late Policy\nLate assignments usually receive a 10% deduction per day.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromPreservedApproximateDetail.ok, true);
    assert.equal(verifiedFromPreservedApproximateDetail.confidence, "high");
    assert.deepEqual(verifiedFromPreservedApproximateDetail.missing, []);

    const verifiedFromOverstatedOptionalRequirement = verifyWorkspaceAnswer({
      question: "Do I need a cover page?",
      answer: "You must include a cover page.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read assignment.md.",
          artifacts: [
            {
              artifactId: "artifact-submission-options",
              title: "assignment.md",
              kind: "assignment",
              excerpt:
                "A cover page is recommended but optional for the report.",
              sectionLabel: "Submission",
            },
          ],
          content:
            "## Submission\nA cover page is recommended but optional for the report.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromOverstatedOptionalRequirement.ok, false);
    assert.equal(verifiedFromOverstatedOptionalRequirement.confidence, "low");
    assert.deepEqual(verifiedFromOverstatedOptionalRequirement.missing, [
      "support",
    ]);
    assert.match(
      verifiedFromOverstatedOptionalRequirement.note ?? "",
      /could not verify.*cover page/i
    );

    const verifiedFromRequiredRequirement = verifyWorkspaceAnswer({
      question: "Do I need a cover page?",
      answer: "You must include a cover page.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read assignment.md.",
          artifacts: [
            {
              artifactId: "artifact-submission-required",
              title: "assignment.md",
              kind: "assignment",
              excerpt: "A cover page is required for the report.",
              sectionLabel: "Submission",
            },
          ],
          content: "## Submission\nA cover page is required for the report.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromRequiredRequirement.ok, true);
    assert.equal(verifiedFromRequiredRequirement.confidence, "high");
    assert.deepEqual(verifiedFromRequiredRequirement.missing, []);

    const verifiedFromUnsupportedPercentWordDetail = verifyWorkspaceAnswer({
      question: "What is the late penalty?",
      answer: "Late assignments receive a 10 percent deduction per day.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read syllabus.txt.",
          artifacts: [
            {
              artifactId: "artifact-late-policy-word-percent",
              title: "syllabus.txt",
              kind: "syllabus",
              excerpt:
                "Late assignments receive a 15 percent deduction per day.",
              sectionLabel: "Late Policy",
            },
          ],
          content:
            "## Late Policy\nLate assignments receive a 15 percent deduction per day.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromUnsupportedPercentWordDetail.ok, false);
    assert.equal(verifiedFromUnsupportedPercentWordDetail.confidence, "low");
    assert.deepEqual(verifiedFromUnsupportedPercentWordDetail.missing, [
      "support",
    ]);
    assert.match(
      verifiedFromUnsupportedPercentWordDetail.note ?? "",
      /could not verify.*10 percent/i
    );

    const verifiedFromPercentSymbolSupportedByPercentWord = verifyWorkspaceAnswer({
      question: "What is the late penalty?",
      answer: "Late assignments receive a 15% deduction per day.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read syllabus.txt.",
          artifacts: [
            {
              artifactId: "artifact-late-policy-percent-symbol",
              title: "syllabus.txt",
              kind: "syllabus",
              excerpt:
                "Late assignments receive a 15 percent deduction per day.",
              sectionLabel: "Late Policy",
            },
          ],
          content:
            "## Late Policy\nLate assignments receive a 15 percent deduction per day.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromPercentSymbolSupportedByPercentWord.ok, true);
    assert.equal(
      verifiedFromPercentSymbolSupportedByPercentWord.confidence,
      "high"
    );
    assert.deepEqual(
      verifiedFromPercentSymbolSupportedByPercentWord.missing,
      []
    );

    const verifiedCrossAssignmentDateLeak = verifyWorkspaceAnswer({
      question: "When is Lab 4 due?",
      answer: "Lab 4 is due Apr 10 at 11:59 PM.",
      observations: [
        {
          tool: "list_assignments",
          status: "ok",
          summary: "Listed assignments for this course.",
          artifacts: [
            {
              artifactId: "course:assignments:17",
              title: "Course assignments",
              kind: "assignment",
              excerpt:
                "- Lab 3 — 2026-04-10 11:59 PM\n- Lab 4 — 2026-04-11 11:59 PM",
            },
          ],
          content:
            "- Lab 3 — 2026-04-10 11:59 PM\n- Lab 4 — 2026-04-11 11:59 PM",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedCrossAssignmentDateLeak.ok, false);
    assert.equal(verifiedCrossAssignmentDateLeak.confidence, "low");
    assert.deepEqual(verifiedCrossAssignmentDateLeak.missing, ["support"]);
    assert.match(
      verifiedCrossAssignmentDateLeak.note ?? "",
      /could not verify.*Apr 10/i
    );

    const verifiedCorrectAssignmentDate = verifyWorkspaceAnswer({
      question: "When is Lab 4 due?",
      answer: "Lab 4 is due Apr 11 at 11:59 PM.",
      observations: [
        {
          tool: "list_assignments",
          status: "ok",
          summary: "Listed assignments for this course.",
          artifacts: [
            {
              artifactId: "course:assignments:17",
              title: "Course assignments",
              kind: "assignment",
              excerpt:
                "- Lab 3 — 2026-04-10 11:59 PM\n- Lab 4 — 2026-04-11 11:59 PM",
            },
          ],
          content:
            "- Lab 3 — 2026-04-10 11:59 PM\n- Lab 4 — 2026-04-11 11:59 PM",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedCorrectAssignmentDate.ok, true);
    assert.equal(verifiedCorrectAssignmentDate.confidence, "medium");
    assert.deepEqual(verifiedCorrectAssignmentDate.missing, []);

    const verifiedConflictingGroundedDate = verifyWorkspaceAnswer({
      question: "When is Lab 4 due?",
      answer: "Lab 4 is due Apr 10 at 11:59 PM.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read stale notes.",
          artifacts: [
            {
              artifactId: "artifact-stale-lab-4",
              title: "stale-notes.md",
              kind: "notes",
              excerpt: "Lab 4 is due Apr 10 at 11:59 PM.",
              sectionLabel: "Lab 4",
            },
          ],
          content: "Lab 4 is due Apr 10 at 11:59 PM.",
        },
        {
          tool: "read_file",
          status: "ok",
          summary: "Read current assignment page.",
          artifacts: [
            {
              artifactId: "artifact-current-lab-4",
              title: "Lab 4 assignment",
              kind: "assignment",
              excerpt: "Lab 4 is due Apr 11 at 11:59 PM.",
              sectionLabel: "Due date",
            },
          ],
          content: "## Due date\nLab 4 is due Apr 11 at 11:59 PM.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedConflictingGroundedDate.ok, false);
    assert.equal(verifiedConflictingGroundedDate.confidence, "low");
    assert.deepEqual(verifiedConflictingGroundedDate.missing, ["support"]);
    assert.match(
      verifiedConflictingGroundedDate.note ?? "",
      /could not verify.*Apr 10/i
    );

    const verifiedFromMixedEvidence = verifyWorkspaceAnswer({
      question: "Explain the branch hazard requirement in detail.",
      answer: "You need to show the stall cycles around the branch hazard.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read docs/reference.txt.",
          artifacts: [
            {
              artifactId: "artifact-1",
              title: "docs/reference.txt",
              kind: "extracted",
              excerpt: "The waveform must show stall cycles around the branch hazard.",
            },
          ],
          content: "The waveform must show stall cycles around the branch hazard.",
        },
        {
          tool: "search_workspace",
          status: "ok",
          summary: "Found another workspace match for branch behavior.",
          artifacts: [
            {
              artifactId: "artifact-2",
              title: "plan.md",
              kind: "plan",
              excerpt: "Capture the waveform before writing the analysis.",
            },
          ],
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromMixedEvidence.confidence, "high");
    assert.deepEqual(verifiedFromMixedEvidence.sources, [
      {
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt: "The waveform must show stall cycles around the branch hazard.",
      },
    ]);
    assert.equal(verifiedFromMixedEvidence.note, null);

    const verifiedFromMixedGroundedReads = verifyWorkspaceAnswer({
      question: "Explain the branch hazard requirement in detail.",
      answer: "You need to show the stall cycles around the branch hazard.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read docs/reference.txt.",
          artifacts: [
            {
              artifactId: "artifact-1",
              title: "docs/reference.txt",
              kind: "extracted",
              excerpt: "The waveform must show stall cycles around the branch hazard.",
            },
          ],
          content: "The waveform must show stall cycles around the branch hazard.",
        },
        {
          tool: "read_file",
          status: "ok",
          summary: "Read docs/resistor-table.txt.",
          artifacts: [
            {
              artifactId: "artifact-3",
              title: "docs/resistor-table.txt",
              kind: "extracted",
              excerpt: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
            },
          ],
          content: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromMixedGroundedReads.confidence, "high");
    assert.deepEqual(verifiedFromMixedGroundedReads.sources, [
      {
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt: "The waveform must show stall cycles around the branch hazard.",
      },
    ]);

    const verifiedFromIrrelevantGroundedButRelevantSearch = verifyWorkspaceAnswer({
      question: "Explain the branch hazard requirement in detail.",
      answer: "You need to show the stall cycles around the branch hazard.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read docs/resistor-table.txt.",
          artifacts: [
            {
              artifactId: "artifact-3",
              title: "docs/resistor-table.txt",
              kind: "extracted",
              excerpt: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
            },
          ],
          content: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
        },
        {
          tool: "search_workspace",
          status: "ok",
          summary: "Found a workspace match for branch hazard.",
          artifacts: [
            {
              artifactId: "artifact-1",
              title: "docs/reference.txt",
              kind: "extracted",
              excerpt: "The waveform must show stall cycles around the branch hazard.",
            },
          ],
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromIrrelevantGroundedButRelevantSearch.confidence, "medium");
    assert.deepEqual(verifiedFromIrrelevantGroundedButRelevantSearch.sources, [
      {
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt: "The waveform must show stall cycles around the branch hazard.",
      },
    ]);
    assert.equal(
      verifiedFromIrrelevantGroundedButRelevantSearch.note,
      "This answer is based on matched search evidence, not a full document read. Use the cited source for exact wording."
    );

    const verifiedFromUnsupportedWorkup = verifyWorkspaceAnswer({
      question: "Explain the branch hazard requirement in detail.",
      answer: "The workup says to explain branch behavior.",
      observations: [],
      usedWorkup: true,
      loaded,
    });
    assert.equal(verifiedFromUnsupportedWorkup.confidence, "low");
    assert.equal(
      verifiedFromUnsupportedWorkup.note,
      "This answer is tentative because the pre-loaded workup does not explicitly cover this question."
    );

    const verifiedComparisonFromSingleRead = verifyWorkspaceAnswer({
      question: "Compare the branch hazard walkthrough to the reference.",
      answer: "The walkthrough and reference both describe the same stall behavior.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read docs/reference.txt.",
          artifacts: [
            {
              artifactId: "artifact-compare-1",
              title: "docs/reference.txt",
              kind: "extracted",
              excerpt: "The waveform must show stall cycles around the branch hazard.",
            },
          ],
          content: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedComparisonFromSingleRead.confidence, "medium");
    assert.equal(
      verifiedComparisonFromSingleRead.note,
      "This answer may be incomplete because the question compares multiple sources, but I only grounded it in one cited source so far."
    );

    const verifiedComparisonFromTwoReads = verifyWorkspaceAnswer({
      question: "Compare the branch hazard walkthrough to the reference.",
      answer: "Both the walkthrough and the reference describe the same stall behavior, but the walkthrough is more step-by-step.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read docs/reference.txt.",
          artifacts: [
            {
              artifactId: "artifact-compare-1",
              title: "docs/reference.txt",
              kind: "extracted",
              excerpt: "The waveform must show stall cycles around the branch hazard.",
              sectionLabel: "Reference",
            },
          ],
          content: "The waveform must show stall cycles around the branch hazard.",
        },
        {
          tool: "read_file",
          status: "ok",
          summary: "Read docs/walkthrough.txt.",
          artifacts: [
            {
              artifactId: "artifact-compare-2",
              title: "docs/walkthrough.txt",
              kind: "extracted",
              excerpt: "The walkthrough explains each branch hazard stall step-by-step.",
              sectionLabel: "Walkthrough",
            },
          ],
          content: "The walkthrough explains each branch hazard stall step-by-step.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedComparisonFromTwoReads.confidence, "high");
    assert.equal(verifiedComparisonFromTwoReads.note, null);

    const verifiedWithInferredSection = verifyWorkspaceAnswer({
      question: "What is the late submission penalty?",
      answer: "10% per day, up to 5 days.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read syllabus.txt.",
          artifacts: [
            {
              artifactId: "artifact-syllabus",
              title: "syllabus.txt",
              kind: "extracted",
              excerpt: "Course syllabus covering policies and grading.",
            },
          ],
          content: [
            "# Course Syllabus",
            "## Overview",
            "This course covers embedded systems.",
            "## Grading",
            "Assignments: 40%, Labs: 30%, Final: 30%",
            "## Late Submission Policy",
            "Late assignments receive a 10% deduction per day, up to 5 days.",
            "## Academic Integrity",
            "All work must be your own.",
          ].join("\n"),
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedWithInferredSection.confidence, "high");
    assert.equal(verifiedWithInferredSection.sources[0]?.title, "syllabus.txt");
    assert.equal(
      verifiedWithInferredSection.sources[0]?.section,
      "Late Submission Policy"
    );
    assert.equal(
      verifiedWithInferredSection.sources[0]?.excerpt,
      "Late assignments receive a 10% deduction per day, up to 5 days."
    );

    const verifiedWithNestedBodyInferredSection = verifyWorkspaceAnswer({
      question: "What should I do before measuring setup time?",
      answer: "Use 1.2V before measuring setup time.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read lab-spec.txt.",
          artifacts: [
            {
              artifactId: "artifact-lab-spec",
              title: "lab-spec.txt",
              kind: "extracted",
              excerpt: "Lab measurement instructions.",
            },
          ],
          content: [
            "# Lab Spec",
            "General setup guidance.",
            "## Measurements",
            "Confirm the scope is connected.",
            "##### Threshold voltage",
            "Use 1.2V before measuring setup time.",
            "##### Cache policy",
            "Use least-recently-used replacement.",
          ].join("\n"),
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedWithNestedBodyInferredSection.confidence, "high");
    assert.equal(
      verifiedWithNestedBodyInferredSection.sources[0]?.section,
      "Threshold voltage"
    );
    assert.equal(
      verifiedWithNestedBodyInferredSection.sources[0]?.excerpt,
      "Use 1.2V before measuring setup time."
    );

    const verifiedNoHeadingsInContent = verifyWorkspaceAnswer({
      question: "What is the late penalty?",
      answer: "10% per day.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read brief.txt.",
          artifacts: [
            {
              artifactId: "artifact-brief",
              title: "brief.txt",
              kind: "extracted",
              excerpt: "Late penalty is 10% per day.",
            },
          ],
          content: "Late penalty is 10% per day, up to 5 days maximum.",
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedNoHeadingsInContent.confidence, "high");
    assert.equal(verifiedNoHeadingsInContent.sources[0]?.title, "brief.txt");
    assert.equal(verifiedNoHeadingsInContent.sources[0]?.section, undefined);

    const verifiedMultiSectionAnswer = verifyWorkspaceAnswer({
      question: "What is the late penalty and what's the grading breakdown?",
      answer: "Late assignments lose 10% per day. Grading is 40% assignments, 30% labs, 30% final.",
      observations: [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read syllabus.txt.",
          artifacts: [
            {
              artifactId: "artifact-syllabus-multi",
              title: "syllabus.txt",
              kind: "extracted",
              excerpt: "Course syllabus covering policies and grading.",
            },
          ],
          content: [
            "# Course Syllabus",
            "## Overview",
            "This course covers embedded systems programming.",
            "## Grading Breakdown",
            "Assignments: 40%, Labs: 30%, Final: 30%",
            "## Late Submission Policy",
            "Late assignments receive a 10% deduction per day, up to 5 days.",
            "## Academic Integrity",
            "All work must be your own.",
          ].join("\n"),
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedMultiSectionAnswer.confidence, "high");
    assert.ok(
      verifiedMultiSectionAnswer.sources.length >= 2,
      `expected at least 2 section-level sources but got ${verifiedMultiSectionAnswer.sources.length}`
    );
    const sectionLabels = verifiedMultiSectionAnswer.sources.map((s) => s.section);
    assert.ok(
      sectionLabels.includes("Late Submission Policy"),
      `expected 'Late Submission Policy' in sources but got: ${JSON.stringify(sectionLabels)}`
    );
    assert.ok(
      sectionLabels.includes("Grading Breakdown"),
      `expected 'Grading Breakdown' in sources but got: ${JSON.stringify(sectionLabels)}`
    );
    assert.match(
      verifiedMultiSectionAnswer.sources.find(
        (source) => source.section === "Late Submission Policy"
      )?.excerpt ?? "",
      /10% deduction per day/
    );
    assert.match(
      verifiedMultiSectionAnswer.sources.find(
        (source) => source.section === "Grading Breakdown"
      )?.excerpt ?? "",
      /Assignments: 40%, Labs: 30%, Final: 30%/
    );
  });
});

test("final answers surface verifier caveats in the answer text", () => {
  assert.equal(
    finalizeAnswerText("The report is due on April 11.", {
      missing: ["support"],
    }),
    [
      "The report is due on April 11.",
      "",
      "I couldn't verify every specific detail above from the cited evidence, so treat those specifics as tentative.",
    ].join("\n")
  );

  assert.equal(
    finalizeAnswerText("The spec probably says to include a waveform.", {
      missing: ["source"],
    }),
    [
      "The spec probably says to include a waveform.",
      "",
      "I couldn't verify this against a reliable, citable source, so treat it as tentative.",
    ].join("\n")
  );

  assert.equal(
    finalizeAnswerText("I don't see that due date in the materials I have.", {
      missing: ["support"],
    }),
    "I don't see that due date in the materials I have."
  );

  assert.equal(
    finalizeAnswerText("", {
      missing: ["answer"],
    }),
    "I wasn't able to find a clear answer."
  );
});

test("memory prompts prefer grounded reads over later search echoes", () => {
  const prompt = buildEvidenceBackedQuestion("Explain the branch hazard requirement.", [
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/reference.txt.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      content: "The waveform must show stall cycles around the branch hazard.",
    },
    {
      tool: "search_workspace",
      status: "ok",
      summary: "Found a workspace match for branch hazard.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
    },
    {
      tool: "search_workspace",
      status: "ok",
      summary: "Found another workspace match for branch hazard.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
    },
    {
      tool: "search_workspace",
      status: "ok",
      summary: "Found the latest workspace match for branch hazard.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
    },
  ]);

  assert.match(
    prompt,
    /The waveform must show stall cycles around the branch hazard\./
  );
  assert.equal((prompt.match(/- Tool:/g) ?? []).length, 1);
  assert.doesNotMatch(prompt, /Found the latest workspace match for branch hazard/);
});

test("memory prompts prefer question-relevant evidence over newer unrelated reads", () => {
  const prompt = buildEvidenceBackedQuestion("Explain the branch hazard requirement.", [
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/reference.txt.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      content: "The waveform must show stall cycles around the branch hazard.",
    },
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/resistor-table.txt.",
      artifacts: [
        {
          artifactId: "artifact-2",
          title: "docs/resistor-table.txt",
          kind: "extracted",
          excerpt: "Use a 4.7k resistor for the LED path.",
        },
      ],
      content: "Use a 4.7k resistor for the LED path.",
    },
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/schedule.txt.",
      artifacts: [
        {
          artifactId: "artifact-3",
          title: "docs/schedule.txt",
          kind: "extracted",
          excerpt: "Demo day starts at 2pm on Friday.",
        },
      ],
      content: "Demo day starts at 2pm on Friday.",
    },
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/bonus.txt.",
      artifacts: [
        {
          artifactId: "artifact-4",
          title: "docs/bonus.txt",
          kind: "extracted",
          excerpt: "Bonus marks come from the optimization section.",
        },
      ],
      content: "Bonus marks come from the optimization section.",
    },
  ]);

  assert.match(prompt, /docs\/reference\.txt/);
  assert.doesNotMatch(prompt, /docs\/bonus\.txt/);
  assert.doesNotMatch(prompt, /4\.7k resistor/);
});

test("memory prompts exclude failed lookups when successful evidence exists", () => {
  const prompt = buildEvidenceBackedQuestion("What does the lab brief say about saturating add mode?", [
    {
      tool: "search_course",
      status: "ok",
      summary: "Found a course document mentioning saturating add mode.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "lab4-brief.txt",
          kind: "attachment",
          excerpt: "The ALU must support saturating add mode and signed overflow detection.",
        },
      ],
    },
    {
      tool: "read_file",
      status: "missing_text",
      summary: "Matched docs/missing.txt, but readable text is missing.",
      artifacts: [
        {
          artifactId: "artifact-2",
          title: "docs/missing.txt",
          kind: "extracted",
        },
      ],
    },
  ]);

  assert.match(prompt, /lab4-brief\.txt/);
  assert.match(prompt, /saturating add mode/i);
  assert.doesNotMatch(prompt, /docs\/missing\.txt/);
  assert.doesNotMatch(prompt, /readable text is missing/i);
});

test("memory prompts fall back to the raw question when no successful evidence exists", () => {
  const prompt = buildEvidenceBackedQuestion("What does the lab brief say about saturating add mode?", [
    {
      tool: "read_file",
      status: "missing_text",
      summary: "Matched lab4-brief.txt, but readable text is missing.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "lab4-brief.txt",
          kind: "attachment",
        },
      ],
    },
  ]);

  assert.equal(
    prompt,
    "What does the lab brief say about saturating add mode?"
  );
});

test("memory prompts prefer relevant search evidence over irrelevant grounded reads", () => {
  const prompt = buildEvidenceBackedQuestion(
    "Explain the branch hazard requirement in detail.",
    [
      {
        tool: "read_file",
        status: "ok",
        summary: "Read docs/resistor-table.txt.",
        artifacts: [
          {
            artifactId: "artifact-3",
            title: "docs/resistor-table.txt",
            kind: "extracted",
            excerpt: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
          },
        ],
        content: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
      },
      {
        tool: "search_workspace",
        status: "ok",
        summary: "Found a workspace match for branch hazard.",
        artifacts: [
          {
            artifactId: "artifact-1",
            title: "docs/reference.txt",
            kind: "extracted",
            excerpt: "The waveform must show stall cycles around the branch hazard.",
          },
        ],
      },
    ]
  );

  assert.match(prompt, /docs\/reference\.txt/);
  assert.match(prompt, /branch hazard/i);
  assert.doesNotMatch(prompt, /docs\/resistor-table\.txt/);
  assert.doesNotMatch(prompt, /220 ohm/i);
});

test("memory prompts preserve source sections and excerpts for final-answer grounding", () => {
  const prompt = buildEvidenceBackedQuestion("What does the submission section require?", [
    {
      tool: "search_workspace",
      status: "ok",
      summary: "Found a workspace match for submission requirements.",
      artifacts: [
        {
          artifactId: "artifact-submission",
          title: "assignment.md",
          kind: "assignment",
          sectionLabel: "Submission format",
          excerpt: "Submit a single PDF report through Canvas.",
        },
      ],
    },
  ]);

  assert.match(prompt, /Source: \[assignment\] assignment\.md — Submission format/);
  assert.match(prompt, /Excerpt: Submit a single PDF report through Canvas\./);
});

test("tool-turn verification falls back to prior grounded evidence when no new tools run", () => {
  const observations: Observation[] = [
    {
      tool: "download_course_file",
      status: "ok",
      summary: "Downloaded and extracted lab4-brief.txt.",
      artifacts: [
        {
          artifactId: "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
          title: "lab4-brief.txt",
          kind: "attachment",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      content: "The waveform must show stall cycles around the branch hazard.",
    },
    {
      tool: "search_workspace",
      status: "ok",
      summary: "Found a workspace match for branch hazard.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
    },
  ];

  const fallback = resolveToolTurnVerificationObservations(
    observations,
    observations.length
  );
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0]?.tool, "download_course_file");

  const mixedTurn = resolveToolTurnVerificationObservations(observations, 1);
  assert.equal(mixedTurn.length, 2);
  assert.equal(mixedTurn[0]?.tool, "download_course_file");
  assert.equal(mixedTurn[1]?.tool, "search_workspace");
});

test("tool-turn verification fallback keeps only question-relevant prior evidence", () => {
  const observations: Observation[] = [
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/reference.txt.",
      artifacts: [
        {
          artifactId: "artifact-branch",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      content: "The waveform must show stall cycles around the branch hazard.",
    },
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/resistor-table.txt.",
      artifacts: [
        {
          artifactId: "artifact-resistors",
          title: "docs/resistor-table.txt",
          kind: "extracted",
          excerpt: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
        },
      ],
      content: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
    },
    {
      tool: "search_workspace",
      status: "ok",
      summary: "Found a workspace match for branch hazard.",
      artifacts: [
        {
          artifactId: "artifact-branch",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
    },
  ];

  const fallback = resolveToolTurnVerificationObservations(
    observations,
    2,
    "Explain the branch hazard requirement in detail."
  );
  assert.equal(fallback.length, 2);
  assert.equal(fallback[0]?.summary, "Read docs/reference.txt.");
  assert.equal(fallback[1]?.summary, "Found a workspace match for branch hazard.");
});

test("tool-turn verification keeps current-turn evidence only when the turn already read grounded content", () => {
  const observations: Observation[] = [
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/reference.txt.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "Older grounded detail.",
        },
      ],
      content: "Older grounded detail.",
    },
    {
      tool: "download_course_file",
      status: "ok",
      summary: "Downloaded and extracted lab4-brief.txt.",
      artifacts: [
        {
          artifactId: "artifact-2",
          title: "lab4-brief.txt",
          kind: "attachment",
          excerpt: "Fresh grounded detail.",
        },
      ],
      content: "Fresh grounded detail.",
    },
  ];

  const currentTurn = resolveToolTurnVerificationObservations(observations, 1);
  assert.equal(currentTurn.length, 1);
  assert.equal(currentTurn[0]?.tool, "download_course_file");
});

test("tool-turn verification keeps prior relevant grounding when current-turn grounded reads are irrelevant", () => {
  const observations: Observation[] = [
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/reference.txt.",
      artifacts: [
        {
          artifactId: "artifact-branch",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      content: "The waveform must show stall cycles around the branch hazard.",
    },
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/resistor-table.txt.",
      artifacts: [
        {
          artifactId: "artifact-resistors",
          title: "docs/resistor-table.txt",
          kind: "extracted",
          excerpt: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
        },
      ],
      content: "Use 220 ohm and 1k ohm resistors in the LED test harness.",
    },
    {
      tool: "search_workspace",
      status: "ok",
      summary: "Found a workspace match for branch hazard.",
      artifacts: [
        {
          artifactId: "artifact-branch",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
    },
  ];

  const fallback = resolveToolTurnVerificationObservations(
    observations,
    1,
    "Explain the branch hazard requirement in detail."
  );
  assert.equal(fallback.length, 3);
  assert.equal(fallback[0]?.summary, "Read docs/reference.txt.");
  assert.equal(fallback[1]?.summary, "Read docs/resistor-table.txt.");
  assert.equal(fallback[2]?.summary, "Found a workspace match for branch hazard.");
});

test("tool-loop recovery only triggers when the loop produced no answer but gathered usable evidence", () => {
  assert.equal(
    shouldRecoverFromToolLoop("", [
      {
        tool: "search_workspace",
        status: "ok",
        summary: "Found a workspace match.",
        artifacts: [
          {
            artifactId: "artifact-1",
            title: "docs/reference.txt",
            kind: "extracted",
            excerpt: "Grounded detail.",
          },
        ],
      },
    ]),
    true
  );

  assert.equal(
    shouldRecoverFromToolLoop("Here is the answer.", [
      {
        tool: "read_file",
        status: "ok",
        summary: "Read docs/reference.txt.",
        artifacts: [
          {
            artifactId: "artifact-1",
            title: "docs/reference.txt",
            kind: "extracted",
            excerpt: "Grounded detail.",
          },
        ],
        content: "Grounded detail.",
      },
    ]),
    false
  );

  assert.equal(
    shouldRecoverFromToolLoop("", [
      {
        tool: "list_files",
        status: "ok",
        summary: "Listed workspace and course files available to chat.",
        artifacts: [],
      },
    ]),
    false
  );

  assert.equal(
    shouldRecoverFromToolLoop("", [
      {
        tool: "read_file",
        status: "missing_text",
        summary: "Matched lab4-brief.txt, but readable text is missing.",
        artifacts: [
          {
            artifactId: "artifact-2",
            title: "lab4-brief.txt",
            kind: "attachment",
          },
        ],
      },
    ]),
    false
  );

  assert.equal(
    shouldRecoverFromToolLoop("", [
      {
        tool: "download_course_file",
        status: "ok",
        summary: "Downloaded and extracted lab4-brief.txt.",
        artifacts: [
          {
            artifactId: "artifact-3",
            title: "lab4-brief.txt",
            kind: "attachment",
            excerpt: "Grounded detail.",
          },
        ],
        content: "Grounded detail.",
      },
      {
        tool: "read_file",
        status: "missing_text",
        summary: "Matched docs/missing.txt, but readable text is missing.",
        artifacts: [
          {
            artifactId: "artifact-4",
            title: "docs/missing.txt",
            kind: "extracted",
          },
        ],
      },
    ]),
    true
  );
});

test("tool-loop recovery forces untried tools after no-info answers", () => {
  assert.equal(
    shouldRecoverFromNoInfoAnswer("I don't have that information.", []),
    true
  );

  assert.equal(
    shouldRecoverFromNoInfoAnswer("I don't have that information.", [
      {
        tool: "read_file",
        status: "ok",
        summary: "Read lab4.txt.",
        artifacts: [
          {
            artifactId: "artifact-lab4",
            title: "lab4.txt",
            kind: "attachment",
            excerpt: "Lab 4 is due Apr 11.",
          },
        ],
        content: "Lab 4 is due Apr 11.",
      },
    ]),
    true
  );

  assert.deepEqual(
    selectNoInfoRecoveryToolCalls(
      "When is Lab 4 due?",
      ["list_assignments", "search_workspace", "search_course"],
      [
        {
          tool: "read_file",
          status: "ok",
          summary: "Read lab4-spec.txt.",
          artifacts: [
            {
              artifactId: "artifact-lab4-spec",
              title: "lab4-spec.txt",
              kind: "attachment",
              excerpt: "Lab 4 setup instructions.",
            },
          ],
          content: "Lab 4 setup instructions. No due date is listed here.",
        },
      ]
    ).slice(0, 2),
    [
      { name: "list_assignments", input: {} },
      { name: "search_workspace", input: { query: "lab 4 due" } },
    ]
  );

  assert.deepEqual(
    selectNoInfoRecoveryToolCalls(
      "When is Lab 4 due?",
      ["list_assignments", "search_workspace", "search_course"],
      []
    ).slice(0, 2),
    [
      { name: "list_assignments", input: {} },
      { name: "search_workspace", input: { query: "lab 4 due" } },
    ]
  );

  assert.deepEqual(
    selectNoInfoRecoveryToolCalls(
      "What did the prof say about extensions?",
      ["list_announcements", "read_thread", "search_workspace", "search_course"],
      []
    ).slice(0, 2),
    [
      {
        name: "list_announcements",
        input: { filter: "all", query: "extensions" },
      },
      { name: "search_workspace", input: { query: "extensions" } },
    ]
  );

  assert.deepEqual(
    selectNoInfoRecoveryToolCalls(
      "What format should I submit in?",
      ["search_workspace", "search_course", "list_files"],
      [
        {
          tool: "search_workspace",
          status: "not_found",
          summary: 'No relevant workspace content found for "format submit".',
          artifacts: [],
        },
      ]
    ),
    [{ name: "search_course", input: { query: "format submit" } }]
  );

  assert.deepEqual(
    selectNoInfoRecoveryToolCalls(
      "What did the prof say about extensions?",
      ["list_announcements", "search_workspace", "search_course"],
      [
        {
          tool: "list_announcements",
          status: "ok",
          summary: 'Listed 0 announcements matching "extensions".',
          artifacts: [
            {
              artifactId: "course:radar:17:all:extensions",
              title: "Course announcements and discussions: extensions",
              kind: "announcement",
              excerpt: 'No recent announcements & discussions matching "extensions".',
            },
          ],
          content: 'No recent announcements & discussions matching "extensions".',
        },
      ]
    ),
    [
      { name: "search_workspace", input: { query: "extensions" } },
      { name: "search_course", input: { query: "extensions" } },
    ]
  );
});

test("tool-loop recovery prefers reading a discovered artifact and skips prior failed reads", () => {
  const briefBreadcrumb: Observation = {
    tool: "search_course",
    status: "ok",
    summary: 'Found 1 relevant course match for "saturating add mode".',
    artifacts: [
      {
        artifactId: "artifact-brief",
        title: "lab4-brief.txt",
        kind: "attachment",
        excerpt: "The ALU must support saturating add mode and signed overflow detection.",
      },
    ],
  };
  const notesBreadcrumb: Observation = {
    tool: "search_workspace",
    status: "ok",
    summary: 'Found 1 relevant workspace match for "saturating add mode".',
    artifacts: [
      {
        artifactId: "artifact-notes",
        title: "docs/saturating-add-notes.txt",
        kind: "extracted",
        excerpt: "Saturating add mode notes and signed overflow detection details.",
      },
    ],
  };

  assert.equal(
    selectRecoveryReadArtifactId(
      "What does the lab brief say about saturating add mode?",
      [briefBreadcrumb]
    ),
    "artifact-brief"
  );

  assert.equal(
    selectRecoveryReadArtifactId(
      "What does the lab brief say about saturating add mode?",
      [briefBreadcrumb, notesBreadcrumb],
      [
        briefBreadcrumb,
        notesBreadcrumb,
        {
          tool: "read_file",
          status: "missing_text",
          summary: "Matched lab4-brief.txt, but readable text is missing.",
          artifacts: [
            {
              artifactId: "artifact-brief",
              title: "lab4-brief.txt",
              kind: "attachment",
            },
          ],
        },
      ]
    ),
    "artifact-notes"
  );

  assert.equal(
    selectRecoveryReadArtifactId(
      "What does the lab brief say about saturating add mode?",
      [briefBreadcrumb, notesBreadcrumb],
      [
        briefBreadcrumb,
        notesBreadcrumb,
        {
          tool: "read_file",
          status: "missing_text",
          summary: "Matched lab4-brief.txt, but readable text is missing.",
          artifacts: [
            {
              artifactId: "artifact-brief",
              title: "lab4-brief.txt",
              kind: "attachment",
            },
          ],
        },
        {
          tool: "read_file",
          status: "missing_text",
          summary: "Matched docs/saturating-add-notes.txt, but readable text is missing.",
          artifacts: [
            {
              artifactId: "artifact-notes",
              title: "docs/saturating-add-notes.txt",
              kind: "extracted",
            },
          ],
        },
      ]
    ),
    null
  );

  assert.equal(
    selectRecoveryReadArtifactId(
      "What does the lab brief say about saturating add mode?",
      [
        {
          tool: "download_course_file",
          status: "ok",
          summary: "Downloaded and extracted lab4-brief.txt.",
          artifacts: [
            {
              artifactId: "artifact-brief",
              title: "lab4-brief.txt",
              kind: "attachment",
              excerpt:
                "The ALU must support saturating add mode and signed overflow detection.",
            },
          ],
          content:
            "The ALU must support saturating add mode and signed overflow detection.",
        },
        notesBreadcrumb,
      ]
    ),
    null
  );
});

test("tool-loop recovery selects a complementary source for comparison questions", () => {
  const referenceRead: Observation = {
    tool: "read_file",
    status: "ok",
    summary: "Read docs/reference.txt.",
    artifacts: [
      {
        artifactId: "artifact-reference",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt:
          "The reference says the waveform must show stall cycles around the branch hazard.",
      },
    ],
    content:
      "The reference says the waveform must show stall cycles around the branch hazard.",
  };
  const comparisonBreadcrumb: Observation = {
    tool: "search_workspace",
    status: "ok",
    summary:
      'Found 2 relevant workspace matches for "branch hazard walkthrough reference".',
    artifacts: [
      {
        artifactId: "artifact-reference",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt:
          "The reference says the waveform must show stall cycles around the branch hazard.",
      },
      {
        artifactId: "artifact-walkthrough",
        title: "docs/walkthrough.txt",
        kind: "extracted",
        excerpt:
          "The walkthrough explains each branch hazard stall step by step.",
      },
    ],
  };
  const walkthroughRead: Observation = {
    tool: "read_file",
    status: "ok",
    summary: "Read docs/walkthrough.txt.",
    artifacts: [
      {
        artifactId: "artifact-walkthrough",
        title: "docs/walkthrough.txt",
        kind: "extracted",
        excerpt:
          "The walkthrough explains each branch hazard stall step by step.",
      },
    ],
    content:
      "The walkthrough explains each branch hazard stall step by step.",
  };

  assert.equal(
    selectComplementaryRecoveryReadArtifactId(
      "Compare the branch hazard walkthrough to the reference.",
      [referenceRead, comparisonBreadcrumb]
    ),
    "artifact-walkthrough"
  );

  assert.equal(
    selectComplementaryRecoveryReadArtifactId(
      "Explain the branch hazard reference.",
      [referenceRead, comparisonBreadcrumb]
    ),
    null
  );

  assert.equal(
    selectComplementaryRecoveryReadArtifactId(
      "Compare the branch hazard walkthrough to the reference.",
      [referenceRead, comparisonBreadcrumb, walkthroughRead]
    ),
    null
  );

  assert.equal(
    selectComplementaryRecoveryReadArtifactId(
      "Compare the branch hazard walkthrough to the reference.",
      [referenceRead, comparisonBreadcrumb],
      [
        referenceRead,
        comparisonBreadcrumb,
        {
          tool: "read_file",
          status: "missing_text",
          summary: "Matched docs/walkthrough.txt, but readable text is missing.",
          artifacts: [
            {
              artifactId: "artifact-walkthrough",
              title: "docs/walkthrough.txt",
              kind: "extracted",
            },
          ],
        },
      ]
    ),
    null
  );
});

test("tool-loop recovery searches for a second source when a multi-source question only has one read", () => {
  const referenceRead: Observation = {
    tool: "read_file",
    status: "ok",
    summary: "Read docs/reference.txt.",
    artifacts: [
      {
        artifactId: "artifact-reference",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt:
          "The reference says the waveform must show stall cycles around the branch hazard.",
      },
    ],
    content:
      "The reference says the waveform must show stall cycles around the branch hazard.",
  };
  const comparisonBreadcrumb: Observation = {
    tool: "search_workspace",
    status: "ok",
    summary:
      'Found 2 relevant workspace matches for "branch hazard walkthrough reference".',
    artifacts: [
      {
        artifactId: "artifact-reference",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt:
          "The reference says the waveform must show stall cycles around the branch hazard.",
      },
      {
        artifactId: "artifact-walkthrough",
        title: "docs/walkthrough.txt",
        kind: "extracted",
        excerpt:
          "The walkthrough explains each branch hazard stall step by step.",
      },
    ],
  };

  const followUpSearches = selectComplementarySearchToolCalls(
    "Compare the branch hazard walkthrough to the reference.",
    ["search_workspace", "search_course", "read_file"],
    [referenceRead]
  );

  assert.deepEqual(
    followUpSearches.map((call) => call.name),
    ["search_workspace", "search_course"]
  );
  assert.equal(
    followUpSearches[0]?.input.query,
    "branch hazard walkthrough reference"
  );

  assert.deepEqual(
    selectComplementarySearchToolCalls(
      "Compare the branch hazard walkthrough to the reference.",
      ["search_workspace", "search_course", "read_file"],
      [referenceRead, comparisonBreadcrumb]
    ),
    []
  );

  assert.deepEqual(
    selectComplementarySearchToolCalls(
      "Explain the branch hazard reference.",
      ["search_workspace", "search_course", "read_file"],
      [referenceRead]
    ),
    []
  );
});

test("tool-loop recovery searches after one read for broad prep questions", () => {
  const overviewRead: Observation = {
    tool: "read_file",
    status: "ok",
    summary: "Read lab4-overview.txt.",
    artifacts: [
      {
        artifactId: "artifact-overview",
        title: "lab4-overview.txt",
        kind: "extracted",
        excerpt:
          "The lab overview says to build and test the cache controller.",
      },
    ],
    content: "The lab overview says to build and test the cache controller.",
  };

  const followUpSearches = selectComplementarySearchToolCalls(
    "What should I review before the lab?",
    ["search_workspace", "search_course", "read_file"],
    [overviewRead]
  );

  assert.deepEqual(
    followUpSearches.map((call) => call.name),
    ["search_workspace", "search_course"]
  );
  assert.equal(followUpSearches[0]?.input.query, "review before lab");

  assert.deepEqual(
    selectComplementarySearchToolCalls(
      "What should I submit for the lab?",
      ["search_workspace", "search_course", "read_file"],
      [overviewRead]
    ),
    []
  );
});

test("failed gate reads fall back to the normal tool loop, and comparison questions keep going until a second source is grounded", () => {
  assert.equal(
    shouldContinueToolLoopAfterGateRead(
      "Explain the branch hazard requirement in detail.",
      {
        tool: "read_file",
        status: "missing_text",
        summary: "Matched lab4-brief.txt, but readable text is missing.",
        artifacts: [
          {
            artifactId: "artifact-1",
            title: "lab4-brief.txt",
            kind: "attachment",
          },
        ],
      }
    ),
    true
  );

  assert.equal(
    shouldContinueToolLoopAfterGateRead(
      "Explain the branch hazard requirement in detail.",
      {
        tool: "read_file",
        status: "ok",
        summary: "Read docs/reference.txt.",
        artifacts: [
          {
            artifactId: "artifact-2",
            title: "docs/reference.txt",
            kind: "extracted",
            excerpt: "Grounded detail.",
          },
        ],
        content: "Grounded detail.",
      }
    ),
    false
  );

  const firstComparisonRead: Observation = {
    tool: "read_file",
    status: "ok",
    summary: "Read docs/reference.txt.",
    artifacts: [
      {
        artifactId: "artifact-reference",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt: "The branch hazard reference shows the required stall cycles.",
      },
    ],
    content: "The branch hazard reference shows the required stall cycles.",
  };
  assert.equal(
    shouldContinueToolLoopAfterGateRead(
      "Compare the branch hazard walkthrough to the reference.",
      firstComparisonRead,
      [firstComparisonRead]
    ),
    true
  );

  const secondComparisonRead: Observation = {
    tool: "read_file",
    status: "ok",
    summary: "Read docs/walkthrough.txt.",
    artifacts: [
      {
        artifactId: "artifact-walkthrough",
        title: "docs/walkthrough.txt",
        kind: "extracted",
        excerpt: "The branch hazard walkthrough explains each stall step in order.",
      },
    ],
    content: "The branch hazard walkthrough explains each stall step in order.",
  };
  assert.equal(
    shouldContinueToolLoopAfterGateRead(
      "Compare the branch hazard walkthrough to the reference.",
      secondComparisonRead,
      [firstComparisonRead, secondComparisonRead]
    ),
    false
  );
});

test("memory evidence selection prefers grounded reads over later search echoes for the same artifact", () => {
  const observations: Observation[] = [
    {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/reference.txt.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "Grounded detail.",
        },
      ],
      content: "Grounded detail.",
    },
    {
      tool: "search_workspace",
      status: "ok",
      summary: "Found a workspace match for branch hazard.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "Grounded detail.",
        },
      ],
    },
    {
      tool: "search_workspace",
      status: "ok",
      summary: "Found another workspace match for branch hazard.",
      artifacts: [
        {
          artifactId: "artifact-1",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "Grounded detail.",
        },
      ],
    },
  ];

  const selected = selectArtifactSupportObservations(observations, ["artifact-1"]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.tool, "read_file");
  assert.match(selected[0]?.content ?? "", /Grounded detail/);
});

test("tool memory treats announcement listings as thread-read breadcrumbs", () => {
  const messages = buildToolPromptMessages(
    [],
    "What did the Lab 4 clarification announcement say about branch hazards?",
    {
      observations: [
        {
          tool: "list_announcements",
          status: "ok",
          summary: 'Listed 1 announcement matching "Lab 4".',
          artifacts: [
            {
              artifactId: "course:radar:17:announcements:lab-4",
              title: "Course announcements",
              kind: "announcement",
              excerpt: "Lab 4 Clarification",
            },
          ],
          content: [
            "**Announcements** (1 item)",
            "",
            "[A] Lab 4 Clarification — Prof. Ada — ECE243 — 1d ago",
          ].join("\n"),
        },
      ],
      readArtifactIds: [],
      stepCount: 1,
    }
  );

  const prompt = messages.at(-1)?.content ?? "";
  assert.match(prompt, /list_announcements only lists candidate topics/i);
  assert.match(prompt, /Call read_thread with "Lab 4 Clarification"/i);
  assert.doesNotMatch(prompt, /Evidence checkpoint: you have grounded text/i);
});

test("tool-loop recovery selects a thread read after announcement discovery", () => {
  const listObservation: Observation = {
    tool: "list_announcements",
    status: "ok",
    summary: 'Listed 2 announcements matching "Lab 4".',
    artifacts: [
      {
        artifactId: "course:radar:17:announcements:lab-4",
        title: "Course announcements",
        kind: "announcement",
        excerpt: "Lab 4 Clarification",
      },
    ],
    content: [
      "**Announcements** (2 items)",
      "",
      "[A] General Lab Update — Prof. Ada — ECE243 — 2d ago",
      "[A] Lab 4 Clarification — Prof. Ada — ECE243 — 1d ago",
    ].join("\n"),
  };

  assert.equal(
    selectThreadRecoveryTopic(
      "What did the Lab 4 clarification announcement say about branch hazards?",
      [listObservation]
    ),
    "Lab 4 Clarification"
  );

  assert.equal(
    selectThreadRecoveryTopic("Are there any Lab 4 announcements?", [
      listObservation,
    ]),
    null
  );

  assert.equal(
    selectThreadRecoveryTopic(
      "What did the Lab 4 clarification announcement say about branch hazards?",
      [
        listObservation,
        {
          tool: "read_thread",
          status: "ok",
          summary: 'Read discussion thread "Lab 4 Clarification".',
          artifacts: [
            {
              artifactId: "course:thread:17:lab-4-clarification",
              title: "Lab 4 Clarification",
              kind: "discussion",
              excerpt: "Use signed overflow detection.",
            },
          ],
          content: "Use signed overflow detection.",
        },
      ]
    ),
    null
  );
});

test("workspace chat dedupes repeated tool calls within a single turn", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );
    const turnToolCache = new Map();

    const firstSearch = await executeToolCallForTurn(
      turnToolCache,
      "search_workspace",
      { query: "branch hazard" },
      ctx
    );
    const secondSearch = await executeToolCallForTurn(
      turnToolCache,
      "search_workspace",
      { query: "  BRANCH   HAZARD " },
      ctx
    );

    assert.equal(firstSearch.deduped, false);
    assert.equal(secondSearch.deduped, true);
    assert.equal(secondSearch.result.modelText, firstSearch.result.modelText);

    const reorderedSearch = await executeToolCallForTurn(
      turnToolCache,
      "search_workspace",
      { query: "hazard branch" },
      ctx
    );

    assert.equal(reorderedSearch.deduped, true);
    assert.equal(reorderedSearch.result.modelText, firstSearch.result.modelText);

    const firstRead = await executeToolCallForTurn(
      turnToolCache,
      "read_file",
      { filename: "docs/reference.txt" },
      ctx
    );
    const secondRead = await executeToolCallForTurn(
      turnToolCache,
      "read_file",
      { filename: " docs/reference.txt " },
      ctx
    );

    assert.equal(firstRead.deduped, false);
    assert.equal(secondRead.deduped, true);
    assert.equal(firstRead.result.observation.status, "ok");
    assert.equal(secondRead.result.modelText, firstRead.result.modelText);
    assert.match(
      secondRead.result.modelText,
      /stall cycles around the branch hazard/i
    );

    const aliasRead = await executeToolCallForTurn(
      turnToolCache,
      "read_file",
      { filename: "reference.txt" },
      ctx
    );

    assert.equal(aliasRead.deduped, true);
    assert.match(
      aliasRead.result.observation.summary,
      /Reused docs\/reference\.txt from an earlier tool call in this turn/i
    );
  });
});

test("workspace chat dedupes reordered course searches within a single turn", async () => {
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
        pageId: "lab4-brief",
        title: "Lab 4 Brief",
        htmlUrl: null,
        updatedAt: null,
        hasBody: true,
      },
    ];

    await fs.writeFile(
      path.join(coursePath, "extracted", "pages", "lab4-brief.txt"),
      "The lab brief explains saturating add mode and signed overflow detection.\n",
      "utf-8"
    );

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );
    const turnToolCache = new Map();

    const firstSearch = await executeToolCallForTurn(
      turnToolCache,
      "search_course",
      { query: "saturating add mode" },
      ctx
    );
    const secondSearch = await executeToolCallForTurn(
      turnToolCache,
      "search_course",
      { query: "mode add saturating" },
      ctx
    );

    assert.equal(firstSearch.deduped, false);
    assert.equal(firstSearch.result.observation.status, "ok");
    assert.equal(secondSearch.deduped, true);
    assert.equal(secondSearch.result.modelText, firstSearch.result.modelText);
  });
});

test("chat agent prompt and tool definitions teach search-then-read behavior", async () => {
  await withTempDir(async (tempDir) => {
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    cache.lectures = [
      {
        title: "Lecture 4 slides",
        url: "https://canvas.example/courses/17/files/4",
        contentType: "slides",
        source: "modules",
        lectureNumber: 4,
        topic: "Branch hazards",
      },
    ];
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );

    const prompt = buildSystemPrompt(ctx);
    assert.match(
      prompt,
      /Treat search_workspace and search_course as discovery tools only/i
    );
    assert.match(prompt, /Choose the most specific tool for action\/navigation requests/i);
    assert.match(prompt, /open_lecture for lectures, recordings, or slides/i);
    assert.match(prompt, /list_announcements then read_thread/i);
    assert.match(prompt, /list_assignments for course workload\/upcoming due questions/i);
    assert.match(prompt, /follow a search with read_file/i);
    assert.match(
      prompt,
      /For compare, changed, agree\/disagree, or conflict questions, do not stop after one source/i
    );
    assert.match(
      prompt,
      /If prior tool memory already names candidate sources from a relevant search, do not search again first/i
    );
    assert.match(
      prompt,
      /If a read or search just failed, do not repeat the same tool call with the same target/i
    );
    assert.match(
      prompt,
      /Use download_course_file only when search_course identifies an undownloaded Canvas File/i
    );
    assert.match(prompt, /Tool-result checkpoint/i);
    assert.match(prompt, /compare the evidence against every requested detail/i);
    assert.match(prompt, /follow-up search\/read to fill the gap/i);
    assert.match(prompt, /Multi-source questions: keep a quick source ledger/i);
    assert.match(prompt, /read the complementary source before answering/i);
    assert.match(
      prompt,
      /GROUNDING RULE:.*Never state a specific date, point value, filename/i
    );
    assert.match(
      prompt,
      /Cite sources at the most specific level/i
    );
    assert.match(
      prompt,
      /Discovery breadcrumbs \(search_workspace, search_course\).*not evidence.*read the best matching source/i
    );
    assert.match(
      prompt,
      /Dead ends \(not_found, missing_text, failed download\).*do not repeat the same target/i
    );

    const tools = buildChatTools({ cache, client: null });
    const workspaceSearch = tools.find((tool) => tool.name === "search_workspace");
    const courseSearch = tools.find((tool) => tool.name === "search_course");
    const readFile = tools.find((tool) => tool.name === "read_file");
    const listFiles = tools.find((tool) => tool.name === "list_files");
    const openResource = tools.find((tool) => tool.name === "open_resource");
    const openLecture = tools.find((tool) => tool.name === "open_lecture");
    const listAnnouncements = buildChatTools({
      cache,
      client: null,
      radar: {} as any,
      courseId: 17,
    }).find((tool) => tool.name === "list_announcements");

    assert.match(workspaceSearch?.description ?? "", /Discovery-only keyword search/i);
    assert.match(workspaceSearch?.description ?? "", /call read_file/i);
    assert.match(
      workspaceSearch?.description ?? "",
      /best two candidate sources/i
    );
    assert.match(courseSearch?.description ?? "", /Discovery-only keyword search/i);
    assert.match(courseSearch?.description ?? "", /download_course_file/i);
    assert.match(courseSearch?.description ?? "", /best two course sources/i);
    assert.match(workspaceSearch?.description ?? "", /QUERY TIPS/);
    assert.match(workspaceSearch?.description ?? "", /not full questions/i);
    assert.match(courseSearch?.description ?? "", /QUERY TIPS/);
    const downloadCourseFile = buildChatTools({
      cache,
      client: {} as any,
    }).find((tool) => tool.name === "download_course_file");
    assert.match(downloadCourseFile?.description ?? "", /undownloaded Canvas File/i);
    assert.match(downloadCourseFile?.description ?? "", /cached course text/i);
    assert.match(readFile?.description ?? "", /grounding tool/i);
    assert.match(readFile?.description ?? "", /read each relevant source/i);
    assert.match(listFiles?.description ?? "", /failed or ambiguous read\/open/i);
    assert.match(listFiles?.description ?? "", /search came up empty/i);
    assert.match(openResource?.description ?? "", /non-lecture PDF, file, page, or resource/i);
    assert.match(openResource?.description ?? "", /prefer open_lecture/i);
    assert.match(openLecture?.description ?? "", /Prefer this over open_resource/i);
    assert.match(listAnnouncements?.description ?? "", /discovery\/orientation tool/i);
    assert.match(listAnnouncements?.description ?? "", /Use read_thread/i);
  });
});

test("workspace chat dedupes repeated failed open actions within a single turn", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );
    const turnToolCache = new Map();

    const firstAttempt = await executeToolCallForTurn(
      turnToolCache,
      "open_resource",
      { query: "zyxwv qplm" },
      ctx
    );
    const secondAttempt = await executeToolCallForTurn(
      turnToolCache,
      "open_resource",
      { query: "qplm zyxwv" },
      ctx
    );

    assert.equal(firstAttempt.deduped, false);
    assert.equal(firstAttempt.result.observation.status, "not_found");
    assert.equal(secondAttempt.deduped, true);
    assert.equal(secondAttempt.result.observation.status, "not_found");
    assert.equal(secondAttempt.result.modelText, firstAttempt.result.modelText);
  });
});

test("search tools add model-only guidance to follow discovery with a grounded read", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "pages"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(coursePath, "extracted", "pages", "lab4-brief.txt"),
      "The lab brief explains saturating add mode and signed overflow detection.\n",
      "utf-8"
    );

    const cache = createCourseCache(coursePath);
    cache.pages = [
      {
        pageId: "lab4-brief",
        title: "Lab 4 Brief",
        htmlUrl: null,
        updatedAt: null,
        hasBody: true,
      },
    ];

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );

    const workspaceSearch = await executeToolCallForTurn(
      new Map(),
      "search_workspace",
      { query: "branch hazard" },
      ctx
    );
    assert.match(workspaceSearch.result.modelText, /discovery breadcrumbs only/i);
    assert.match(workspaceSearch.result.modelText, /call read_file/i);
    assert.doesNotMatch(
      workspaceSearch.result.uiText,
      /discovery breadcrumbs only/i
    );

    const courseSearch = await executeToolCallForTurn(
      new Map(),
      "search_course",
      { query: "saturating add mode" },
      ctx
    );
    assert.match(courseSearch.result.modelText, /discovery breadcrumbs only/i);
    assert.match(courseSearch.result.modelText, /call read_file/i);
    assert.doesNotMatch(courseSearch.result.uiText, /discovery breadcrumbs only/i);
  });
});

test("search_workspace prefers viable matches over artifacts that already failed a read", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    await fs.writeFile(
      path.join(loaded.path, "extracted", "docs", "notes.txt"),
      "Branch hazard notes explain the same stall-cycle requirement in more detail.\n",
      "utf-8"
    );
    loaded.extractedFiles.push({
      name: "docs/notes.txt",
      relativePath: path.join("extracted", "docs", "notes.txt"),
    });

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache: null, client: null, config: null, courseId: 17 }
    );

    appendObservation(ctx.runState, {
      tool: "read_file",
      status: "missing_text",
      summary: "Matched docs/reference.txt, but readable text is missing.",
      artifacts: [
        {
          artifactId: "workspace:extracted:docs/reference.txt",
          title: "docs/reference.txt",
          kind: "extracted",
        },
      ],
    });

    const result = await executeToolCallForTurn(
      new Map(),
      "search_workspace",
      { query: "branch hazard" },
      ctx
    );

    assert.equal(result.result.observation.status, "ok");
    const artifactIds = result.result.observation.artifacts.map(
      (artifact) => artifact.artifactId
    );
    assert.ok(artifactIds.includes("workspace:extracted:docs/notes.txt"));
    assert.ok(!artifactIds.includes("workspace:extracted:docs/reference.txt"));
    assert.match(result.result.modelText, /notes\.txt/i);
    assert.doesNotMatch(result.result.modelText, /reference\.txt/i);
  });
});

test("search_course prefers viable matches over artifacts that already failed a read", async () => {
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
        pageId: "lab4-brief",
        title: "Lab 4 Brief",
        htmlUrl: null,
        updatedAt: null,
        hasBody: true,
      },
      {
        pageId: "lab4-notes",
        title: "Lab 4 Notes",
        htmlUrl: null,
        updatedAt: null,
        hasBody: true,
      },
    ];

    await fs.writeFile(
      path.join(coursePath, "extracted", "pages", "lab4-brief.txt"),
      "The lab brief explains saturating add mode and signed overflow detection.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "extracted", "pages", "lab4-notes.txt"),
      "The notes explain saturating add mode and signed overflow detection with examples.\n",
      "utf-8"
    );

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );

    const baseline = await executeToolCallForTurn(
      new Map(),
      "search_course",
      { query: "saturating add mode" },
      ctx
    );
    assert.equal(baseline.result.observation.status, "ok");
    assert.ok(baseline.result.observation.artifacts.length >= 2);

    const failedArtifact = baseline.result.observation.artifacts[0]!;
    appendObservation(ctx.runState, {
      tool: "read_file",
      status: "missing_text",
      summary: `Matched ${failedArtifact.title}, but readable text is missing.`,
      artifacts: [failedArtifact],
    });

    const filtered = await executeToolCallForTurn(
      new Map(),
      "search_course",
      { query: "saturating add mode" },
      ctx
    );

    assert.equal(filtered.result.observation.status, "ok");
    assert.ok(
      filtered.result.observation.artifacts.every(
        (artifact) => artifact.artifactId !== failedArtifact.artifactId
      )
    );
  });
});

test("workspace chat reuses downloaded attachment content across tools within a single turn", async () => {
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
            title: "lab4-brief.txt",
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
    cache.attachments = [
      {
        sourceType: "module_linked",
        canvasFileId: 99,
        originalFilename: "lab4-brief.txt",
        localPath: "attachments/modules/lab4-brief.txt",
        contentType: "text/plain",
        size: 256,
        downloadUrl: "https://canvas.example/files/99/download",
        reason: "downloaded on demand from module item \"lab4-brief.txt\"",
        status: "downloaded",
      },
    ];

    await fs.writeFile(
      path.join(coursePath, "attachments", "modules", "lab4-brief.txt"),
      "The downloaded brief explains the branch hazard waveform in detail.\n",
      "utf-8"
    );

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );
    const turnToolCache = new Map();

    const downloaded = await executeToolCallForTurn(
      turnToolCache,
      "download_course_file",
      { title: "lab4 brief" },
      ctx
    );
    const reread = await executeToolCallForTurn(
      turnToolCache,
      "read_file",
      { filename: "lab4-brief.txt" },
      ctx
    );

    assert.equal(downloaded.deduped, false);
    assert.equal(reread.deduped, true);
    assert.match(
      reread.result.observation.summary,
      /Reused lab4-brief\.txt from an earlier tool call in this turn/i
    );
    assert.equal(reread.result.modelText, downloaded.result.modelText);
  });
});

test("download_course_file reuses cached readable course content before download", async () => {
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
        pageId: "lab4-brief",
        title: "Lab 4 Brief",
        htmlUrl: null,
        updatedAt: null,
        hasBody: true,
      },
    ];
    await fs.writeFile(
      path.join(coursePath, "extracted", "pages", "lab4-brief.txt"),
      "The cached page explains signed overflow detection for Lab 4.\n",
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
      { title: "Lab 4 Brief" },
      ctx
    );

    assert.equal(result.deduped, false);
    assert.equal(result.result.observation.status, "ok");
    assert.match(result.result.observation.summary, /no download needed/i);
    assert.equal(result.result.observation.artifacts[0]?.title, "Lab 4 Brief");
    assert.equal(result.result.observation.artifacts[0]?.kind, "page");
    assert.match(result.result.modelText, /signed overflow detection/i);
  });
});

test("workspace chat dedupes repeated missing download lookups within a single turn", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );
    const turnToolCache = new Map();

    const firstAttempt = await executeToolCallForTurn(
      turnToolCache,
      "download_course_file",
      { title: "lab4-brief" },
      ctx
    );
    const secondAttempt = await executeToolCallForTurn(
      turnToolCache,
      "download_course_file",
      { title: "lab4 brief" },
      ctx
    );

    assert.equal(firstAttempt.deduped, false);
    assert.equal(firstAttempt.result.observation.status, "not_found");
    assert.equal(secondAttempt.deduped, true);
    assert.equal(secondAttempt.result.observation.status, "not_found");
    assert.equal(secondAttempt.result.modelText, firstAttempt.result.modelText);
  });
});

test("workspace chat dedupes repeated missing read lookups within a single turn", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    const cache = createCourseCache(coursePath);
    cache.attachments = [
      {
        sourceType: "module_linked",
        canvasFileId: 99,
        originalFilename: "lab4-brief.txt",
        localPath: "attachments/modules/lab4-brief.txt",
        contentType: "text/plain",
        size: 256,
        downloadUrl: "https://canvas.example/files/99/download",
        reason: "downloaded on demand from module item \"lab4-brief.txt\"",
        status: "downloaded",
      },
    ];

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );
    const turnToolCache = new Map();

    const firstAttempt = await executeToolCallForTurn(
      turnToolCache,
      "read_file",
      { filename: "lab4-brief.txt" },
      ctx
    );
    const secondAttempt = await executeToolCallForTurn(
      turnToolCache,
      "read_file",
      { filename: "lab4 brief" },
      ctx
    );

    assert.equal(firstAttempt.deduped, false);
    assert.equal(firstAttempt.result.observation.status, "missing_text");
    assert.equal(secondAttempt.deduped, true);
    assert.equal(secondAttempt.result.observation.status, "missing_text");
    assert.equal(secondAttempt.result.modelText, firstAttempt.result.modelText);
  });
});

test("seeded failed gate reads dedupe alias retries in the next tool loop", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );
    const turnToolCache = new Map();
    const failedGateRead: ToolExecutionResult = {
      observation: {
        tool: "read_file",
        status: "missing_text",
        summary: "Matched lab4-brief.txt, but readable text is missing.",
        artifacts: [
          {
            artifactId:
              "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
            title: "lab4-brief.txt",
            kind: "attachment",
          },
        ],
      },
      modelText: "Matched lab4-brief.txt, but readable text is missing.",
      uiText: "Matched lab4-brief.txt, but readable text is missing.",
    };

    seedTurnToolCacheEntry(
      turnToolCache,
      "read_file",
      { filename: "lab4-brief.txt" },
      failedGateRead
    );

    const retried = await executeToolCallForTurn(
      turnToolCache,
      "read_file",
      { filename: "lab4 brief" },
      ctx
    );

    assert.equal(retried.deduped, true);
    assert.equal(retried.result.observation.status, "missing_text");
    assert.equal(retried.result.modelText, failedGateRead.modelText);
  });
});

test("run-state compaction keeps grounded reads while trimming stale transient observations", () => {
  const runState = createEmptyRunState();

  appendObservation(runState, {
    tool: "read_file",
    status: "ok",
    summary: "Read docs/reference-a.txt.",
    artifacts: [
      {
        artifactId: "artifact-a",
        title: "docs/reference-a.txt",
        kind: "extracted",
        excerpt: "Grounded detail A.",
      },
    ],
    content: "Grounded detail A.",
  });

  for (let index = 0; index < 30; index += 1) {
    appendObservation(runState, {
      tool: "search_workspace",
      status: "not_found",
      summary: `No relevant workspace content found for "miss ${index}".`,
      artifacts: [],
    });
  }

  appendObservation(runState, {
    tool: "download_course_file",
    status: "ok",
    summary: "Downloaded and extracted lab4-brief.txt.",
    artifacts: [
      {
        artifactId: "artifact-b",
        title: "lab4-brief.txt",
        kind: "attachment",
        excerpt: "Grounded detail B.",
      },
    ],
    content: "Grounded detail B.",
  });

  assert.ok(runState.observations.length <= 24);
  assert.deepEqual(runState.readArtifactIds, ["artifact-a", "artifact-b"]);
  assert.ok(
    runState.observations.some(
      (observation) => observation.summary === "Read docs/reference-a.txt."
    )
  );
  assert.ok(
    runState.observations.some(
      (observation) => observation.summary === "Downloaded and extracted lab4-brief.txt."
    )
  );
  assert.ok(
    runState.observations.every(
      (observation) =>
        observation.summary !== 'No relevant workspace content found for "miss 0".'
    )
  );
});

test("run-state compaction preserves older successful search breadcrumbs", () => {
  const runState = createEmptyRunState();

  appendObservation(runState, {
    tool: "search_workspace",
    status: "ok",
    summary: 'Found 1 relevant workspace match for "branch hazard".',
    artifacts: [
      {
        artifactId: "workspace:extracted:docs/reference.txt",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt: "The waveform must show stall cycles around the branch hazard.",
      },
    ],
  });

  for (let index = 0; index < 30; index += 1) {
    appendObservation(runState, {
      tool: "search_workspace",
      status: "not_found",
      summary: `No relevant workspace content found for "miss ${index}".`,
      artifacts: [],
    });
  }

  assert.ok(
    runState.observations.some(
      (observation) =>
        observation.summary === 'Found 1 relevant workspace match for "branch hazard".'
    )
  );
  assert.equal(runState.readArtifactIds.length, 0);
});

test("run-state compaction preserves older failed artifact reads", () => {
  const runState = createEmptyRunState();

  appendObservation(runState, {
    tool: "read_file",
    status: "missing_text",
    summary: "Matched lab4-brief.txt, but readable text is missing.",
    artifacts: [
      {
        artifactId: "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
        title: "lab4-brief.txt",
        kind: "attachment",
      },
    ],
  });

  for (let index = 0; index < 30; index += 1) {
    appendObservation(runState, {
      tool: "search_workspace",
      status: "not_found",
      summary: `No relevant workspace content found for "miss ${index}".`,
      artifacts: [],
    });
  }

  assert.ok(
    runState.observations.some(
      (observation) =>
        observation.summary ===
        "Matched lab4-brief.txt, but readable text is missing."
    )
  );
});

test("run-state does not store duplicate grounded observations for the same evidence", () => {
  const runState = createEmptyRunState();

  appendObservation(runState, {
    tool: "read_file",
    status: "ok",
    summary: "Read docs/reference.txt.",
    artifacts: [
      {
        artifactId: "artifact-a",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt: "Grounded detail A.",
      },
    ],
    content: "Grounded detail A.",
  });

  appendObservation(runState, {
    tool: "download_course_file",
    status: "ok",
    summary: "Reused docs/reference.txt from an earlier tool call in this turn.",
    artifacts: [
      {
        artifactId: "artifact-a",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt: "Grounded detail A.",
      },
    ],
    content: "Grounded detail A.",
  });

  assert.equal(runState.stepCount, 2);
  assert.equal(runState.observations.length, 1);
  assert.deepEqual(runState.readArtifactIds, ["artifact-a"]);
  assert.equal(runState.observations[0]?.tool, "read_file");
});

test("run-state does not store duplicate failed artifact observations for the same dead end", () => {
  const runState = createEmptyRunState();

  appendObservation(runState, {
    tool: "read_file",
    status: "missing_text",
    summary: "Matched lab4-brief.txt, but readable text is missing.",
    artifacts: [
      {
        artifactId: "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
        title: "lab4-brief.txt",
        kind: "attachment",
      },
    ],
  });

  appendObservation(runState, {
    tool: "read_file",
    status: "missing_text",
    summary: "Matched lab4-brief.txt, but readable text is missing.",
    artifacts: [
      {
        artifactId: "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
        title: "lab4-brief.txt",
        kind: "attachment",
      },
    ],
  });

  assert.equal(runState.stepCount, 2);
  assert.equal(runState.observations.length, 1);
  assert.equal(runState.observations[0]?.status, "missing_text");
});

test("run-state does not store duplicate successful search observations for the same artifacts", () => {
  const runState = createEmptyRunState();

  appendObservation(runState, {
    tool: "search_workspace",
    status: "ok",
    summary: 'Found 1 relevant workspace match for "branch hazard".',
    artifacts: [
      {
        artifactId: "workspace:extracted:docs/reference.txt",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt: "The waveform must show stall cycles around the branch hazard.",
      },
    ],
  });

  appendObservation(runState, {
    tool: "search_workspace",
    status: "ok",
    summary: 'Found 1 relevant workspace match for "hazard branch".',
    artifacts: [
      {
        artifactId: "workspace:extracted:docs/reference.txt",
        title: "docs/reference.txt",
        kind: "extracted",
        excerpt: "The waveform must show stall cycles around the branch hazard.",
      },
    ],
  });

  assert.equal(runState.stepCount, 2);
  assert.equal(runState.observations.length, 1);
  assert.equal(runState.observations[0]?.tool, "search_workspace");
  assert.equal(runState.readArtifactIds.length, 0);
});

test("run-state does not store duplicate semantic search misses", () => {
  const runState = createEmptyRunState();

  appendObservation(runState, {
    tool: "search_workspace",
    status: "not_found",
    summary: 'No relevant workspace content found for "branch hazard".',
    artifacts: [],
  });

  appendObservation(runState, {
    tool: "search_workspace",
    status: "not_found",
    summary: 'No relevant workspace content found for "hazard branch".',
    artifacts: [],
  });

  assert.equal(runState.stepCount, 2);
  assert.equal(runState.observations.length, 1);
  assert.equal(runState.observations[0]?.tool, "search_workspace");
  assert.equal(runState.observations[0]?.status, "not_found");
});

test("read_file reuses previously read content across turns", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );

    appendObservation(ctx.runState, {
      tool: "read_file",
      status: "ok",
      summary: "Read docs/reference.txt.",
      artifacts: [
        {
          artifactId: "workspace:extracted:docs/reference.txt",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      content: "The waveform must show stall cycles around the branch hazard.",
    });

    await fs.rm(
      path.join(loaded.path, "extracted", "docs", "reference.txt"),
      { force: true }
    );
    clearArtifactIndexCache();

    const result = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "reference.txt" },
      ctx
    );

    assert.equal(result.deduped, false);
    assert.equal(result.result.observation.status, "ok");
    assert.match(result.result.observation.summary, /Reused previously read/i);
    assert.match(result.result.modelText, /stall cycles around the branch hazard/i);
  });
});

test("read_file reuses fuzzy-matched grounded content across turns", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache: null, client: null, config: null, courseId: 17 }
    );

    appendObservation(ctx.runState, {
      tool: "download_course_file",
      status: "ok",
      summary: "Downloaded and extracted lab4-brief.txt.",
      artifacts: [
        {
          artifactId: "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
          title: "lab4-brief.txt",
          kind: "attachment",
          excerpt: "The downloaded brief explains the branch hazard waveform in detail.",
        },
      ],
      content: "The downloaded brief explains the branch hazard waveform in detail.",
    });

    const result = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "lab4 brief" },
      ctx
    );

    assert.equal(result.deduped, false);
    assert.equal(result.result.observation.status, "ok");
    assert.match(result.result.observation.summary, /Reused previously read lab4-brief\.txt/i);
    assert.match(result.result.modelText, /branch hazard waveform in detail/i);
  });
});

test("read_file recovers text from a local course attachment when extracted text is missing", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "attachments", "modules"), {
      recursive: true,
    });

    const cache = createCourseCache(coursePath);
    cache.attachments = [
      {
        sourceType: "module_linked",
        canvasFileId: 99,
        originalFilename: "lab4-brief.txt",
        localPath: "attachments/modules/lab4-brief.txt",
        contentType: "text/plain",
        size: 256,
        downloadUrl: "https://canvas.example/files/99/download",
        reason: "downloaded on demand from module item \"lab4-brief.txt\"",
        status: "downloaded",
      },
    ];

    await fs.writeFile(
      path.join(coursePath, "attachments", "modules", "lab4-brief.txt"),
      "The local attachment explains the branch hazard waveform in detail.\n",
      "utf-8"
    );

    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded,
      { cache, client: null, config: null, courseId: 17 }
    );

    const result = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "lab4-brief.txt" },
      ctx
    );

    assert.equal(result.result.observation.status, "ok");
    assert.match(result.result.observation.summary, /Recovered text from local attachment/i);
    assert.match(result.result.modelText, /branch hazard waveform in detail/i);

    const reread = await readWorkspaceKnowledgeArtifactById(
      loaded,
      cache,
      "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt",
      30000
    );
    assert.equal(reread.status, "ok");
    if (reread.status !== "ok") {
      return;
    }
    assert.match(reread.content, /branch hazard waveform in detail/i);
  });
});

test("download_course_file reuses cached extracted attachments instead of redownloading", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "extracted", "attachments", "modules"), {
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
            title: "lab4-brief.txt",
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
    cache.attachments = [
      {
        sourceType: "module_linked",
        canvasFileId: 99,
        originalFilename: "lab4-brief.txt",
        localPath: "attachments/modules/lab4-brief.txt",
        contentType: "text/plain",
        size: 256,
        downloadUrl: "https://canvas.example/files/99/download",
        reason: "downloaded on demand from module item \"lab4-brief.txt\"",
        status: "downloaded",
      },
    ];

    await fs.writeFile(
      path.join(
        coursePath,
        "extracted",
        "attachments",
        "modules",
        "lab4-brief.txt.txt"
      ),
      "The brief says to include the waveform and explain the branch hazard.\n",
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
      { title: "lab4 brief" },
      ctx
    );

    assert.equal(result.deduped, false);
    assert.equal(result.result.observation.status, "ok");
    assert.equal(
      result.result.observation.artifacts[0]?.artifactId,
      "course:attachment:attachments/modules/lab4-brief.txt:lab4-brief.txt"
    );
    assert.match(result.result.modelText, /waveform/i);
  });
});

test("download_course_file recovers text from a previously downloaded local file before retrying Canvas", async () => {
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
            title: "lab4-brief.txt",
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
    cache.attachments = [
      {
        sourceType: "module_linked",
        canvasFileId: 99,
        originalFilename: "lab4-brief.txt",
        localPath: "attachments/modules/lab4-brief.txt",
        contentType: "text/plain",
        size: 256,
        downloadUrl: "https://canvas.example/files/99/download",
        reason: "downloaded on demand from module item \"lab4-brief.txt\"",
        status: "downloaded",
      },
    ];

    await fs.writeFile(
      path.join(coursePath, "attachments", "modules", "lab4-brief.txt"),
      "The recovered local file still explains the branch hazard waveform.\n",
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
      { title: "lab4 brief" },
      ctx
    );

    assert.equal(result.result.observation.status, "ok");
    assert.match(result.result.observation.summary, /Recovered text from previously downloaded/i);
    assert.match(result.result.modelText, /branch hazard waveform/i);
  });
});

test("artifact-backed download observations count as already-read evidence for retrieval", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

    const runState = createEmptyRunState();
    appendObservation(runState, {
      tool: "download_course_file",
      status: "ok",
      summary: "Downloaded and extracted lab4-brief.txt.",
      artifacts: [
        {
          artifactId: "workspace:extracted:docs/reference.txt",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      content: "The waveform must show stall cycles around the branch hazard.",
    });

    assert.deepEqual(runState.readArtifactIds, ["workspace:extracted:docs/reference.txt"]);

    const decision = await decideWorkspaceRetrieval({
      question: "Explain the branch hazard requirement in detail.",
      runState,
      loaded,
      cache,
    });

    assert.deepEqual(decision, {
      action: "answer_from_memory",
      reason: "already_read_relevant_artifact",
      sourceArtifactIds: ["workspace:extracted:docs/reference.txt"],
    });
  });
});

test("shouldGroundUnverifiedAnswer triggers when model answered from search snippets without reading", () => {
  const searchOnlyObservations = [
    {
      tool: "search_workspace",
      status: "ok" as const,
      summary: 'Found 2 relevant workspace matches for "branch hazard".',
      artifacts: [
        {
          artifactId: "workspace:extracted:docs/reference.txt",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
    },
  ];

  assert.equal(
    shouldGroundUnverifiedAnswer(
      "The branch hazard requires stall cycles.",
      searchOnlyObservations,
      "What does the branch hazard requirement say?"
    ),
    true
  );
});

test("shouldGroundUnverifiedAnswer still triggers when an unread search result remains after another read", () => {
  const mixedObservations = [
    {
      tool: "read_file",
      status: "ok" as const,
      summary: "Read lab4-overview.txt.",
      artifacts: [
        {
          artifactId: "workspace:extracted:lab4-overview.txt",
          title: "lab4-overview.txt",
          kind: "extracted",
          excerpt: "The lab overview mentions waveform evidence.",
        },
      ],
      content: "The lab overview mentions waveform evidence.",
    },
    {
      tool: "search_workspace",
      status: "ok" as const,
      summary: 'Found a workspace match for "rubric waveform evidence".',
      artifacts: [
        {
          artifactId: "workspace:extracted:lab4-rubric.pdf",
          title: "lab4-rubric.pdf",
          kind: "attachment",
          excerpt: "The rubric gives 30% credit for waveform evidence.",
        },
      ],
    },
  ];

  assert.equal(
    selectUngroundedSearchRecoveryReadArtifactId(
      "What does the rubric say about waveform evidence?",
      mixedObservations
    ),
    "workspace:extracted:lab4-rubric.pdf"
  );
  assert.equal(
    shouldGroundUnverifiedAnswer(
      "The rubric gives 30% credit for waveform evidence.",
      mixedObservations,
      "What does the rubric say about waveform evidence?"
    ),
    true
  );
});

test("shouldRegenerateAnswerAfterRecoveryRead revises snippet answers once grounded", () => {
  const beforeRecovery = [
    {
      tool: "search_workspace",
      status: "ok" as const,
      summary: 'Found a workspace match for "branch hazard".',
      artifacts: [
        {
          artifactId: "workspace:extracted:docs/reference.txt",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
    },
  ];
  const afterRecovery = [
    ...beforeRecovery,
    {
      tool: "read_file",
      status: "ok" as const,
      summary: "Read docs/reference.txt.",
      artifacts: [
        {
          artifactId: "workspace:extracted:docs/reference.txt",
          title: "docs/reference.txt",
          kind: "extracted",
          sectionLabel: "Branch hazard waveform",
        },
      ],
      content: "The waveform must show stall cycles around the branch hazard.",
    },
  ];

  assert.equal(
    shouldRegenerateAnswerAfterRecoveryRead({
      answer: "The branch hazard requires stall cycles.",
      question: "What does the branch hazard requirement say?",
      beforeRecoveryObservations: beforeRecovery,
      afterRecoveryObservations: afterRecovery,
    }),
    true
  );

  assert.equal(
    shouldRegenerateAnswerAfterRecoveryRead({
      answer: "The branch hazard requires stall cycles.",
      question: "What does the branch hazard requirement say?",
      beforeRecoveryObservations: beforeRecovery,
      afterRecoveryObservations: beforeRecovery,
    }),
    false
  );
});

test("shouldGroundUnverifiedAnswer does not trigger when model already read a document", () => {
  const groundedObservations = [
    {
      tool: "search_workspace",
      status: "ok" as const,
      summary: 'Found a workspace match for "branch hazard".',
      artifacts: [
        {
          artifactId: "workspace:extracted:docs/reference.txt",
          title: "docs/reference.txt",
          kind: "extracted",
          excerpt: "The waveform must show stall cycles.",
        },
      ],
    },
    {
      tool: "read_file",
      status: "ok" as const,
      summary: "Read docs/reference.txt.",
      artifacts: [
        {
          artifactId: "workspace:extracted:docs/reference.txt",
          title: "docs/reference.txt",
          kind: "extracted",
        },
      ],
      content: "The waveform must show stall cycles around the branch hazard.",
    },
  ];

  assert.equal(
    shouldGroundUnverifiedAnswer(
      "The branch hazard requires stall cycles in the waveform.",
      groundedObservations,
      "What does the branch hazard requirement say?"
    ),
    false
  );
});

test("shouldGroundUnverifiedAnswer does not trigger when answer is empty", () => {
  const searchOnlyObservations = [
    {
      tool: "search_workspace",
      status: "ok" as const,
      summary: 'Found a workspace match.',
      artifacts: [
        {
          artifactId: "workspace:extracted:docs/reference.txt",
          title: "docs/reference.txt",
          kind: "extracted",
        },
      ],
    },
  ];

  assert.equal(
    shouldGroundUnverifiedAnswer(
      "",
      searchOnlyObservations,
      "What does the branch hazard requirement say?"
    ),
    false
  );
});

test("shouldGroundUnverifiedAnswer does not trigger when there are no search breadcrumbs", () => {
  const noSearchObservations = [
    {
      tool: "list_files",
      status: "ok" as const,
      summary: "Listed workspace files.",
      artifacts: [],
    },
  ];

  assert.equal(
    shouldGroundUnverifiedAnswer(
      "I found these files in the workspace.",
      noSearchObservations,
      "What files are available?"
    ),
    false
  );
});
