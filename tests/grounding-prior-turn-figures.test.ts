import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { Observation } from "../src/agent/observation.js";
import { verifyWorkspaceAnswer } from "../src/agent/verify.js";

const loaded = {
  path: "/tmp/ws",
  sessionSlug: "lab-4",
  assignmentId: 42,
  assignmentName: "Lab 4",
  courseId: 17,
  courseName: "ECE243",
  courseCode: "ECE243H1",
  preparedAt: "2026-04-02T09:00:00.000Z",
  workspaceState: "ready",
  assignmentMd: "# Lab 4",
  planMd: null,
  notesMd: null,
  workupJson: null,
  extractedFiles: [],
  extractedFileCache: new Map<string, string>(),
} as unknown as LoadedWorkspace;

const earlierRead: Observation = {
  tool: "read_file",
  status: "ok",
  summary: "Read lab4.txt.",
  artifacts: [{ artifactId: "attachment:lab4", title: "lab4.txt", kind: "attachment" }],
  content: "## Submission\n\nLab 4 is due Friday March 27 at 11:59 PM. Late work loses 10% per day.",
};

const thisTurnRead: Observation = {
  tool: "read_file",
  status: "ok",
  summary: "Read rubric.txt.",
  artifacts: [{ artifactId: "attachment:rubric", title: "rubric.txt", kind: "attachment" }],
  content: "## Grading\n\nCorrectness 60 marks, style 20 marks, report 20 marks.",
};

const question = "How is Lab 4 graded and when is it due?";
const answer =
  "Grading (rubric.txt — Grading): correctness 60 marks, style 20, report 20. It is due Friday March 27 at 11:59 PM (lab4.txt — Submission).";

test("before: a figure remembered from an earlier turn's read is flagged when only this turn's evidence is checked", () => {
  const result = verifyWorkspaceAnswer({ question, answer, observations: [thisTurnRead], usedWorkup: false, loaded });
  assert.match(result.note ?? "", /could not confirm/);
  assert.match(result.note ?? "", /March 27|11:59/);
});

test("after: earlier-turn reads count as evidence for the figure check", () => {
  const result = verifyWorkspaceAnswer({
    question,
    answer,
    observations: [thisTurnRead],
    usedWorkup: false,
    loaded,
    priorObservations: [earlierRead, thisTurnRead],
  });
  assert.doesNotMatch(result.note ?? "", /could not confirm/);
});

test("prior observations do not rescue a figure that appears nowhere", () => {
  const result = verifyWorkspaceAnswer({
    question,
    answer: answer.replace("March 27", "March 23"),
    observations: [thisTurnRead],
    usedWorkup: false,
    loaded,
    priorObservations: [earlierRead, thisTurnRead],
  });
  assert.match(result.note ?? "", /could not confirm/);
  assert.match(result.note ?? "", /March 23/);
});
