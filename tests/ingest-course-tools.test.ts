import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import { buildCourseToolsPageBody, fetchCourseContent } from "../src/ingest/fetch-course-content.js";
import { renderIngestionSummary } from "../src/format/render-ingestion-summary.js";
import { createMockCanvasServer, startServer, stopServer, type MockServerData } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";

const COURSE: Course = { id: 101, name: "Introduction to Computer Science", courseCode: "CS101", termName: "Spring 2026", isCurrent: true };

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-tools-"));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function startServerWith(mutate?: (data: MockServerData) => void) {
  const data = buildDefaultServerData();
  mutate?.(data);
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const config: Config = { baseUrl: `http://127.0.0.1:${port}/api/v1`, accessToken: "test-token-valid" };
  return { config, stop: () => stopServer(server) };
}

test("before: without tabs, nothing in the cache says where the course's Q&A forum is", async () => {
  const { config, stop } = await startServerWith((data) => {
    data.tabs = new Map();
  });
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    assert.equal(raw.tabs.length, 0);
    assert.ok(!raw.fetchedPages.some((page) => /piazza/i.test(page.body)));
  } finally {
    await stop();
  }
});

test("external tools from course navigation become a 'Course tools' page with hints and links", async () => {
  const { config, stop } = await startServerWith();
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    const tools = raw.fetchedPages.find((page) => page.slug === "course-tools");
    assert.ok(tools, "course-tools page exists");
    assert.match(tools.body, /Piazza<\/strong> \(Q&A forum/);
    assert.match(tools.body, /Zoom<\/strong> \(live sessions and office hours/);
    assert.match(tools.body, /external_tools\/77/);
    assert.doesNotMatch(tools.body, /Old tool/, "hidden tools are skipped");
    assert.doesNotMatch(tools.body, /Home/, "internal tabs are skipped");
  } finally {
    await stop();
  }
});

test("ingestCourse stores the tools page, counts external tools, and lists them in the summary", async () => {
  const { config, stop } = await startServerWith();
  try {
    await withTempCwd(async () => {
      const result = await ingestCourse(COURSE, new CanvasClient(config, { maxRetries: 0 }), config, { refresh: false });
      const text = await fs.readFile(path.join(result.coursePath, "extracted", "pages", "course-tools.txt"), "utf-8");
      assert.match(text, /^# Course tools and external links/m);
      assert.match(text, /Piazza/);
      assert.equal(result.ingestion.counts.externalTools, 2);
      assert.match(renderIngestionSummary(result), /2 external tools/);
    });
  } finally {
    await stop();
  }
});

test("a blocked tabs endpoint degrades to no tools page", async () => {
  const { config, stop } = await startServerWith((data) => {
    data.forbiddenPaths = [/\/courses\/\d+\/tabs$/];
  });
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    assert.equal(raw.tabs.length, 0);
    assert.ok(!raw.fetchedPages.some((page) => page.slug === "course-tools"));
  } finally {
    await stop();
  }
});

test("buildCourseToolsPageBody returns null with no external tools and orders by position", () => {
  assert.equal(buildCourseToolsPageBody([{ id: "home", label: "Home", type: "internal" }]), null);
  const body = buildCourseToolsPageBody([
    { id: "b", label: "Gradescope", type: "external", full_url: "https://x/2", position: 9 },
    { id: "a", label: "Ed Discussion", type: "external", full_url: "https://x/1", position: 3 },
  ]);
  assert.ok(body);
  assert.ok(body.indexOf("Ed Discussion") < body.indexOf("Gradescope"));
  assert.match(body, /Ed Discussion<\/strong> \(Q&A forum/);
  assert.match(body, /Gradescope<\/strong> \(assignment submission and grading/);
});
