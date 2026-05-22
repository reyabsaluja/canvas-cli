import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { CanvasClient } from "../src/canvas/client.js";
import { createMockCanvasServer, startServer, stopServer, type MockServerData, type MockCourse } from "./helpers/mock-canvas-server.js";
import type { Config } from "../src/config/env.js";

function generateCourses(count: number): MockCourse[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Course ${i + 1}`,
    course_code: `C${i + 1}`,
    enrollment_term_id: 1,
    workflow_state: "available",
    start_at: "2026-01-10T00:00:00Z",
    end_at: "2026-05-30T00:00:00Z",
    term: { id: 1, name: "Spring 2026", start_at: "2026-01-06T00:00:00Z", end_at: "2026-06-01T00:00:00Z" },
    enrollments: [{ enrollment_state: "active", type: "student" }],
  }));
}

test("integration: pagination handling", async (t) => {
  let server: http.Server;
  let port: number;

  await t.test("fetches all courses across multiple pages", async () => {
    const courses = generateCourses(7);
    const data: MockServerData = {
      courses,
      assignments: new Map(),
      modules: new Map(),
      pages: new Map(),
      files: new Map(),
      courseDetails: new Map(),
      pagePerPage: 3,
    };

    server = createMockCanvasServer(data);
    port = await startServer(server);

    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "test-token-valid",
    };

    const client = new CanvasClient(config);
    const result = await client.getCourses();
    assert.equal(result.length, 7);
    assert.equal(result[0].name, "Course 1");
    assert.equal(result[6].name, "Course 7");

    await stopServer(server);
  });

  await t.test("fetches assignments across multiple pages with Link headers", async () => {
    const assignments = Array.from({ length: 5 }, (_, i) => ({
      id: 1000 + i,
      name: `Assignment ${i + 1}`,
      due_at: `2026-06-0${i + 1}T23:59:00Z`,
      html_url: `https://canvas.example/courses/1/assignments/${1000 + i}`,
      course_id: 1,
      has_submitted_submissions: false,
      submission: {
        workflow_state: "unsubmitted" as const,
        submitted_at: null,
        score: null,
        grade: null,
        attempt: null,
        late: false,
        missing: false,
      },
    }));

    const data: MockServerData = {
      courses: [generateCourses(1)[0]],
      assignments: new Map([[1, assignments]]),
      modules: new Map(),
      pages: new Map(),
      files: new Map(),
      courseDetails: new Map(),
      pagePerPage: 2,
    };

    server = createMockCanvasServer(data);
    port = await startServer(server);

    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "test-token-valid",
    };

    const client = new CanvasClient(config);
    const result = await client.getAssignments(1);
    assert.equal(result.length, 5);
    assert.equal(result[0].name, "Assignment 1");
    assert.equal(result[4].name, "Assignment 5");

    await stopServer(server);
  });

  await t.test("handles single-page response (no Link header)", async () => {
    const data: MockServerData = {
      courses: generateCourses(2),
      assignments: new Map(),
      modules: new Map(),
      pages: new Map(),
      files: new Map(),
      courseDetails: new Map(),
      pagePerPage: 50,
    };

    server = createMockCanvasServer(data);
    port = await startServer(server);

    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "test-token-valid",
    };

    const client = new CanvasClient(config);
    const result = await client.getCourses();
    assert.equal(result.length, 2);

    await stopServer(server);
  });

  await t.test("paginates modules and module items", async () => {
    const modules = Array.from({ length: 4 }, (_, i) => ({
      id: 100 + i,
      name: `Module ${i + 1}`,
      position: i + 1,
      items_count: 1,
      items_url: `http://localhost/api/v1/courses/1/modules/${100 + i}/items`,
      items: [
        { id: 200 + i, title: `Item in Module ${i + 1}`, type: "Page", position: 1, page_url: `page-${i}` },
      ],
    }));

    const data: MockServerData = {
      courses: generateCourses(1),
      assignments: new Map(),
      modules: new Map([[1, modules]]),
      pages: new Map(),
      files: new Map(),
      courseDetails: new Map(),
      pagePerPage: 2,
    };

    server = createMockCanvasServer(data);
    port = await startServer(server);

    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "test-token-valid",
    };

    const client = new CanvasClient(config);
    const result = await client.getModulesSafe(1);
    assert.equal(result.length, 4);
    assert.equal(result[3].name, "Module 4");

    await stopServer(server);
  });

  await t.test("terminates pagination when next link repeats the same URL", { timeout: 5000 }, async () => {
    let requestCount = 0;
    const maxRequests = 3;
    const loopServer = http.createServer((req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "unauthorized" }] }));
        return;
      }

      requestCount++;
      const port = (loopServer.address() as { port: number }).port;
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      // Stop emitting next link after maxRequests to avoid hanging the test
      if (requestCount < maxRequests) {
        headers["Link"] = `<http://127.0.0.1:${port}/api/v1/courses?page=${requestCount + 1}&per_page=10>; rel="next"`;
      }

      res.writeHead(200, headers);
      res.end(JSON.stringify([{ id: requestCount, name: `Course ${requestCount}`, course_code: `C${requestCount}`, enrollment_term_id: 1, workflow_state: "available", start_at: null, end_at: null }]));
    });

    const loopPort = await startServer(loopServer);

    const config: Config = {
      baseUrl: `http://127.0.0.1:${loopPort}/api/v1`,
      accessToken: "test-token-valid",
    };

    const client = new CanvasClient(config);
    const result = await client.getCourses();

    assert.equal(requestCount, maxRequests);
    assert.equal(result.length, maxRequests);

    await stopServer(loopServer);
  });
});
