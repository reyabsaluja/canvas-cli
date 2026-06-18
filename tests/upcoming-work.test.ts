import assert from "node:assert/strict";
import test from "node:test";
import type { Assignment } from "../src/domain/models.js";
import {
  buildCourseIntroMessages,
  buildGlobalIntroMessages,
} from "../src/tui/app-workspace-content.js";
import { fetchUpcomingAssignments } from "../src/tui/services.js";

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  const dueAt = Object.hasOwn(overrides, "dueAt")
    ? (overrides.dueAt ?? null)
    : new Date(Date.now() + 24 * 60 * 60 * 1000);
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? "Upcoming Lab",
    courseId: overrides.courseId ?? 17,
    courseName: overrides.courseName ?? "ECE243",
    dueAt,
    submitted: overrides.submitted ?? false,
    status: overrides.status ?? (dueAt ? "upcoming" : "no_date"),
    htmlUrl: overrides.htmlUrl ?? "https://canvas.example/assignments/1",
  };
}

test("fetchUpcomingAssignments only returns unsubmitted assignments with future due dates", async () => {
  const now = Date.now();
  const soon = new Date(now + 24 * 60 * 60 * 1000);
  const later = new Date(now + 2 * 24 * 60 * 60 * 1000);
  const past = new Date(now - 24 * 60 * 60 * 1000);

  const services = {
    allCourses: [
      {
        id: 17,
        name: "ECE243",
        courseCode: "ECE243H1",
        termName: "Winter 2026",
        publicDescription: null,
        isCurrent: true,
      },
    ],
    courseConfig: null,
    assignmentCache: new Map(),
    client: {
      async getAssignments(courseId: number) {
        return [
          {
            id: 1,
            name: "Future Lab",
            course_id: courseId,
            due_at: soon.toISOString(),
            has_submitted_submissions: false,
            html_url: "https://canvas.example/future-lab",
          },
          {
            id: 2,
            name: "Overdue Submission Shell",
            course_id: courseId,
            due_at: past.toISOString(),
            has_submitted_submissions: false,
            html_url: "https://canvas.example/old-shell",
          },
          {
            id: 3,
            name: "No Due Date Shell",
            course_id: courseId,
            due_at: null,
            has_submitted_submissions: false,
            html_url: "https://canvas.example/no-date",
          },
          {
            id: 4,
            name: "Submitted Future Quiz",
            course_id: courseId,
            due_at: later.toISOString(),
            has_submitted_submissions: true,
            submission: { workflow_state: "submitted" },
            html_url: "https://canvas.example/submitted",
          },
        ];
      },
    },
  } as any;

  const upcoming = await fetchUpcomingAssignments(services, 10);

  assert.deepEqual(
    upcoming.map((item) => item.name),
    ["Future Lab"]
  );
});

test("global intro hides overdue and no-date assignments from Upcoming assignments", () => {
  const now = Date.now();
  const messages = buildGlobalIntroMessages(
    [],
    [
      assignment({ name: "Future Lab", dueAt: new Date(now + 60 * 60 * 1000) }),
      assignment({
        id: 2,
        name: "Overdue Submission Shell",
        dueAt: new Date(now - 60 * 60 * 1000),
        status: "overdue",
      }),
      assignment({
        id: 3,
        name: "No Due Date Shell",
        dueAt: null,
        status: "no_date",
      }),
    ],
    []
  );

  const content = messages.map((message) => message.content).join("\n");
  assert.match(content, /Upcoming assignments/);
  assert.match(content, /Future Lab/);
  assert.doesNotMatch(content, /Overdue Submission Shell/);
  assert.doesNotMatch(content, /No Due Date Shell/);
});

test("course intro omits upcoming work summaries", () => {
  const now = Date.now();
  const messages = buildCourseIntroMessages(
    {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      publicDescription: null,
      isCurrent: true,
    },
    [
      assignment({ name: "Future Lab", dueAt: new Date(now + 60 * 60 * 1000) }),
      assignment({
        id: 2,
        name: "Overdue Submission Shell",
        dueAt: new Date(now - 60 * 60 * 1000),
        status: "overdue",
      }),
    ],
    false
  );

  assert.deepEqual(messages, []);
});
