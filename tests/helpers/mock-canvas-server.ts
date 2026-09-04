import http from "node:http";

export interface MockCourse {
  id: number;
  name: string;
  course_code: string;
  enrollment_term_id: number;
  workflow_state: string;
  start_at: string | null;
  end_at: string | null;
  term?: { id: number; name: string; start_at: string | null; end_at: string | null };
  enrollments?: Array<{ enrollment_state: string; type: string }>;
}

export interface MockAssignment {
  id: number;
  name: string;
  due_at: string | null;
  html_url: string;
  course_id: number;
  has_submitted_submissions: boolean;
  description?: string | null;
  points_possible?: number | null;
  submission_types?: string[];
  allowed_attempts?: number;
  attachments?: MockAttachment[];
  peer_reviews?: boolean;
  peer_review_count?: number;
  group_category_id?: number | null;
  grade_group_students_individually?: boolean;
  submission?: {
    workflow_state: string;
    submitted_at: string | null;
    score: number | null;
    grade: string | null;
    attempt: number | null;
    late: boolean;
    missing: boolean;
  };
  /** Rubric criteria, as returned with include[]=rubric on the detail endpoint. */
  rubric?: MockRubricCriterion[] | null;
  /** Per-section/group/student dates, as returned with include[]=all_dates. */
  all_dates?: MockAssignmentDate[] | null;
}

export interface MockRubricCriterion {
  id: string | number;
  description: string;
  long_description?: string | null;
  points: number | null;
  ratings?: Array<{
    id?: string | number;
    description: string;
    long_description?: string | null;
    points?: number | null;
  }> | null;
}

export interface MockAssignmentDate {
  id?: number;
  base?: boolean;
  title?: string | null;
  due_at: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  set_type?: string | null;
  set_id?: number | null;
}

/** One of the current user's submissions, as served by GET /courses/:id/students/submissions. */
export interface MockSubmission {
  assignment_id: number;
  user_id: number;
  workflow_state: string;
  submitted_at: string | null;
  score: number | null;
  grade: string | null;
  attempt: number | null;
  late: boolean;
  missing: boolean;
  submission_comments?: MockSubmissionComment[] | null;
  rubric_assessment?: Record<
    string,
    {
      points?: number | null;
      rating_id?: string | number | null;
      comments?: string | null;
      comments_enabled?: boolean | null;
    } | null
  > | null;
}

export interface MockSubmissionComment {
  id: number;
  author_id?: number | null;
  author_name?: string | null;
  comment?: string | null;
  html_comment?: string | null;
  created_at?: string | null;
  edited_at?: string | null;
  media_comment?: {
    "content-type"?: string | null;
    display_name?: string | null;
    media_id?: string | null;
    media_type?: string | null;
    url?: string | null;
  } | null;
  /** Files the grader attached to the comment (marked-up PDFs, rubrics). */
  attachments?: MockAttachment[] | null;
}

/** A course calendar event served by GET /calendar_events?context_codes[]=course_<id>. */
export interface MockCalendarEvent {
  id: number;
  title: string;
  description?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  all_day?: boolean | null;
  location_name?: string | null;
  location_address?: string | null;
  context_code?: string | null;
  html_url?: string | null;
  workflow_state?: string | null;
}

export interface MockModule {
  id: number;
  name: string;
  position: number;
  items_count: number;
  items_url: string;
  unlock_at?: string | null;
  require_sequential_progress?: boolean;
  prerequisite_module_ids?: number[];
  items?: Array<{
    id: number;
    title: string;
    completion_requirement?: { type: string; min_score?: number };
    type: string;
    position: number;
    content_id?: number;
    page_url?: string;
    html_url?: string;
    external_url?: string;
  }>;
}

export interface MockPage {
  page_id: number;
  url: string;
  title: string;
  html_url: string | null;
  updated_at: string | null;
  body?: string | null;
}

export interface MockFile {
  id: number;
  display_name: string;
  filename: string;
  content_type: string;
  size: number;
  url: string;
  updated_at: string | null;
  folder_id: number | null;
}

export interface MockFolder {
  id: number;
  name: string;
  full_name: string;
  parent_folder_id: number | null;
  files_count?: number;
  folders_count?: number;
}

/** A file attached to a topic post or reply, shaped like Canvas's file JSON. */
export interface MockAttachment {
  id: number;
  display_name: string;
  filename: string;
  "content-type": string;
  size: number;
  url: string;
}

export interface MockDiscussionEntry {
  id: number;
  user_id: number;
  user_name: string;
  message: string | null;
  created_at: string;
  updated_at?: string;
  deleted?: boolean;
  /** File attached to this reply (Canvas allows one per entry). */
  attachment?: MockAttachment | null;
  /** Nested replies (threaded discussions). */
  replies?: MockDiscussionEntry[];
}

export interface MockDiscussionTopic {
  id: number;
  title: string;
  message: string | null;
  posted_at: string | null;
  last_reply_at: string | null;
  user_name: string | null;
  html_url: string;
  is_announcement?: boolean;
  discussion_type?: string;
  /** Files attached to the post itself (not linked from the message HTML). */
  attachments?: MockAttachment[];
  /** Top-level entries; each may carry nested `replies`. */
  entries?: MockDiscussionEntry[];
}

export interface MockQuiz {
  id: number;
  title: string;
  html_url?: string;
  description?: string | null;
  quiz_type?: string;
  time_limit?: number | null;
  allowed_attempts?: number;
  points_possible?: number | null;
  question_count?: number;
  due_at?: string | null;
  published?: boolean;
}

export interface MockAssignmentGroup {
  id: number;
  name: string;
  position?: number;
  group_weight?: number;
  rules?: { drop_lowest?: number; drop_highest?: number };
}

export interface MockTab {
  id: string;
  label: string;
  html_url?: string;
  full_url?: string;
  type?: string;
  hidden?: boolean;
  position?: number;
}

export interface MockServerData {
  courses: MockCourse[];
  assignments: Map<number, MockAssignment[]>;
  modules: Map<number, MockModule[]>;
  pages: Map<number, MockPage[]>;
  files: Map<number, MockFile[]>;
  /** Folder tree served from GET /courses/:id/folders. */
  folders?: Map<number, MockFolder[]>;
  /** Quizzes served from GET /courses/:id/quizzes. */
  quizzes?: Map<number, MockQuiz[]>;
  /** Navigation tabs served from GET /courses/:id/tabs. */
  tabs?: Map<number, MockTab[]>;
  /** Assignment groups served from GET /courses/:id/assignment_groups. */
  assignmentGroups?: Map<number, MockAssignmentGroup[]>;
  /** Bytes served from GET /files/:id/download (defaults to a short text body). */
  fileContents?: Map<number, string>;
  /** Any API path matching one of these returns 403, to simulate institution blocks. */
  forbiddenPaths?: RegExp[];
  /**
   * Discussion topics (and announcements, flagged with `is_announcement`)
   * served from GET /courses/:id/discussion_topics, plus the /view, /entries
   * and /entries/:id/replies endpoints built from their `entries` trees.
   */
  discussions?: Map<number, MockDiscussionTopic[]>;
  /**
   * How many `recent_replies` GET .../entries lists inline before setting
   * `has_more_replies` (real Canvas caps this at 10). Defaults to 2.
   */
  discussionRecentReplyLimit?: number;
  courseDetails: Map<number, { syllabus_body: string | null }>;
  pagePerPage?: number;
  /** The current user's submissions served from GET /courses/:id/students/submissions. */
  submissions?: Map<number, MockSubmission[]>;
  /** Course calendar events served from GET /calendar_events. */
  calendarEvents?: Map<number, MockCalendarEvent[]>;
  /** Called for every authenticated request, so tests can assert what was (not) fetched. */
  onRequest?: (method: string, path: string) => void;
}

function parseLinkParams(url: URL): { page: number; perPage: number } {
  const page = parseInt(url.searchParams.get("page") ?? "1", 10);
  const perPage = parseInt(url.searchParams.get("per_page") ?? "10", 10);
  return { page, perPage };
}

function paginatedResponse(
  items: unknown[],
  page: number,
  perPage: number,
  baseUrl: string,
  path: string
): { body: string; headers: Record<string, string> } {
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const slice = items.slice(start, end);
  const totalPages = Math.ceil(items.length / perPage);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (totalPages > 1) {
    const links: string[] = [];
    if (page < totalPages) {
      links.push(`<${baseUrl}${path}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
    }
    links.push(`<${baseUrl}${path}?page=${totalPages}&per_page=${perPage}>; rel="last"`);
    if (page > 1) {
      links.push(`<${baseUrl}${path}?page=1&per_page=${perPage}>; rel="first"`);
    }
    headers["Link"] = links.join(", ");
  }

  return { body: JSON.stringify(slice), headers };
}

function flattenMockEntries(
  entries: MockDiscussionEntry[],
  parentId: number | null,
  out: Array<MockDiscussionEntry & { parent_id: number | null }> = []
): Array<MockDiscussionEntry & { parent_id: number | null }> {
  for (const entry of entries) {
    out.push({ ...entry, parent_id: parentId });
    flattenMockEntries(entry.replies ?? [], entry.id, out);
  }
  return out;
}

/** Shape a mock entry the way GET .../view does: no user_name, nested `replies`. */
function toViewEntry(
  entry: MockDiscussionEntry,
  parentId: number | null
): Record<string, unknown> {
  const { replies, user_name: _userName, ...rest } = entry;
  const view: Record<string, unknown> = {
    ...rest,
    parent_id: parentId,
    updated_at: entry.updated_at ?? entry.created_at,
  };
  if (replies && replies.length > 0) {
    view.replies = replies.map((reply) => toViewEntry(reply, entry.id));
  }
  return view;
}

/** Shape a mock entry the way GET .../entries and .../replies do. */
function toListEntry(
  entry: MockDiscussionEntry & { parent_id: number | null }
): Record<string, unknown> {
  const { replies: _replies, ...rest } = entry;
  return {
    ...rest,
    updated_at: entry.updated_at ?? entry.created_at,
    read_state: "read",
  };
}

/** Every file attached to a topic post or reply, across all courses. */
function findMockTopicAttachment(
  data: MockServerData,
  fileId: number
): MockAttachment | undefined {
  for (const assignments of data.assignments.values()) {
    for (const assignment of assignments) {
      const onAssignment = (assignment.attachments ?? []).find((a) => a.id === fileId);
      if (onAssignment) return onAssignment;
    }
  }
  for (const topics of data.discussions?.values() ?? []) {
    for (const topic of topics) {
      const onTopic = (topic.attachments ?? []).find((a) => a.id === fileId);
      if (onTopic) return onTopic;
      for (const entry of flattenMockEntries(topic.entries ?? [], null)) {
        if (entry.attachment?.id === fileId) return entry.attachment;
      }
    }
  }
  for (const submissions of data.submissions?.values() ?? []) {
    for (const submission of submissions) {
      for (const comment of submission.submission_comments ?? []) {
        const onComment = (comment.attachments ?? []).find((a) => a.id === fileId);
        if (onComment) return onComment;
      }
    }
  }
  return undefined;
}

function findMockTopic(
  data: MockServerData,
  courseId: number,
  topicId: number
): MockDiscussionTopic | undefined {
  return (data.discussions?.get(courseId) ?? []).find((t) => t.id === topicId);
}

export function createMockCanvasServer(data: MockServerData): http.Server {
  const server = http.createServer((req, res) => {
    // Mirror the client's origin (Host header) in Link headers, like real Canvas
    // does; the client refuses to follow pagination links to a different origin.
    const port = (server.address() as { port: number })?.port ?? 0;
    const host = req.headers.host || `localhost:${port}`;
    const baseApiUrl = `http://${host}/api/v1`;

    const url = new URL(req.url ?? "/", `http://localhost`);
    const path = url.pathname.replace(/^\/api\/v1/, "");

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "Invalid access token." }] }));
      return;
    }

    const token = authHeader.slice(7);
    if (token === "expired-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "Invalid access token." }] }));
      return;
    }

    if (token === "forbidden-token") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "user not authorized" }] }));
      return;
    }

    if (data.forbiddenPaths?.some((pattern) => pattern.test(path))) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "user not authorized" }] }));
      return;
    }

    const { page, perPage } = parseLinkParams(url);
    const effectivePerPage = data.pagePerPage ?? perPage;
    data.onRequest?.(req.method ?? "GET", path);

    // GET /courses
    if (path === "/courses" && req.method === "GET") {
      const { body, headers } = paginatedResponse(
        data.courses,
        page,
        effectivePerPage,
        baseApiUrl,
        "/courses"
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id
    const courseDetailMatch = path.match(/^\/courses\/(\d+)$/);
    if (courseDetailMatch && req.method === "GET") {
      const courseId = parseInt(courseDetailMatch[1], 10);
      const course = data.courses.find((c) => c.id === courseId);
      if (!course) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "The specified resource does not exist" }] }));
        return;
      }
      const detail = data.courseDetails.get(courseId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...course, syllabus_body: detail?.syllabus_body ?? null }));
      return;
    }

    // GET /courses/:id/assignments
    const assignmentsMatch = path.match(/^\/courses\/(\d+)\/assignments$/);
    if (assignmentsMatch && req.method === "GET") {
      const courseId = parseInt(assignmentsMatch[1], 10);
      const assignments = data.assignments.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        assignments,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/assignments`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/students/submissions (the caller's own submissions when
    // student_ids[] is omitted, with grader comments and rubric assessments)
    const ownSubmissionsMatch = path.match(/^\/courses\/(\d+)\/students\/submissions$/);
    if (ownSubmissionsMatch && req.method === "GET") {
      const courseId = parseInt(ownSubmissionsMatch[1], 10);
      const submissions = data.submissions?.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        submissions,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/students/submissions`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /calendar_events?context_codes[]=course_<id>
    if (path === "/calendar_events" && req.method === "GET") {
      const events = url.searchParams.getAll("context_codes[]").flatMap((code) => {
        const match = code.match(/^course_(\d+)$/);
        return match ? (data.calendarEvents?.get(parseInt(match[1], 10)) ?? []) : [];
      });
      const { body, headers } = paginatedResponse(
        events,
        page,
        effectivePerPage,
        baseApiUrl,
        "/calendar_events"
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/assignments/:aid
    const assignmentDetailMatch = path.match(/^\/courses\/(\d+)\/assignments\/(\d+)$/);
    if (assignmentDetailMatch && req.method === "GET") {
      const courseId = parseInt(assignmentDetailMatch[1], 10);
      const assignmentId = parseInt(assignmentDetailMatch[2], 10);
      const assignments = data.assignments.get(courseId) ?? [];
      const assignment = assignments.find((a) => a.id === assignmentId);
      if (!assignment) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "The specified resource does not exist" }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(assignment));
      return;
    }

    // GET /courses/:id/modules
    const modulesMatch = path.match(/^\/courses\/(\d+)\/modules$/);
    if (modulesMatch && req.method === "GET") {
      const courseId = parseInt(modulesMatch[1], 10);
      const modules = data.modules.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        modules.map(({ items: _items, ...m }) => m),
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/modules`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/modules/:mid/items
    const moduleItemsMatch = path.match(/^\/courses\/(\d+)\/modules\/(\d+)\/items$/);
    if (moduleItemsMatch && req.method === "GET") {
      const courseId = parseInt(moduleItemsMatch[1], 10);
      const moduleId = parseInt(moduleItemsMatch[2], 10);
      const modules = data.modules.get(courseId) ?? [];
      const mod = modules.find((m) => m.id === moduleId);
      const items = mod?.items ?? [];
      const { body, headers } = paginatedResponse(
        items,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/modules/${moduleId}/items`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/assignment_groups
    const groupsMatch = path.match(/^\/courses\/(\d+)\/assignment_groups$/);
    if (groupsMatch && req.method === "GET") {
      const courseId = parseInt(groupsMatch[1], 10);
      const groups = data.assignmentGroups?.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(groups, page, effectivePerPage, baseApiUrl, `/courses/${courseId}/assignment_groups`);
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/tabs
    const tabsMatch = path.match(/^\/courses\/(\d+)\/tabs$/);
    if (tabsMatch && req.method === "GET") {
      const courseId = parseInt(tabsMatch[1], 10);
      const tabs = data.tabs?.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(tabs, page, effectivePerPage, baseApiUrl, `/courses/${courseId}/tabs`);
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/quizzes
    const quizzesMatch = path.match(/^\/courses\/(\d+)\/quizzes$/);
    if (quizzesMatch && req.method === "GET") {
      const courseId = parseInt(quizzesMatch[1], 10);
      const quizzes = data.quizzes?.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        quizzes,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/quizzes`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/pages
    const pagesMatch = path.match(/^\/courses\/(\d+)\/pages$/);
    if (pagesMatch && req.method === "GET") {
      const courseId = parseInt(pagesMatch[1], 10);
      const pages = data.pages.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        pages.map(({ body: _body, ...p }) => p),
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/pages`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/pages/:slug
    const pageSlugMatch = path.match(/^\/courses\/(\d+)\/pages\/([^/]+)$/);
    if (pageSlugMatch && req.method === "GET") {
      const courseId = parseInt(pageSlugMatch[1], 10);
      const slug = pageSlugMatch[2];
      const pages = data.pages.get(courseId) ?? [];
      const foundPage = pages.find((p) => p.url === slug);
      if (!foundPage) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "The specified resource does not exist" }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(foundPage));
      return;
    }

    // GET /courses/:id/front_page
    const frontPageMatch = path.match(/^\/courses\/(\d+)\/front_page$/);
    if (frontPageMatch && req.method === "GET") {
      const courseId = parseInt(frontPageMatch[1], 10);
      const pages = data.pages.get(courseId) ?? [];
      const frontPage = pages.find((p) => p.url === "front-page");
      if (!frontPage) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(frontPage));
      return;
    }

    // GET /courses/:id/files
    const filesMatch = path.match(/^\/courses\/(\d+)\/files$/);
    if (filesMatch && req.method === "GET") {
      const courseId = parseInt(filesMatch[1], 10);
      const files = data.files.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        files,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/files`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/folders
    const foldersMatch = path.match(/^\/courses\/(\d+)\/folders$/);
    if (foldersMatch && req.method === "GET") {
      const courseId = parseInt(foldersMatch[1], 10);
      const folders = data.folders?.get(courseId) ?? [];
      const { body, headers } = paginatedResponse(
        folders,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/folders`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /files/:id/download (also reachable without the /api/v1 prefix)
    const fileDownloadMatch = path.match(/^\/files\/(\d+)\/download$/);
    if (fileDownloadMatch && req.method === "GET") {
      const fileId = parseInt(fileDownloadMatch[1], 10);
      let found: MockFile | undefined;
      for (const files of data.files.values()) {
        found = files.find((f) => f.id === fileId);
        if (found) break;
      }
      const attached = found ? undefined : findMockTopicAttachment(data, fileId);
      if (!found && !attached) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
        return;
      }
      const filename = found?.filename ?? attached!.filename;
      const contentType = found?.content_type ?? attached!["content-type"];
      const content =
        data.fileContents?.get(fileId) ?? `mock content of ${filename}\n`;
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": String(Buffer.byteLength(content)),
      });
      res.end(content);
      return;
    }

    // GET /courses/:id/discussion_topics (announcements when only_announcements=true)
    const discussionMatch = path.match(/^\/courses\/(\d+)\/discussion_topics$/);
    if (discussionMatch && req.method === "GET") {
      const courseId = parseInt(discussionMatch[1], 10);
      const onlyAnnouncements = url.searchParams.get("only_announcements") === "true";
      const topics = (data.discussions?.get(courseId) ?? [])
        .filter((topic) => (topic.is_announcement ?? false) === onlyAnnouncements)
        .map(({ entries: _entries, ...topic }) => ({
          context_code: `course_${courseId}`,
          discussion_type: "threaded",
          read_state: "read",
          unread_count: 0,
          published: true,
          locked: false,
          is_announcement: false,
          ...topic,
        }));
      const { body, headers } = paginatedResponse(
        topics,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/discussion_topics`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/discussion_topics/:tid/view
    const discussionViewMatch = path.match(/^\/courses\/(\d+)\/discussion_topics\/(\d+)\/view$/);
    if (discussionViewMatch && req.method === "GET") {
      const topic = findMockTopic(data, parseInt(discussionViewMatch[1], 10), parseInt(discussionViewMatch[2], 10));
      if (!topic) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
        return;
      }
      const participants = new Map<number, string>();
      for (const entry of flattenMockEntries(topic.entries ?? [], null)) {
        participants.set(entry.user_id, entry.user_name);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          participants: [...participants].map(([id, display_name]) => ({ id, display_name })),
          unread_entries: [],
          view: (topic.entries ?? []).map((entry) => toViewEntry(entry, null)),
          new_entries: [],
        })
      );
      return;
    }

    // GET /courses/:id/discussion_topics/:tid/entries
    const discussionEntriesMatch = path.match(/^\/courses\/(\d+)\/discussion_topics\/(\d+)\/entries$/);
    if (discussionEntriesMatch && req.method === "GET") {
      const courseId = parseInt(discussionEntriesMatch[1], 10);
      const topicId = parseInt(discussionEntriesMatch[2], 10);
      const topic = findMockTopic(data, courseId, topicId);
      if (!topic) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
        return;
      }
      const limit = data.discussionRecentReplyLimit ?? 2;
      const topLevel = (topic.entries ?? []).map((entry) => {
        const descendants = flattenMockEntries(entry.replies ?? [], entry.id);
        const recent = descendants
          .slice()
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, limit);
        return {
          ...toListEntry({ ...entry, parent_id: null }),
          recent_replies: recent.map(toListEntry),
          has_more_replies: descendants.length > limit,
        };
      });
      const { body, headers } = paginatedResponse(
        topLevel,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/discussion_topics/${topicId}/entries`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /courses/:id/discussion_topics/:tid/entries/:eid/replies
    const discussionRepliesMatch = path.match(
      /^\/courses\/(\d+)\/discussion_topics\/(\d+)\/entries\/(\d+)\/replies$/
    );
    if (discussionRepliesMatch && req.method === "GET") {
      const courseId = parseInt(discussionRepliesMatch[1], 10);
      const topicId = parseInt(discussionRepliesMatch[2], 10);
      const entryId = parseInt(discussionRepliesMatch[3], 10);
      const topic = findMockTopic(data, courseId, topicId);
      const root = topic
        ? flattenMockEntries(topic.entries ?? [], null).find((e) => e.id === entryId)
        : undefined;
      if (!topic || !root) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
        return;
      }
      const replies = flattenMockEntries(root.replies ?? [], root.id).map(toListEntry);
      const { body, headers } = paginatedResponse(
        replies,
        page,
        effectivePerPage,
        baseApiUrl,
        `/courses/${courseId}/discussion_topics/${topicId}/entries/${entryId}/replies`
      );
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    // GET /announcements
    if (path === "/announcements" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    // GET /files/:id
    const fileByIdMatch = path.match(/^\/files\/(\d+)$/);
    if (fileByIdMatch && req.method === "GET") {
      const fileId = parseInt(fileByIdMatch[1], 10);
      for (const files of data.files.values()) {
        const file = files.find((f) => f.id === fileId);
        if (file) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(file));
          return;
        }
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
      return;
    }

    // Fallback: 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errors: [{ message: "endpoint not found" }] }));
  });

  return server;
}

export function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

export function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
