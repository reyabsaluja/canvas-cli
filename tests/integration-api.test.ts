import assert from "node:assert/strict";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import { CanvasNotFoundError } from "../src/errors.js";
import { createMockCanvasServer, startServer, stopServer } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";
import type { Config } from "../src/config/env.js";

test("integration: mock Canvas API", async (t) => {
  const data = buildDefaultServerData();
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const config: Config = {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    accessToken: "test-token-valid",
  };

  t.after(async () => { await stopServer(server); });

  await t.test("getCourses returns all courses", async () => {
    const client = new CanvasClient(config);
    const courses = await client.getCourses();
    assert.equal(courses.length, 3);
    assert.equal(courses[0].name, "Introduction to Computer Science");
    assert.equal(courses[1].course_code, "CS202");
    assert.equal(courses[2].workflow_state, "completed");
  });

  await t.test("getAssignments returns assignments for a course", async () => {
    const client = new CanvasClient(config);
    const assignments = await client.getAssignments(101);
    assert.equal(assignments.length, 3);
    assert.equal(assignments[0].name, "Lab 1: Hello World");
    assert.equal(assignments[2].submission?.workflow_state, "graded");
  });

  await t.test("getAssignments returns empty for course with no assignments", async () => {
    const client = new CanvasClient(config);
    const assignments = await client.getAssignments(303);
    assert.equal(assignments.length, 0);
  });

  await t.test("getAssignmentDetail returns single assignment", async () => {
    const client = new CanvasClient(config);
    const detail = await client.getAssignmentDetail(101, 1001);
    assert.equal(detail.name, "Lab 1: Hello World");
    assert.equal(detail.points_possible, 10);
  });

  await t.test("getAssignmentDetail throws CanvasNotFoundError for non-existent assignment", async () => {
    const client = new CanvasClient(config);
    await assert.rejects(
      () => client.getAssignmentDetail(101, 9999),
      (err: unknown) => {
        assert.ok(err instanceof CanvasNotFoundError);
        assert.equal(err.kind, "not_found");
        return true;
      }
    );
  });

  await t.test("getCourseDetail returns course with syllabus", async () => {
    const client = new CanvasClient(config);
    const detail = await client.getCourseDetail(101);
    assert.equal(detail.name, "Introduction to Computer Science");
    assert.ok(detail.syllabus_body?.includes("CS101 course syllabus"));
  });

  await t.test("getModulesSafe returns modules for a course", async () => {
    const client = new CanvasClient(config);
    const modules = await client.getModulesSafe(101);
    assert.equal(modules.length, 2);
    assert.equal(modules[0].name, "Week 1: Getting Started");
    assert.equal(modules[1].name, "Week 2: Variables");
  });

  await t.test("getModuleItemsSafe returns items for a module", async () => {
    const client = new CanvasClient(config);
    const items = await client.getModuleItemsSafe(101, 10);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "Welcome Page");
    assert.equal(items[1].title, "Syllabus PDF");
  });

  await t.test("getPagesSafe returns pages for a course", async () => {
    const client = new CanvasClient(config);
    const pages = await client.getPagesSafe(101);
    assert.equal(pages.length, 2);
    assert.equal(pages[0].title, "Welcome to CS101");
  });

  await t.test("getPageBySlugSafe returns page content", async () => {
    const client = new CanvasClient(config);
    const page = await client.getPageBySlugSafe(101, "welcome");
    assert.ok(page);
    assert.equal(page.title, "Welcome to CS101");
    assert.ok(page.body?.includes("Welcome to Introduction"));
  });

  await t.test("getPageBySlugSafe returns null for missing page", async () => {
    const client = new CanvasClient(config);
    const page = await client.getPageBySlugSafe(101, "nonexistent");
    assert.equal(page, null);
  });

  await t.test("getFilesSafe returns files for a course", async () => {
    const client = new CanvasClient(config);
    const files = await client.getFilesSafe(101);
    assert.equal(files.length, 2);
    assert.equal(files[0].display_name, "syllabus.pdf");
    assert.equal(files[1].filename, "lab1-starter.zip");
  });

  await t.test("getFileSafe returns a single file by id", async () => {
    const client = new CanvasClient(config);
    const file = await client.getFileSafe(5001);
    assert.ok(file);
    assert.equal(file.display_name, "syllabus.pdf");
  });

  await t.test("getFileSafe returns null for missing file", async () => {
    const client = new CanvasClient(config);
    const file = await client.getFileSafe(9999);
    assert.equal(file, null);
  });

  await t.test("full flow: list courses → get assignments → get detail", async () => {
    const client = new CanvasClient(config);

    const courses = await client.getCourses();
    const csCourse = courses.find((c) => c.course_code === "CS101");
    assert.ok(csCourse);

    const assignments = await client.getAssignments(csCourse.id);
    const lab1 = assignments.find((a) => a.name.includes("Hello World"));
    assert.ok(lab1);

    const detail = await client.getAssignmentDetail(csCourse.id, lab1.id);
    assert.equal(detail.points_possible, 10);
    assert.ok(detail.description?.includes("Hello World"));
  });

});
