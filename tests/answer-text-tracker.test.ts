import assert from "node:assert/strict";
import test from "node:test";
import { createAnswerTextTracker } from "../src/ai/provider.js";

test("answer is only the text written after the last tool call", () => {
  const tracker = createAnswerTextTracker();
  tracker.text("Let me read the handout.");
  tracker.tool();
  tracker.text("Now the outline.");
  tracker.tool();
  tracker.text("\n\nYou submit two files.");
  assert.equal(tracker.answer(), "You submit two files.");
  assert.equal(tracker.all, "Let me read the handout.Now the outline.\n\nYou submit two files.");
});

test("an answer with no tool calls is returned whole", () => {
  const tracker = createAnswerTextTracker();
  tracker.text("Due Friday.");
  assert.equal(tracker.answer(), "Due Friday.");
});

test("when nothing follows the last tool call, the whole text is the answer", () => {
  const tracker = createAnswerTextTracker();
  tracker.text("The answer is in the handout.");
  tracker.tool();
  assert.equal(tracker.answer(), "The answer is in the handout.");
});
