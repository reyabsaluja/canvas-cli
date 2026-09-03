import assert from "node:assert/strict";
import test from "node:test";
import { appendObservation, createEmptyRunState } from "../src/agent/run-state.js";
import { buildToolPromptMessages } from "../src/tui/chat-agent/memory.js";

function longRead(): string {
  const filler = "Section text about lab logistics and setup that says nothing about penalties. ";
  return `## Overview\n\n${filler.repeat(45)}\n\n## Late policy\n\nLate submissions lose 10% per day, up to five days; after that the mark is zero.`;
}

test("before/after: tool memory carries the question-relevant passage from an earlier read, not just its head", () => {
  const runState = createEmptyRunState();
  appendObservation(runState, {
    tool: "read_file",
    status: "ok",
    summary: "Read syllabus.pdf.",
    artifacts: [{ artifactId: "attachment:syllabus", title: "syllabus.pdf", kind: "attachment" }],
    content: longRead(),
  });
  const messages = buildToolPromptMessages(
    [
      { role: "user", content: "what is this lab about?" },
      { role: "assistant", content: "It is about setting up the toolchain." },
    ],
    "what is the late penalty?",
    runState
  );
  const prompt = messages[messages.length - 1]!.content;
  assert.match(prompt, /Previously gathered tool memory/);
  assert.match(prompt, /10% per day/, "the passage answering the follow-up must be in memory");
  assert.ok(prompt.includes("syllabus.pdf"));
});

test("tool memory says which sections a read covered and which a cut-off read omitted", () => {
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
        omittedLabels: Array.from({ length: 20 }, (_, index) => `Page ${40 + index}`),
      },
    ],
    content: "## Page 1\n\nCache coherence overview and the MESI protocol.",
  });
  appendObservation(runState, {
    tool: "read_file",
    status: "ok",
    summary: "Read lecture12.pdf — Page 57.",
    artifacts: [{ artifactId: "attachment:lecture12", title: "lecture12.pdf", kind: "attachment", sectionLabel: "Page 57" }],
    content: "Page 57\n\nMESI state transitions on a write miss.",
  });
  const prompt = buildToolPromptMessages([], "explain the MESI protocol transitions", runState)[0]!.content;
  assert.match(prompt, /Cut off before the end; not read: Page 40, Page 41/);
  assert.match(prompt, /and 12 more/);
  assert.match(prompt, /read_file with section:/);
  assert.match(prompt, /Section read: Page 57\./);
});
