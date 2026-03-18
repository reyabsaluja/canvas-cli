import { CanvasClient } from "../canvas/client.js";
import { loadConfig } from "../config/env.js";
import { resolveAssignment } from "../domain/resolve-assignment.js";
import { renderAssignmentDetail } from "../format/renderAssignmentDetail.js";
import { loadCourseCache } from "../enrich/cache-loader.js";
import { enrichAssignmentDetail } from "../enrich/enrich-assignment.js";
import { handleError } from "../errors.js";

interface ShowAssignmentOptions {
  course?: string;
  id?: string;
  json?: boolean;
}

export async function showAssignmentCommand(
  name: string,
  options: ShowAssignmentOptions
): Promise<void> {
  const config = loadConfig();
  const client = new CanvasClient(config);

  let rawCourses;
  try {
    rawCourses = await client.getCourses();
  } catch (err) {
    handleError(err);
    return;
  }

  try {
    const { detail, course } = await resolveAssignment(name, options, client, rawCourses);

    // Try to enrich with course cache
    const cache = await loadCourseCache(course.courseCode, course.id);
    const enriched = cache
      ? enrichAssignmentDetail(detail, cache)
      : detail;

    if (options.json) {
      console.log(JSON.stringify(enriched, null, 2));
    } else {
      console.log(renderAssignmentDetail(enriched));
    }
  } catch (err) {
    handleError(err);
  }
}
