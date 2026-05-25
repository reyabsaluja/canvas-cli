import assert from "node:assert/strict";
import test from "node:test";
import { handleCommand } from "../src/tui/app-commands.js";
import type { AppServices } from "../src/tui/services/types.js";
import type { CommandApi } from "../src/tui/app-types.js";
import type { Course } from "../src/domain/models.js";

const fakeCourse: Course = {
  id: 42,
  name: "Test Course",
  courseCode: "TEST101",
  termName: "Fall 2025",
  isCurrent: true,
};

function makeServices(courses: Course[] = [fakeCourse]): AppServices {
  return {
    client: {} as any,
    config: { baseUrl: "https://example.com", accessToken: "fake" },
    aiConfig: null,
    rawCourses: [] as any,
    allCourses: courses,
    courseConfig: null,
    assignmentCache: new Map(),
    radar: {} as any,
    resolvedAssignments: new Map(),
    activeIngestionAc: null,
  };
}

function makeApi(scope: { type: string; courseId?: number }): CommandApi {
  const messages: unknown[] = [];
  return {
    runtime: { scope } as any,
    addMessage: async (msg: unknown) => { messages.push(msg); },
    messages,
  } as any;
}

test("/refresh at course scope returns course-refresh result", async () => {
  const services = makeServices();
  const api = makeApi({ type: "course", courseId: 42 });
  const result = await handleCommand("/refresh", "", api, services);
  assert.deepEqual(result, { type: "course-refresh", courseId: 42 });
});

test("/refresh at course scope with missing course returns scope:global", async () => {
  const services = makeServices([]);
  const api = makeApi({ type: "course", courseId: 999 });
  const result = await handleCommand("/refresh", "", api, services);
  assert.deepEqual(result, { type: "scope", scope: { type: "global" } });
});
