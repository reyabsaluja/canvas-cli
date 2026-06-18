import type {
  MockAssignment,
  MockCourse,
  MockFile,
  MockModule,
  MockPage,
  MockServerData,
  MockSubmission,
} from "./mock-canvas-server.js";

export const COURSES: MockCourse[] = [
  {
    id: 101,
    name: "Introduction to Computer Science",
    course_code: "CS101",
    enrollment_term_id: 1,
    workflow_state: "available",
    start_at: "2026-01-10T00:00:00Z",
    end_at: "2026-05-30T00:00:00Z",
    term: { id: 1, name: "Spring 2026", start_at: "2026-01-06T00:00:00Z", end_at: "2026-06-01T00:00:00Z" },
    enrollments: [{ enrollment_state: "active", type: "student" }],
  },
  {
    id: 202,
    name: "Data Structures and Algorithms",
    course_code: "CS202",
    enrollment_term_id: 1,
    workflow_state: "available",
    start_at: "2026-01-10T00:00:00Z",
    end_at: "2026-05-30T00:00:00Z",
    term: { id: 1, name: "Spring 2026", start_at: "2026-01-06T00:00:00Z", end_at: "2026-06-01T00:00:00Z" },
    enrollments: [{ enrollment_state: "active", type: "student" }],
  },
  {
    id: 303,
    name: "Ancient History",
    course_code: "HIST303",
    enrollment_term_id: 0,
    workflow_state: "completed",
    start_at: "2025-09-01T00:00:00Z",
    end_at: "2025-12-15T00:00:00Z",
    term: { id: 0, name: "Fall 2025", start_at: "2025-09-01T00:00:00Z", end_at: "2025-12-20T00:00:00Z" },
    enrollments: [{ enrollment_state: "completed", type: "student" }],
  },
];

export const CS101_ASSIGNMENTS: MockAssignment[] = [
  {
    id: 1001,
    name: "Lab 1: Hello World",
    due_at: "2026-06-01T23:59:00Z",
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
    due_at: "2026-06-08T23:59:00Z",
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
    due_at: "2026-03-15T14:00:00Z",
    html_url: "https://canvas.example/courses/101/assignments/1003",
    course_id: 101,
    has_submitted_submissions: true,
    description: null,
    points_possible: 100,
    submission_types: ["online_quiz"],
    rubric: [
      {
        id: "crit-analysis",
        description: "Loop Invariant Analysis",
        points: 10,
        ratings: [
          {
            id: "rating-strong",
            description: "Strong",
            points: 10,
          },
          {
            id: "rating-partial",
            description: "Partial",
            points: 7,
          },
        ],
      },
    ],
    submission: {
      workflow_state: "graded",
      submitted_at: "2026-03-15T13:55:00Z",
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
    due_at: "2026-06-05T23:59:00Z",
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
    require_sequential_progress: true,
    prerequisite_module_ids: [10],
    items: [
      {
        id: 102,
        title: "Variables Lecture Notes",
        type: "Page",
        position: 1,
        page_url: "variables-lecture",
        completion_requirement: {
          type: "must_mark_done",
          completed: false,
        },
      },
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

export const CS101_SUBMISSIONS: MockSubmission[] = [
  {
    assignment_id: 1003,
    user_id: 7,
    workflow_state: "graded",
    submitted_at: "2026-03-15T13:55:00Z",
    score: 87,
    grade: "87",
    attempt: 1,
    late: false,
    missing: false,
    submission_comments: [
      {
        id: 9001,
        author_id: 42,
        author_name: "Prof. Ada",
        comment:
          "Nice work overall. Review the loop invariant feedback before the final.",
        html_comment:
          "<p>Nice work overall. Review the <strong>loop invariant feedback</strong> before the final.</p>",
        created_at: "2026-03-16T10:00:00Z",
      },
    ],
    rubric_assessment: {
      "crit-analysis": {
        points: 7,
        rating_id: "rating-partial",
        comments:
          "<p>Your invariant is close, but explain initialization before the loop.</p>",
      },
    },
  },
];

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
    submissions: new Map([[101, CS101_SUBMISSIONS]]),
    assignmentDateDetails: new Map([
      [
        101,
        new Map([
          [
            1002,
            {
              due_at: "2026-06-08T23:59:00Z",
              unlock_at: "2026-06-01T00:00:00Z",
              lock_at: "2026-06-15T23:59:00Z",
              only_visible_to_overrides: false,
              overrides: [
                {
                  id: 7001,
                  title: "Section B extension",
                  set_type: "CourseSection",
                  course_section_id: 42,
                  due_at: "2026-06-10T23:59:00Z",
                  lock_at: "2026-06-17T23:59:00Z",
                },
              ],
              peer_review_sub_assignment: {
                id: 7102,
                title: "Lab 2 Peer Review",
                due_at: "2026-06-12T23:59:00Z",
                overrides: [
                  {
                    id: 7103,
                    title: "Section B peer review",
                    set_type: "CourseSection",
                    course_section_id: 42,
                    due_at: "2026-06-14T23:59:00Z",
                  },
                ],
              },
            },
          ],
        ]),
      ],
    ]),
    tabs: new Map([
      [
        101,
        [
          {
            id: "context_external_tool_42",
            label: "Course Zoom",
            type: "external",
            hidden: false,
            visibility: "public",
            position: 8,
            html_url:
              "https://canvas.example/courses/101/external_tools/42",
            full_url: "https://zoom.example/cs101",
          },
        ],
      ],
    ]),
    courseDetails: new Map([
      [101, { syllabus_body: "<p>CS101 course syllabus content here.</p>" }],
      [202, { syllabus_body: null }],
    ]),
  };
}
