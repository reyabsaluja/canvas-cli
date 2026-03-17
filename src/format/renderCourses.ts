import chalk from "chalk";
import type { Course } from "../domain/models.js";

export function renderCourseList(courses: Course[], showAll: boolean): string {
  if (courses.length === 0) {
    return showAll
      ? chalk.dim("No courses found.")
      : chalk.dim("No current courses found. Try --all to include past courses.");
  }

  const lines: string[] = [""];

  for (const c of courses) {
    const parts: string[] = [];

    const code = c.courseCode || "";
    const name = c.name || "";
    const label = code && code !== name
      ? `${chalk.bold(code)}  ${chalk.dim(name)}`
      : chalk.bold(name || code || `Course ${c.id}`);
    parts.push(label);

    if (c.termName) {
      parts.push(chalk.dim(`(${c.termName})`));
    }

    if (!c.isCurrent) {
      parts.push(chalk.dim.italic("past"));
    }

    lines.push("  " + parts.join("  "));
  }

  lines.push("");
  return lines.join("\n");
}
