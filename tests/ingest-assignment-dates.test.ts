import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import { fetchCourseContent } from "../src/ingest/fetch-course-content.js";
import { normalizeCourseContent } from "../src/ingest/normalize-content.js";
import type { AssignmentIndexEntry } from "../src/ingest/types.js";
import {
  createMockCanvasServer,
  startServer,
  stopServer,
  type MockServerData,
} from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData, CS101_LAB1_ALL_DATES } from "./helpers/fixtures.js";

const COURSE: Course = {
  id: 101,
  name: "Introduction to Computer Science",
  courseCode: "CS101",
  termName: "Spring 2026",
  isCurrent: true,
};

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-assignment-dates-"));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function startDatesServer(mutate?: (data: MockServerData) => void) {
  const data = buildDefaultServerData();
  const requests: string[] = [];
  data.onRequest = (_method, requestPath) => {
    requests.push(requestPath);
  };
  const lab1 = data.assignments.get(101)!.find((a) => a.id === 1001)!;
  lab1.all_dates = CS101_LAB1_ALL_DATES;
  mutate?.(data);
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const config: Config = { baseUrl: `http://127.0.0.1:${port}/api/v1`, accessToken: "test-token-valid" };
  return { config, requests, stop: () => stopServer(server) };
}

test("all_dates overrides are normalised onto the assignment index without extra date_details requests", async () => {
  const { config, requests, stop } = await startDatesServer();
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    assert.ok(
      !requests.some((p) => p.includes("/date_details")),
      "no per-assignment date_details request is made"
    );
    const lab1 = raw.assignments.find((a) => a.id === 1001);
    assert.equal(lab1?.all_dates?.length, 2);

    const { assignments } = normalizeCourseContent(raw);
    const entry = assignments.find((a) => a.id === 1001) as AssignmentIndexEntry;
    assert.ok(entry.dateDetails, "date details are set when overrides exist");
    assert.equal(entry.dateDetails.overrideCount, 1);
    assert.equal(entry.dateDetails.dueAt, CS101_LAB1_ALL_DATES[0]!.due_at, "base due date");
    assert.equal(entry.dateDetails.overrides[0]?.title, "Section B (evening)");
    assert.equal(entry.dateDetails.overrides[0]?.setType, "CourseSection");
    assert.equal(entry.dateDetails.overrides[0]?.dueAt, CS101_LAB1_ALL_DATES[1]!.due_at);

    // An assignment with no overrides carries no date details.
    const lab2 = assignments.find((a) => a.id === 1002) as AssignmentIndexEntry;
    assert.equal(lab2.dateDetails ?? null, null);
  } finally {
    await stop();
  }
});

test("the assignment extract lists every dated group under Assignment Dates, and nothing when there are no overrides", async () => {
  const { config, stop } = await startDatesServer();
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      const lab1 = await fs.readFile(
        path.join(result.coursePath, "extracted", "assignments", "1001.txt"),
        "utf-8"
      );
      assert.match(lab1, /^## Assignment Dates$/m);
      assert.match(
        lab1,
        new RegExp(`^- Everyone else: due ${CS101_LAB1_ALL_DATES[0]!.due_at}; unlocks `, "m")
      );
      assert.match(
        lab1,
        new RegExp(
          `^- Section B \\(evening\\) \\(section\\): due ${CS101_LAB1_ALL_DATES[1]!.due_at}; unlocks .*; locks ${CS101_LAB1_ALL_DATES[1]!.lock_at}$`,
          "m"
        )
      );
      // Dates come before the description so a skim finds them.
      assert.ok(lab1.indexOf("## Assignment Dates") < lab1.indexOf("## Description"));

      const lab2 = await fs.readFile(
        path.join(result.coursePath, "extracted", "assignments", "1002.txt"),
        "utf-8"
      );
      assert.doesNotMatch(lab2, /Assignment Dates/);

      const index = JSON.parse(
        await fs.readFile(path.join(result.coursePath, "assignments.json"), "utf-8")
      ) as AssignmentIndexEntry[];
      assert.equal(index.find((a) => a.id === 1001)?.dateDetails?.overrides.length, 1);
    });
  } finally {
    await stop();
  }
});

test("a lone base entry in all_dates is not treated as an override", async () => {
  const { config, stop } = await startDatesServer((data) => {
    const lab1 = data.assignments.get(101)!.find((a) => a.id === 1001)!;
    lab1.all_dates = [CS101_LAB1_ALL_DATES[0]!];
  });
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    const { assignments } = normalizeCourseContent(raw);
    const entry = assignments.find((a) => a.id === 1001) as AssignmentIndexEntry;
    assert.equal(entry.dateDetails ?? null, null);
  } finally {
    await stop();
  }
});
