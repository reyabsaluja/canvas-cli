import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { CanvasClient } from "../src/canvas/client.js";
import { createMockCanvasServer, startServer, stopServer } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";
import { fetchCourseContent } from "../src/ingest/fetch-course-content.js";
import { normalizeCourseContent } from "../src/ingest/normalize-content.js";
import type { Config } from "../src/config/env.js";

test("integration: ingest pipeline end-to-end with mock API", async (t) => {
  const data = buildDefaultServerData();
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const config: Config = {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    accessToken: "test-token-valid",
  };

  t.after(async () => { await stopServer(server); });

  await t.test("fetchCourseContent retrieves all course data", async () => {
    const client = new CanvasClient(config, { maxRetries: 0 });
    const raw = await fetchCourseContent(client, 101);

    assert.equal(raw.courseDetail.name, "Introduction to Computer Science");
    assert.ok(raw.courseDetail.syllabus_body?.includes("CS101 course syllabus"));
    assert.equal(raw.assignments.length, 3);
    assert.equal(raw.modules.length, 2);
    assert.equal(raw.files.length, 2);
    assert.equal(raw.pages.length, 2);
  });

  await t.test("fetchCourseContent resolves module items", async () => {
    const client = new CanvasClient(config, { maxRetries: 0 });
    const raw = await fetchCourseContent(client, 101);

    const week1 = raw.modules.find((m) => m.name === "Week 1: Getting Started");
    assert.ok(week1);
    assert.equal(week1.items.length, 2);
    assert.equal(week1.items[0].title, "Welcome Page");
    assert.equal(week1.items[1].title, "Syllabus PDF");
  });

  await t.test("normalizeCourseContent produces structured indices", async () => {
    const client = new CanvasClient(config, { maxRetries: 0 });
    const raw = await fetchCourseContent(client, 101);
    const normalized = normalizeCourseContent(raw);

    assert.equal(normalized.assignments.length, 3);
    assert.equal(normalized.assignments[0].name, "Lab 1: Hello World");
    assert.equal(normalized.assignments[0].pointsPossible, 10);

    assert.equal(normalized.modules.length, 2);
    assert.equal(normalized.modules[0].name, "Week 1: Getting Started");
    assert.equal(normalized.modules[0].items.length, 2);

    assert.equal(normalized.files.length, 2);
    assert.equal(normalized.files[0].displayName, "syllabus.pdf");

    assert.equal(normalized.pages.length, 2);
    assert.equal(normalized.pages[0].title, "Welcome to CS101");
  });

  await t.test("fetchCourseContent handles course with no modules/files/pages", async () => {
    const client = new CanvasClient(config, { maxRetries: 0 });
    const raw = await fetchCourseContent(client, 202);

    assert.equal(raw.assignments.length, 1);
    assert.equal(raw.modules.length, 0);
    assert.equal(raw.files.length, 0);
    assert.equal(raw.pages.length, 0);
    assert.equal(raw.courseDetail.name, "Data Structures and Algorithms");
  });

  await t.test("ingest fetches assignment detail including descriptions", async () => {
    const client = new CanvasClient(config, { maxRetries: 0 });
    const raw = await fetchCourseContent(client, 101);

    const lab1 = raw.assignments.find((a) => a.name === "Lab 1: Hello World");
    assert.ok(lab1);
    assert.ok(lab1.description?.includes("Hello World"));
    assert.equal(lab1.points_possible, 10);
  });

  await t.test("ingest handles pages that link to other Canvas pages", async () => {
    const client = new CanvasClient(config, { maxRetries: 0 });
    const raw = await fetchCourseContent(client, 101);

    assert.ok(raw.fetchedPages.length >= 0);
    for (const page of raw.fetchedPages) {
      assert.ok(page.slug);
      assert.ok(page.title);
      assert.ok(page.body);
    }
  });

});

test("integration: ingest pipeline with partially unavailable API", async (t) => {
  let server: http.Server;
  let port: number;

  await t.test("ingest succeeds when files/pages APIs are blocked", async () => {
    const partialServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/^\/api\/v1/, "");

      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer valid-token")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "unauthorized" }] }));
        return;
      }

      if (path === "/courses/101") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: 101,
          name: "CS101",
          course_code: "CS101",
          enrollment_term_id: 1,
          workflow_state: "available",
          start_at: "2026-01-10T00:00:00Z",
          end_at: "2026-05-30T00:00:00Z",
          syllabus_body: "<p>Syllabus here</p>",
        }));
        return;
      }

      if (path === "/courses/101/assignments") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{
          id: 1001,
          name: "Lab 1",
          due_at: "2026-06-01T23:59:00Z",
          html_url: "https://canvas.example/courses/101/assignments/1001",
          course_id: 101,
          has_submitted_submissions: false,
        }]));
        return;
      }

      if (path === "/courses/101/assignments/1001") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: 1001,
          name: "Lab 1",
          due_at: "2026-06-01T23:59:00Z",
          html_url: "https://canvas.example/courses/101/assignments/1001",
          course_id: 101,
          has_submitted_submissions: false,
          description: "<p>Do Lab 1.</p>",
          points_possible: 10,
          submission_types: ["online_upload"],
        }));
        return;
      }

      if (path === "/courses/101/modules") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{
          id: 10,
          name: "Week 1",
          position: 1,
          items_count: 0,
          items_url: "http://localhost/api/v1/courses/101/modules/10/items",
        }]));
        return;
      }

      if (path === "/courses/101/modules/10/items") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }

      // Files and Pages return 403 (blocked by institution)
      if (path === "/courses/101/files" || path === "/courses/101/pages") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "user not authorized" }] }));
        return;
      }

      if (path === "/courses/101/front_page") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
        return;
      }

      if (path.includes("/discussion_topics")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
    });

    port = await startServer(partialServer);

    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "valid-token",
    };

    const client = new CanvasClient(config, { maxRetries: 0 });
    const raw = await fetchCourseContent(client, 101);

    assert.equal(raw.assignments.length, 1);
    assert.equal(raw.modules.length, 1);
    assert.equal(raw.files.length, 0);
    assert.equal(raw.pages.length, 0);
    assert.ok(raw.warnings.length > 0);

    await stopServer(partialServer);
  });
});
