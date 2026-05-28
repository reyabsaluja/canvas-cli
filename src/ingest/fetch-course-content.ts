import type { CanvasClient } from "../canvas/client.js";
import type {
  CanvasAssignmentGroup,
  CanvasCourseDetail,
  CanvasAssignment,
  CanvasAssignmentDetail,
  CanvasCalendarEvent,
  CanvasModule,
  CanvasModuleItem,
  CanvasFile,
  CanvasPage,
  CanvasQuiz,
  CanvasQuizQuestion,
  CanvasDiscussionEntry,
  CanvasDiscussionTopic,
  CanvasDiscussionTopicView,
} from "../canvas/types.js";
import { decodeEntities } from "../format/html-to-text.js";
import { mapWithConcurrency } from "./concurrency.js";
import { collectAssignmentRubricHtmlSources } from "./rich-text-sources.js";

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
  quizzes: CanvasQuiz[];
  quizQuestions: Map<number, CanvasQuizQuestion[]>;
  calendarEvents: CanvasCalendarEvent[];
  announcements: CanvasDiscussionTopic[];
  discussions: CanvasDiscussionTopic[];
  announcementThreads: RawDiscussionThread[];
  discussionThreads: RawDiscussionThread[];
  assignmentGroups: CanvasAssignmentGroup[];
  /** Front page (home page) HTML body, if accessible. */
  frontPageBody: string | null;
  /** Individual page bodies fetched from the Pages index and discovered same-course Canvas links. */
  fetchedPages: Array<{ slug: string; title: string; body: string }>;
  warnings: string[];
}

const MODULE_ITEMS_CONCURRENCY = 4;
const PAGE_BODY_CONCURRENCY = 4;
const DISCUSSION_VIEW_CONCURRENCY = 4;
const ASSIGNMENT_DETAIL_CONCURRENCY = 4;
const QUIZ_DETAIL_CONCURRENCY = 4;
const QUIZ_QUESTIONS_CONCURRENCY = 4;

/**
 * Fetch all available course content from Canvas.
 * Handles gracefully when Files API or Pages API is blocked.
 */
export async function fetchCourseContent(
  client: CanvasClient,
  courseId: number,
  signal?: AbortSignal | null
): Promise<RawCourseContent> {
  const warnings: string[] = [];
  client.resetSkippedEndpoints();

  // Fetch course detail (with syllabus) and assignments in parallel
  let courseDetail, assignmentSummaries;
  try {
    [courseDetail, assignmentSummaries] = await Promise.all([
      client.getCourseDetail(courseId, signal),
      client.getAssignments(courseId, signal),
    ]);
  } catch (err) {
    throw new Error(
      `Failed to fetch course data: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }

  const announcementFetcher = (client as CanvasClient & {
    getAnnouncementsSafe?: (courseId: number, _options?: unknown, signal?: AbortSignal | null) => Promise<CanvasDiscussionTopic[]>;
  }).getAnnouncementsSafe;
  const assignmentDetailsPromise = enrichAssignmentsWithDetails(
    client,
    courseId,
    assignmentSummaries,
    signal
  );
  const discussionFetcher = (client as CanvasClient & {
    getDiscussionTopicsSafe?: (courseId: number, signal?: AbortSignal | null) => Promise<CanvasDiscussionTopic[]>;
  }).getDiscussionTopicsSafe;
  const quizFetcher = (client as CanvasClient & {
    getQuizzesSafe?: (courseId: number, signal?: AbortSignal | null) => Promise<CanvasQuiz[]>;
  }).getQuizzesSafe;
  const quizzesPromise = quizFetcher
    ? quizFetcher
        .call(client, courseId, signal)
        .then((quizSummaries) =>
          enrichQuizzesWithDetails(client, courseId, quizSummaries, signal)
        )
    : Promise.resolve({ quizzes: [] as CanvasQuiz[], warning: null });
  const calendarEventFetcher = (client as CanvasClient & {
    getCalendarEventsSafe?: (
      courseId: number,
      signal?: AbortSignal | null
    ) => Promise<CanvasCalendarEvent[]>;
  }).getCalendarEventsSafe;
  const discussionViewFetcher = (client as CanvasClient & {
    getDiscussionTopicViewSafe?: (
      courseId: number,
      topicId: number,
      signal?: AbortSignal | null
    ) => Promise<CanvasDiscussionTopicView | null>;
  }).getDiscussionTopicViewSafe;
  const assignmentGroupFetcher = (client as CanvasClient & {
    getAssignmentGroupsSafe?: (
      courseId: number,
      signal?: AbortSignal | null
    ) => Promise<CanvasAssignmentGroup[]>;
  }).getAssignmentGroupsSafe;
  const [
    rawModules,
    files,
    pages,
    quizDetailResult,
    calendarEvents,
    announcements,
    discussions,
    frontPage,
    assignmentDetailResult,
    assignmentGroups,
  ] =
    await Promise.all([
      client.getModulesSafe(courseId, signal),
      client.getFilesSafe(courseId, signal),
      client.getPagesSafe(courseId, signal),
      quizzesPromise,
      calendarEventFetcher
        ? calendarEventFetcher.call(client, courseId, signal)
        : Promise.resolve([]),
      announcementFetcher
        ? announcementFetcher.call(client, courseId, undefined, signal)
        : Promise.resolve([]),
      discussionFetcher
        ? discussionFetcher.call(client, courseId, signal)
        : Promise.resolve([]),
      client.getFrontPageSafe(courseId, signal),
      assignmentDetailsPromise,
      assignmentGroupFetcher
        ? assignmentGroupFetcher.call(client, courseId, signal)
        : Promise.resolve([] as CanvasAssignmentGroup[]),
    ]);
  const assignments = assignmentDetailResult.assignments;
  if (assignmentDetailResult.warning) {
    warnings.push(assignmentDetailResult.warning);
  }
  const quizzes = quizDetailResult.quizzes;
  if (quizDetailResult.warning) {
    warnings.push(quizDetailResult.warning);
  }

  const modules = await mapWithConcurrency(
    rawModules,
    MODULE_ITEMS_CONCURRENCY,
    async (mod) => {
      const items = await client.getModuleItemsSafe(courseId, mod.id, signal);
      return { ...mod, items };
    },
    signal
  );

  if (files.length === 0 && rawModules.length > 0) {
    warnings.push("Files API not accessible — file index will be empty");
  }

  if (pages.length === 0 && rawModules.length > 0) {
    warnings.push("Pages API not accessible — page index will be empty");
  }

  if (client.skippedEndpoints.length > 0) {
    const skipped = client.skippedEndpoints.map((url) => {
      const match = url.match(/\/courses\/\d+\/(\w+)/);
      return match ? match[1] : url;
    });
    const unique = [...new Set(skipped)];
    warnings.push(
      `${client.skippedEndpoints.length} endpoint(s) returned errors after retries — unavailable: ${unique.join(", ")}`
    );
  }

  // Fetch front page (course home page content)
  let frontPageBody: string | null = null;
  if (frontPage?.body) {
    frontPageBody = frontPage.body;
  }

  const announcementThreads = discussionViewFetcher
    ? await mapWithConcurrency(
        announcements,
        DISCUSSION_VIEW_CONCURRENCY,
        async (topic) => {
          const view = await discussionViewFetcher.call(client, courseId, topic.id, signal);
          return {
            topic,
            entries: flattenDiscussionEntries(view),
            participantCount: view?.participants.length ?? 0,
          };
        },
        signal
      )
    : announcements.map((topic) => ({
        topic,
        entries: [],
        participantCount: 0,
      }));

  const discussionThreads = discussionViewFetcher
    ? await mapWithConcurrency(
        discussions,
        DISCUSSION_VIEW_CONCURRENCY,
        async (topic) => {
          const view = await discussionViewFetcher.call(client, courseId, topic.id, signal);
          return {
            topic,
            entries: flattenDiscussionEntries(view),
            participantCount: view?.participants.length ?? 0,
          };
        },
        signal
      )
    : discussions.map((topic) => ({
        topic,
        entries: [],
        participantCount: 0,
      }));

  // Fetch quiz question bodies — these often contain links to reading materials
  const quizQuestionsFetcher = (client as CanvasClient & {
    getQuizQuestionsSafe?: (
      courseId: number,
      quizId: number,
      signal?: AbortSignal | null
    ) => Promise<CanvasQuizQuestion[]>;
  }).getQuizQuestionsSafe;
  const quizQuestions = new Map<number, CanvasQuizQuestion[]>();
  if (quizQuestionsFetcher && quizzes.length > 0) {
    const questionResults = await mapWithConcurrency(
      quizzes,
      QUIZ_QUESTIONS_CONCURRENCY,
      async (quiz) => {
        const questions = await quizQuestionsFetcher.call(
          client,
          courseId,
          quiz.id,
          signal
        );
        return { quizId: quiz.id, questions };
      },
      signal
    );
    for (const result of questionResults) {
      if (result.questions.length > 0) {
        quizQuestions.set(result.quizId, result.questions);
      }
    }
  }

  const seenSlugs = new Set<string>();
  const pendingSlugs: string[] = [];
  const courseHtmlUrl = courseDetail.html_url ?? null;
  const fetchedPagesBySlug = new Map<
    string,
    { slug: string; title: string; body: string }
  >();

  const enqueueSlug = (slug: string | null | undefined): void => {
    if (!slug || seenSlugs.has(slug) || fetchedPagesBySlug.has(slug)) return;
    seenSlugs.add(slug);
    pendingSlugs.push(slug);
  };

  const rememberFetchedPage = (
    slug: string | null | undefined,
    title: string | null | undefined,
    body: string | null | undefined,
    baseUrl?: string | null
  ): void => {
    if (!slug || !body || fetchedPagesBySlug.has(slug)) {
      return;
    }
    fetchedPagesBySlug.set(slug, {
      slug,
      title: title ?? slug,
      body,
    });
    enqueueLinkedPageSlugs(body, baseUrl ?? buildCanvasPageUrl(courseHtmlUrl, slug));
  };

  const enqueueLinkedPageSlugs = (
    html: string | null | undefined,
    baseUrl?: string | null
  ): void => {
    if (!html) return;
    for (const slug of extractCanvasPageSlugs(html, courseId, baseUrl)) {
      enqueueSlug(slug);
    }
  };

  // Seed the crawl from every page listed in the Pages index, explicit module
  // pages, then expand through every HTML surface we can already access. This
  // recovers unlinked course pages in addition to page hubs linked from
  // assignments, quizzes, calendar events, the syllabus, announcements, and
  // other pages.
  for (const page of pages) {
    rememberFetchedPage(page.url, page.title, page.body ?? null, page.html_url);
    enqueueSlug(page.url);
  }
  for (const mod of modules) {
    for (const item of mod.items) {
      if (item.type === "Page") {
        enqueueSlug(item.page_url);
      }
    }
  }
  enqueueLinkedPageSlugs(frontPageBody, courseHtmlUrl);
  enqueueLinkedPageSlugs(courseDetail.syllabus_body, courseHtmlUrl);
  for (const assignment of assignments) {
    const description = (assignment as { description?: unknown }).description;
    if (typeof description === "string") {
      enqueueLinkedPageSlugs(description, assignment.html_url);
    }
    for (const source of collectAssignmentRubricHtmlSources(assignment)) {
      enqueueLinkedPageSlugs(source.html, assignment.html_url);
    }
  }
  for (const quiz of quizzes) {
    enqueueLinkedPageSlugs(quiz.description, quiz.html_url ?? courseHtmlUrl);
  }
  for (const questions of quizQuestions.values()) {
    for (const question of questions) {
      const quiz = quizzes.find((entry) => entry.id === question.quiz_id);
      enqueueLinkedPageSlugs(
        question.question_text,
        quiz?.html_url ?? courseHtmlUrl
      );
    }
  }
  for (const event of calendarEvents) {
    enqueueLinkedPageSlugs(event.description, event.html_url ?? courseHtmlUrl);
  }
  for (const thread of announcementThreads) {
    enqueueLinkedPageSlugs(thread.topic.message, thread.topic.html_url);
    for (const entry of thread.entries) {
      enqueueLinkedPageSlugs(entry.message, thread.topic.html_url);
    }
  }
  for (const thread of discussionThreads) {
    enqueueLinkedPageSlugs(thread.topic.message, thread.topic.html_url);
    for (const entry of thread.entries) {
      enqueueLinkedPageSlugs(entry.message, thread.topic.html_url);
    }
  }

  while (pendingSlugs.length > 0) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const batch = pendingSlugs.splice(0, pendingSlugs.length);
    const batchResults = await mapWithConcurrency(
      batch,
      PAGE_BODY_CONCURRENCY,
      async (slug) => {
        const page = await client.getPageBySlugSafe(courseId, slug, signal);
        if (!page?.body) {
          return null;
        }
        return { slug, title: page.title, body: page.body };
      },
      signal
    );

    for (const page of batchResults) {
      if (!page) continue;
      rememberFetchedPage(
        page.slug,
        page.title,
        page.body,
        buildCanvasPageUrl(courseHtmlUrl, page.slug)
      );
    }
  }

  return {
    courseDetail,
    assignments,
    modules,
    files,
    pages,
    quizzes,
    quizQuestions,
    calendarEvents,
    announcements,
    discussions,
    announcementThreads,
    discussionThreads,
    assignmentGroups,
    frontPageBody,
    fetchedPages: Array.from(fetchedPagesBySlug.values()),
    warnings,
  };
}

async function enrichAssignmentsWithDetails(
  client: CanvasClient,
  courseId: number,
  assignments: CanvasAssignment[],
  signal?: AbortSignal | null
): Promise<{ assignments: RawAssignmentRecord[]; warning: string | null }> {
  const detailFetcher = (client as CanvasClient & {
    getAssignmentDetail?: (
      courseId: number,
      assignmentId: number,
      signal?: AbortSignal | null
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
        const detail = await detailFetcher.call(client, courseId, assignment.id, signal);
        return { ...assignment, ...detail };
      } catch {
        failedDetails += 1;
        return assignment;
      }
    },
    signal
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

async function enrichQuizzesWithDetails(
  client: CanvasClient,
  courseId: number,
  quizzes: CanvasQuiz[],
  signal?: AbortSignal | null
): Promise<{ quizzes: CanvasQuiz[]; warning: string | null }> {
  const detailFetcher = (client as CanvasClient & {
    getQuizDetail?: (
      courseId: number,
      quizId: number,
      signal?: AbortSignal | null
    ) => Promise<CanvasQuiz>;
  }).getQuizDetail;

  if (!detailFetcher || quizzes.length === 0) {
    return { quizzes, warning: null };
  }

  let failedDetails = 0;
  const enrichedQuizzes = await mapWithConcurrency(
    quizzes,
    QUIZ_DETAIL_CONCURRENCY,
    async (quiz) => {
      try {
        const detail = await detailFetcher.call(client, courseId, quiz.id, signal);
        return { ...quiz, ...detail };
      } catch {
        failedDetails += 1;
        return quiz;
      }
    },
    signal
  );

  return {
    quizzes: enrichedQuizzes,
    warning:
      failedDetails > 0
        ? `Quiz detail unavailable for ${failedDetails} quiz${
            failedDetails === 1 ? "" : "zes"
          } — instructions and quiz metadata may be incomplete`
        : null,
  };
}

const CANVAS_LINK_ATTR_RE =
  /\b(?:href|src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function extractCanvasPageSlugs(
  html: string,
  courseId: number,
  baseUrl?: string | null
): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = CANVAS_LINK_ATTR_RE.exec(html)) !== null) {
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!href) {
      continue;
    }
    const parsed = parseUrl(href, baseUrl);
    if (!parsed) {
      continue;
    }
    const pageMatch = parsed.pathname.match(/^\/courses\/(\d+)\/pages\/([^/?#]+)/);
    if (!pageMatch || parseInt(pageMatch[1]!, 10) !== courseId) {
      continue;
    }
    const slug = decodeURIComponent(pageMatch[2]!);
    if (!seen.has(slug)) {
      seen.add(slug);
      slugs.push(slug);
    }
  }
  return slugs;
}

function parseUrl(href: string, baseUrl?: string | null): URL | null {
  try {
    return new URL(href, baseUrl ?? "https://canvas.invalid");
  } catch {
    return null;
  }
}

function buildCanvasPageUrl(courseHtmlUrl: string | null, slug: string): string | null {
  if (!courseHtmlUrl) {
    return null;
  }
  return `${courseHtmlUrl.replace(/\/$/, "")}/pages/${encodeURIComponent(slug)}`;
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
