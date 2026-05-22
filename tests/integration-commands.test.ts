import assert from "node:assert/strict";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import { createMockCanvasServer, startServer, stopServer } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";
import { normalizeCourse, normalizeAssignment } from "../src/domain/normalize.js";
import { filterRelevantAssignments } from "../src/domain/assignment-relevance.js";
import { matchCourses } from "../src/domain/matching.js";
import { sortByUrgency } from "../src/domain/sorting.js";
import { renderCourseList } from "../src/format/render-courses.js";
import { renderAssignments } from "../src/format/render-assignments.js";
import type { Config } from "../src/config/env.js";

test("integration: command-level flows against mock API", async (t) => {
  const data = buildDefaultServerData();
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const config: Config = {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    accessToken: "test-token-valid",
  };

  t.after(async () => { await stopServer(server); });

  await t.test("courses flow: list → normalize → render", async () => {
    const client = new CanvasClient(config);
    const rawCourses = await client.getCourses();
    const allCourses = rawCourses.map(normalizeCourse);

    assert.equal(allCourses.length, 3);

    const currentCourses = allCourses.filter((c) => c.isCurrent);
    assert.equal(currentCourses.length, 2);
    assert.ok(currentCourses.some((c) => c.courseCode === "CS101"));
    assert.ok(currentCourses.some((c) => c.courseCode === "CS202"));

    const output = renderCourseList(currentCourses, false);
    assert.ok(output.includes("CS101"));
    assert.ok(output.includes("CS202"));
    assert.ok(!output.includes("HIST303"));
  });

  await t.test("courses flow: --all shows completed courses", async () => {
    const client = new CanvasClient(config);
    const rawCourses = await client.getCourses();
    const allCourses = rawCourses.map(normalizeCourse);

    const output = renderCourseList(allCourses, true);
    assert.ok(output.includes("HIST303"));
  });

  await t.test("assignments flow: fetch → normalize → filter → sort", async () => {
    const client = new CanvasClient(config);
    const rawCourses = await client.getCourses();
    const courses = rawCourses.map(normalizeCourse);
    const currentCourses = courses.filter((c) => c.isCurrent);

    const allAssignments = [];
    for (const course of currentCourses) {
      const raw = await client.getAssignments(course.id);
      allAssignments.push(...raw.map((a) => normalizeAssignment(a, course.name)));
    }

    assert.equal(allAssignments.length, 4);

    const filtered = filterRelevantAssignments(allAssignments, {});
    const sorted = sortByUrgency(filtered);

    assert.ok(sorted.length <= allAssignments.length);
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].dueAt && sorted[i + 1].dueAt) {
        assert.ok(sorted[i].dueAt! <= sorted[i + 1].dueAt!);
      }
    }
  });

  await t.test("assignments flow: --course filter narrows to one course", async () => {
    const client = new CanvasClient(config);
    const rawCourses = await client.getCourses();
    const courses = rawCourses.map(normalizeCourse);

    const matches = matchCourses("CS101", courses);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].courseCode, "CS101");

    const assignments = await client.getAssignments(matches[0].id);
    const normalized = assignments.map((a) => normalizeAssignment(a, matches[0].name));
    assert.equal(normalized.length, 3);
  });

  await t.test("assignments flow: --course with ambiguous query returns multiple matches", async () => {
    const client = new CanvasClient(config);
    const rawCourses = await client.getCourses();
    const courses = rawCourses.map(normalizeCourse);

    const matches = matchCourses("CS", courses);
    assert.ok(matches.length >= 2);
  });

  await t.test("assignments flow: --all includes graded assignments", async () => {
    const client = new CanvasClient(config);
    const rawCourses = await client.getCourses();
    const courses = rawCourses.map(normalizeCourse);
    const csCourse = courses.find((c) => c.courseCode === "CS101")!;

    const raw = await client.getAssignments(csCourse.id);
    const normalized = raw.map((a) => normalizeAssignment(a, csCourse.name));

    const allFiltered = filterRelevantAssignments(normalized, { all: true });
    assert.equal(allFiltered.length, 3);

    const defaultFiltered = filterRelevantAssignments(normalized, {});
    assert.ok(defaultFiltered.length <= allFiltered.length);
  });

  await t.test("show assignment flow: pick course → get detail", async () => {
    const client = new CanvasClient(config);
    const rawCourses = await client.getCourses();
    const courses = rawCourses.map(normalizeCourse);

    const matches = matchCourses("CS101", courses);
    assert.equal(matches.length, 1);

    const detail = await client.getAssignmentDetail(matches[0].id, 1001);
    assert.equal(detail.name, "Lab 1: Hello World");
    assert.ok(detail.description?.includes("Hello World"));
    assert.equal(detail.points_possible, 10);
  });

  await t.test("assignment rendering produces readable output", async () => {
    const client = new CanvasClient(config);
    const rawCourses = await client.getCourses();
    const courses = rawCourses.map(normalizeCourse);
    const csCourse = courses.find((c) => c.courseCode === "CS101")!;

    const raw = await client.getAssignments(csCourse.id);
    const normalized = raw.map((a) => normalizeAssignment(a, csCourse.name));
    const sorted = sortByUrgency(normalized);

    const output = renderAssignments(sorted, { groupByCourse: false });
    assert.ok(output.includes("Lab 1"));
    assert.ok(output.includes("Lab 2"));
  });

});
