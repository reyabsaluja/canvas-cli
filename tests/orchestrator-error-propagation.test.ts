import assert from "node:assert/strict";
import test from "node:test";
import { ToolRuntimeError } from "../src/work/orchestrator.js";
import { isAIProviderError } from "../src/ai/provider.js";

test("ToolRuntimeError is not classified as an AI provider error", () => {
  const err = new ToolRuntimeError("search_modules", new Error("disk full"));
  assert.strictEqual(isAIProviderError(err), false);
});

test("ToolRuntimeError captures tool name and cause", () => {
  const cause = new Error("ENOENT: no such file");
  const err = new ToolRuntimeError("read_document", cause);

  assert.strictEqual(err.toolName, "read_document");
  assert.strictEqual(err.name, "ToolRuntimeError");
  assert.ok(err.message.includes("read_document"));
  assert.ok(err.message.includes("ENOENT"));
  assert.strictEqual(err.cause, cause);
});

test("ToolRuntimeError handles non-Error causes", () => {
  const err = new ToolRuntimeError("download_module_file", "timeout");
  assert.ok(err.message.includes("timeout"));
  assert.strictEqual(err.toolName, "download_module_file");
});

test("AI provider errors are correctly identified", () => {
  const fetchErr = new Error("fetch failed");
  assert.strictEqual(isAIProviderError(fetchErr), true);

  const connErr = new Error("ECONNREFUSED");
  assert.strictEqual(isAIProviderError(connErr), true);
});

test("error discrimination: ToolRuntimeError would re-throw, AI errors would be swallowed", () => {
  // This mirrors the catch block logic in runInvestigation
  const toolErr = new ToolRuntimeError("search_modules", new Error("bug"));
  const aiErr = new Error("fetch failed");

  // ToolRuntimeError should propagate
  assert.strictEqual(toolErr instanceof ToolRuntimeError, true);

  // AI error should be swallowed (produces partial workup)
  assert.strictEqual(isAIProviderError(aiErr), true);
  assert.strictEqual(toolErr instanceof ToolRuntimeError && !isAIProviderError(toolErr), true);
});
