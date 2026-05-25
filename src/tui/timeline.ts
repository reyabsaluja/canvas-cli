import chalk, { type ChalkInstance } from "chalk";
import type { CanvasClient } from "../canvas/client.js";
import type { Course } from "../domain/models.js";
import { getTermSize, truncatePlainToWidth } from "./screen.js";

export interface TimelineAssignment {
  name: string;
  dueAt: Date | null;
  unlockAt: Date | null;
  lockAt: Date | null;
  submitted: boolean;
  graded: boolean;
}

export interface TimelineCourse {
  name: string;
  assignments: TimelineAssignment[];
}

interface TimeWindow {
  start: Date;
  end: Date;
}

const COURSE_COLORS: ChalkInstance[] = [
  chalk.red,
  chalk.blue,
  chalk.green,
  chalk.yellow,
  chalk.magenta,
  chalk.cyan,
];

export function parseTimelineArgs(args: string): { window: string; showAll: boolean } {
  const trimmed = args.trim();
  const showAll = trimmed.includes("--all");
  const cleaned = trimmed.replace(/--all/g, "").replace(/\s+/g, " ").trim();
  return { window: cleaned || "default", showAll };
}

export function resolveTimeWindow(windowArg: string, assignments: TimelineAssignment[]): TimeWindow {
  const now = new Date();

  if (windowArg === "default" || !windowArg) {
    const start = new Date(now);
    start.setDate(start.getDate() - 14);
    const end = new Date(now);
    end.setDate(end.getDate() + 28);
    return { start, end };
  }

  if (windowArg === "week") {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return { start: monday, end: sunday };
  }

  if (windowArg === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start, end };
  }

  if (windowArg === "semester") {
    const dates = assignments
      .map((a) => a.dueAt)
      .filter((d): d is Date => d !== null);
    if (dates.length === 0) {
      const start = new Date(now);
      start.setDate(start.getDate() - 14);
      const end = new Date(now);
      end.setDate(end.getDate() + 28);
      return { start, end };
    }
    const earliest = new Date(Math.min(...dates.map((d) => d.getTime())));
    const latest = new Date(Math.max(...dates.map((d) => d.getTime())));
    earliest.setDate(earliest.getDate() - 3);
    latest.setDate(latest.getDate() + 3);
    return { start: earliest, end: latest };
  }

  const nextMatch = windowArg.match(/^next\s+(\d+)\s+(week|weeks|day|days|month|months)$/i);
  if (nextMatch) {
    const count = parseInt(nextMatch[1]!, 10);
    const unit = nextMatch[2]!.toLowerCase();
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    const end = new Date(now);
    if (unit.startsWith("week")) {
      end.setDate(end.getDate() + count * 7);
    } else if (unit.startsWith("day")) {
      end.setDate(end.getDate() + count);
    } else if (unit.startsWith("month")) {
      end.setMonth(end.getMonth() + count);
    }
    return { start, end };
  }

  const start = new Date(now);
  start.setDate(start.getDate() - 14);
  const end = new Date(now);
  end.setDate(end.getDate() + 28);
  return { start, end };
}

export async function fetchTimelineData(
  client: CanvasClient,
  courses: Course[],
  showAll: boolean,
  signal?: AbortSignal | null
): Promise<{ data: TimelineCourse[]; warnings: string[] }> {
  const results: TimelineCourse[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i]!;

    if (signal?.aborted) break;

    if (courses.length > 8 && i > 0 && i % 8 === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }

    try {
      const raw = await client.getAssignments(course.id, signal);
      const assignments: TimelineAssignment[] = raw
        .filter((a) => showAll || a.submission?.workflow_state !== "graded")
        .map((a) => ({
          name: a.name,
          dueAt: a.due_at ? new Date(a.due_at) : null,
          unlockAt: a.unlock_at ? new Date(a.unlock_at) : null,
          lockAt: a.lock_at ? new Date(a.lock_at) : null,
          submitted: a.has_submitted_submissions || a.submission?.workflow_state === "submitted",
          graded: a.submission?.workflow_state === "graded",
        }));

      results.push({ name: course.name, assignments });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      warnings.push(`Could not fetch ${course.name} (access denied — enrollment may have ended)`);
    }
  }

  return { data: results, warnings };
}

export function renderTimeline(
  courses: TimelineCourse[],
  window: TimeWindow,
  warnings: string[]
): string {
  const { cols } = getTermSize();
  const now = new Date();
  const narrow = cols < 80;

  const maxCourseName = narrow ? 8 : 14;
  const maxAssignmentName = narrow ? 16 : 28;
  const gutterWidth = maxCourseName + maxAssignmentName + 4;
  const chartWidth = Math.max(20, cols - gutterWidth - 2);

  const windowStart = window.start.getTime();
  const windowEnd = window.end.getTime();
  const windowSpan = windowEnd - windowStart;

  const toCol = (date: Date): number => {
    const offset = date.getTime() - windowStart;
    return Math.round((offset / windowSpan) * (chartWidth - 1));
  };

  const lines: string[] = [];

  lines.push(renderTimeAxis(window, gutterWidth, chartWidth, now, narrow));
  lines.push(renderTodayMarker(window, gutterWidth, chartWidth, now));

  const noDueDateAssignments: Array<{ courseName: string; name: string; colorIdx: number }> = [];

  for (let ci = 0; ci < courses.length; ci++) {
    const course = courses[ci]!;
    const color = COURSE_COLORS[ci % COURSE_COLORS.length]!;
    const colorIdx = ci % COURSE_COLORS.length;

    const visible = course.assignments.filter((a) => {
      if (!a.dueAt) return false;
      return a.dueAt.getTime() >= windowStart && a.dueAt.getTime() <= windowEnd;
    });

    const noDue = course.assignments.filter((a) => !a.dueAt);
    for (const a of noDue) {
      noDueDateAssignments.push({ courseName: course.name, name: a.name, colorIdx });
    }

    if (visible.length === 0 && noDue.length === 0) continue;

    const courseLabel = truncatePlainToWidth(course.name, maxCourseName);
    lines.push(`  ${color.bold(courseLabel)}`);

    const sorted = [...visible].sort(
      (a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0)
    );

    for (const assignment of sorted) {
      const assignLabel = truncatePlainToWidth(assignment.name, maxAssignmentName);
      const gutter = " ".repeat(4) + assignLabel;
      const gutterPad = " ".repeat(Math.max(0, gutterWidth - gutter.length));
      const bar = renderBar(assignment, toCol, chartWidth, now, color);
      lines.push(`${gutter}${gutterPad}${bar}`);
    }
  }

  if (noDueDateAssignments.length > 0) {
    lines.push("");
    lines.push(`  ${chalk.dim("No due date")}`);
    for (const item of noDueDateAssignments.slice(0, 10)) {
      const label = truncatePlainToWidth(`${item.courseName}: ${item.name}`, gutterWidth + chartWidth - 4);
      lines.push(`    ${chalk.dim(label)}`);
    }
    if (noDueDateAssignments.length > 10) {
      lines.push(`    ${chalk.dim(`... and ${noDueDateAssignments.length - 10} more`)}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("");
    for (const w of warnings) {
      lines.push(`  ${chalk.yellow("⚠")} ${chalk.dim(w)}`);
    }
  }

  lines.push("");
  lines.push(renderLegend());

  return lines.join("\n");
}

function renderTimeAxis(
  window: TimeWindow,
  gutterWidth: number,
  chartWidth: number,
  now: Date,
  narrow: boolean
): string {
  const windowStart = window.start.getTime();
  const windowEnd = window.end.getTime();
  const windowSpan = windowEnd - windowStart;

  const labelInterval = narrow ? 14 : 7;
  const labels: Array<{ col: number; text: string }> = [];

  const cursor = new Date(window.start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getDay() !== 1) {
    cursor.setDate(cursor.getDate() + 1);
  }

  while (cursor.getTime() <= windowEnd) {
    const col = Math.round(
      ((cursor.getTime() - windowStart) / windowSpan) * (chartWidth - 1)
    );
    if (col >= 0 && col < chartWidth) {
      const text = cursor.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      labels.push({ col, text });
    }
    cursor.setDate(cursor.getDate() + labelInterval);
  }

  const axisChars = new Array(chartWidth).fill(" ");
  let lastEnd = -1;
  for (const label of labels) {
    if (label.col <= lastEnd) continue;
    for (let i = 0; i < label.text.length && label.col + i < chartWidth; i++) {
      axisChars[label.col + i] = label.text[i]!;
    }
    lastEnd = label.col + label.text.length;
  }

  const gutter = " ".repeat(gutterWidth);
  return `${gutter}${chalk.dim(axisChars.join(""))}`;
}

function renderTodayMarker(
  window: TimeWindow,
  gutterWidth: number,
  chartWidth: number,
  now: Date
): string {
  const windowStart = window.start.getTime();
  const windowEnd = window.end.getTime();
  const windowSpan = windowEnd - windowStart;
  const nowCol = Math.round(
    ((now.getTime() - windowStart) / windowSpan) * (chartWidth - 1)
  );

  const markerChars = new Array(chartWidth).fill(" ");

  if (nowCol >= 0 && nowCol < chartWidth) {
    const text = "▼ TODAY";
    if (nowCol + text.length <= chartWidth) {
      for (let i = 0; i < text.length; i++) {
        markerChars[nowCol + i] = text[i]!;
      }
    } else {
      markerChars[nowCol] = "▼";
    }
  }

  const gutter = " ".repeat(gutterWidth);
  return `${gutter}${chalk.white.bold(markerChars.join(""))}`;
}

function renderBar(
  assignment: TimelineAssignment,
  toCol: (date: Date) => number,
  chartWidth: number,
  now: Date,
  courseColor: ChalkInstance
): string {
  const barChars = new Array(chartWidth).fill(" ");

  if (!assignment.dueAt) return barChars.join("");

  const dueCol = Math.max(0, Math.min(chartWidth - 1, toCol(assignment.dueAt)));
  const urgentStart = new Date(assignment.dueAt);
  urgentStart.setHours(urgentStart.getHours() - 48);

  const hasWindow = assignment.unlockAt !== null;
  let startCol: number;

  if (hasWindow) {
    startCol = Math.max(0, Math.min(chartWidth - 1, toCol(assignment.unlockAt!)));
  } else {
    const impliedStart = new Date(assignment.dueAt);
    impliedStart.setDate(impliedStart.getDate() - 7);
    startCol = Math.max(0, Math.min(chartWidth - 1, toCol(impliedStart)));
  }

  if (startCol === dueCol) {
    if (assignment.submitted) {
      barChars[dueCol] = chalk.dim("■");
    } else if (assignment.dueAt.getTime() < now.getTime()) {
      barChars[dueCol] = chalk.red("■");
    } else {
      barChars[dueCol] = courseColor.bold("■");
    }
    return barChars.join("");
  }

  const urgentCol = Math.max(startCol, Math.min(chartWidth - 1, toCol(urgentStart)));

  for (let col = startCol; col <= dueCol && col < chartWidth; col++) {
    if (assignment.submitted) {
      barChars[col] = chalk.dim("░");
    } else if (assignment.dueAt.getTime() < now.getTime()) {
      if (col >= urgentCol) {
        barChars[col] = chalk.red("▓");
      } else {
        barChars[col] = courseColor("░");
      }
    } else if (col >= urgentCol) {
      barChars[col] = courseColor.bold("█");
    } else {
      barChars[col] = courseColor("░");
    }
  }

  if (
    !assignment.submitted &&
    assignment.dueAt.getTime() < now.getTime()
  ) {
    const nowCol = Math.max(0, Math.min(chartWidth - 1, toCol(now)));
    for (let col = dueCol + 1; col <= nowCol && col < chartWidth; col++) {
      barChars[col] = chalk.red("▓");
    }
  }

  return barChars.join("");
}

function renderLegend(): string {
  return [
    chalk.dim("  ░░░░ available   ████ urgent (48h)   ▓▓ overdue   ■ point event"),
  ].join("\n");
}

export function buildTimelineOutput(
  courses: TimelineCourse[],
  windowArg: string,
  showAll: boolean,
  warnings: string[]
): string {
  const allAssignments = courses.flatMap((c) => c.assignments);

  if (courses.length === 0) {
    return "No courses set up yet. Run /courses to add your courses.";
  }

  const window = resolveTimeWindow(windowArg, allAssignments);

  const visibleAssignments = allAssignments.filter((a) => {
    if (!a.dueAt) return false;
    return a.dueAt.getTime() >= window.start.getTime() && a.dueAt.getTime() <= window.end.getTime();
  });

  const allSubmitted = allAssignments.length > 0 && allAssignments.every((a) => a.dueAt === null || a.submitted);

  if (visibleAssignments.length === 0 && allSubmitted) {
    return "You're all caught up. Nothing outstanding.";
  }

  if (visibleAssignments.length === 0) {
    return "Nothing due in this window. Try /timeline semester to see the full picture.";
  }

  const chart = renderTimeline(courses, window, warnings);
  if (allSubmitted) {
    return "You're all caught up. Nothing outstanding.\n\n" + chart;
  }

  return chart;
}
