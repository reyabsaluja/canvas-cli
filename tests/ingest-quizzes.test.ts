import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import { buildQuizPageBody, fetchCourseContent } from "../src/ingest/fetch-course-content.js";
import { renderIngestionSummary } from "../src/format/render-ingestion-summary.js";
import { createMockCanvasServer, startServer, stopServer, type MockServerData } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData, CS101_QUIZZES } from "./helpers/fixtures.js";

const COURSE: Course = {
  id: 101,
  name: "Introduction to Computer Science",
  courseCode: "CS101",
  termName: "Spring 2026",
  isCurrent: true,
};

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-quizzes-"));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function startQuizServer(mutate?: (data: MockServerData) => void) {
  const data = buildDefaultServerData();
  mutate?.(data);
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const config: Config = { baseUrl: `http://127.0.0.1:${port}/api/v1`, accessToken: "test-token-valid" };
  return { config, stop: () => stopServer(server) };
}

test("before: with quizzes stripped from the fetch, the practice quiz is invisible", async () => {
  const { config, stop } = await startQuizServer((data) => {
    data.quizzes = new Map();
  });
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    assert.equal(raw.quizzes.length, 0);
    assert.ok(!raw.fetchedPages.some((page) => page.slug.startsWith("quiz-")));
  } finally {
    await stop();
  }
});

test("quizzes are fetched and exposed as page bodies with their rules and instructions", async () => {
  const { config, stop } = await startQuizServer();
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    assert.equal(raw.quizzes.length, CS101_QUIZZES.length);
    const practice = raw.fetchedPages.find((page) => page.slug === "quiz-9001");
    assert.ok(practice, "practice quiz becomes a fetched page");
    assert.equal(practice.title, "Quiz: Week 3 Practice Quiz");
    assert.match(practice.body, /practice quiz \(not graded\)/);
    assert.match(practice.body, /Time limit: 20 minutes/);
    assert.match(practice.body, /Allowed attempts: unlimited/);
    assert.match(practice.body, /Bring the formula sheet/);
  } finally {
    await stop();
  }
});

test("ingestCourse writes quiz pages to extracted/pages, counts them, and shows them in the summary", async () => {
  const { config, stop } = await startQuizServer();
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });
      const text = await fs.readFile(path.join(result.coursePath, "extracted", "pages", "quiz-9002.txt"), "utf-8");
      assert.match(text, /^# Quiz: Midterm Quiz/m);
      assert.match(text, /Time limit: 50 minutes/);
      assert.match(text, /Allowed attempts: 1/);
      assert.match(text, /Closed book\. Calculators allowed\./);
      assert.equal(result.ingestion.counts.quizzes, 2);
      const summary = renderIngestionSummary(result);
      assert.match(summary, /2 quizzes/);
    });
  } finally {
    await stop();
  }
});

test("a blocked Quizzes API degrades to zero quizzes without failing ingestion", async () => {
  const { config, stop } = await startQuizServer((data) => {
    data.forbiddenPaths = [/\/courses\/\d+\/quizzes$/];
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });
      assert.equal(result.ingestion.counts.quizzes, 0);
      assert.ok(result.assignments.length > 0, "the rest of the ingest still runs");
    });
  } finally {
    await stop();
  }
});

test("buildQuizPageBody covers surveys, limits, and missing instructions", () => {
  const body = buildQuizPageBody({ id: 1, title: "Survey", quiz_type: "survey", time_limit: null, allowed_attempts: 3, description: "" });
  assert.match(body, /survey \(not graded\)/);
  assert.match(body, /Time limit: none/);
  assert.match(body, /Allowed attempts: 3/);
  assert.match(body, /No instructions were provided/);
});
