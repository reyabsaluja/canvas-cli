import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { Observation } from "../src/agent/observation.js";
import { scoreObservationRelevance } from "../src/agent/observation-relevance.js";
import { verifyWorkspaceAnswer } from "../src/agent/verify.js";

const rubricRead: Observation = {
  tool: "read_file",
  status: "ok",
  summary: "Read rubric.txt.",
  artifacts: [{ artifactId: "attachment:rubric", title: "rubric.txt", kind: "attachment" }],
  content: "## Grading\n\nCorrectness 60 marks, style 20 marks, report 20 marks.",
};

const loaded = {
  path: "/tmp/ws", sessionSlug: "lab-4", assignmentId: 42, assignmentName: "Lab 4", courseId: 17, courseName: "ECE243", courseCode: "ECE243H1",
  preparedAt: "2026-04-02T09:00:00.000Z", workspaceState: "ready", assignmentMd: "# Lab 4", planMd: null, notesMd: null, workupJson: null,
  extractedFiles: [], extractedFileCache: new Map<string, string>(),
} as unknown as LoadedWorkspace;

test("before/after: an inflected question word matches the section it asks about", () => {
  assert.ok(scoreObservationRelevance("How is Lab 4 graded?", rubricRead) > 0, "graded should match Grading");
  assert.ok(scoreObservationRelevance("what is the grading breakdown?", rubricRead) > 0);
  assert.equal(scoreObservationRelevance("where are the lecture recordings?", rubricRead), 0, "unrelated questions still score zero");
});

test("a read that answers the question is reported as a read, not as search evidence", () => {
  const result = verifyWorkspaceAnswer({
    question: "How is Lab 4 graded?",
    answer: "Per rubric.txt — Grading: correctness 60 marks, style 20, report 20.",
    observations: [rubricRead],
    usedWorkup: false,
    loaded,
  });
  assert.equal(result.confidence, "high");
  assert.doesNotMatch(result.note ?? "", /matched search evidence/);
});
