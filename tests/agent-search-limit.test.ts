import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import { createEmptyRunState } from "../src/agent/run-state.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { buildChatTools } from "../src/tui/chat-agent/tool-defs.js";
import { executeToolCallForTurn, parseSearchLimit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "../src/tui/chat-agent/tool-execution.js";
import type { ChatAgentContext } from "../src/tui/chat-agent/types.js";

test("search tools expose a limit parameter and the parser clamps it", () => {
  const defs = buildChatTools({ loaded: { extractedFiles: [] }, cache: { courseId: 17, modules: [], attachments: [], lectures: [] } } as unknown as ChatAgentContext);
  for (const name of ["search_workspace", "search_course"]) {
    const def = defs.find((d) => d.name === name);
    assert.ok(def, `${name} defined`);
    const props = (def.parameters as { properties: Record<string, unknown> }).properties;
    assert.ok("limit" in props, `${name} accepts limit`);
  }
  assert.equal(parseSearchLimit(undefined), DEFAULT_SEARCH_LIMIT);
  assert.equal(parseSearchLimit(0), DEFAULT_SEARCH_LIMIT);
  assert.equal(parseSearchLimit("12"), 12);
  assert.equal(parseSearchLimit(500), MAX_SEARCH_LIMIT);
  assert.ok(DEFAULT_SEARCH_LIMIT >= 8, "default must not drop below 8");
});

test("before/after: search_workspace returns more than five matches when asked", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-search-limit-"));
  try {
    const workspacePath = path.join(tempDir, "workspace");
    await fs.mkdir(path.join(workspacePath, "extracted", "docs"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "assignment.md"), "# Lab 5\n", "utf-8");
    const extractedFiles: Array<{ name: string; relativePath: string }> = [];
    for (let index = 1; index <= 12; index += 1) {
      const name = `reading-${index}.txt`;
      await fs.writeFile(
        path.join(workspacePath, "extracted", "docs", name),
        `## Reading ${index}\n\nThis reading discusses the MESI protocol and cache coherence in section ${index}.\n`,
        "utf-8"
      );
      extractedFiles.push({ name: `docs/${name}`, relativePath: path.join("extracted", "docs", name) });
    }
    const ctx = {
      loaded: {
        path: workspacePath, sessionSlug: "lab-5", assignmentId: 43, assignmentName: "Lab 5", courseId: 17, courseName: "ECE243", courseCode: "ECE243H1",
        preparedAt: "2026-04-02T09:00:00.000Z", workspaceState: "ready", assignmentMd: "# Lab 5\n", planMd: null, notesMd: null, workupJson: null,
        extractedFiles, extractedFileCache: new Map<string, string>(),
      } as unknown as LoadedWorkspace,
      cache: null,
      runState: createEmptyRunState(),
    } as unknown as ChatAgentContext;
    clearArtifactIndexCache();

    const count = async (input: Record<string, unknown>) => {
      const result = await executeToolCallForTurn(new Map(), "search_workspace", input, ctx);
      return result.result.observation.artifacts.length;
    };
    const defaultCount = await count({ query: "MESI protocol cache coherence" });
    const wideCount = await count({ query: "MESI protocol cache coherence", limit: 12 });
    const narrowCount = await count({ query: "MESI protocol cache coherence", limit: 2 });
    assert.ok(defaultCount > 5, `default should exceed the old cap of 5, got ${defaultCount}`);
    assert.ok(wideCount >= defaultCount && wideCount >= 10, `limit 12 should widen results, got ${wideCount}`);
    assert.equal(narrowCount, 2);
  } finally {
    clearArtifactIndexCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
