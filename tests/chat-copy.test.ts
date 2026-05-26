import assert from "node:assert/strict";
import test from "node:test";
import { formatMessageForCopy } from "../src/tui/chat-copy.js";
import type { ChatMessage } from "../src/tui/chat-state.js";

test("copied assistant answers include section-level source excerpts", () => {
  const message: ChatMessage = {
    role: "assistant",
    content: "Submit one PDF report through Canvas.",
    sources: [
      {
        kind: "assignment",
        title: "assignment.md",
        section: "Submission format",
        excerpt: "Submit a single PDF report through Canvas.",
      },
    ],
  };

  assert.equal(
    formatMessageForCopy(message),
    [
      "Submit one PDF report through Canvas.",
      "",
      "Sources:",
      "- [assignment] assignment.md — Submission format",
      "  Submit a single PDF report through Canvas.",
    ].join("\n")
  );
});
