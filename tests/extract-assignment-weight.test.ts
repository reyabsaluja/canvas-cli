import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import { describeAssignmentWeight } from "../src/ingest/storage.js";
import { createMockCanvasServer, startServer, stopServer } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";

const COURSE: Course = { id: 101, name: "Introduction to Computer Science", courseCode: "CS101", termName: "Spring 2026", isCurrent: true };

test("describeAssignmentWeight states the group, its weight, drop rules and the assignment's share", () => {
  const groups = [
    { id: 71, name: "Labs", group_weight: 30, rules: { drop_lowest: 1 }, assignments: [
      { id: 1001, name: "Lab 1", due_at: null, points_possible: 10, omit_from_final_grade: false },
      { id: 1002, name: "Lab 2", due_at: null, points_possible: 30, omit_from_final_grade: false },
    ] },
    { id: 72, name: "Exams", group_weight: 70 },
  ];
  assert.deepEqual(describeAssignmentWeight(1001, { points_possible: 10 }, groups), [
    "Assignment group: Labs (30% of the final grade; lowest 1 dropped)",
    "Approximate share of the final grade: 7.5% (10 of 40 points in Labs)",
  ]);
  assert.deepEqual(describeAssignmentWeight(9999, { assignment_group_id: 72, points_possible: 40 }, groups), [
    "Assignment group: Exams (70% of the final grade)",
  ]);
  assert.deepEqual(describeAssignmentWeight(1001, undefined, []), []);
});

test("before/after: the assignment extract says how much the assignment is worth", async () => {
  const data = buildDefaultServerData();
  data.assignmentGroups!.get(101)![0]!.assignments = [
    { id: 1001, name: "Lab 1: Hello World", due_at: null, points_possible: 10, omit_from_final_grade: false } as never,
    { id: 1002, name: "Lab 2: Variables and Types", due_at: null, points_possible: 15, omit_from_final_grade: false } as never,
  ];
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const config: Config = { baseUrl: `http://127.0.0.1:${port}/api/v1`, accessToken: "test-token-valid" };
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-assignment-weight-"));
  process.chdir(tempDir);
  try {
    const result = await ingestCourse(COURSE, new CanvasClient(config, { maxRetries: 0 }), config, { refresh: false });
    const dir = path.join(result.coursePath, "extracted", "assignments");
    const file = (await fs.readdir(dir)).find((name) => name.includes("1001"))!;
    const text = await fs.readFile(path.join(dir, file), "utf-8");
    assert.match(text, /^Assignment group: Labs \(30% of the final grade; lowest 1 dropped\)$/m);
    assert.match(text, /^Approximate share of the final grade: 12\.0% \(10 of 25 points in Labs\)$/m);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopServer(server);
  }
});
