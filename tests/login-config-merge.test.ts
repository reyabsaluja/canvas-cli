import assert from "node:assert/strict";
import test from "node:test";
import { mergeLoginConfig } from "../src/commands/login.js";

test("re-running login keeps settings it does not manage", () => {
  const merged = mergeLoginConfig(
    { canvasBaseUrl: "https://old.test", aiProvider: "openai", aiModel: "gpt-5.6", ingestSubmissionFeedback: false },
    { canvasBaseUrl: "https://new.test", aiProvider: "anthropic", aiModel: "claude-opus-5" }
  );
  assert.deepEqual(merged, {
    canvasBaseUrl: "https://new.test",
    aiProvider: "anthropic",
    aiModel: "claude-opus-5",
    ingestSubmissionFeedback: false,
  });
});

test("skipping the AI step clears the previous AI settings", () => {
  const merged = mergeLoginConfig(
    { canvasBaseUrl: "https://old.test", aiProvider: "bedrock", aiModel: "x", aiEffort: "high", awsRegion: "us-east-1" },
    { canvasBaseUrl: "https://new.test" }
  );
  assert.deepEqual(merged, { canvasBaseUrl: "https://new.test" });
});
