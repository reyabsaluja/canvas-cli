import type { CanvasClient } from "../canvas/client.js";
import type {
  CanvasCourseDetail,
  CanvasAssignment,
  CanvasAssignmentDetail,
  CanvasModule,
  CanvasModuleItem,
  CanvasFile,
  CanvasPage,
  CanvasDiscussionEntry,
  CanvasDiscussionTopic,
  CanvasDiscussionTopicView,
} from "../canvas/types.js";
import { mapWithConcurrency } from "./concurrency.js";

export interface RawDiscussionThread {
  topic: CanvasDiscussionTopic;
  entries: CanvasDiscussionEntry[];
  participantCount: number;
}

export type RawAssignmentRecord = CanvasAssignment &
  Partial<Omit<CanvasAssignmentDetail, keyof CanvasAssignment>>;

export interface RawCourseContent {
  courseDetail: CanvasCourseDetail;
  assignments: RawAssignmentRecord[];
  modules: Array<CanvasModule & { items: CanvasModuleItem[] }>;
  files: CanvasFile[];
  pages: CanvasPage[];
  announcements: CanvasDiscussionTopic[];
  discussions: CanvasDiscussionTopic[];
  discussionThreads: RawDiscussionThread[];
  /** Front page (home page) HTML body, if accessible. */
  frontPageBody: string | null;
  /** Individual page bodies fetched from discovered same-course Canvas links. */
  fetchedPages: Array<{ slug: string; title: string; body: string }>;
  warnings: string[];
}

const MODULE_ITEMS_CONCURRENCY = 4;
const PAGE_BODY_CONCURRENCY = 4;
const DISCUSSION_VIEW_CONCURRENCY = 4;
const ASSIGNMENT_DETAIL_CONCURRENCY = 4;

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
  let courseDetail, assignmentSummaries;
  try {
    [courseDetail, assignmentSummaries] = await Promise.all([
      client.getCourseDetail(courseId),
      client.getAssignments(courseId),
    ]);
  } catch (err) {
    throw new Error(
      `Failed to fetch course data: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }

  const announcementFetcher = (client as CanvasClient & {
    getAnnouncementsSafe?: (courseId: number) => Promise<CanvasDiscussionTopic[]>;
  }).getAnnouncementsSafe;
  const assignmentDetailsPromise = enrichAssignmentsWithDetails(
    client,
    courseId,
    assignmentSummaries
  );
  const discussionFetcher = (client as CanvasClient & {
    getDiscussionTopicsSafe?: (courseId: number) => Promise<CanvasDiscussionTopic[]>;
  }).getDiscussionTopicsSafe;
  const discussionViewFetcher = (client as CanvasClient & {
    getDiscussionTopicViewSafe?: (
      courseId: number,
      topicId: number
    ) => Promise<CanvasDiscussionTopicView | null>;
  }).getDiscussionTopicViewSafe;
  const [
    rawModules,
    files,
    pages,
    announcements,
    discussions,
    frontPage,
    assignmentDetailResult,
  ] =
    await Promise.all([
      client.getModulesSafe(courseId),
      client.getFilesSafe(courseId),
      client.getPagesSafe(courseId),
      announcementFetcher
        ? announcementFetcher.call(client, courseId)
        : Promise.resolve([]),
      discussionFetcher
        ? discussionFetcher.call(client, courseId)
        : Promise.resolve([]),
      client.getFrontPageSafe(courseId),
      assignmentDetailsPromise,
    ]);
  const assignments = assignmentDetailResult.assignments;
  if (assignmentDetailResult.warning) {
    warnings.push(assignmentDetailResult.warning);
  }

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

  const discussionThreads = discussionViewFetcher
    ? await mapWithConcurrency(
        discussions,
        DISCUSSION_VIEW_CONCURRENCY,
        async (topic) => {
          const view = await discussionViewFetcher.call(client, courseId, topic.id);
          return {
            topic,
            entries: flattenDiscussionEntries(view),
            participantCount: view?.participants.length ?? 0,
          };
        }
      )
    : discussions.map((topic) => ({
        topic,
        entries: [],
        participantCount: 0,
      }));

  const seenSlugs = new Set<string>();
  const pendingSlugs: string[] = [];

  const enqueueSlug = (slug: string | null | undefined): void => {
    if (!slug || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);
    pendingSlugs.push(slug);
  };

  const enqueueLinkedPageSlugs = (html: string | null | undefined): void => {
    if (!html) return;
    for (const slug of extractCanvasPageSlugs(html, courseId)) {
      enqueueSlug(slug);
    }
  };

  // Seed the crawl from explicit module pages, then expand through every HTML
  // surface we can already access. This recovers page hubs linked from
  // assignments, the syllabus, announcements, and other pages.
  for (const mod of modules) {
    for (const item of mod.items) {
      if (item.type === "Page") {
        enqueueSlug(item.page_url);
      }
    }
  }
  enqueueLinkedPageSlugs(frontPageBody);
  enqueueLinkedPageSlugs(courseDetail.syllabus_body);
  for (const assignment of assignments) {
    const description = (assignment as { description?: unknown }).description;
    if (typeof description === "string") {
      enqueueLinkedPageSlugs(description);
    }
  }
  for (const announcement of announcements) {
    enqueueLinkedPageSlugs(announcement.message);
  }
  for (const thread of discussionThreads) {
    enqueueLinkedPageSlugs(thread.topic.message);
    for (const entry of thread.entries) {
      enqueueLinkedPageSlugs(entry.message);
    }
  }

  const fetchedPagesBySlug = new Map<
    string,
    { slug: string; title: string; body: string }
  >();

  while (pendingSlugs.length > 0) {
    const batch = pendingSlugs.splice(0, pendingSlugs.length);
    const batchResults = await mapWithConcurrency(
      batch,
      PAGE_BODY_CONCURRENCY,
      async (slug) => {
        const page = await client.getPageBySlugSafe(courseId, slug);
        if (!page?.body) {
          return null;
        }
        return { slug, title: page.title, body: page.body };
      }
    );

    for (const page of batchResults) {
      if (!page || fetchedPagesBySlug.has(page.slug)) continue;
      fetchedPagesBySlug.set(page.slug, page);
      enqueueLinkedPageSlugs(page.body);
    }
  }

  return {
    courseDetail,
    assignments,
    modules,
    files,
    pages,
    announcements,
    discussions,
    discussionThreads,
    frontPageBody,
    fetchedPages: Array.from(fetchedPagesBySlug.values()),
    warnings,
  };
}

async function enrichAssignmentsWithDetails(
  client: CanvasClient,
  courseId: number,
  assignments: CanvasAssignment[]
): Promise<{ assignments: RawAssignmentRecord[]; warning: string | null }> {
  const detailFetcher = (client as CanvasClient & {
    getAssignmentDetail?: (
      courseId: number,
      assignmentId: number
    ) => Promise<CanvasAssignmentDetail>;
  }).getAssignmentDetail;

  if (!detailFetcher || assignments.length === 0) {
    return { assignments, warning: null };
  }

  let failedDetails = 0;
  const enrichedAssignments = await mapWithConcurrency(
    assignments,
    ASSIGNMENT_DETAIL_CONCURRENCY,
    async (assignment) => {
      try {
        const detail = await detailFetcher.call(client, courseId, assignment.id);
        return { ...assignment, ...detail };
      } catch {
        failedDetails += 1;
        return assignment;
      }
    }
  );

  return {
    assignments: enrichedAssignments,
    warning:
      failedDetails > 0
        ? `Assignment detail unavailable for ${failedDetails} assignment${
            failedDetails === 1 ? "" : "s"
          } — descriptions and rubrics may be incomplete`
        : null,
  };
}

const CANVAS_PAGE_LINK_RE =
  /href=(["'])[^"'#?]*\/courses\/(\d+)\/pages\/([^"'?#]+)[^"']*\1/gi;

function extractCanvasPageSlugs(html: string, courseId: number): string[] {
  const slugs: string[] = [];
  let match;
  while ((match = CANVAS_PAGE_LINK_RE.exec(html)) !== null) {
    if (parseInt(match[2]!, 10) === courseId) {
      slugs.push(decodeURIComponent(match[3]!));
    }
  }
  CANVAS_PAGE_LINK_RE.lastIndex = 0;
  return slugs;
}

function flattenDiscussionEntries(
  view: CanvasDiscussionTopicView | null
): CanvasDiscussionEntry[] {
  if (!view) {
    return [];
  }

  const flattened: CanvasDiscussionEntry[] = [];
  const seen = new Set<number>();

  const visit = (entry: CanvasDiscussionEntry): void => {
    if (seen.has(entry.id)) {
      return;
    }
    seen.add(entry.id);
    flattened.push(entry);
    for (const reply of entry.recent_replies ?? []) {
      visit(reply);
    }
  };

  for (const entry of view.view ?? []) {
    visit(entry);
  }
  for (const entry of view.new_entries ?? []) {
    visit(entry);
  }

  return flattened.sort((left, right) =>
    left.created_at.localeCompare(right.created_at)
  );
}
