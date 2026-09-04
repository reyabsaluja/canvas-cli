import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import { buildGradingSchemePageBody, fetchCourseContent } from "../src/ingest/fetch-course-content.js";
import { createMockCanvasServer, startServer, stopServer, type MockServerData } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";

const COURSE: Course = { id: 101, name: "Introduction to Computer Science", courseCode: "CS101", termName: "Spring 2026", isCurrent: true };

async function startServerWith(mutate?: (data: MockServerData) => void) {
  const data = buildDefaultServerData();
  mutate?.(data);
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const config: Config = { baseUrl: `http://127.0.0.1:${port}/api/v1`, accessToken: "test-token-valid" };
  return { config, stop: () => stopServer(server) };
}

test("before: with no assignment groups, nothing says how much labs are worth", async () => {
  const { config, stop } = await startServerWith((data) => {
    data.assignmentGroups = new Map();
  });
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    assert.equal(raw.assignmentGroups.length, 0);
    assert.ok(!raw.fetchedPages.some((page) => /of the final grade/.test(page.body)));
  } finally {
    await stop();
  }
});

test("assignment groups become a grading-scheme page with weights, drop rules and members", async () => {
  const { config, stop } = await startServerWith();
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    const page = raw.fetchedPages.find((entry) => entry.slug === "grading-scheme");
    assert.ok(page, "grading-scheme page exists");
    assert.match(page.body, /Labs — 30% of the final grade/);
    assert.match(page.body, /Exams — 70% of the final grade/);
    assert.match(page.body, /the lowest 1 score is dropped/);
    assert.match(page.body, /weighted sum/);
  } finally {
    await stop();
  }
});

test("ingestCourse stores the grading page and counts the groups", async () => {
  const { config, stop } = await startServerWith();
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-grading-"));
  process.chdir(tempDir);
  try {
    const result = await ingestCourse(COURSE, new CanvasClient(config, { maxRetries: 0 }), config, { refresh: false });
    const text = await fs.readFile(path.join(result.coursePath, "extracted", "pages", "grading-scheme.txt"), "utf-8");
    assert.match(text, /^# Grading scheme: assignment groups and weights/m);
    assert.match(text, /Labs — 30% of the final grade/);
    assert.equal(result.ingestion.counts.assignmentGroups, 2);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
    await stop();
  }
});

test("buildGradingSchemePageBody computes each assignment's share of the final grade", () => {
  const body = buildGradingSchemePageBody(
    [{ id: 1, name: "Labs", group_weight: 40, assignments: [
      { id: 10, name: "Lab 1", due_at: null, points_possible: 10, omit_from_final_grade: false },
      { id: 11, name: "Lab 2", due_at: null, points_possible: 30, omit_from_final_grade: false },
      { id: 12, name: "Practice", due_at: null, points_possible: 5, omit_from_final_grade: true },
    ] }],
    [],
    true
  );
  assert.ok(body);
  assert.match(body, /Lab 1 \(10 points, about 10\.0% of the final grade\)/);
  assert.match(body, /Lab 2 \(30 points, about 30\.0% of the final grade\)/);
  assert.doesNotMatch(body, /Practice/);
  assert.equal(buildGradingSchemePageBody([], [], true), null);
});
