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
import { buildDefaultServerData, CS101_ANNOUNCEMENTS } from "./helpers/fixtures.js";

const COURSE: Course = { id: 101, name: "Introduction to Computer Science", courseCode: "CS101", termName: "Spring 2026", isCurrent: true };

test("before/after: page extracts carry their updated date and Canvas link; announcements name their author", async () => {
  const data = buildDefaultServerData();
  // Announcements are opt-in in the default data; attachments are dropped so
  // no download against canvas.example is attempted.
  data.discussions = new Map([[101, CS101_ANNOUNCEMENTS.map((topic) => ({ ...topic, attachments: [] }))]]);
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const config: Config = { baseUrl: `http://127.0.0.1:${port}/api/v1`, accessToken: "test-token-valid" };
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-post-metadata-"));
  process.chdir(tempDir);
  try {
    const result = await ingestCourse(COURSE, new CanvasClient(config, { maxRetries: 0 }), config, { refresh: false });
    const welcome = await fs.readFile(path.join(result.coursePath, "extracted", "pages", "welcome.txt"), "utf-8");
    assert.match(welcome, /^# Welcome to CS101\n\nUpdated: \d{4}-\d{2}-\d{2}T/m);
    assert.match(welcome, /^Canvas URL: https?:\/\/.*\/pages\/welcome/m);

    const announcementsDir = path.join(result.coursePath, "extracted", "announcements");
    const files = await fs.readdir(announcementsDir);
    const texts = await Promise.all(files.map((name) => fs.readFile(path.join(announcementsDir, name), "utf-8")));
    const review = texts.find((text) => text.includes("Midterm review session Thursday"));
    assert.ok(review, "midterm review announcement extracted");
    assert.match(review, /^From: Prof\. Grace$/m);
    assert.match(review, /^Posted: /m);
    // Synthetic pages have no Canvas page entry and so no fake date or link.
    const tools = await fs.readFile(path.join(result.coursePath, "extracted", "pages", "course-tools.txt"), "utf-8");
    assert.doesNotMatch(tools, /^Updated:|^Canvas URL:/m);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopServer(server);
  }
});
