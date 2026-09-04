import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmptyRunState } from "../src/agent/run-state.js";
import { executeToolDetailed } from "../src/work/tool-handlers.js";
import { INVESTIGATION_TOOLS } from "../src/work/tools.js";

function buildDeck(): string {
  const lines: string[] = [];
  for (let page = 1; page <= 60; page += 1) {
    lines.push(`## Page ${page}`, "", `Slide ${page}: ${page === 57 ? "the MESI protocol keeps caches coherent" : "filler content for this slide"}. `.repeat(30), "");
  }
  return lines.join("\n");
}

test("before/after: /work read_document can open a page past the cut-off with section", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-work-section-"));
  try {
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "attachments"), { recursive: true });
    await fs.writeFile(path.join(coursePath, "attachments", "lecture12.txt"), buildDeck(), "utf-8");
    const state = {
      assignmentName: "Lab 4", courseName: "ECE243", visitedSources: [], extractedTexts: new Map<string, string>(), evidenceNotes: [],
      toolCallCount: 0, runState: createEmptyRunState(), primaryInstructionSourceIds: [], dueDateSourceIds: [],
    };
    const ctx = {
      cache: {
        courseId: 17, coursePath, assignments: [], modules: [], files: [], pages: [], syllabusCandidates: [], lectures: [],
        attachments: [{ canvasFileId: 1, originalFilename: "lecture12.txt", localPath: path.join("attachments", "lecture12.txt"), contentType: "text/plain", size: 1, downloadUrl: null, reason: "fixture", sourceType: "module_linked", status: "downloaded" }],
        ingestion: null,
      },
      state, client: {} as never, config: {} as never, courseId: 17,
    };

    const whole = await executeToolDetailed("read_document", { filename: "lecture12.txt" }, ctx as never);
    assert.match(whole.observation.content ?? "", /\[\.\.\.truncated\]/, "the whole read is cut off");
    assert.doesNotMatch(whole.observation.content ?? "", /MESI protocol/, "page 57 is past the cut");

    const page57 = await executeToolDetailed("read_document", { filename: "lecture12.txt", section: "Page 57" }, ctx as never);
    assert.equal(page57.observation.status, "ok");
    assert.match(page57.observation.summary, /Page 57/);
    assert.match(page57.observation.content ?? "", /MESI protocol keeps caches coherent/);
    assert.doesNotMatch(page57.observation.content ?? "", /Slide 58/);

    const missing = await executeToolDetailed("read_document", { filename: "lecture12.txt", section: "Page 999" }, ctx as never);
    assert.match(missing.observation.content ?? "", /was not found .* showing the document from the start/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("the read_document schema advertises section", () => {
  const tool = INVESTIGATION_TOOLS.find((t) => t.name === "read_document")!;
  assert.ok("section" in (tool.parameters as { properties: Record<string, unknown> }).properties);
});
