import chalk from "chalk";
import type { CanvasClient } from "../canvas/client.js";
import type { CanvasEnrollment } from "../canvas/types.js";
import type { Course } from "../domain/models.js";
import {
  parseGradeData,
  calculateNeeded,
  letterToPercent,
  percentToLetter,
  type CourseGradeData,
  type GradeGroup,
  type NeedResult,
} from "./grade-calculator.js";

export interface GradeArgs {
  mode: "summary" | "detail" | "need";
  courseName?: string;
  target?: number;
  error?: string;
}

export function parseGradeArgs(args: string, inCourseScope: boolean): GradeArgs {
  const trimmed = args.trim();

  if (!trimmed) {
    return { mode: inCourseScope ? "detail" : "summary" };
  }

  const needMatch = trimmed.match(/^need\s+(.+)$/i);
  if (needMatch) {
    const rest = needMatch[1]!.trim();
    const numericMatch = rest.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
    if (numericMatch) {
      const target = parseFloat(numericMatch[1]!);
      const courseName = numericMatch[2]!.trim() || undefined;
      if (target < 0 || target > 100) {
        return { mode: "need", error: "Target must be between 0 and 100." };
      }
      return { mode: "need", target, courseName };
    }
    const letterMatch = rest.match(/^([A-Da-d][+-]?)\s*(.*)$/);
    if (letterMatch) {
      const letter = letterMatch[1]!;
      const percent = letterToPercent(letter);
      if (percent === null) {
        return { mode: "need", error: `Unknown grade letter "${letter}".` };
      }
      const courseName = letterMatch[2]!.trim() || undefined;
      return { mode: "need", target: percent, courseName };
    }
    return { mode: "need", error: `Could not parse target from "${rest}". Use a letter grade (A, B+) or a number (90).` };
  }

  return { mode: "detail", courseName: trimmed };
}

export function matchCourse(query: string, courses: Course[]): { course?: Course; error?: string } {
  const lower = query.toLowerCase();
  const exact = courses.filter(
    (c) => c.name.toLowerCase() === lower || c.courseCode.toLowerCase() === lower
  );
  if (exact.length === 1) return { course: exact[0] };

  const partial = courses.filter(
    (c) => c.name.toLowerCase().includes(lower) || c.courseCode.toLowerCase().includes(lower)
  );
  if (partial.length === 1) return { course: partial[0] };
  if (partial.length > 1) {
    const names = partial.map((c) => c.courseCode || c.name).join(", ");
    return { error: `Multiple courses match "${query}". Did you mean: ${names}?` };
  }
  const allNames = courses.map((c) => c.courseCode || c.name).join(", ");
  return { error: `No course matching "${query}". Your courses: ${allNames}.` };
}

export async function fetchGradeSummary(
  client: CanvasClient,
  courses: Course[],
  signal?: AbortSignal | null
): Promise<{ rows: SummaryRow[]; warnings: string[] }> {
  const rows: SummaryRow[] = [];
  const warnings: string[] = [];

  let enrollments: CanvasEnrollment[] = [];
  try {
    enrollments = await client.getMyEnrollments(signal);
  } catch {
    // Fall back to per-course fetching
  }

  const enrollmentMap = new Map<number, CanvasEnrollment>();
  for (const e of enrollments) {
    if (e.type === "StudentEnrollment" && e.enrollment_state === "active") {
      enrollmentMap.set(e.course_id, e);
    }
  }

  for (const course of courses) {
    if (signal?.aborted) break;
    const enrollment = enrollmentMap.get(course.id);
    if (enrollment) {
      const score = enrollment.grades?.current_score ?? enrollment.computed_current_score ?? null;
      const grade = enrollment.grades?.current_grade ?? enrollment.computed_current_grade ?? null;
      rows.push({ courseName: course.courseCode || course.name, score, grade });
    } else {
      try {
        const groups = await client.getAssignmentGroupsSafe(course.id, signal);
        const data = parseGradeData(groups);
        rows.push({
          courseName: course.courseCode || course.name,
          score: data.currentScore,
          grade: data.currentGrade,
        });
      } catch {
        warnings.push(`Could not access grades for ${course.courseCode || course.name}.`);
      }
    }
  }

  return { rows, warnings };
}

export async function fetchGradeDetail(
  client: CanvasClient,
  course: Course,
  signal?: AbortSignal | null
): Promise<{ data: CourseGradeData; warnings: string[] }> {
  const warnings: string[] = [];
  const groups = await client.getAssignmentGroups(course.id, signal);
  const data = parseGradeData(groups);
  return { data, warnings };
}

interface SummaryRow {
  courseName: string;
  score: number | null;
  grade: string | null;
}

export function renderGradeSummary(rows: SummaryRow[], warnings: string[]): string {
  const lines: string[] = [];
  if (rows.length === 0) {
    return "  No graded courses found.";
  }

  const nameWidth = Math.max(10, ...rows.map((r) => r.courseName.length));
  const gradeWidth = 6;
  const scoreWidth = 7;

  lines.push(`  ${chalk.white.bold("Grades")}`);
  lines.push("");
  lines.push(`  ${chalk.dim("┌" + "─".repeat(nameWidth + 2) + "┬" + "─".repeat(gradeWidth + 2) + "┬" + "─".repeat(scoreWidth + 2) + "┐")}`);
  lines.push(`  ${chalk.dim("│")} ${chalk.dim("Course".padEnd(nameWidth))} ${chalk.dim("│")} ${chalk.dim("Grade".padEnd(gradeWidth))} ${chalk.dim("│")} ${chalk.dim("Score".padEnd(scoreWidth))} ${chalk.dim("│")}`);
  lines.push(`  ${chalk.dim("├" + "─".repeat(nameWidth + 2) + "┼" + "─".repeat(gradeWidth + 2) + "┼" + "─".repeat(scoreWidth + 2) + "┤")}`);

  for (const row of rows) {
    const gradeStr = row.grade ?? "—";
    const scoreStr = row.score != null ? `${row.score.toFixed(1)}%` : "—";
    const color = gradeColor(row.grade);
    lines.push(`  ${chalk.dim("│")} ${chalk.white(row.courseName.padEnd(nameWidth))} ${chalk.dim("│")} ${color(gradeStr.padEnd(gradeWidth))} ${chalk.dim("│")} ${color(scoreStr.padEnd(scoreWidth))} ${chalk.dim("│")}`);
  }

  lines.push(`  ${chalk.dim("└" + "─".repeat(nameWidth + 2) + "┴" + "─".repeat(gradeWidth + 2) + "┴" + "─".repeat(scoreWidth + 2) + "┘")}`);

  for (const w of warnings) {
    lines.push("");
    lines.push(`  ${chalk.yellow("⚠")} ${chalk.dim(w)}`);
  }

  return lines.join("\n");
}

export function renderGradeDetail(course: Course, data: CourseGradeData, warnings: string[]): string {
  const lines: string[] = [];
  const courseName = course.courseCode ? `${course.courseCode} — ${course.name}` : course.name;

  if (data.currentScore === null) {
    return `  ${chalk.white.bold(courseName)}\n\n  ${chalk.dim("No graded assignments yet. Check back after your first score is posted.")}`;
  }

  const scoreStr = `${data.currentScore.toFixed(1)}%`;
  const gradeStr = data.currentGrade ?? "";
  const color = gradeColor(data.currentGrade);

  lines.push(`  ${chalk.white.bold(courseName)}`);
  lines.push(`  ${chalk.dim("Current:")} ${color(scoreStr)} ${color(`(${gradeStr})`)}`);
  lines.push("");

  for (const group of data.groups) {
    const visible = group.assignments.filter((a) => !a.omitted);
    if (visible.length === 0) continue;

    const weightStr = data.isWeighted ? chalk.dim(` (${group.weight}%)`) : "";
    const groupPct = group.percentage !== null
      ? chalk.white(`${group.percentage.toFixed(1)}%`)
      : chalk.dim("—");

    lines.push(`  ${chalk.hex("#e8a86d").bold(group.name)}${weightStr}  ${groupPct}`);

    const nameCol = Math.max(20, ...visible.map((a) => Math.min(a.name.length, 30)));

    for (const a of visible) {
      const line = renderAssignmentLine(a, nameCol);
      lines.push(`    ${line}`);
    }
    lines.push("");
  }

  const gradedPct = (data.gradedWeightFraction * 100).toFixed(0);
  const remainingPct = (data.remainingWeightFraction * 100).toFixed(0);
  lines.push(`  ${chalk.dim("─".repeat(46))}`);
  lines.push(`  ${chalk.dim("Graded:")} ${chalk.white(gradedPct + "%")} ${chalk.dim("of total weight")}`);

  const remaining = countRemaining(data.groups);
  if (remaining) {
    lines.push(`  ${chalk.dim("Remaining:")} ${chalk.white(remainingPct + "%")} ${chalk.dim(`(${remaining})`)}`);
  }

  for (const w of warnings) {
    lines.push("");
    lines.push(`  ${chalk.yellow("⚠")} ${chalk.dim(w)}`);
  }

  return lines.join("\n");
}

export function renderNeedResult(course: Course, result: NeedResult): string {
  const lines: string[] = [];
  const courseName = course.courseCode ? `${course.courseCode} — ${course.name}` : course.name;
  const currentStr = `${result.currentScore.toFixed(1)}%`;

  lines.push(`  ${chalk.white.bold(courseName)} ${chalk.dim("—")} ${chalk.dim("Current:")} ${currentStr} ${chalk.dim(`(${result.currentGrade ?? "—"})`)}`);
  lines.push(`  ${chalk.dim("Target:")} ${chalk.white(result.targetLabel)} ${chalk.dim(`(${result.targetPercent}%)`)}`);
  lines.push("");

  if (result.status === "already") {
    lines.push(`  ${chalk.green("✓")} ${chalk.white("Already above target.")}`);
    if (result.floorScore !== undefined) {
      const floorGrade = percentToLetter(result.floorScore);
      lines.push(`  ${chalk.dim(`You could score 0% on remaining work and still get: ${result.floorScore.toFixed(1)}% (${floorGrade})`)}`);
    }
  } else if (result.status === "possible") {
    lines.push(`  ${chalk.white(`Average needed across remaining: ${result.neededAverage!.toFixed(1)}%`)}`);
    lines.push("");
    if (result.neededAverage! > 95) {
      lines.push(`  ${chalk.yellow("Verdict: Possible, but difficult.")}`);
    } else if (result.neededAverage! > 85) {
      lines.push(`  ${chalk.dim("Verdict: Achievable with strong performance.")}`);
    } else {
      lines.push(`  ${chalk.green("Verdict: Very achievable.")}`);
    }
  } else {
    lines.push(`  ${chalk.yellow("⚠")} ${chalk.white("Not reachable.")}`);
    if (result.maxAchievable !== null) {
      const maxGrade = percentToLetter(result.maxAchievable);
      lines.push(`  ${chalk.dim(`Even 100% on all remaining work yields: ${result.maxAchievable.toFixed(1)}% (${maxGrade})`)}`);
    }
    if (result.nearestReachable && result.nearestReachable.length > 0) {
      lines.push("");
      lines.push(`  ${chalk.dim("Nearest reachable grades:")}`);
      for (const r of result.nearestReachable) {
        lines.push(`    ${chalk.white(r.label)} ${chalk.dim("— need avg")} ${r.neededAvg.toFixed(1)}% ${chalk.dim("on remaining")}`);
      }
    }
  }

  return lines.join("\n");
}

function renderAssignmentLine(a: { name: string; pointsPossible: number; score: number | null; dueAt: Date | null; submitted: boolean; graded: boolean; missing: boolean }, nameCol: number): string {
  const maxName = Math.min(nameCol, 30);
  const nameStr = a.name.length > maxName ? a.name.slice(0, maxName - 1) + "…" : a.name;
  const now = new Date();

  if (a.graded && a.score != null) {
    const scoreStr = `${a.score}/${a.pointsPossible}`;
    const pct = a.pointsPossible > 0 ? `${((a.score / a.pointsPossible) * 100).toFixed(1)}%` : "";
    return `${chalk.dim("·")} ${chalk.white(nameStr.padEnd(nameCol))}  ${scoreStr.padEnd(10)}  ${pct}`;
  }

  if (a.missing) {
    return `${chalk.red("·")} ${chalk.white(nameStr.padEnd(nameCol))}  ${chalk.red("missing")}`;
  }

  if (a.submitted) {
    return `${chalk.dim("·")} ${chalk.white(nameStr.padEnd(nameCol))}  ${chalk.dim("submitted")}`;
  }

  const dueSuffix = a.dueAt
    ? a.dueAt > now
      ? chalk.dim(`due ${formatShortDate(a.dueAt)}`)
      : chalk.red(`past due ${formatShortDate(a.dueAt)}`)
    : "";
  return `${chalk.dim("·")} ${chalk.dim(nameStr.padEnd(nameCol))}  ${chalk.dim("—")}  ${dueSuffix}`;
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function countRemaining(groups: GradeGroup[]): string {
  const counts: Record<string, number> = {};
  for (const g of groups) {
    for (const a of g.assignments) {
      if (!a.graded && !a.omitted && a.pointsPossible > 0) {
        counts[g.name] = (counts[g.name] ?? 0) + 1;
      }
    }
  }
  const parts = Object.entries(counts).map(([name, count]) => `${count} ${name.toLowerCase()}`);
  return parts.join(", ");
}

function gradeColor(grade: string | null): (s: string) => string {
  if (!grade) return chalk.dim;
  const letter = grade.charAt(0).toUpperCase();
  if (letter === "A") return chalk.green;
  if (letter === "B") return chalk.white;
  if (letter === "C") return chalk.yellow;
  return chalk.red;
}
