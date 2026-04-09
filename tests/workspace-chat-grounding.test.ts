import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import type { Observation } from "../src/agent/observation.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { decideWorkspaceRetrieval } from "../src/agent/retrieval-gate.js";
import { verifyWorkspaceAnswer } from "../src/agent/verify.js";
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

    const topMatch = (
      await searchWorkspaceKnowledge(loaded, cache, "branch hazard", 1)
    )[0];
    assert.ok(topMatch);

    const fromSearch = await decideWorkspaceRetrieval({
      question: "Explain the branch hazard requirement in detail.",
      runState: emptyRunState,
      loaded,
      cache,
    });
    assert.deepEqual(fromSearch, {
      action: "read_artifact",
      reason: "top_workspace_match_needs_read",
      artifactId: topMatch!.artifact.id,
    });

    const readResult = await readWorkspaceKnowledgeArtifactById(
      loaded,
      cache,
      topMatch!.artifact.id,
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

test("workspace answer verification derives sources and confidence deterministically", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);

    const verifiedFromRead = verifyWorkspaceAnswer({
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

    const verifiedFromWorkup = verifyWorkspaceAnswer({
      answer: "You need to submit a waveform screenshot and short analysis.",
      observations: [],
      usedWorkup: true,
      loaded,
    });
    assert.equal(verifiedFromWorkup.ok, true);
    assert.equal(verifiedFromWorkup.confidence, "medium");
    assert.equal(verifiedFromWorkup.sources[0]?.title, "workup.json");

    const verifiedFromMissingText = verifyWorkspaceAnswer({
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
  });
});
