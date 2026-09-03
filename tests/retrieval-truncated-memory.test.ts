import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import { appendObservation, createEmptyRunState } from "../src/agent/run-state.js";
import { decideWorkspaceRetrieval, findRememberedReadMissingSection } from "../src/agent/retrieval-gate.js";
import { buildDocumentReadView } from "../src/tui/chat-agent/tool-execution.js";

function omittedPages(from: number, to: number): string[] {
  const labels: string[] = [];
  for (let page = from; page <= to; page += 1) labels.push(`Page ${page}`);
  return labels;
}

function runStateWithTruncatedRead() {
  const runState = createEmptyRunState();
  appendObservation(runState, {
    tool: "read_file",
    status: "ok",
    summary: "Read lecture12.pdf.",
    artifacts: [
      {
        artifactId: "attachment:lecture12",
        title: "lecture12.pdf",
        kind: "attachment",
        truncated: true,
        omittedLabels: omittedPages(40, 60),
      },
    ],
    content:
      "## Page 1\n\nLecture 12: Cache coherence. The MESI protocol keeps caches consistent. " +
      "## Page 2\n\nWe compare snooping and directory protocols for the MESI protocol.\n[...truncated]",
  });
  return runState;
}

const workspace = {
  path: "/tmp/ws",
  sessionSlug: "lab-5",
  assignmentId: 1,
  assignmentName: "Lab 5",
  courseId: 17,
  courseName: "ECE243",
  courseCode: "ECE243H1",
  preparedAt: "2026-04-02T09:00:00.000Z",
  workspaceState: "ready",
  assignmentMd: "# Lab 5",
  planMd: null,
  notesMd: null,
  workupJson: null,
  extractedFiles: [],
  extractedFileCache: new Map<string, string>(),
} as unknown as LoadedWorkspace;

test("a cut-off read is not reused to answer about a page it never included", async () => {
  const runState = runStateWithTruncatedRead();
  const decision = await decideWorkspaceRetrieval({
    question: "What does page 57 say about the MESI protocol?",
    runState,
    loaded: workspace,
    cache: null,
  });
  assert.equal(decision.action, "read_artifact");
  assert.equal(decision.action === "read_artifact" ? decision.artifactId : null, "attachment:lecture12");
  assert.equal(decision.action === "read_artifact" ? decision.section : null, "Page 57");
});

test("questions about pages the read did cover still reuse memory", async () => {
  const runState = runStateWithTruncatedRead();
  assert.equal(findRememberedReadMissingSection("What does page 2 say about the MESI protocol?", runState), null);
  const decision = await decideWorkspaceRetrieval({
    question: "What does page 2 say about the MESI protocol?",
    runState,
    loaded: workspace,
    cache: null,
  });
  assert.equal(decision.action, "answer_from_memory");
});

test("section references by heading text and other spellings are recognised", () => {
  const runState = createEmptyRunState();
  appendObservation(runState, {
    tool: "read_file",
    status: "ok",
    summary: "Read handout.pdf.",
    artifacts: [
      {
        artifactId: "attachment:handout",
        title: "handout.pdf",
        kind: "attachment",
        truncated: true,
        omittedLabels: ["Grading Rubric", "Part 4", "Page 12"],
      },
    ],
    content: "## Overview\n\nThe handout covers the lab.\n[...truncated]",
  });
  assert.deepEqual(findRememberedReadMissingSection("what does the grading rubric say?", runState), {
    artifactId: "attachment:handout",
    section: "Grading Rubric",
  });
  assert.equal(findRememberedReadMissingSection("explain part 4", runState)?.section, "Part 4");
  assert.equal(findRememberedReadMissingSection("see p. 12 please", runState)?.section, "Page 12");
  assert.equal(findRememberedReadMissingSection("what is the lab about?", runState), null);
});

test("whole-document reads record what they omitted; section reads do not", () => {
  const lines: string[] = [];
  for (let page = 1; page <= 30; page += 1) {
    lines.push(`## Page ${page}`, `Slide ${page} text. `.repeat(40), "");
  }
  const document = lines.join("\n");
  const whole = buildDocumentReadView(document, {}, 4000);
  assert.equal(whole.truncated, true);
  assert.ok(whole.omittedLabels.includes("Page 30"));
  const section = buildDocumentReadView(document, { section: "Page 30" }, 4000);
  assert.equal(section.sectionLabel, "Page 30");
  assert.equal(section.truncated, false);
});
