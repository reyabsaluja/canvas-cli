import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPdfContextBundle } from "../src/pdf/context.js";
import { generatePdfExport } from "../src/pdf/generate.js";
import { extractMakePdf } from "../src/tui/pdf-command.js";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { ChatSession, ScopeRuntime } from "../src/tui/chat-state.js";

test("buildPdfContextBundle captures workspace context and omits the command turn", () => {
  const workspacePath = path.join(os.tmpdir(), "canvas-cli-pdf-context");
  const session = makeSession([
    { role: "user", content: "what should I do first?" },
    { role: "assistant", content: "Start with the lab brief." },
    { role: "user", content: "/make-pdf study guide" },
  ]);
  const runtime = makeRuntime(workspacePath);
  const loaded = makeWorkspace(workspacePath);

  const bundle = buildPdfContextBundle({
    instruction: "study guide",
    session,
    runtime,
    loaded,
    cache: null,
    aiConfig: null,
    now: new Date("2026-05-01T12:00:00Z"),
  });

  assert.match(bundle.promptContext, /Lab 4/);
  assert.match(bundle.promptContext, /Start with the lab brief/);
  assert.doesNotMatch(bundle.promptContext, /\/make-pdf study guide/);
  assert.equal(bundle.outputDirectory, path.join(workspacePath, "exports"));
});

test("generatePdfExport writes markdown and a readable PDF without AI", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-pdf-"));
  const session = makeSession([
    { role: "user", content: "summarize the assignment" },
    { role: "assistant", content: "It is about implementing a queue." },
  ]);
  const runtime = makeRuntime(workspacePath);
  const loaded = makeWorkspace(workspacePath);

  const result = await generatePdfExport({
    instruction: "assignment brief",
    session,
    runtime,
    loaded,
    cache: null,
    aiConfig: null,
    now: new Date("2026-05-01T12:00:00Z"),
  });

  assert.equal(result.usedAI, false);
  assert.match(result.warning ?? "", /AI is not configured/);
  assert.equal(path.dirname(result.pdfPath), path.join(workspacePath, "exports"));

  const pdfBytes = await fs.readFile(result.pdfPath);
  assert.equal(pdfBytes.subarray(0, 4).toString("utf-8"), "%PDF");

  const markdown = await fs.readFile(result.markdownPath, "utf-8");
  assert.match(markdown, /# Assignment Brief/);
  assert.match(markdown, /implementing a queue/);
});

function makeSession(messages: ChatSession["messages"]): ChatSession {
  return {
    version: 1,
    id: "workspace-test",
    title: "Lab 4",
    scope: {
      type: "workspace",
      workspacePath: "/tmp/workspace",
      courseId: 17,
      assignmentId: 42,
    },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    lastOpenedAt: "2026-05-01T00:00:00.000Z",
    messages,
    metadata: {
      courseId: 17,
      courseName: "ECE243",
      courseCode: "ECE243",
      assignmentId: 42,
      assignmentName: "Lab 4",
      workspacePath: "/tmp/workspace",
      sessionSlug: "ece243-lab-4-42",
    },
  };
}

function makeRuntime(workspacePath: string): ScopeRuntime {
  return {
    scope: {
      type: "workspace",
      workspacePath,
      courseId: 17,
      assignmentId: 42,
    },
    title: "Lab 4",
    scopeLabel: "workspace",
    statusLabel: "ready",
  };
}

function makeWorkspace(workspacePath: string): LoadedWorkspace {
  return {
    path: workspacePath,
    sessionSlug: "ece243-lab-4-42",
    assignmentId: 42,
    assignmentName: "Lab 4",
    courseId: 17,
    courseName: "ECE243",
    courseCode: "ECE243",
    preparedAt: "2026-05-01T00:00:00.000Z",
    workspaceState: "ready",
    assignmentMd: "# Lab 4\n\nImplement the queue.",
    planMd: "1. Read the lab brief\n2. Build the queue",
    notesMd: null,
    workupJson: {
      overview: "Implement and test a queue.",
      deliverables: ["Source code", "Short report"],
      constraints: ["Submit before the deadline"],
    },
    extractedFiles: [{ name: "lab-brief.pdf.txt", relativePath: "extracted/lab-brief.pdf.txt" }],
  };
}

test("extractMakePdf detects /make-pdf as a prefix command", () => {
  const result = extractMakePdf("/make-pdf study guide");
  assert.equal(result.triggered, true);
  assert.equal(result.instruction, "study guide");
});

test("extractMakePdf detects /pdf alias", () => {
  const result = extractMakePdf("/pdf");
  assert.equal(result.triggered, true);
  assert.equal(result.instruction, "");
});

test("extractMakePdf detects /make-pdf as a suffix in a sentence", () => {
  const result = extractMakePdf("make a full exam study guide look at everything in course /make-pdf");
  assert.equal(result.triggered, true);
  assert.equal(result.instruction, "make a full exam study guide look at everything in course");
});

test("extractMakePdf does not trigger on regular input", () => {
  const result = extractMakePdf("what is the plan for this assignment?");
  assert.equal(result.triggered, false);
});
