import type { MockCourse, MockAssignment, MockModule, MockPage, MockFile, MockFolder, MockAttachment, MockDiscussionTopic, MockServerData } from "./mock-canvas-server.js";

// All dates are relative to "now" so the fixtures never go stale: the two
// CS courses are always in the current term and HIST303 is always finished.
const DAY_MS = 24 * 60 * 60 * 1000;
export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

export const COURSES: MockCourse[] = [
  {
    id: 101,
    name: "Introduction to Computer Science",
    course_code: "CS101",
    enrollment_term_id: 1,
    workflow_state: "available",
    start_at: daysFromNow(-60),
    end_at: daysFromNow(80),
    term: { id: 1, name: "Spring 2026", start_at: daysFromNow(-64), end_at: daysFromNow(82) },
    enrollments: [{ enrollment_state: "active", type: "student" }],
  },
  {
    id: 202,
    name: "Data Structures and Algorithms",
    course_code: "CS202",
    enrollment_term_id: 1,
    workflow_state: "available",
    start_at: daysFromNow(-60),
    end_at: daysFromNow(80),
    term: { id: 1, name: "Spring 2026", start_at: daysFromNow(-64), end_at: daysFromNow(82) },
    enrollments: [{ enrollment_state: "active", type: "student" }],
  },
  {
    id: 303,
    name: "Ancient History",
    course_code: "HIST303",
    enrollment_term_id: 0,
    workflow_state: "completed",
    start_at: daysFromNow(-365),
    end_at: daysFromNow(-260),
    term: { id: 0, name: "Fall 2025", start_at: daysFromNow(-365), end_at: daysFromNow(-255) },
    enrollments: [{ enrollment_state: "completed", type: "student" }],
  },
];

export const CS101_ASSIGNMENTS: MockAssignment[] = [
  {
    id: 1001,
    name: "Lab 1: Hello World",
    due_at: daysFromNow(14),
    html_url: "https://canvas.example/courses/101/assignments/1001",
    course_id: 101,
    has_submitted_submissions: false,
    description: "<p>Write a program that prints Hello World.</p>",
    points_possible: 10,
    submission_types: ["online_upload"],
    submission: {
      workflow_state: "unsubmitted",
      submitted_at: null,
      score: null,
      grade: null,
      attempt: null,
      late: false,
      missing: false,
    },
  },
  {
    id: 1002,
    name: "Lab 2: Variables and Types",
    due_at: daysFromNow(21),
    html_url: "https://canvas.example/courses/101/assignments/1002",
    course_id: 101,
    has_submitted_submissions: false,
    description: "<p>Practice with variables, types, and basic I/O.</p>",
    points_possible: 15,
    submission_types: ["online_upload"],
    submission: {
      workflow_state: "unsubmitted",
      submitted_at: null,
      score: null,
      grade: null,
      attempt: null,
      late: false,
      missing: false,
    },
  },
  {
    id: 1003,
    name: "Midterm Exam",
    due_at: daysFromNow(-30),
    html_url: "https://canvas.example/courses/101/assignments/1003",
    course_id: 101,
    has_submitted_submissions: true,
    description: null,
    points_possible: 100,
    submission_types: ["online_quiz"],
    submission: {
      workflow_state: "graded",
      submitted_at: daysFromNow(-30),
      score: 87,
      grade: "87",
      attempt: 1,
      late: false,
      missing: false,
    },
  },
];

export const CS202_ASSIGNMENTS: MockAssignment[] = [
  {
    id: 2001,
    name: "Problem Set 1: Linked Lists",
    due_at: daysFromNow(18),
    html_url: "https://canvas.example/courses/202/assignments/2001",
    course_id: 202,
    has_submitted_submissions: false,
    description: "<p>Implement a doubly-linked list with iterators.</p>",
    points_possible: 25,
    submission_types: ["online_upload"],
    submission: {
      workflow_state: "unsubmitted",
      submitted_at: null,
      score: null,
      grade: null,
      attempt: null,
      late: false,
      missing: false,
    },
  },
];

export const CS101_MODULES: MockModule[] = [
  {
    id: 10,
    name: "Week 1: Getting Started",
    position: 1,
    items_count: 2,
    items_url: "http://localhost/api/v1/courses/101/modules/10/items",
    items: [
      { id: 100, title: "Welcome Page", type: "Page", position: 1, page_url: "welcome" },
      { id: 101, title: "Syllabus PDF", type: "File", position: 2, content_id: 5001 },
    ],
  },
  {
    id: 11,
    name: "Week 2: Variables",
    position: 2,
    items_count: 1,
    items_url: "http://localhost/api/v1/courses/101/modules/11/items",
    items: [
      { id: 102, title: "Variables Lecture Notes", type: "Page", position: 1, page_url: "variables-lecture" },
    ],
  },
];

export const CS101_PAGES: MockPage[] = [
  {
    page_id: 1,
    url: "welcome",
    title: "Welcome to CS101",
    html_url: "https://canvas.example/courses/101/pages/welcome",
    updated_at: "2026-01-10T12:00:00Z",
    body: "<p>Welcome to Introduction to Computer Science!</p>",
  },
  {
    page_id: 2,
    url: "variables-lecture",
    title: "Variables Lecture Notes",
    html_url: "https://canvas.example/courses/101/pages/variables-lecture",
    updated_at: "2026-01-17T12:00:00Z",
    body: "<p>This week we cover variables, types, and expressions.</p>",
  },
];

export const CS101_FILES: MockFile[] = [
  {
    id: 5001,
    display_name: "syllabus.pdf",
    filename: "syllabus.pdf",
    content_type: "application/pdf",
    size: 52400,
    url: "https://canvas.example/files/5001/download",
    updated_at: "2026-01-08T10:00:00Z",
    folder_id: 1,
  },
  {
    id: 5002,
    display_name: "lab1-starter.zip",
    filename: "lab1-starter.zip",
    content_type: "application/zip",
    size: 12800,
    url: "https://canvas.example/files/5002/download",
    updated_at: "2026-01-15T10:00:00Z",
    folder_id: 2,
  },
];

export const CS101_FOLDERS: MockFolder[] = [
  { id: 1, name: "course files", full_name: "course files", parent_folder_id: null, files_count: 1, folders_count: 2 },
  { id: 2, name: "Labs", full_name: "course files/Labs", parent_folder_id: 1, files_count: 1, folders_count: 0 },
  { id: 3, name: "Lectures", full_name: "course files/Lectures", parent_folder_id: 1, files_count: 0, folders_count: 1 },
  { id: 4, name: "Week 3", full_name: "course files/Lectures/Week 3", parent_folder_id: 3, files_count: 0, folders_count: 0 },
];

/**
 * A threaded Q&A discussion. The answers students actually need (the TA's
 * "no Makefile" reply, the "C11" reply) are nested replies, and the second
 * thread has more replies than GET .../entries lists inline.
 */
export const CS101_DISCUSSIONS: MockDiscussionTopic[] = [
  {
    id: 7001,
    title: "Lab 1 Q&A",
    message: "<p>Post your Lab 1 questions here.</p>",
    posted_at: daysFromNow(-10),
    last_reply_at: daysFromNow(-3),
    user_name: "Prof. Grace",
    html_url: "https://canvas.example/courses/101/discussion_topics/7001",
    discussion_type: "threaded",
    entries: [
      {
        id: 71,
        user_id: 11,
        user_name: "Student One",
        message: "<p>Does Lab 1 need a Makefile?</p>",
        created_at: daysFromNow(-9),
        replies: [
          {
            id: 72,
            user_id: 2,
            user_name: "TA Linus",
            message: "<p>No Makefile needed: submit hello.c only; we compile with gcc -Wall.</p>",
            created_at: daysFromNow(-8),
            replies: [
              {
                id: 73,
                user_id: 11,
                user_name: "Student One",
                message: "<p>Thanks!</p>",
                created_at: daysFromNow(-7),
              },
            ],
          },
        ],
      },
      {
        id: 74,
        user_id: 12,
        user_name: "Student Two",
        message: "<p>Which C standard should we use?</p>",
        created_at: daysFromNow(-6),
        replies: [
          {
            id: 75,
            user_id: 2,
            user_name: "TA Linus",
            message: "<p>Use C11 for every lab.</p>",
            created_at: daysFromNow(-5),
          },
          {
            id: 76,
            user_id: 13,
            user_name: "Student Three",
            message: "<p>Is gnu11 acceptable?</p>",
            created_at: daysFromNow(-4),
          },
          {
            id: 77,
            user_id: 1,
            user_name: "Prof. Grace",
            message: "<p>Yes, gnu11 is fine; avoid VLAs in graded code.</p>",
            created_at: daysFromNow(-3),
          },
        ],
      },
    ],
  },
];

/**
 * Files attached to posts (the Canvas "Attach" button on an announcement or
 * reply). They are not linked from the message HTML, so only the topic's
 * `attachments[]` / entry `attachment` fields reveal them. URLs point at
 * canvas.example; rewrite them to the mock origin with
 * `rewriteAttachmentUrls` before serving.
 */
export const CS101_MIDTERM_REVIEW_ATTACHMENT: MockAttachment = {
  id: 5301,
  display_name: "Midterm Review Guide.txt",
  filename: "Midterm Review Guide.txt",
  "content-type": "text/plain",
  size: 96,
  url: "https://canvas.example/files/5301/download?download_frd=1&verifier=abc",
};

export const CS101_REPLY_ATTACHMENT: MockAttachment = {
  id: 5302,
  display_name: "gnu11-flags.txt",
  filename: "gnu11-flags.txt",
  "content-type": "text/plain",
  size: 40,
  url: "https://canvas.example/files/5302/download?verifier=def",
};

/** An announcement whose handout exists only as a post attachment. */
export const CS101_ANNOUNCEMENTS: MockDiscussionTopic[] = [
  {
    id: 7101,
    title: "Midterm review session Thursday",
    message: "<p>Review session Thursday 5pm in ENG 101. The study guide is attached.</p>",
    posted_at: daysFromNow(-12),
    last_reply_at: null,
    user_name: "Prof. Grace",
    html_url: "https://canvas.example/courses/101/discussion_topics/7101",
    is_announcement: true,
    discussion_type: "side_comment",
    attachments: [CS101_MIDTERM_REVIEW_ATTACHMENT],
  },
];

export function rewriteAttachmentUrls(
  attachment: MockAttachment,
  origin: string
): MockAttachment {
  return {
    ...attachment,
    url: attachment.url.replace(/^https:\/\/canvas\.example/, origin),
  };
}

export function buildDefaultServerData(): MockServerData {
  return {
    courses: COURSES,
    assignments: new Map([
      [101, CS101_ASSIGNMENTS],
      [202, CS202_ASSIGNMENTS],
    ]),
    modules: new Map([[101, CS101_MODULES]]),
    pages: new Map([[101, CS101_PAGES]]),
    files: new Map([[101, CS101_FILES]]),
    folders: new Map([[101, CS101_FOLDERS]]),
    discussions: new Map([[101, CS101_DISCUSSIONS]]),
    courseDetails: new Map([
      [101, { syllabus_body: "<p>CS101 course syllabus content here.</p>" }],
      [202, { syllabus_body: null }],
    ]),
  };
}
