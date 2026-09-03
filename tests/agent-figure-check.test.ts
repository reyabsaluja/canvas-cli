import assert from "node:assert/strict";
import test from "node:test";
import { buildStepReflectionNote } from "../src/agent/observation.js";
import { buildSystemPrompt } from "../src/tui/chat-agent/prompt.js";
import type { ChatAgentContext } from "../src/tui/chat-agent/types.js";

function minimalContext(): ChatAgentContext {
  return {
    loaded: {
      path: "/tmp/ws",
      sessionSlug: "lab-5",
      assignmentId: 1,
      assignmentName: "Lab 5",
      courseId: 17,
      courseName: "ECE243",
      courseCode: "ECE243H1",
      preparedAt: "2026-04-02T09:00:00.000Z",
      workspaceState: "ready",
      assignmentMd: "# Lab 5\nDue March 27.",
      planMd: null,
      notesMd: null,
      workupJson: null,
      extractedFiles: [],
      extractedFileCache: new Map(),
    },
    cache: null,
  } as unknown as ChatAgentContext;
}

test("the system prompt tells the agent to confirm every figure against something it read this turn", () => {
  const prompt = buildSystemPrompt(minimalContext(), { maxSteps: 30 });
  assert.match(prompt, /Figure check: every date, time, percentage, mark value, address or count you state must appear in a tool result you read this turn/);
  assert.match(prompt, /read the section that states it first/);
});

test("the reflection footer names the sections a cut-off read omitted and how to fetch them", () => {
  const note = buildStepReflectionNote({
    step: 2,
    maxSteps: 30,
    observation: {
      tool: "read_file",
      status: "ok",
      summary: "Read lecture12.pdf.",
      artifacts: [
        {
          artifactId: "attachment:lecture12",
          title: "lecture12.pdf",
          kind: "attachment",
          truncated: true,
          omittedLabels: ["Page 40", "Page 41", "Page 42", "Page 43", "Page 44", "Page 45", "Page 46", "Page 47"],
        },
      ],
      content: "## Page 1\n\nCache coherence.\n[...truncated]",
    },
    deduped: false,
    needsMultipleSources: false,
    groundedReadCount: 1,
  });
  assert.match(note, /cut off before the end of lecture12\.pdf/);
  assert.match(note, /Page 40, Page 41, Page 42, Page 43, Page 44, Page 45 and 2 more/);
  assert.match(note, /read_file again with section: "<that label>"/);
  assert.match(note, /Any date, time, percentage or value you will state must come from a result you read this turn/);
});

test("a complete read gets no cut-off warning", () => {
  const note = buildStepReflectionNote({
    step: 1,
    maxSteps: 30,
    observation: {
      tool: "read_file",
      status: "ok",
      summary: "Read syllabus.pdf.",
      artifacts: [{ artifactId: "attachment:syllabus", title: "syllabus.pdf", kind: "attachment" }],
      content: "## Late policy\n\n10% per day.",
    },
    deduped: false,
    needsMultipleSources: false,
    groundedReadCount: 1,
  });
  assert.doesNotMatch(note, /cut off/);
});
