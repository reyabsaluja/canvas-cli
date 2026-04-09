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
