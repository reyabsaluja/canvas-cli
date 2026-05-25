import assert from "node:assert/strict";
import test from "node:test";
import chalk from "chalk";
import {
  parseTimelineArgs,
  resolveTimeWindow,
  renderBar,
  buildTimelineOutput,
  type TimelineAssignment,
  type TimelineCourse,
} from "../src/tui/timeline.js";

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

test("timeline", async (t) => {
  await t.test("parseTimelineArgs: default with no args", () => {
    const result = parseTimelineArgs("");
    assert.equal(result.window, "default");
    assert.equal(result.showAll, false);
  });

  await t.test("parseTimelineArgs: week", () => {
    const result = parseTimelineArgs("week");
    assert.equal(result.window, "week");
    assert.equal(result.showAll, false);
  });

  await t.test("parseTimelineArgs: semester with --all", () => {
    const result = parseTimelineArgs("semester --all");
    assert.equal(result.window, "semester");
    assert.equal(result.showAll, true);
  });

  await t.test("parseTimelineArgs: next 2 weeks", () => {
    const result = parseTimelineArgs("next 2 weeks");
    assert.equal(result.window, "next 2 weeks");
    assert.equal(result.showAll, false);
  });

  await t.test("parseTimelineArgs: --all mid-phrase normalizes whitespace", () => {
    const result = parseTimelineArgs("next --all 2 weeks");
    assert.equal(result.window, "next 2 weeks");
    assert.equal(result.showAll, true);
  });

  await t.test("resolveTimeWindow: default returns 2 weeks back, 4 weeks forward", () => {
    const { window } = resolveTimeWindow("default", []);
    const now = Date.now();
    const startDiff = Math.abs(window.start.getTime() - (now - 14 * 86400000));
    const endDiff = Math.abs(window.end.getTime() - (now + 28 * 86400000));
    assert.ok(startDiff < 2000);
    assert.ok(endDiff < 2000);
  });

  await t.test("resolveTimeWindow: week returns Mon-Sun of current week", () => {
    const { window } = resolveTimeWindow("week", []);
    assert.equal(window.start.getDay(), 1);
    assert.equal(window.end.getDay(), 0);
  });

  await t.test("resolveTimeWindow: month returns first-to-last of current month", () => {
    const { window } = resolveTimeWindow("month", []);
    assert.equal(window.start.getDate(), 1);
    const nextDay = new Date(window.end);
    nextDay.setDate(nextDay.getDate() + 1);
    assert.equal(nextDay.getDate(), 1);
  });

  await t.test("resolveTimeWindow: semester spans assignment dates", () => {
    const assignments: TimelineAssignment[] = [
      { name: "A", dueAt: new Date("2026-01-15"), unlockAt: null, lockAt: null, submitted: false, graded: false },
      { name: "B", dueAt: new Date("2026-05-20"), unlockAt: null, lockAt: null, submitted: false, graded: false },
    ];
    const { window } = resolveTimeWindow("semester", assignments);
    assert.ok(window.start.getTime() < new Date("2026-01-15").getTime());
    assert.ok(window.end.getTime() > new Date("2026-05-20").getTime());
  });

  await t.test("resolveTimeWindow: semester with no dated assignments returns fallback warning", () => {
    const assignments: TimelineAssignment[] = [
      { name: "A", dueAt: null, unlockAt: null, lockAt: null, submitted: false, graded: false },
    ];
    const { fallback } = resolveTimeWindow("semester", assignments);
    assert.ok(fallback);
    assert.match(fallback, /No dated assignments/);
  });

  await t.test("resolveTimeWindow: next N weeks", () => {
    const { window } = resolveTimeWindow("next 3 weeks", []);
    const now = Date.now();
    const expectedEnd = now + 21 * 86400000;
    assert.ok(Math.abs(window.end.getTime() - expectedEnd) < 2000);
  });

  await t.test("buildTimelineOutput: no visible assignments and no extras returns guidance", () => {
    const farFuture = new Date();
    farFuture.setFullYear(farFuture.getFullYear() + 5);
    const courses: TimelineCourse[] = [
      {
        name: "CS 301",
        assignments: [
          { name: "HW 1", dueAt: farFuture, unlockAt: null, lockAt: null, submitted: false, graded: false },
        ],
      },
    ];
    const result = buildTimelineOutput(courses, "week", false, []);
    assert.match(result, /Nothing due in this window/);
  });

  await t.test("buildTimelineOutput: all submitted shows caught up message with chart", () => {
    const courses: TimelineCourse[] = [
      {
        name: "CS 301",
        assignments: [
          { name: "HW 1", dueAt: new Date(), unlockAt: null, lockAt: null, submitted: true, graded: false },
        ],
      },
    ];
    const result = buildTimelineOutput(courses, "default", false, []);
    assert.match(result, /all caught up/);
    assert.ok(result.includes("CS 301"));
  });

  await t.test("buildTimelineOutput: all submitted outside window returns caught up only", () => {
    const farPast = new Date();
    farPast.setFullYear(farPast.getFullYear() - 2);
    const courses: TimelineCourse[] = [
      {
        name: "CS 301",
        assignments: [
          { name: "HW 1", dueAt: farPast, unlockAt: null, lockAt: null, submitted: true, graded: false },
        ],
      },
    ];
    const result = buildTimelineOutput(courses, "default", false, []);
    assert.match(result, /all caught up/);
  });

  await t.test("buildTimelineOutput: no assignments in window shows guidance", () => {
    const farFuture = new Date();
    farFuture.setFullYear(farFuture.getFullYear() + 5);
    const courses: TimelineCourse[] = [
      {
        name: "CS 301",
        assignments: [
          { name: "HW 1", dueAt: farFuture, unlockAt: null, lockAt: null, submitted: false, graded: false },
        ],
      },
    ];
    const result = buildTimelineOutput(courses, "week", false, []);
    assert.match(result, /Nothing due in this window/);
  });

  await t.test("buildTimelineOutput: renders chart with assignments in window", () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const courses: TimelineCourse[] = [
      {
        name: "CS 301",
        assignments: [
          { name: "HW 5", dueAt: soon, unlockAt: null, lockAt: null, submitted: false, graded: false },
        ],
      },
    ];
    const result = buildTimelineOutput(courses, "default", false, []);
    assert.ok(result.includes("CS 301"));
    assert.ok(result.includes("HW 5"));
    assert.ok(result.includes("TODAY"));
  });

  await t.test("buildTimelineOutput: includes warnings", () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const courses: TimelineCourse[] = [
      {
        name: "CS 301",
        assignments: [
          { name: "HW 5", dueAt: soon, unlockAt: null, lockAt: null, submitted: false, graded: false },
        ],
      },
    ];
    const result = buildTimelineOutput(courses, "default", false, [
      "Could not fetch MATH 240 (access denied)",
    ]);
    assert.ok(result.includes("MATH 240"));
  });

  await t.test("buildTimelineOutput: legend is shown", () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const courses: TimelineCourse[] = [
      {
        name: "CS 301",
        assignments: [
          { name: "HW 5", dueAt: soon, unlockAt: null, lockAt: null, submitted: false, graded: false },
        ],
      },
    ];
    const result = buildTimelineOutput(courses, "default", false, []);
    assert.ok(result.includes("available"));
    assert.ok(result.includes("urgent"));
    assert.ok(result.includes("overdue"));
  });

  await t.test("renderBar: point event when startCol equals dueCol", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const dueAt = new Date("2026-03-15T12:00:00Z");
    const assignment: TimelineAssignment = {
      name: "Quiz", dueAt, unlockAt: new Date("2026-03-15T10:00:00Z"), lockAt: null, submitted: false, graded: false,
    };
    const chartWidth = 10;
    const toCol = (_date: Date) => 5;
    const bar = stripAnsi(renderBar(assignment, toCol, chartWidth, now, chalk.red));
    assert.equal(bar[5], "■");
    assert.equal(bar.trim(), "■");
  });

  await t.test("renderBar: submitted point event is dimmed", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const dueAt = new Date("2026-03-15T12:00:00Z");
    const assignment: TimelineAssignment = {
      name: "Quiz", dueAt, unlockAt: new Date("2026-03-15T10:00:00Z"), lockAt: null, submitted: true, graded: false,
    };
    const chartWidth = 10;
    const toCol = (_date: Date) => 5;
    const bar = stripAnsi(renderBar(assignment, toCol, chartWidth, now, chalk.red));
    assert.equal(bar[5], "■");
  });

  await t.test("renderBar: overdue extends past due date to now", () => {
    const now = new Date("2026-03-20T12:00:00Z");
    const dueAt = new Date("2026-03-15T12:00:00Z");
    const assignment: TimelineAssignment = {
      name: "HW", dueAt, unlockAt: new Date("2026-03-10T00:00:00Z"), lockAt: null, submitted: false, graded: false,
    };
    const chartWidth = 20;
    const toCol = (date: Date) => {
      const base = new Date("2026-03-08T00:00:00Z").getTime();
      const span = 20 * 86400000;
      return Math.round(((date.getTime() - base) / span) * 19);
    };
    const bar = stripAnsi(renderBar(assignment, toCol, chartWidth, now, chalk.blue));
    const nowCol = toCol(now);
    const dueCol = toCol(dueAt);
    for (let i = dueCol + 1; i <= nowCol && i < chartWidth; i++) {
      assert.equal(bar[i], "▓", `expected ▓ at col ${i}`);
    }
  });

  await t.test("renderBar: urgent zone uses bold block chars", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const dueAt = new Date("2026-03-12T12:00:00Z");
    const assignment: TimelineAssignment = {
      name: "HW", dueAt, unlockAt: new Date("2026-03-05T00:00:00Z"), lockAt: null, submitted: false, graded: false,
    };
    const chartWidth = 20;
    const base = new Date("2026-03-04T00:00:00Z").getTime();
    const span = 14 * 86400000;
    const toCol = (date: Date) => Math.round(((date.getTime() - base) / span) * 19);
    const bar = stripAnsi(renderBar(assignment, toCol, chartWidth, now, chalk.green));
    const startCol = toCol(assignment.unlockAt!);
    const dueCol = toCol(dueAt);
    assert.ok(bar.slice(startCol, dueCol + 1).includes("░"));
    assert.ok(bar.slice(startCol, dueCol + 1).includes("█"));
  });

  await t.test("renderBar: submitted assignment uses light chars", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const dueAt = new Date("2026-03-15T12:00:00Z");
    const assignment: TimelineAssignment = {
      name: "HW", dueAt, unlockAt: new Date("2026-03-08T00:00:00Z"), lockAt: null, submitted: true, graded: false,
    };
    const chartWidth = 20;
    const base = new Date("2026-03-06T00:00:00Z").getTime();
    const span = 14 * 86400000;
    const toCol = (date: Date) => Math.round(((date.getTime() - base) / span) * 19);
    const bar = stripAnsi(renderBar(assignment, toCol, chartWidth, now, chalk.yellow));
    const startCol = toCol(assignment.unlockAt!);
    const dueCol = toCol(dueAt);
    for (let i = startCol; i <= dueCol; i++) {
      assert.equal(bar[i], "░", `expected ░ at col ${i}`);
    }
  });
});
