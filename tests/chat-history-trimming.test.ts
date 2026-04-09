import assert from "node:assert/strict";
import test from "node:test";
import { buildToolPromptMessages } from "../src/tui/chat-agent.js";

test("buildToolPromptMessages trims the active tool prompt before the model call", () => {
  const history = Array.from({ length: 10 }, (_, index) => {
    const n = index + 1;
    return [
      { role: "user", content: `Question ${n}: ${"u".repeat(9000)}` },
      { role: "assistant", content: `Answer ${n}: ${"a".repeat(9000)}` },
    ];
  }).flat();

  const promptMessages = buildToolPromptMessages(history, `Latest question: ${"q".repeat(9000)}`);

  assert.ok(promptMessages.length <= 12, "expected prompt to respect message cap");
  const totalChars = promptMessages.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(totalChars <= 80000, "expected prompt to respect char cap");
  assert.equal(promptMessages.at(-1)?.role, "user");
  assert.match(promptMessages.at(-1)?.content ?? "", /Latest question/);
  assert.ok(
    promptMessages.every(
      (message) => message.content.includes("Question 10") || message.content.includes("Answer 10") || message.content.includes("Latest question") || message.content.includes("Question 9") || message.content.includes("Answer 9") || message.content.includes("Question 8") || message.content.includes("Answer 8") || message.content.includes("Question 7") || message.content.includes("Answer 7")
    ),
    "expected oldest turns to be trimmed first"
  );
});

test("buildToolPromptMessages carries forward compact tool memory for the next turn", () => {
  const promptMessages = buildToolPromptMessages(
    [
      { role: "user", content: "What does the branch hazard section require?" },
      { role: "assistant", content: "It wants the waveform details." },
    ],
    "Explain it again without rereading the file.",
    {
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
          status: "not_found",
          summary: 'File "missing.pdf" not found. Use list_files to see available files.',
          artifacts: [],
        },
      ],
      readArtifactIds: ["artifact-1"],
      stepCount: 2,
    }
  );

  const latestMessage = promptMessages.at(-1)?.content ?? "";
  assert.match(latestMessage, /Previously gathered tool memory/);
  assert.match(latestMessage, /docs\/reference\.txt/);
  assert.match(latestMessage, /stall cycles around the branch hazard/i);
  assert.match(latestMessage, /missing\.pdf/);
  assert.match(latestMessage, /Only call a tool if you still need new evidence/i);
});

test("buildToolPromptMessages prefers question-relevant memory over newer unrelated reads", () => {
  const promptMessages = buildToolPromptMessages(
    [],
    "Explain the branch hazard requirement in detail.",
    {
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
      ],
      readArtifactIds: ["artifact-1", "artifact-2", "artifact-3", "artifact-4"],
      stepCount: 4,
    }
  );

  const latestMessage = promptMessages.at(-1)?.content ?? "";
  assert.match(latestMessage, /docs\/reference\.txt/);
  assert.doesNotMatch(latestMessage, /docs\/bonus\.txt/);
});

test("buildToolPromptMessages keeps relevant search breadcrumbs alongside grounded reads", () => {
  const promptMessages = buildToolPromptMessages(
    [],
    "Compare the branch hazard walkthrough to the reference.",
    {
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
          summary: 'Found 1 relevant workspace match for "branch hazard walkthrough".',
          artifacts: [
            {
              artifactId: "artifact-2",
              title: "docs/walkthrough.txt",
              kind: "extracted",
              excerpt: "The walkthrough explains each branch hazard stall step-by-step.",
            },
          ],
        },
        {
          tool: "search_workspace",
          status: "ok",
          summary: 'Found 1 relevant workspace match for "resistor values".',
          artifacts: [
            {
              artifactId: "artifact-3",
              title: "docs/resistor-table.txt",
              kind: "extracted",
              excerpt: "Use a 4.7k resistor for the LED path.",
            },
          ],
        },
      ],
      readArtifactIds: ["artifact-1"],
      stepCount: 3,
    }
  );

  const latestMessage = promptMessages.at(-1)?.content ?? "";
  assert.match(latestMessage, /docs\/reference\.txt/);
  assert.match(latestMessage, /docs\/walkthrough\.txt/);
  assert.doesNotMatch(latestMessage, /docs\/resistor-table\.txt/);
});
