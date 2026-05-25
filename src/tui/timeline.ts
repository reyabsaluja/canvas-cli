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

export const NO_COURSES_MESSAGE = "No courses set up yet. Run /courses to add your courses.";

const COURSE_COLORS: ChalkInstance[] = [
  chalk.red,
  chalk.blue,
  chalk.green,
  chalk.yellow,
  chalk.magenta,
  chalk.cyan,
];

export function parseTimelineArgs(args: string): { window: string; showAll: boolean; error?: string } {
  const trimmed = args.trim();
  const showAll = trimmed.includes("--all");
  const cleaned = trimmed.replace(/--all/g, "").replace(/\s+/g, " ").trim();
  if (cleaned && !isValidTimelineArg(cleaned)) {
    return { window: "default", showAll, error: `Unknown argument "${cleaned}". Usage: /timeline [week | month | semester | next N days/weeks] [--all]` };
  }
  return { window: cleaned || "default", showAll };
}

function isValidTimelineArg(arg: string): boolean {
  if (["week", "month", "semester", "default"].includes(arg)) return true;
  if (/^next\s+\d+\s+(week|weeks|day|days|month|months)$/i.test(arg)) return true;
  return false;
}

export interface ResolvedWindow {
  window: TimeWindow;
  fallback?: string;
}

export function resolveTimeWindow(windowArg: string, assignments: TimelineAssignment[]): ResolvedWindow {
  const now = new Date();

  if (windowArg === "default" || !windowArg) {
    const start = new Date(now);
    start.setDate(start.getDate() - 14);
    const end = new Date(now);
    end.setDate(end.getDate() + 28);
    return { window: { start, end } };
  }

  if (windowArg === "week") {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return { window: { start: monday, end: sunday } };
  }

  if (windowArg === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { window: { start, end } };
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
      return { window: { start, end }, fallback: "No dated assignments found — showing default window." };
    }
    const earliest = new Date(Math.min(...dates.map((d) => d.getTime())));
    const latest = new Date(Math.max(...dates.map((d) => d.getTime())));
    earliest.setDate(earliest.getDate() - 3);
    latest.setDate(latest.getDate() + 3);
    return { window: { start: earliest, end: latest } };
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
    return { window: { start, end } };
  }

  const start = new Date(now);
  start.setDate(start.getDate() - 14);
  const end = new Date(now);
  end.setDate(end.getDate() + 28);
  return { window: { start, end } };
}

export async function fetchTimelineData(
  client: CanvasClient,
  courses: Course[],
  showAll: boolean,
  signal?: AbortSignal | null
): Promise<{ data: TimelineCourse[]; warnings: string[] }> {
  const results: TimelineCourse[] = [];
  const warnings: string[] = [];

  const fetchOne = async (course: Course): Promise<void> => {
    if (signal?.aborted) return;
    try {
      const raw = await client.getAssignments(course.id, signal);
      const assignments: TimelineAssignment[] = raw
        .filter((a) => showAll || a.submission?.workflow_state !== "graded")
        .map((a) => ({
          name: a.name,
          dueAt: a.due_at ? new Date(a.due_at) : null,
          unlockAt: a.unlock_at != null ? new Date(a.unlock_at) : null,
          lockAt: a.lock_at != null ? new Date(a.lock_at) : null,
          submitted: a.has_submitted_submissions || a.submission?.workflow_state === "submitted",
          graded: a.submission?.workflow_state === "graded",
        }));
      results.push({ name: course.name, assignments });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      warnings.push(`Could not fetch ${course.name} (access denied — enrollment may have ended)`);
    }
  };

  const CONCURRENCY = 4;
  for (let i = 0; i < courses.length; i += CONCURRENCY) {
    if (signal?.aborted) break;
    const batch = courses.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(fetchOne));
  }

  return { data: results, warnings };
}

function renderTimeline(
  courses: TimelineCourse[],
  window: TimeWindow,
  warnings: string[],
  overrideCols?: number
): string {
  const cols = overrideCols ?? getTermSize().cols;
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

  const gridCols = getGridColumns(window, chartWidth, narrow);
  const nowCol = toCol(now);

  const makeGridBackground = (): string[] => {
    const bg = new Array(chartWidth).fill(" ");
    for (const gc of gridCols) {
      if (gc >= 0 && gc < chartWidth) bg[gc] = chalk.dim("│");
    }
    if (nowCol >= 0 && nowCol < chartWidth) bg[nowCol] = chalk.white.bold("│");
    return bg;
  };

  const lines: string[] = [];

  lines.push(renderTimeAxis(window, gutterWidth, chartWidth, now, narrow));
  lines.push(renderTodayMarker(window, gutterWidth, chartWidth, now));


  for (let ci = 0; ci < courses.length; ci++) {
    const course = courses[ci]!;
    const color = COURSE_COLORS[ci % COURSE_COLORS.length]!;

    const visible = course.assignments.filter((a) => {
      if (!a.dueAt) return false;
      return a.dueAt.getTime() >= windowStart && a.dueAt.getTime() <= windowEnd;
    });


    if (visible.length === 0) continue;

    const courseLabel = truncatePlainToWidth(course.name, maxCourseName);
    const coursePad = " ".repeat(Math.max(0, gutterWidth - courseLabel.length - 2));
    lines.push(`  ${color.bold(courseLabel)}${coursePad}${makeGridBackground().join("")}`);

    const sorted = [...visible].sort(
      (a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0)
    );

    for (const assignment of sorted) {
      const assignLabel = truncatePlainToWidth(assignment.name, maxAssignmentName);
      const gutter = " ".repeat(4) + assignLabel;
      const gutterPad = " ".repeat(Math.max(0, gutterWidth - gutter.length));
      const bar = renderBar(assignment, toCol, chartWidth, now, color, makeGridBackground());
      lines.push(`${gutter}${gutterPad}${bar}`);
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

function getLabelInterval(window: TimeWindow, narrow: boolean): number {
  const spanDays = (window.end.getTime() - window.start.getTime()) / 86400000;
  if (narrow) return spanDays > 60 ? 28 : 14;
  if (spanDays > 90) return 14;
  return 7;
}

function getGridColumns(window: TimeWindow, chartWidth: number, narrow: boolean): number[] {
  const windowStart = window.start.getTime();
  const windowEnd = window.end.getTime();
  const windowSpan = windowEnd - windowStart;
  const labelInterval = getLabelInterval(window, narrow);
  const cols: number[] = [];

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
      cols.push(col);
    }
    cursor.setDate(cursor.getDate() + labelInterval);
  }
  return cols;
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

  const labelInterval = getLabelInterval(window, narrow);
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
    const offset = Math.max(0, label.col - Math.floor(label.text.length / 2));
    if (offset <= lastEnd) continue;
    for (let i = 0; i < label.text.length && offset + i < chartWidth; i++) {
      axisChars[offset + i] = label.text[i]!;
    }
    lastEnd = offset + label.text.length;
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

export function renderBar(
  assignment: TimelineAssignment,
  toCol: (date: Date) => number,
  chartWidth: number,
  now: Date,
  courseColor: ChalkInstance,
  gridBackground?: string[]
): string {
  const barChars = gridBackground ? [...gridBackground] : new Array(chartWidth).fill(" ");

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
    const overflowCol = Math.max(0, Math.min(chartWidth - 1, toCol(now)));
    for (let col = dueCol + 1; col <= overflowCol && col < chartWidth; col++) {
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

  const { window, fallback } = resolveTimeWindow(windowArg, allAssignments);
  if (fallback) {
    warnings = [...warnings, fallback];
  }

  const visibleAssignments = allAssignments.filter((a) => {
    if (!a.dueAt) return false;
    return a.dueAt.getTime() >= window.start.getTime() && a.dueAt.getTime() <= window.end.getTime();
  });

  const allSubmitted = allAssignments.length > 0 && allAssignments.every((a) => a.submitted);
  const hasChartContent = visibleAssignments.length > 0 || warnings.length > 0;

  if (visibleAssignments.length === 0) {
    if (allSubmitted && !hasChartContent) {
      return "You're all caught up. Nothing outstanding.";
    }
    if (!hasChartContent) {
      return "Nothing due in this window. Try /timeline semester to see the full picture.";
    }
    const chart = renderTimeline(courses, window, warnings);
    return "Nothing due in this window. Try /timeline semester to see the full picture.\n\n" + chart;
  }

  const chart = renderTimeline(courses, window, warnings);
  if (allSubmitted) {
    return "You're all caught up. Nothing outstanding.\n\n" + chart;
  }

  return chart;
}
