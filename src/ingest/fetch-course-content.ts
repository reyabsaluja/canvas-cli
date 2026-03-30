import type { CanvasClient } from "../canvas/client.js";
import type {
  CanvasCourseDetail,
  CanvasAssignment,
  CanvasModule,
  CanvasModuleItem,
  CanvasFile,
  CanvasPage,
} from "../canvas/types.js";
import { mapWithConcurrency } from "./concurrency.js";

export interface RawCourseContent {
  courseDetail: CanvasCourseDetail;
  assignments: CanvasAssignment[];
  modules: Array<CanvasModule & { items: CanvasModuleItem[] }>;
  files: CanvasFile[];
  pages: CanvasPage[];
  /** Front page (home page) HTML body, if accessible. */
  frontPageBody: string | null;
  /** Individual page bodies fetched from module item page slugs. */
  fetchedPages: Array<{ slug: string; title: string; body: string }>;
  warnings: string[];
}

const MODULE_ITEMS_CONCURRENCY = 4;
const PAGE_BODY_CONCURRENCY = 4;

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

  const [rawModules, files, pages, frontPage] = await Promise.all([
    client.getModulesSafe(courseId),
    client.getFilesSafe(courseId),
    client.getPagesSafe(courseId),
    client.getFrontPageSafe(courseId),
  ]);

  const modules = await mapWithConcurrency(
    rawModules,
    MODULE_ITEMS_CONCURRENCY,
    async (mod) => {
      const items = await client.getModuleItemsSafe(courseId, mod.id);
      return { ...mod, items };
    }
  );

  if (files.length === 0 && rawModules.length > 0) {
    warnings.push("Files API not accessible — file index will be empty");
  }

  if (pages.length === 0 && rawModules.length > 0) {
    warnings.push("Pages API not accessible — page index will be empty");
  }

  // Fetch front page (course home page content)
  let frontPageBody: string | null = null;
  if (frontPage?.body) {
    frontPageBody = frontPage.body;
  }

  // Fetch individual page bodies from module item page slugs
  // Even when the Pages list API is blocked, individual pages may be accessible by slug
  const seenSlugs = new Set<string>();
  const pageSlugs: string[] = [];
  for (const mod of modules) {
    for (const item of mod.items) {
      if (item.type === "Page" && item.page_url && !seenSlugs.has(item.page_url)) {
        seenSlugs.add(item.page_url);
        pageSlugs.push(item.page_url);
      }
    }
  }

  const fetchedPages = (
    await mapWithConcurrency(
      pageSlugs,
      PAGE_BODY_CONCURRENCY,
      async (slug) => {
        const page = await client.getPageBySlugSafe(courseId, slug);
        if (!page?.body) {
          return null;
        }
        return { slug, title: page.title, body: page.body };
      }
    )
  ).filter(
    (page): page is { slug: string; title: string; body: string } => page !== null
  );

  return { courseDetail, assignments, modules, files, pages, frontPageBody, fetchedPages, warnings };
}
