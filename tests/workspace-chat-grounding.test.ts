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
import { appendObservation, createEmptyRunState } from "../src/agent/run-state.js";
import { verifyWorkspaceAnswer } from "../src/agent/verify.js";
import {
  buildEvidenceBackedQuestion,
  executeToolCallForTurn,
  resolveToolTurnVerificationObservations,
  seedTurnToolCacheEntry,
  selectArtifactSupportObservations,
  selectRecoveryReadArtifactId,
  shouldContinueToolLoopAfterGateRead,
  shouldRecoverFromToolLoop,
} from "../src/tui/chat-agent.js";
import { createChatContext, hydrateConversationHistory } from "../src/tui/services.js";
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
      reason: "top_workspace_match_needs_read",
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
      reason: "top_workspace_match_needs_read",
      artifactId: nextMatch.artifact.id,
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

test("workspace retrieval gate prefers grounded memory over later discovered artifacts", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const cache = createCourseCache(path.join(tempDir, "course"));

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
            summary: 'Found 1 relevant workspace match for "branch hazard".',
            artifacts: [
              {
                artifactId: "workspace:extracted:docs/reference.txt",
                title: "docs/reference.txt",
                kind: "extracted",
                excerpt:
                  "The branch hazard requirement is to show the stall cycles clearly in the waveform.",
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
      reason: "weak_workspace_match",
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
            },
          ],
        },
      ],
      usedWorkup: false,
      loaded,
    });
    assert.equal(verifiedFromSearchOnly.confidence, "medium");

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

    const verifiedFromUnsupportedWorkup = verifyWorkspaceAnswer({
      question: "Explain the branch hazard requirement in detail.",
      answer: "The workup says to explain branch behavior.",
      observations: [],
      usedWorkup: true,
      loaded,
    });
    assert.equal(verifiedFromUnsupportedWorkup.confidence, "low");
  });
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

test("failed gate reads fall back to the normal tool loop, but grounded gate reads do not", () => {
  assert.equal(
    shouldContinueToolLoopAfterGateRead({
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
    }),
    true
  );

  assert.equal(
    shouldContinueToolLoopAfterGateRead({
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
    }),
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
