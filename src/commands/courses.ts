import { CanvasClient } from "../canvas/client.js";
import { loadConfig } from "../config/env.js";
import { normalizeCourse } from "../domain/normalize.js";
import { renderCourseList } from "../format/renderCourses.js";
import { handleError } from "../errors.js";

interface CoursesOptions {
  all?: boolean;
  json?: boolean;
}

export async function coursesCommand(options: CoursesOptions): Promise<void> {
  const config = loadConfig();
  const client = new CanvasClient(config);

  let rawCourses;
  try {
    rawCourses = await client.getCourses();
  } catch (err) {
    handleError(err);
    return;
  }

  const allCourses = rawCourses.map(normalizeCourse);

  const courses = options.all
    ? allCourses
    : allCourses.filter((c) => c.isCurrent);

  if (options.json) {
    console.log(JSON.stringify(courses, null, 2));
    return;
  }

  console.log(renderCourseList(courses, !!options.all));
}
