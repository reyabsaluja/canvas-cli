import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import {
  buildCalendarEventPageBody,
  buildCourseCalendarPageBody,
  fetchCourseContent,
} from "../src/ingest/fetch-course-content.js";
import { renderIngestionSummary } from "../src/format/render-ingestion-summary.js";
import {
  createMockCanvasServer,
  startServer,
  stopServer,
  type MockCalendarEvent,
  type MockServerData,
} from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData, CS101_CALENDAR_EVENTS } from "./helpers/fixtures.js";

const COURSE: Course = {
  id: 101,
  name: "Introduction to Computer Science",
  courseCode: "CS101",
  termName: "Spring 2026",
  isCurrent: true,
};

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-calendar-events-"));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** Point the fixture's links at the mock origin so nothing leaves the test. */
function localizeEvents(origin: string): MockCalendarEvent[] {
  return CS101_CALENDAR_EVENTS.map((event) => ({
    ...event,
    description: event.description?.replace(/https:\/\/canvas\.example/g, origin) ?? null,
    html_url: event.html_url?.replace(/^https:\/\/canvas\.example/, origin) ?? null,
  }));
}

async function startCalendarServer(mutate?: (data: MockServerData) => void) {
  const data = buildDefaultServerData();
  const requests: string[] = [];
  data.onRequest = (_method, requestPath) => {
    requests.push(requestPath);
  };
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const origin = `http://127.0.0.1:${port}`;
  data.calendarEvents = new Map([[101, localizeEvents(origin)]]);
  mutate?.(data);
  const config: Config = { baseUrl: `${origin}/api/v1`, accessToken: "test-token-valid" };
  return { config, origin, requests, stop: () => stopServer(server) };
}

const [REVIEW, READING_WEEK] = CS101_CALENDAR_EVENTS as [MockCalendarEvent, MockCalendarEvent];

test("fetchCourseContent turns each calendar event into a synthetic page plus one Course calendar page", async () => {
  const { config, origin, requests, stop } = await startCalendarServer();
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    assert.ok(requests.includes("/calendar_events"), "asks the calendar for the course's events");
    assert.equal(raw.calendarEvents.length, 2);

    const review = raw.fetchedPages.find((page) => page.slug === "calendar-event-6101");
    assert.ok(review, "the review session becomes a fetched page");
    assert.equal(review.title, "Calendar event: Midterm review");
    assert.match(review.body, /ENG 101/);
    assert.match(review.body, new RegExp(REVIEW.start_at!));
    assert.match(review.body, /Bring your questions/);
    assert.match(review.body, new RegExp(`${origin}/courses/101/files/5001/download`));

    const calendar = raw.fetchedPages.find((page) => page.slug === "course-calendar");
    assert.ok(calendar, "a single course calendar page lists every event");
    assert.equal(calendar.title, "Course calendar");
    assert.ok(
      calendar.body.indexOf("Midterm review") < calendar.body.indexOf("Reading week"),
      "events are listed chronologically"
    );
    assert.match(calendar.body, /all day/i);
  } finally {
    await stop();
  }
});

test("ingestCourse writes the event pages with time, location, and the description link, and counts them", async () => {
  const { config, origin, stop } = await startCalendarServer();
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      const review = await fs.readFile(
        path.join(result.coursePath, "extracted", "pages", "calendar-event-6101.txt"),
        "utf-8"
      );
      assert.match(review, /^# Calendar event: Midterm review/m);
      assert.match(review, new RegExp(`Starts: ${REVIEW.start_at}`));
      assert.match(review, new RegExp(`Ends: ${REVIEW.end_at}`));
      assert.match(review, /Location: ENG 101/);
      assert.match(review, /Address: Engineering Building, 1st floor/);
      assert.match(review, /Bring your questions\./);
      assert.match(review, new RegExp(`syllabus\\.pdf \\(${origin}/courses/101/files/5001/download\\)`));
      assert.match(review, new RegExp(`Canvas URL: ${origin}/calendar\\?event_id=6101`));

      const readingWeek = await fs.readFile(
        path.join(result.coursePath, "extracted", "pages", "calendar-event-6102.txt"),
        "utf-8"
      );
      assert.match(readingWeek, /All day: yes/);
      assert.match(readingWeek, /No event description provided/);

      const calendar = await fs.readFile(
        path.join(result.coursePath, "extracted", "pages", "course-calendar.txt"),
        "utf-8"
      );
      assert.match(calendar, /^# Course calendar/m);
      assert.match(calendar, /Midterm review/);
      assert.match(calendar, /Reading week/);

      assert.ok(
        result.pages.some((page) => page.pageId === "calendar-event-6101"),
        "event pages are indexed like any other page"
      );
      assert.equal(result.ingestion.calendar?.events, 2);
      const summary = renderIngestionSummary(result);
      assert.match(summary, /2 calendar events/);
    });
  } finally {
    await stop();
  }
});

test("a blocked calendar degrades to zero events without failing ingestion", async () => {
  const { config, stop } = await startCalendarServer((data) => {
    data.forbiddenPaths = [/^\/calendar_events$/];
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });
      assert.equal(result.ingestion.calendar?.events, 0);
      assert.ok(!result.pages.some((page) => page.pageId === "course-calendar"));
      assert.ok(result.assignments.length > 0, "the rest of the ingest still runs");
    });
  } finally {
    await stop();
  }
});

test("buildCalendarEventPageBody and buildCourseCalendarPageBody cover all-day and undated events", () => {
  const body = buildCalendarEventPageBody({
    id: 1,
    title: "Office hours",
    all_day: true,
    all_day_date: "2026-10-02",
    start_at: "2026-10-02T00:00:00Z",
    location_name: "Zoom",
    description: "",
  });
  assert.match(body, /Date: 2026-10-02/);
  assert.match(body, /All day: yes/);
  assert.match(body, /Location: Zoom/);
  assert.match(body, /No event description provided/);

  const undated = buildCalendarEventPageBody({ id: 2, title: "TBA" });
  assert.match(undated, /Starts: not scheduled/);

  assert.equal(buildCourseCalendarPageBody([]), null);
  const calendar = buildCourseCalendarPageBody([
    { id: 3, title: "Later", start_at: "2026-11-01T10:00:00Z" },
    { id: 4, title: "Sooner", start_at: "2026-10-01T10:00:00Z", location_name: "Room 1" },
    { id: 5, title: "Undated" },
  ]);
  assert.ok(calendar);
  assert.ok(calendar.indexOf("Sooner") < calendar.indexOf("Later"));
  assert.ok(calendar.indexOf("Later") < calendar.indexOf("Undated"), "undated events sort last");
  assert.match(calendar, /Room 1/);
  assert.match(calendar, /calendar-event-4/);
});
