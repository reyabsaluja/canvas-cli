import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import { createMockCanvasServer, startServer, stopServer } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";

const COURSE: Course = { id: 101, name: "Introduction to Computer Science", courseCode: "CS101", termName: "Spring 2026", isCurrent: true };

test("before/after: the assignment extract states attempts, group work and peer-review rules", async () => {
  const data = buildDefaultServerData();
  const assignments = data.assignments.get(101)!;
  const lab1 = assignments.find((a) => a.id === 1001)!;
  Object.assign(lab1, {
    allowed_attempts: 2,
    peer_reviews: true,
    peer_review_count: 3,
    group_category_id: 55,
    grade_group_students_individually: true,
  });
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const config: Config = { baseUrl: `http://127.0.0.1:${port}/api/v1`, accessToken: "test-token-valid" };
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-assignment-rules-"));
  process.chdir(tempDir);
  try {
    const result = await ingestCourse(COURSE, new CanvasClient(config, { maxRetries: 0 }), config, { refresh: false });
    const dir = path.join(result.coursePath, "extracted", "assignments");
    const files = await fs.readdir(dir);
    const lab1File = files.find((name) => name.includes("1001"));
    assert.ok(lab1File, `expected an extract for assignment 1001, got ${files.join(", ")}`);
    const text = await fs.readFile(path.join(dir, lab1File), "utf-8");
    assert.match(text, /^Attempts allowed: 2$/m);
    assert.match(text, /^Group assignment: yes \(students graded individually\)$/m);
    assert.match(text, /^Peer reviews: required \(3 per student\)$/m);
    // Ordinary assignments stay as they were: no spurious rule lines.
    const lab2File = files.find((name) => name.includes("1002"))!;
    const lab2 = await fs.readFile(path.join(dir, lab2File), "utf-8");
    assert.doesNotMatch(lab2, /Attempts allowed|Group assignment|Peer reviews/);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopServer(server);
  }
});
