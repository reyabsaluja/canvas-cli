import type { CanvasClient } from "../canvas/client.js";
import type {
  CanvasCourseDetail,
  CanvasAssignment,
  CanvasAssignmentDetail,
  CanvasModule,
  CanvasModuleItem,
  CanvasFile,
  CanvasQuiz,
  CanvasTab,
  CanvasAssignmentGroup,
  CanvasFolder,
  CanvasPage,
  CanvasDiscussionEntry,
  CanvasDiscussionTopic,
  CanvasDiscussionTopicView,
  CanvasSubmission,
  CanvasCalendarEvent,
} from "../canvas/types.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  collectAssignmentFeedbackHtmlSources,
  collectAssignmentRubricHtmlSources,
} from "./rich-text-sources.js";

export interface RawDiscussionThread {
  topic: CanvasDiscussionTopic;
  /**
   * Every entry in the thread, nested replies included, in thread order
   * (each reply directly after the entry it answers, siblings oldest first).
   * `user_name` is resolved from the view's participants when the API omits it.
   */
  entries: CanvasDiscussionEntry[];
  participantCount: number;
  /** Replies fetched through GET .../entries/:id/replies because the inline list was truncated. */
  repliesPaged?: number;
}

export type RawAssignmentRecord = CanvasAssignment &
  Partial<Omit<CanvasAssignmentDetail, keyof CanvasAssignment>>;

export interface RawCourseContent {
  courseDetail: CanvasCourseDetail;
  assignments: RawAssignmentRecord[];
  modules: Array<CanvasModule & { items: CanvasModuleItem[] }>;
  files: CanvasFile[];
  /** Folder tree of the course Files area (empty when the Files API is blocked). */
  folders: CanvasFolder[];
  pages: CanvasPage[];
  announcements: CanvasDiscussionTopic[];
  /**
   * Reply threads under announcements (instructors answer "is the room
   * change for both sections?" there), captured the same way as discussion
   * threads: one entry per announcement, empty when comments are disabled.
   */
  announcementThreads: RawDiscussionThread[];
  discussions: CanvasDiscussionTopic[];
  discussionThreads: RawDiscussionThread[];
  /** Front page (home page) HTML body, if accessible. */
  frontPageBody: string | null;
  /** Individual page bodies fetched from the Pages index and discovered same-course Canvas links. */
  fetchedPages: Array<{ slug: string; title: string; body: string }>;
  /** Quizzes (classic + New Quizzes) as listed by the Quizzes API; empty when blocked. */
  quizzes: CanvasQuiz[];
  /** Course navigation tabs; external tools (Piazza, Zoom, Ed, ...) are captured as a page. */
  tabs: CanvasTab[];
  /** Assignment groups (weights, drop rules); rendered as a "Grading scheme" page. */
  assignmentGroups: CanvasAssignmentGroup[];
  /**
   * Course calendar events (exam slots, review sessions, office hours). Each
   * is stored as a "Calendar event: <title>" page and all of them on the
   * "Course calendar" page; empty when the calendar is blocked.
   */
  calendarEvents: CanvasCalendarEvent[];
  /**
   * How the student's own grader feedback was captured. The comments and
   * rubric assessments themselves are merged into each assignment's
   * `submission`; this only says what was fetched.
   */
  submissionFeedback: SubmissionFeedbackFetchSummary;
  warnings: string[];
}

export interface SubmissionFeedbackFetchSummary {
  /** False when the caller opted out (`--no-feedback`); no request is made then. */
  enabled: boolean;
  /** Submissions returned for the current user. */
  submissions: number;
  /** Grader/peer comments across all submissions. */
  comments: number;
  /** Submissions carrying a rubric assessment. */
  rubricAssessments: number;
}

export interface FetchCourseContentOptions {
  /**
   * Fetch the student's own submission comments, feedback attachments, and
   * rubric assessments (GET /courses/:id/students/submissions). Defaults to
   * true; when false the endpoint is never requested.
   */
  includeSubmissionFeedback?: boolean;
}

const MODULE_ITEMS_CONCURRENCY = 4;
const PAGE_BODY_CONCURRENCY = 4;
const DISCUSSION_VIEW_CONCURRENCY = 4;
const DISCUSSION_REPLY_PAGING_CONCURRENCY = 4;
const ASSIGNMENT_DETAIL_CONCURRENCY = 4;

/**
 * Fetch all available course content from Canvas.
 * Handles gracefully when Files API or Pages API is blocked.
 */
export async function fetchCourseContent(
  client: CanvasClient,
  courseId: number,
  signal?: AbortSignal | null,
  options?: FetchCourseContentOptions
): Promise<RawCourseContent> {
  const warnings: string[] = [];
  const includeSubmissionFeedback = options?.includeSubmissionFeedback !== false;
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
  const folderFetcher = (client as CanvasClient & {
    getFoldersSafe?: (courseId: number, signal?: AbortSignal | null) => Promise<CanvasFolder[]>;
  }).getFoldersSafe;
  // The student's own grader feedback. Optional on the client so hand-rolled
  // test doubles keep working; skipped entirely when the caller opted out.
  const submissionFetcher = (client as CanvasClient & {
    getCurrentUserSubmissionsSafe?: (courseId: number, signal?: AbortSignal | null) => Promise<CanvasSubmission[]>;
  }).getCurrentUserSubmissionsSafe;
  const [
    rawModules,
    files,
    folders,
    pages,
    announcements,
    discussions,
    frontPage,
    assignmentDetailResult,
    currentUserSubmissions,
  ] =
    await Promise.all([
      client.getModulesSafe(courseId, signal),
      client.getFilesSafe(courseId, signal),
      folderFetcher
        ? folderFetcher.call(client, courseId, signal)
        : Promise.resolve([]),
      client.getPagesSafe(courseId, signal),
      announcementFetcher
        ? announcementFetcher.call(client, courseId, undefined, signal)
        : Promise.resolve([]),
      discussionFetcher
        ? discussionFetcher.call(client, courseId, signal)
        : Promise.resolve([]),
      client.getFrontPageSafe(courseId, signal),
      assignmentDetailsPromise,
      includeSubmissionFeedback && submissionFetcher
        ? submissionFetcher.call(client, courseId, signal)
        : Promise.resolve([] as CanvasSubmission[]),
    ]);
  const assignments = mergeSubmissionFeedback(
    assignmentDetailResult.assignments,
    currentUserSubmissions
  );
  if (assignmentDetailResult.warning) {
    warnings.push(assignmentDetailResult.warning);
  }
  const submissionFeedback: SubmissionFeedbackFetchSummary = {
    enabled: includeSubmissionFeedback,
    submissions: currentUserSubmissions.length,
    comments: currentUserSubmissions.reduce(
      (sum, submission) => sum + (submission.submission_comments?.length ?? 0),
      0
    ),
    rubricAssessments: currentUserSubmissions.filter(
      (submission) =>
        submission.rubric_assessment &&
        typeof submission.rubric_assessment === "object" &&
        Object.keys(submission.rubric_assessment).length > 0
    ).length,
  };

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

  const discussionThreads = await mapWithConcurrency(
    discussions,
    DISCUSSION_VIEW_CONCURRENCY,
    (topic) => collectDiscussionThread(client, courseId, topic, signal),
    signal
  );
  const announcementThreads = await mapWithConcurrency(
    announcements,
    DISCUSSION_VIEW_CONCURRENCY,
    (topic) => collectDiscussionThread(client, courseId, topic, signal),
    signal
  );

  const seenSlugs = new Set<string>();
  const pendingSlugs: string[] = [];
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
    body: string | null | undefined
  ): void => {
    if (!slug || !body || fetchedPagesBySlug.has(slug)) {
      return;
    }
    fetchedPagesBySlug.set(slug, {
      slug,
      title: title ?? slug,
      body,
    });
    enqueueLinkedPageSlugs(body);
  };

  const enqueueLinkedPageSlugs = (html: string | null | undefined): void => {
    if (!html) return;
    for (const slug of extractCanvasPageSlugs(html, courseId)) {
      enqueueSlug(slug);
    }
  };

  // Seed the crawl from every page listed in the Pages index, explicit module
  // pages, then expand through every HTML surface we can already access. This
  // recovers unlinked course pages in addition to page hubs linked from
  // assignments, the syllabus, announcements, and other pages.
  for (const page of pages) {
    rememberFetchedPage(page.url, page.title, page.body ?? null);
    enqueueSlug(page.url);
  }
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
    // Rubric details and grader feedback link to pages too ("see the style
    // guide page"), so they seed the crawl like any other rich text.
    for (const source of collectAssignmentRubricHtmlSources(assignment)) {
      enqueueLinkedPageSlugs(source.html);
    }
    for (const source of collectAssignmentFeedbackHtmlSources(assignment)) {
      enqueueLinkedPageSlugs(source.html);
    }
  }
  for (const announcement of announcements) {
    enqueueLinkedPageSlugs(announcement.message);
  }
  for (const thread of announcementThreads) {
    for (const entry of thread.entries) {
      enqueueLinkedPageSlugs(entry.message);
    }
  }
  for (const thread of discussionThreads) {
    enqueueLinkedPageSlugs(thread.topic.message);
    for (const entry of thread.entries) {
      enqueueLinkedPageSlugs(entry.message);
    }
  }

  // Quizzes: their instructions, time limit and attempt rules live only on
  // the quiz object, and practice quizzes/surveys never appear as
  // assignments. Store each as a page so it is extracted and indexed like one.
  // Optional on the client so hand-rolled test doubles keep working.
  const getQuizzesSafe = (client as {
    getQuizzesSafe?: (courseId: number, signal?: AbortSignal | null) => Promise<CanvasQuiz[]>;
  }).getQuizzesSafe;
  const quizzes = getQuizzesSafe ? await getQuizzesSafe.call(client, courseId, signal) : [];
  for (const quiz of quizzes) {
    rememberFetchedPage(`quiz-${quiz.id}`, `Quiz: ${quiz.title}`, buildQuizPageBody(quiz));
  }

  // Course navigation: external tools (Piazza, Ed, Zoom, Gradescope, ...) are
  // often the only place a course names where questions, office hours or
  // recordings live. Capture them as a "Course tools" page.
  const getTabsSafe = (client as {
    getTabsSafe?: (courseId: number, signal?: AbortSignal | null) => Promise<CanvasTab[]>;
  }).getTabsSafe;
  const tabs = getTabsSafe ? await getTabsSafe.call(client, courseId, signal) : [];
  const toolsBody = buildCourseToolsPageBody(tabs);
  if (toolsBody) {
    rememberFetchedPage("course-tools", "Course tools and external links", toolsBody);
  }

  // Grading scheme: "how much is Lab 4 worth?" is answered by assignment
  // group weights and drop rules, which live only on assignment_groups.
  const getAssignmentGroupsSafe = (client as {
    getAssignmentGroupsSafe?: (courseId: number, signal?: AbortSignal | null) => Promise<CanvasAssignmentGroup[]>;
  }).getAssignmentGroupsSafe;
  const assignmentGroups = getAssignmentGroupsSafe
    ? await getAssignmentGroupsSafe.call(client, courseId, signal)
    : [];
  const gradingBody = buildGradingSchemePageBody(
    assignmentGroups,
    assignments,
    courseDetail.apply_assignment_group_weights ?? null
  );
  if (gradingBody) {
    rememberFetchedPage("grading-scheme", "Grading scheme: assignment groups and weights", gradingBody);
  }

  // Course calendar: exam dates, review sessions and office hours often live
  // only here. One page per event (so search finds "midterm review") plus a
  // single chronological "Course calendar" page for "what's coming up?".
  const getCalendarEventsSafe = (client as {
    getCalendarEventsSafe?: (courseId: number, signal?: AbortSignal | null) => Promise<CanvasCalendarEvent[]>;
  }).getCalendarEventsSafe;
  const calendarEvents = getCalendarEventsSafe
    ? await getCalendarEventsSafe.call(client, courseId, signal)
    : [];
  for (const event of calendarEvents) {
    rememberFetchedPage(
      `calendar-event-${event.id}`,
      `Calendar event: ${event.title}`,
      buildCalendarEventPageBody(event)
    );
  }
  const calendarBody = buildCourseCalendarPageBody(calendarEvents);
  if (calendarBody) {
    rememberFetchedPage("course-calendar", "Course calendar", calendarBody);
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
      rememberFetchedPage(page.slug, page.title, page.body);
    }
  }

  return {
    courseDetail,
    assignments,
    modules,
    files,
    folders,
    pages,
    announcements,
    announcementThreads,
    discussions,
    discussionThreads,
    frontPageBody,
    fetchedPages: Array.from(fetchedPagesBySlug.values()),
    quizzes,
    tabs,
    assignmentGroups,
    calendarEvents,
    submissionFeedback,
    warnings,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "2026-10-02" for an all-day event, else the full timestamp. */
function describeEventStart(event: CanvasCalendarEvent): string | null {
  if (event.all_day && event.all_day_date) return event.all_day_date;
  if (event.all_day && event.start_at) return event.start_at.slice(0, 10);
  return event.start_at ?? null;
}

/**
 * Render one calendar event as HTML for the page pipeline: when, where, and
 * the description (which may link handouts and pages). Exported for tests.
 */
export function buildCalendarEventPageBody(event: CanvasCalendarEvent): string {
  const facts: string[] = [];
  const start = describeEventStart(event);
  if (event.all_day) {
    facts.push(`<li>Date: ${start ? escapeHtml(start) : "not scheduled"}</li>`);
    facts.push("<li>All day: yes</li>");
  } else {
    facts.push(`<li>Starts: ${start ? escapeHtml(start) : "not scheduled"}</li>`);
    if (event.end_at && event.end_at !== event.start_at) {
      facts.push(`<li>Ends: ${escapeHtml(event.end_at)}</li>`);
    }
  }
  if (event.location_name) facts.push(`<li>Location: ${escapeHtml(event.location_name)}</li>`);
  if (event.location_address) facts.push(`<li>Address: ${escapeHtml(event.location_address)}</li>`);
  if (event.workflow_state && event.workflow_state !== "active") {
    facts.push(`<li>Status: ${escapeHtml(event.workflow_state)}</li>`);
  }
  if (event.html_url) {
    facts.push(`<li>Canvas URL: <a href="${escapeHtml(event.html_url)}">${escapeHtml(event.html_url)}</a></li>`);
  }
  const description = event.description?.trim()
    ? `<h2>Description</h2>\n${event.description}`
    : "<p>No event description provided.</p>";
  return `<h2>Event details</h2>\n<ul>${facts.join("")}</ul>\n${description}`;
}

/**
 * Every calendar event in chronological order (undated last) as one page,
 * or null when the calendar is empty. Exported for tests.
 */
export function buildCourseCalendarPageBody(events: CanvasCalendarEvent[]): string | null {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => {
    const left = a.start_at ?? a.all_day_date ?? "";
    const right = b.start_at ?? b.all_day_date ?? "";
    if (left && right) return left.localeCompare(right);
    if (left) return -1;
    if (right) return 1;
    return a.title.localeCompare(b.title);
  });
  const items = sorted.map((event) => {
    const start = describeEventStart(event);
    const when = event.all_day
      ? `${start ?? "date not set"} (all day)`
      : start
        ? `${start}${event.end_at && event.end_at !== event.start_at ? ` to ${event.end_at}` : ""}`
        : "not scheduled";
    const where = event.location_name ? ` — ${escapeHtml(event.location_name)}` : "";
    return `<li><strong>${escapeHtml(event.title)}</strong>: ${escapeHtml(when)}${where} (details: page calendar-event-${event.id})</li>`;
  });
  return (
    "<p>Events on this course's Canvas calendar, in date order. Each event also has its own page with the full description.</p>" +
    `<ul>${items.join("")}</ul>`
  );
}

/**
 * Attach the student's own submission records (comments, feedback files,
 * rubric assessment) to the matching assignments. The assignment list's
 * inline `submission` (score, grade, late/missing) is kept and the richer
 * record is layered on top.
 */
export function mergeSubmissionFeedback(
  assignments: RawAssignmentRecord[],
  submissions: CanvasSubmission[]
): RawAssignmentRecord[] {
  if (submissions.length === 0) {
    return assignments;
  }

  const submissionByAssignmentId = new Map<number, CanvasSubmission>();
  for (const submission of submissions) {
    if (typeof submission.assignment_id !== "number") {
      continue;
    }
    submissionByAssignmentId.set(submission.assignment_id, submission);
  }

  if (submissionByAssignmentId.size === 0) {
    return assignments;
  }

  return assignments.map((assignment) => {
    const submission = submissionByAssignmentId.get(assignment.id);
    if (!submission) {
      return assignment;
    }
    return {
      ...assignment,
      submission: assignment.submission
        ? { ...assignment.submission, ...submission }
        : submission,
    };
  });
}

/**
 * Assignment groups with weights, drop rules and member assignments as a
 * page, or null when there are no groups. Exported for tests.
 */
export function buildGradingSchemePageBody(
  groups: CanvasAssignmentGroup[],
  assignments: Array<{
    id: number;
    name: string;
    assignment_group_id?: number | null;
    points_possible?: number | null;
    due_at?: string | null;
  }>,
  weightsApplied: boolean | null
): string | null {
  if (groups.length === 0) return null;
  const sorted = [...groups].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const anyWeight = sorted.some((group) => typeof group.group_weight === "number" && group.group_weight > 0);
  const parts: string[] = [];
  if (weightsApplied === true || (weightsApplied === null && anyWeight)) {
    parts.push("<p>The final grade is a weighted sum of these assignment groups.</p>");
  } else if (weightsApplied === false) {
    parts.push("<p>Assignment group weights are not applied; the final grade is based on total points.</p>");
  }
  for (const group of sorted) {
    const weight =
      typeof group.group_weight === "number" && (anyWeight || weightsApplied)
        ? ` — ${group.group_weight}% of the final grade`
        : "";
    parts.push(`<h2>${group.name}${weight}</h2>`);
    const rules: string[] = [];
    if (group.rules?.drop_lowest) rules.push(`the lowest ${group.rules.drop_lowest} score${group.rules.drop_lowest > 1 ? "s are" : " is"} dropped`);
    if (group.rules?.drop_highest) rules.push(`the highest ${group.rules.drop_highest} score${group.rules.drop_highest > 1 ? "s are" : " is"} dropped`);
    if (rules.length > 0) parts.push(`<p>Rules: ${rules.join("; ")}.</p>`);
    // Prefer the group's own assignment list (include[]=assignments); fall
    // back to the course assignments tagged with this group id.
    const members: Array<{ name: string; points_possible?: number | null; due_at?: string | null }> =
      group.assignments && group.assignments.length > 0
        ? group.assignments.filter((a) => !a.omit_from_final_grade)
        : assignments.filter((assignment) => assignment.assignment_group_id === group.id);
    if (members.length === 0) {
      parts.push("<p>No assignments in this group yet.</p>");
      continue;
    }
    const totalPoints = members.reduce((sum, a) => sum + (a.points_possible ?? 0), 0);
    parts.push(
      `<ul>${members
        .map((a) => {
          const points = a.points_possible !== null && a.points_possible !== undefined ? `${a.points_possible} points` : "points not set";
          const share =
            totalPoints > 0 && typeof group.group_weight === "number" && group.group_weight > 0 && a.points_possible
              ? `, about ${((a.points_possible / totalPoints) * group.group_weight).toFixed(1)}% of the final grade`
              : "";
          const due = a.due_at ? `, due ${a.due_at}` : "";
          return `<li>${a.name} (${points}${share}${due})</li>`;
        })
        .join("")}</ul>`
    );
  }
  return parts.join("\n");
}

const TOOL_HINTS: Array<[RegExp, string]> = [
  [/piazza/i, "Q&A forum: ask and search course questions here"],
  [/\bed\b|edstem/i, "Q&A forum: ask and search course questions here"],
  [/zoom/i, "live sessions and office hours (video)"],
  [/gradescope|crowdmark/i, "assignment submission and grading"],
  [/panopto|kaltura|echo360|yuja|mediasite|studio/i, "lecture recordings"],
  [/github|gitlab|bitbucket/i, "code hosting"],
  [/turnitin/i, "plagiarism checking for submissions"],
  [/pearson|mcgraw|wiley|cengage|zybook|mylab|mastering/i, "publisher platform for textbook work"],
  [/slack|discord|teams/i, "chat with the class"],
  [/perusall|hypothes/i, "collaborative reading"],
  [/top hat|tophat|iclicker|poll/i, "in-class polling"],
];

/** Externally hosted course tools as a page, or null when there are none. Exported for tests. */
export function buildCourseToolsPageBody(tabs: CanvasTab[]): string | null {
  const external = tabs
    .filter((tab) => tab.type === "external" && !tab.hidden)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (external.length === 0) return null;
  const items = external.map((tab) => {
    const url = tab.full_url ?? tab.html_url ?? "";
    const hint = TOOL_HINTS.find(([pattern]) => pattern.test(`${tab.label} ${url}`))?.[1];
    const link = url ? ` — <a href="${url}">${url}</a>` : "";
    return `<li><strong>${tab.label}</strong>${hint ? ` (${hint})` : ""}${link}</li>`;
  });
  return (
    "<p>External tools linked from this course's navigation. These are where the course sends students for things Canvas itself does not host.</p>" +
    `<ul>${items.join("")}</ul>`
  );
}

function describeAttempts(value: number | null | undefined): string {
  if (value === null || value === undefined) return "not stated";
  if (value < 0) return "unlimited";
  return `${value}`;
}

/** Render a quiz's rules and instructions as HTML for the page pipeline. Exported for tests. */
export function buildQuizPageBody(quiz: CanvasQuiz): string {
  const facts: string[] = [];
  const type =
    quiz.quiz_type === "practice_quiz"
      ? "practice quiz (not graded)"
      : quiz.quiz_type === "graded_survey"
        ? "graded survey"
        : quiz.quiz_type === "survey"
          ? "survey (not graded)"
          : "graded quiz";
  facts.push(`<li>Type: ${type}</li>`);
  if (quiz.due_at) facts.push(`<li>Due: ${quiz.due_at}</li>`);
  if (quiz.unlock_at) facts.push(`<li>Available from: ${quiz.unlock_at}</li>`);
  if (quiz.lock_at) facts.push(`<li>Locks at: ${quiz.lock_at}</li>`);
  facts.push(`<li>Time limit: ${quiz.time_limit ? `${quiz.time_limit} minutes` : "none"}</li>`);
  facts.push(`<li>Allowed attempts: ${describeAttempts(quiz.allowed_attempts)}</li>`);
  if (quiz.points_possible !== null && quiz.points_possible !== undefined) {
    facts.push(`<li>Points possible: ${quiz.points_possible}</li>`);
  }
  if (quiz.question_count !== null && quiz.question_count !== undefined) {
    facts.push(`<li>Questions: ${quiz.question_count}</li>`);
  }
  if (quiz.shuffle_answers) facts.push("<li>Answers are shuffled</li>");
  if (quiz.one_question_at_a_time) facts.push("<li>One question at a time</li>");
  if (quiz.show_correct_answers === false) facts.push("<li>Correct answers are not shown afterwards</li>");
  if (quiz.published === false) facts.push("<li>Not yet published</li>");
  if (quiz.html_url) facts.push(`<li>Link: <a href="${quiz.html_url}">${quiz.html_url}</a></li>`);
  const instructions = quiz.description?.trim()
    ? `<h2>Instructions</h2>\n${quiz.description}`
    : "<p>No instructions were provided.</p>";
  return `<h2>Quiz details</h2>\n<ul>${facts.join("")}</ul>\n${instructions}`;
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

interface DiscussionThreadNode {
  entry: CanvasDiscussionEntry;
  children: DiscussionThreadNode[];
}

type DiscussionClient = CanvasClient & {
  getDiscussionTopicViewSafe?: (
    courseId: number,
    topicId: number,
    signal?: AbortSignal | null
  ) => Promise<CanvasDiscussionTopicView | null>;
  getDiscussionEntriesSafe?: (
    courseId: number,
    topicId: number,
    signal?: AbortSignal | null
  ) => Promise<CanvasDiscussionEntry[]>;
  getDiscussionEntryRepliesSafe?: (
    courseId: number,
    topicId: number,
    entryId: number,
    signal?: AbortSignal | null
  ) => Promise<CanvasDiscussionEntry[]>;
};

/**
 * Capture the full reply tree of one discussion topic.
 *
 * Prefers GET .../view (one request, every entry, threaded children nested
 * under `replies`, authors in `participants`). When the view is unavailable
 * (403, or 503 while Canvas materialises it) falls back to GET .../entries,
 * whose inline `recent_replies` stop at 10 — any entry flagged
 * `has_more_replies` then has its complete reply list paged in. Deleted
 * tombstones are skipped while their children are kept. Everything degrades
 * to an empty thread rather than failing the ingest.
 */
export async function collectDiscussionThread(
  client: CanvasClient,
  courseId: number,
  topic: CanvasDiscussionTopic,
  signal?: AbortSignal | null
): Promise<RawDiscussionThread> {
  const fetchers = client as DiscussionClient;
  const empty: RawDiscussionThread = {
    topic,
    entries: [],
    participantCount: 0,
    repliesPaged: 0,
  };

  const view = fetchers.getDiscussionTopicViewSafe
    ? await fetchers.getDiscussionTopicViewSafe.call(client, courseId, topic.id, signal)
    : null;

  const namesByUserId = new Map<number, string>();
  const nodesById = new Map<number, DiscussionThreadNode>();
  let roots: DiscussionThreadNode[];

  if (view) {
    for (const participant of view.participants ?? []) {
      if (participant.display_name) {
        namesByUserId.set(participant.id, participant.display_name);
      }
    }
    roots = buildDiscussionTree(view.view ?? [], nodesById);
    attachFlatEntries(view.new_entries ?? [], roots, nodesById, null);
  } else if (fetchers.getDiscussionEntriesSafe) {
    const topLevel = await fetchers.getDiscussionEntriesSafe.call(
      client,
      courseId,
      topic.id,
      signal
    );
    if (topLevel.length === 0) {
      return empty;
    }
    roots = buildDiscussionTree(topLevel, nodesById);
  } else {
    return empty;
  }

  let repliesPaged = 0;
  if (fetchers.getDiscussionEntryRepliesSafe) {
    const truncated = Array.from(nodesById.values()).filter(
      (node) => node.entry.has_more_replies === true
    );
    const pagedReplies = await mapWithConcurrency(
      truncated,
      DISCUSSION_REPLY_PAGING_CONCURRENCY,
      async (node) => ({
        node,
        replies: await fetchers.getDiscussionEntryRepliesSafe!.call(
          client,
          courseId,
          topic.id,
          node.entry.id,
          signal
        ),
      }),
      signal
    );
    for (const { node, replies } of pagedReplies) {
      if (replies.length === 0) continue;
      repliesPaged += replies.length;
      attachFlatEntries(replies, roots, nodesById, node);
    }
  }

  const entries: CanvasDiscussionEntry[] = [];
  const visit = (node: DiscussionThreadNode): void => {
    const { entry } = node;
    const isTombstone = entry.deleted === true && !entry.message;
    if (!isTombstone) {
      entries.push({
        ...entry,
        user_name: entry.user_name ?? namesByUserId.get(entry.user_id) ?? null,
        replies: undefined,
        recent_replies: undefined,
      });
    }
    for (const child of sortByCreatedAt(node.children)) {
      visit(child);
    }
  };
  for (const root of sortByCreatedAt(roots)) {
    visit(root);
  }

  const participantCount = view
    ? Math.max(
        view.participants?.length ?? 0,
        new Set(entries.map((entry) => entry.user_id)).size
      )
    : new Set(entries.map((entry) => entry.user_id)).size;

  return { topic, entries, participantCount, repliesPaged };
}

/**
 * Turn a nested entry list (`replies` from /view, `recent_replies` from
 * /entries) into a tree, registering every node by id.
 */
function buildDiscussionTree(
  entries: CanvasDiscussionEntry[],
  nodesById: Map<number, DiscussionThreadNode>
): DiscussionThreadNode[] {
  const roots: DiscussionThreadNode[] = [];

  const visit = (
    entry: CanvasDiscussionEntry,
    parent: DiscussionThreadNode | null
  ): void => {
    if (nodesById.has(entry.id)) {
      return;
    }
    const node: DiscussionThreadNode = { entry, children: [] };
    nodesById.set(entry.id, node);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    for (const child of entry.replies ?? []) {
      visit(child, node);
    }
    for (const child of entry.recent_replies ?? []) {
      visit(child, node);
    }
  };

  for (const entry of entries) {
    visit(entry, null);
  }
  return roots;
}

/**
 * Attach a flat list of entries (new_entries, or a paged reply list) under
 * their `parent_id`. Parents are created before their children, so walking in
 * creation order lets nested paged replies find their parent; anything whose
 * parent is unknown lands under `fallbackParent` (or becomes a root).
 */
function attachFlatEntries(
  entries: CanvasDiscussionEntry[],
  roots: DiscussionThreadNode[],
  nodesById: Map<number, DiscussionThreadNode>,
  fallbackParent: DiscussionThreadNode | null
): void {
  for (const entry of sortEntriesByCreatedAt(entries)) {
    if (nodesById.has(entry.id)) {
      continue;
    }
    const node: DiscussionThreadNode = { entry, children: [] };
    nodesById.set(entry.id, node);
    const parent =
      (entry.parent_id != null ? nodesById.get(entry.parent_id) : undefined) ??
      fallbackParent;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    for (const child of entry.replies ?? []) {
      attachFlatEntries([{ ...child, parent_id: entry.id }], roots, nodesById, node);
    }
    for (const child of entry.recent_replies ?? []) {
      attachFlatEntries([{ ...child, parent_id: entry.id }], roots, nodesById, node);
    }
  }
}

function sortByCreatedAt(nodes: DiscussionThreadNode[]): DiscussionThreadNode[] {
  return nodes
    .slice()
    .sort((left, right) =>
      (left.entry.created_at ?? "").localeCompare(right.entry.created_at ?? "")
    );
}

function sortEntriesByCreatedAt(
  entries: CanvasDiscussionEntry[]
): CanvasDiscussionEntry[] {
  return entries
    .slice()
    .sort((left, right) =>
      (left.created_at ?? "").localeCompare(right.created_at ?? "")
    );
}
