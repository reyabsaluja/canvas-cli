import type { CanvasClient } from "../canvas/client.js";
import type {
  CanvasCourseDetail,
  CanvasAssignment,
  CanvasModule,
  CanvasModuleItem,
  CanvasFile,
  CanvasPage,
} from "../canvas/types.js";

export interface RawCourseContent {
  courseDetail: CanvasCourseDetail;
  assignments: CanvasAssignment[];
  modules: Array<CanvasModule & { items: CanvasModuleItem[] }>;
  files: CanvasFile[];
  pages: CanvasPage[];
  warnings: string[];
}

/**
 * Fetch all available course content from Canvas.
 * Handles gracefully when Files API or Pages API is blocked.
 */
export async function fetchCourseContent(
  client: CanvasClient,
  courseId: number
): Promise<RawCourseContent> {
  const warnings: string[] = [];

  // Fetch course detail (with syllabus) and assignments in parallel
  let courseDetail, assignments;
  try {
    [courseDetail, assignments] = await Promise.all([
      client.getCourseDetail(courseId),
      client.getAssignments(courseId),
    ]);
  } catch (err) {
    throw new Error(
      `Failed to fetch course data: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }

  // Fetch modules (may be disabled for some courses)
  const rawModules = await client.getModulesSafe(courseId);

  // Fetch module items for each module (sequentially to avoid rate limiting)
  const modules: Array<CanvasModule & { items: CanvasModuleItem[] }> = [];
  for (const mod of rawModules) {
    const items = await client.getModuleItemsSafe(courseId, mod.id);
    modules.push({ ...mod, items });
  }

  // Fetch files (may be blocked)
  const files = await client.getFilesSafe(courseId);
  if (files.length === 0 && rawModules.length > 0) {
    warnings.push("Files API not accessible — file index will be empty");
  }

  // Fetch pages (may be blocked)
  const pages = await client.getPagesSafe(courseId);
  if (pages.length === 0 && rawModules.length > 0) {
    warnings.push("Pages API not accessible — page index will be empty");
  }

  return { courseDetail, assignments, modules, files, pages, warnings };
}
