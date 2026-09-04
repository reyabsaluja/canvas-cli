import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import { appendObservation, createEmptyRunState } from "../src/agent/run-state.js";
import { decideWorkspaceRetrieval } from "../src/agent/retrieval-gate.js";

// A handout read whose headings happen to overlap with course-communication
// vocabulary. Without the intent bypass the gate scores these headings against
// "announcement about a lab 4 extension" and answers from memory without ever
// calling list_announcements / read_thread / open_lecture / list_assignments.
const LAB4_HANDOUT = [
  "# Lab 4: Interrupts and Timers",
  "",
  "## Interrupt requirement",
  "",
  "Your ISR must clear the timer interrupt flag by writing 1 to the interrupt status register at 0xFFFEC60C. If you do not clear the flag the ISR is re-entered immediately and the board hangs. Keep the ISR short: increment a global counter and return.",
  "",
  "## Extensions",
  "",
  "Extensions to the lab 4 deadline are granted only for documented medical reasons; ask the prof before the due date.",
  "",
  "## Lectures to review",
  "",
  "Lecture 9 (interrupt controllers) and lecture 10 (timers) cover everything needed for this lab.",
].join("\n");

function runStateWithHandoutRead() {
  const runState = createEmptyRunState();
  appendObservation(runState, {
    tool: "read_file",
    status: "ok",
    summary: "Read lab4.pdf.",
    artifacts: [
      {
        artifactId: "attachment:lab4",
        title: "lab4.pdf",
        kind: "attachment",
      },
    ],
    content: LAB4_HANDOUT,
  });
  return runState;
}

const workspace = {
  path: "/tmp/ws",
  sessionSlug: "lab-4",
  assignmentId: 1,
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

const COURSE_INTENT_QUESTIONS = [
  "did the prof post an announcement about a lab 4 extension?",
  "any discussion threads about the lab 4 extension?",
  "which lectures cover the material for this lab?",
  "what's due this week?",
];

test("before/after: announcement, discussion, lecture and workload questions reach the tools even after a relevant read", async () => {
  for (const question of COURSE_INTENT_QUESTIONS) {
    const decision = await decideWorkspaceRetrieval({
      question,
      runState: runStateWithHandoutRead(),
      loaded: workspace,
      cache: null,
    });
    assert.equal(decision.action, "let_model_decide", `${question} -> ${JSON.stringify(decision)}`);
    assert.equal(decision.reason, "course_intent_needs_tools", question);
  }
});

test("questions the remembered read actually answers still reuse memory", async () => {
  const decision = await decideWorkspaceRetrieval({
    question: "Explain the interrupt requirement in detail",
    runState: runStateWithHandoutRead(),
    loaded: workspace,
    cache: null,
  });
  assert.equal(decision.action, "answer_from_memory", JSON.stringify(decision));
});
