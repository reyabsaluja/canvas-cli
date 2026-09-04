import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import { selectAssignmentAttachments } from "../src/ingest/attachment-selection.js";
import { renderIngestionSummary } from "../src/format/render-ingestion-summary.js";
import { createMockCanvasServer, startServer, stopServer } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";

const COURSE: Course = { id: 101, name: "Introduction to Computer Science", courseCode: "CS101", termName: "Spring 2026", isCurrent: true };

test("before: selectAssignmentAttachments is the only selector that sees files attached to an assignment", () => {
  const selection = selectAssignmentAttachments(
    [{ id: 1001, name: "Lab 1", attachments: [{ id: 5401, display_name: "starter.zip", filename: "starter.zip", url: "https://canvas.example/files/5401/download", content_type: "application/zip", size: 120 }] }],
    []
  );
  assert.equal(selection.selected.length, 1);
  assert.equal(selection.selected[0]?.subfolder, "assignments");
  assert.equal(selection.selected[0]?.sourceType, "assignment_linked");
  assert.match(selection.selected[0]?.reason ?? "", /attached to assignment "Lab 1"/);
  // Already-claimed files (e.g. also linked from a module) are not downloaded twice.
  const deduped = selectAssignmentAttachments(
    [{ id: 1001, name: "Lab 1", attachments: [{ id: 5401, display_name: "starter.zip", url: "https://canvas.example/files/5401/download" }] }],
    [{ sourceType: "module_linked", fileId: 5401, filename: "starter.zip", downloadUrl: "x", reason: "module", contentType: null, size: null, subfolder: "modules" }]
  );
  assert.equal(deduped.selected.length, 0);
  assert.equal(deduped.summary.alreadySelected, 1);
});

test("ingestCourse downloads files attached to an assignment even when the Files API is blocked", async () => {
  const data = buildDefaultServerData();
  data.forbiddenPaths = [/\/courses\/\d+\/files$/, /\/courses\/\d+\/folders$/];
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const origin = `http://127.0.0.1:${port}`;
  const lab1 = data.assignments.get(101)!.find((a) => a.id === 1001)!;
  lab1.attachments = [
    { id: 5401, display_name: "lab1-starter.txt", filename: "lab1-starter.txt", "content-type": "text/plain", size: 64, url: `${origin}/files/5401/download?download_frd=1` },
  ];
  data.fileContents = new Map([[5401, "int main(void) { return 0; }\n"]]);
  const config: Config = { baseUrl: `${origin}/api/v1`, accessToken: "test-token-valid" };
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-assignment-attachments-"));
  process.chdir(tempDir);
  try {
    const result = await ingestCourse(COURSE, new CanvasClient(config, { maxRetries: 0 }), config, { refresh: false });
    const starter = result.attachments.find((a) => a.originalFilename === "lab1-starter.txt");
    assert.ok(starter, "assignment attachment is downloaded");
    assert.equal(starter.status, "downloaded");
    assert.equal(starter.localPath, "attachments/assignments/lab1-starter.txt");
    const text = await fs.readFile(path.join(result.coursePath, starter.localPath), "utf-8");
    assert.match(text, /int main/);
    assert.equal(result.ingestion.assignmentAttachments?.downloaded, 1);
    assert.match(renderIngestionSummary(result), /1 files attached to assignments/);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopServer(server);
  }
});
