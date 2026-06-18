import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchCourseContent } from "../src/ingest/fetch-course-content.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import type { Course } from "../src/domain/models.js";
import { buildZipBuffer } from "./helpers/build-zip.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempCwd(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-ingest-"));
  process.chdir(tempDir);
  try {
    await fn(tempDir);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("fetchCourseContent uses bounded concurrency for module items and page bodies", async () => {
  let activeModuleItemRequests = 0;
  let maxModuleItemRequests = 0;
  let activePageRequests = 0;
  let maxPageRequests = 0;

  const client = {
    async getCourseDetail() {
      return {
        id: 17,
        name: "ECE243",
        course_code: "ECE243H1",
        syllabus_body: null,
        start_at: null,
        end_at: null,
        term: null,
      };
    },
    async getAssignments() {
      return [];
    },
    async getModulesSafe() {
      return Array.from({ length: 6 }, (_, index) => ({
        id: index + 1,
        name: `Module ${index + 1}`,
        position: index + 1,
        items_count: 1,
        items_url: "",
      }));
    },
    async getModuleItemsSafe(_courseId: number, moduleId: number) {
      activeModuleItemRequests += 1;
      maxModuleItemRequests = Math.max(
        maxModuleItemRequests,
        activeModuleItemRequests
      );
      await sleep(10);
      activeModuleItemRequests -= 1;
      return [
        {
          id: moduleId * 100,
          title: `Page ${moduleId}`,
          type: "Page",
          position: 1,
          page_url: `page-${moduleId}`,
        },
      ];
    },
    async getFilesSafe() {
      return [];
    },
    async getPagesSafe() {
      return [];
    },
    async getFrontPageSafe() {
      return null;
    },
    async getPageBySlugSafe(_courseId: number, slug: string) {
      activePageRequests += 1;
      maxPageRequests = Math.max(maxPageRequests, activePageRequests);
      await sleep(10);
      activePageRequests -= 1;
      return {
        title: `Title for ${slug}`,
        body: `Body for ${slug}`,
        url: slug,
      };
    },
    skippedEndpoints: [] as string[],
    resetSkippedEndpoints() {},
  } as any;

  const result = await fetchCourseContent(client, 17);

  assert.equal(result.modules.length, 6);
  assert.equal(result.fetchedPages.length, 6);
  assert.ok(maxModuleItemRequests > 1);
  assert.ok(maxModuleItemRequests <= 4);
  assert.ok(maxPageRequests > 1);
  assert.ok(maxPageRequests <= 4);
});

test("ingestCourse captures page bodies from the Pages index even when no other surface links them", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const client = {
      async getCourseDetail() {
        return {
          id: course.id,
          name: course.name,
          course_code: course.courseCode,
          syllabus_body: null,
          start_at: null,
          end_at: null,
          term: null,
          html_url: "https://canvas.example/courses/17",
        };
      },
      async getAssignments() {
        return [];
      },
      async getModulesSafe() {
        return [];
      },
      async getModuleItemsSafe() {
        return [];
      },
      async getFilesSafe() {
        return [];
      },
      async getPagesSafe() {
        return [
          {
            page_id: 11,
            url: "course-schedule",
            title: "Course Schedule",
            html_url: "https://canvas.example/courses/17/pages/course-schedule",
            updated_at: "2026-04-01T12:00:00.000Z",
          },
        ];
      },
      async getAnnouncementsSafe() {
        return [];
      },
      async getFrontPageSafe() {
        return null;
      },
      async getPageBySlugSafe(_courseId: number, slug: string) {
        if (slug !== "course-schedule") {
          return null;
        }
        return {
          title: "Course Schedule",
          body:
            "<h2>Weeks 9-10</h2><p>Lab 4 demo happens in week 10.</p>",
          url: slug,
        };
      },
      skippedEndpoints: [] as string[],
      resetSkippedEndpoints() {},
    } as any;

    const result = await ingestCourse(
      course,
      client,
      {
        baseUrl: "https://canvas.example/api/v1",
        accessToken: "token",
      },
      { refresh: false }
    );

    assert.deepEqual(result.pages.map((page) => page.pageId), ["course-schedule"]);

    const pageExtract = await fs.readFile(
      path.join(result.coursePath, "extracted", "pages", "course-schedule.txt"),
      "utf-8"
    );
    assert.match(pageExtract, /^# Course Schedule/m);
    assert.match(pageExtract, /Weeks 9-10/);
    assert.match(pageExtract, /Lab 4 demo happens in week 10\./);
  });
});

test("ingestCourse captures module prerequisites and completion requirements", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const client = {
      async getCourseDetail() {
        return {
          id: course.id,
          name: course.name,
          course_code: course.courseCode,
          syllabus_body: null,
          start_at: null,
          end_at: null,
          term: null,
          html_url: "https://canvas.example/courses/17",
        };
      },
      async getAssignments() {
        return [];
      },
      async getModulesSafe() {
        return [
          {
            id: 10,
            name: "Module 1: Setup",
            position: 1,
            items_count: 1,
            items_url: "",
            require_sequential_progress: false,
            prerequisite_module_ids: [],
          },
          {
            id: 11,
            name: "Module 2: Lab Prep",
            position: 2,
            items_count: 2,
            items_url: "",
            unlock_at: "2026-04-10T13:00:00Z",
            require_sequential_progress: true,
            prerequisite_module_ids: [10],
          },
        ];
      },
      async getModuleItemsSafe(_courseId: number, moduleId: number) {
        if (moduleId === 10) {
          return [
            {
              id: 100,
              title: "Read the setup guide",
              type: "Page",
              position: 1,
              page_url: "setup-guide",
              completion_requirement: {
                type: "must_view",
                completed: true,
              },
            },
          ];
        }
        return [
          {
            id: 110,
            title: "Mark the safety checklist done",
            type: "Page",
            position: 1,
            page_url: "safety-checklist",
            completion_requirement: {
              type: "must_mark_done",
              completed: false,
            },
          },
          {
            id: 111,
            title: "Score at least 8 on the readiness quiz",
            type: "Quiz",
            position: 2,
            content_id: 501,
            completion_requirement: {
              type: "min_score",
              min_score: 8,
              completed: false,
            },
          },
        ];
      },
      async getFilesSafe() {
        return [];
      },
      async getPagesSafe() {
        return [];
      },
      async getFrontPageSafe() {
        return null;
      },
      async getPageBySlugSafe() {
        return null;
      },
      skippedEndpoints: [] as string[],
      resetSkippedEndpoints() {},
    } as any;

    const result = await ingestCourse(
      course,
      client,
      {
        baseUrl: "https://canvas.example/api/v1",
        accessToken: "token",
      },
      { refresh: false }
    );

    const labPrep = result.modules.find((module) => module.id === 11);
    assert.ok(labPrep);
    assert.deepEqual(labPrep.prerequisiteModuleIds, [10]);
    assert.equal(labPrep.requiresSequentialProgress, true);
    assert.equal(
      labPrep.items[1].completionRequirement?.minScore,
      8
    );

    const moduleExtract = await fs.readFile(
      path.join(result.coursePath, "extracted", "modules", "11.txt"),
      "utf-8"
    );
    assert.match(moduleExtract, /^# Module 2: Lab Prep/m);
    assert.match(moduleExtract, /## Key facts/);
    assert.match(moduleExtract, /Unlocks: 2026-04-10T13:00:00Z/);
    assert.match(moduleExtract, /Requires sequential progress: yes/);
    assert.match(moduleExtract, /Module 1: Setup \(module 10\)/);
    assert.match(moduleExtract, /Completion requirement: must mark done/);
    assert.match(moduleExtract, /minimum score with at least 8/);
  });
});

test("ingestCourse crawls announcement and linked-page content into the cache", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const pageBodies = new Map<
      string,
      { title: string; body: string; url: string }
    >([
      [
        "assignment-hub",
        {
          title: "Assignment Hub",
          body:
            '<p>Continue to <a href="/courses/17/pages/deep-reference">deep reference</a>.</p>',
          url: "assignment-hub",
        },
      ],
      [
        "deep-reference",
        {
          title: "Deep Reference",
          body:
            '<p><a class="instructure_file_link" title="deep-guide.pdf" href="https://canvas.example/courses/17/files/91?verifier=xyz">Deep guide</a></p>',
          url: "deep-reference",
        },
      ],
      [
        "announcement-hub",
        {
          title: "Announcement Hub",
          body: "<p>Exam format and timing details live here.</p>",
          url: "announcement-hub",
        },
      ],
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) =>
      new Response(`downloaded ${String(input)}`, { status: 200 });

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [
            {
              id: 1,
              name: "Homework 1",
              due_at: null,
              html_url: "https://canvas.example/courses/17/assignments/1",
              course_id: course.id,
              has_submitted_submissions: false,
              description:
                '<p>Read the <a href="https://canvas.example/courses/17/pages/assignment-hub">assignment hub</a>.</p>',
            },
          ];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [
            {
              id: 5,
              title: "Midterm update",
              message:
                '<p><a href="/courses/17/pages/announcement-hub">Announcement hub</a> and <a class="instructure_file_link" title="midterm-guide.pdf" href="https://canvas.example/courses/17/files/92?verifier=abc">midterm guide</a>.</p>',
              context_code: "course_17",
              posted_at: "2026-04-01T10:00:00.000Z",
              last_reply_at: null,
              discussion_type: "side_comment",
              read_state: "read",
              unread_count: 0,
              user_name: "Prof. Ada",
              html_url: "https://canvas.example/courses/17/discussion_topics/5",
              published: true,
              is_announcement: true,
              locked: false,
            },
          ];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe(_courseId: number, slug: string) {
          return pageBodies.get(slug) ?? null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.deepEqual(
        result.pages.map((page) => page.pageId).sort(),
        ["announcement-hub", "assignment-hub", "deep-reference"]
      );
      assert.equal(result.announcements?.length, 1);
      assert.ok(
        result.attachments.some(
          (attachment) =>
            attachment.originalFilename === "midterm-guide.pdf" &&
            attachment.status === "downloaded"
        )
      );
      assert.ok(
        result.attachments.some(
          (attachment) =>
            attachment.originalFilename === "deep-guide.pdf" &&
            attachment.status === "downloaded"
        )
      );

      const announcements = JSON.parse(
        await fs.readFile(
          path.join(result.coursePath, "announcements.json"),
          "utf-8"
        )
      ) as Array<{ title: string }>;
      assert.equal(announcements[0]?.title, "Midterm update");

      const announcementExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "announcements", "5.txt"),
        "utf-8"
      );
      assert.match(announcementExtract, /Midterm update/);
      assert.match(
        announcementExtract,
        /Announcement hub \(https:\/\/canvas\.example\/courses\/17\/pages\/announcement-hub\)/
      );

      const fetchedPageExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "pages", "assignment-hub.txt"),
        "utf-8"
      );
      assert.match(
        fetchedPageExtract,
        /deep reference \(https:\/\/canvas\.example\/courses\/17\/pages\/deep-reference\)/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse stores assignment descriptions as rich extracted documents", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const client = {
      async getCourseDetail() {
        return {
          id: course.id,
          name: course.name,
          course_code: course.courseCode,
          syllabus_body: null,
          start_at: null,
          end_at: null,
          term: null,
          html_url: "https://canvas.example/courses/17",
        };
      },
      async getAssignments() {
        return [
          {
            id: 42,
            name: "Lab 4",
            due_at: "2026-04-30T23:59:00.000Z",
            html_url: "https://canvas.example/courses/17/assignments/42",
            course_id: course.id,
            has_submitted_submissions: false,
            description: [
              "<h2>Deliverables</h2>",
              "<ul><li>Waveform screenshot</li><li>Short analysis</li></ul>",
              '<p>Review the <a href="/courses/17/pages/lab-4-spec">lab spec</a>.</p>',
            ].join(""),
            unlock_at: "2026-04-20T12:00:00.000Z",
            lock_at: null,
            points_possible: 25,
            grading_type: "points",
            submission_types: ["online_upload"],
            allowed_extensions: [".pdf", ".zip"],
            peer_reviews: true,
            automatic_peer_reviews: true,
            anonymous_peer_reviews: true,
            intra_group_peer_reviews: false,
            peer_review_count: 2,
            peer_reviews_assign_at: "2026-04-24T16:00:00.000Z",
          },
        ];
      },
      async getAssignmentDateDetailsSafe() {
        return {
          due_at: "2026-04-30T23:59:00.000Z",
          unlock_at: "2026-04-20T12:00:00.000Z",
          lock_at: "2026-05-07T23:59:00.000Z",
          only_visible_to_overrides: false,
          assignment_overrides: [
            {
              id: 901,
              title: "Lab section 2 extension",
              set_type: "CourseSection",
              course_section_id: 22,
              due_at: "2026-05-02T23:59:00.000Z",
            },
          ],
          peer_review_sub_assignment: {
            id: 902,
            title: "Lab 4 Peer Review",
            due_at: "2026-05-05T23:59:00.000Z",
            assignment_overrides: [
              {
                id: 903,
                title: "Lab section 2 peer review extension",
                set_type: "CourseSection",
                course_section_id: 22,
                due_at: "2026-05-06T23:59:00.000Z",
              },
            ],
          },
        };
      },
      async getModulesSafe() {
        return [];
      },
      async getModuleItemsSafe() {
        return [];
      },
      async getFilesSafe() {
        return [];
      },
      async getPagesSafe() {
        return [];
      },
      async getAnnouncementsSafe() {
        return [];
      },
      async getFrontPageSafe() {
        return null;
      },
      async getPageBySlugSafe() {
        return null;
      },
      skippedEndpoints: [] as string[],
      resetSkippedEndpoints() {},
    } as any;

    const result = await ingestCourse(
      course,
      client,
      {
        baseUrl: "https://canvas.example/api/v1",
        accessToken: "token",
      },
      { refresh: false }
    );

    const assignmentExtract = await fs.readFile(
      path.join(result.coursePath, "extracted", "assignments", "42.txt"),
      "utf-8"
    );

    assert.match(assignmentExtract, /^# Lab 4/m);
    assert.match(assignmentExtract, /## Key facts/);
    assert.match(assignmentExtract, /Due: 2026-04-30T23:59:00.000Z/);
    assert.match(assignmentExtract, /Points: 25/);
    assert.match(assignmentExtract, /Submission types: online_upload/);
    assert.match(assignmentExtract, /Allowed file extensions: \.pdf, \.zip/);
    assert.match(assignmentExtract, /Peer reviews: yes/);
    assert.match(assignmentExtract, /Peer reviews assigned automatically: yes/);
    assert.match(assignmentExtract, /Anonymous peer reviews: yes/);
    assert.match(assignmentExtract, /Intra-group peer reviews: no/);
    assert.match(assignmentExtract, /Peer reviews required: 2/);
    assert.match(
      assignmentExtract,
      /Peer reviews assigned at: 2026-04-24T16:00:00.000Z/
    );
    assert.match(assignmentExtract, /## Assignment Dates/);
    assert.match(assignmentExtract, /### Assignment date overrides/);
    assert.match(
      assignmentExtract,
      /Lab section 2 extension; type CourseSection; section 22; due 2026-05-02T23:59:00.000Z/
    );
    assert.match(assignmentExtract, /### Peer review dates/);
    assert.match(assignmentExtract, /Peer review assignment: Lab 4 Peer Review/);
    assert.match(assignmentExtract, /Due: 2026-05-05T23:59:00.000Z/);
    assert.match(
      assignmentExtract,
      /Lab section 2 peer review extension; type CourseSection; section 22; due 2026-05-06T23:59:00.000Z/
    );
    assert.match(assignmentExtract, /## Description/);
    assert.match(assignmentExtract, /Waveform screenshot/);
    assert.match(
      assignmentExtract,
      /lab spec \(https:\/\/canvas\.example\/courses\/17\/pages\/lab-4-spec\)/
    );

    assert.equal(result.assignments[0]?.peerReviews, true);
    assert.equal(result.assignments[0]?.automaticPeerReviews, true);
    assert.equal(result.assignments[0]?.anonymousPeerReviews, true);
    assert.equal(result.assignments[0]?.intraGroupPeerReviews, false);
    assert.equal(result.assignments[0]?.peerReviewCount, 2);
    assert.equal(
      result.assignments[0]?.peerReviewsAssignAt,
      "2026-04-24T16:00:00.000Z"
    );
    assert.equal(result.assignments[0]?.dateDetails?.overrideCount, 1);
    assert.equal(
      result.assignments[0]?.dateDetails?.peerReviewSubAssignment?.dueAt,
      "2026-05-05T23:59:00.000Z"
    );
  });
});

test("ingestCourse captures submission feedback comments and files", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const downloadUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input);
      downloadUrls.push(url);
      return new Response(`downloaded feedback resource: ${url}\n`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [
            {
              id: 42,
              name: "Lab 4",
              due_at: "2026-04-30T23:59:00.000Z",
              html_url: "https://canvas.example/courses/17/assignments/42",
              course_id: course.id,
              has_submitted_submissions: true,
              description: "<p>Submit your final lab report.</p>",
              points_possible: 25,
              grading_type: "points",
              submission_types: ["online_upload"],
              rubric: [
                {
                  id: "clarity",
                  description: "Argument clarity",
                  points: 5,
                  ratings: [
                    {
                      id: "clear",
                      description: "Clear",
                      points: 4,
                    },
                  ],
                },
              ],
              submission: {
                workflow_state: "graded",
                submitted_at: "2026-04-29T20:00:00.000Z",
                score: 21,
                grade: "21",
                attempt: 1,
                late: false,
                missing: false,
              },
            },
          ];
        },
        async getCurrentUserSubmissionsSafe() {
          return [
            {
              assignment_id: 42,
              user_id: 99,
              workflow_state: "graded",
              submitted_at: "2026-04-29T20:00:00.000Z",
              score: 21,
              grade: "21",
              attempt: 1,
              late: false,
              missing: false,
              submission_comments: [
                {
                  id: 501,
                  author_id: 7,
                  author_name: "Prof. Ada",
                  comment:
                    "Revise the introduction using the posted feedback guide.",
                  html_comment:
                    '<p>Revise the introduction using the <a href="/courses/17/pages/revision-notes">revision notes</a> and <a class="instructure_file_link" title="annotated-rubric.pdf" href="https://canvas.example/courses/17/files/334?verifier=comment">annotated rubric</a>.</p>',
                  created_at: "2026-05-01T14:00:00.000Z",
                  attachments: [
                    {
                      id: 333,
                      display_name: "prof-feedback.txt",
                      filename: "prof-feedback.txt",
                      url: "https://canvas.example/courses/17/files/333/download?verifier=feedback",
                      content_type: "text/plain",
                      size: 2048,
                    },
                  ],
                },
              ],
              rubric_assessment: {
                clarity: {
                  points: 4,
                  rating_id: "clear",
                  comments:
                    '<p>Good structure. Read the <a href="/courses/17/pages/rubric-feedback">rubric feedback</a> and keep the <a class="instructure_file_link" title="criterion-notes.pdf" href="https://canvas.example/courses/17/files/335?verifier=rubric">criterion notes</a>.</p>',
                },
              },
            },
          ];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe(_courseId: number, slug: string) {
          if (slug === "revision-notes") {
            return {
              title: "Revision Notes",
              body: "<p>Clarify your motivation and cite waveform evidence.</p>",
              url: slug,
            };
          }
          if (slug === "rubric-feedback") {
            return {
              title: "Rubric Feedback",
              body: "<p>Explain the setup before evaluating the loop.</p>",
              url: slug,
            };
          }
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.deepEqual(downloadUrls.sort(), [
        "https://canvas.example/courses/17/files/333/download?verifier=feedback",
        "https://canvas.example/courses/17/files/334/download?verifier=comment",
        "https://canvas.example/courses/17/files/335/download?verifier=rubric",
      ]);
      assert.equal(result.attachments.length, 3);
      assert.ok(
        result.attachments.every(
          (attachment) =>
            attachment.sourceType === "submission_comment_attachment"
        )
      );
      assert.ok(
        result.attachments.some(
          (attachment) => attachment.originalFilename === "prof-feedback.txt"
        )
      );
      assert.ok(
        result.attachments.some(
          (attachment) => attachment.originalFilename === "annotated-rubric.pdf"
        )
      );
      assert.ok(
        result.attachments.some(
          (attachment) => attachment.originalFilename === "criterion-notes.pdf"
        )
      );
      assert.ok(
        result.pages.some((page) => page.pageId === "revision-notes")
      );
      assert.ok(
        result.pages.some((page) => page.pageId === "rubric-feedback")
      );

      const assignmentExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "assignments", "42.txt"),
        "utf-8"
      );
      assert.match(assignmentExtract, /## Submission Feedback/);
      assert.match(assignmentExtract, /### Prof\. Ada/);
      assert.match(assignmentExtract, /Revise the introduction/);
      assert.match(
        assignmentExtract,
        /revision notes \(https:\/\/canvas\.example\/courses\/17\/pages\/revision-notes\)/
      );
      assert.match(assignmentExtract, /Attachments:/);
      assert.match(assignmentExtract, /prof-feedback\.txt/);
      assert.match(assignmentExtract, /### Rubric Assessment/);
      assert.match(assignmentExtract, /#### Argument clarity/);
      assert.match(assignmentExtract, /Points: 4 \/ 5/);
      assert.match(assignmentExtract, /Rating: Clear \(4 points\)/);
      assert.match(
        assignmentExtract,
        /rubric feedback \(https:\/\/canvas\.example\/courses\/17\/pages\/rubric-feedback\)/
      );
      assert.match(
        assignmentExtract,
        /criterion notes \(https:\/\/canvas\.example\/courses\/17\/files\/335\?verifier=rubric\)/
      );

      const feedbackText = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "attachments",
          "submission-comments",
          "prof-feedback.txt.txt"
        ),
        "utf-8"
      );
      assert.match(feedbackText, /downloaded feedback resource/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse downloads Canvas files embedded in page iframes", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const downloadUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});
      downloadUrls.push(url);
      assert.equal(headers.get("Authorization"), "Bearer token");
      return new Response("Embedded lab spec details from iframe.\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [
            {
              page_id: 10,
              url: "lab-resources",
              title: "Lab Resources",
              html_url: "https://canvas.example/courses/17/pages/lab-resources",
              updated_at: null,
            },
          ];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe(_courseId: number, slug: string) {
          if (slug !== "lab-resources") {
            return null;
          }
          return {
            title: "Lab Resources",
            body:
              '<p>Embedded spec:</p><iframe title="embedded-lab-spec.txt" src="https://canvas.example/courses/17/files/333/preview?wrap=1&amp;verifier=embed"></iframe>',
            url: slug,
          };
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.deepEqual(downloadUrls, [
        "https://canvas.example/courses/17/files/333/download?verifier=embed",
      ]);
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0]?.sourceType, "page_linked");
      assert.equal(result.attachments[0]?.originalFilename, "embedded-lab-spec.txt");
      assert.equal(result.attachments[0]?.status, "downloaded");
      assert.match(
        result.attachments[0]?.reason ?? "",
        /linked in "Lab Resources"/
      );

      const embeddedText = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "attachments",
          "pages",
          "embedded-lab-spec.txt.txt"
        ),
        "utf-8"
      );
      assert.match(embeddedText, /Embedded lab spec details from iframe/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse enriches assignment extracts with rubric criteria from assignment detail", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const detailCalls: number[] = [];
    const client = {
      async getCourseDetail() {
        return {
          id: course.id,
          name: course.name,
          course_code: course.courseCode,
          syllabus_body: null,
          start_at: null,
          end_at: null,
          term: null,
          html_url: "https://canvas.example/courses/17",
        };
      },
      async getAssignments() {
        return [
          {
            id: 42,
            name: "Lab 4",
            due_at: "2026-04-30T23:59:00.000Z",
            html_url: "https://canvas.example/courses/17/assignments/42",
            course_id: course.id,
            has_submitted_submissions: false,
          },
        ];
      },
      async getAssignmentDetail(_courseId: number, assignmentId: number) {
        detailCalls.push(assignmentId);
        return {
          id: 42,
          name: "Lab 4",
          due_at: "2026-04-30T23:59:00.000Z",
          html_url: "https://canvas.example/courses/17/assignments/42",
          course_id: course.id,
          has_submitted_submissions: false,
          description: "<p>Implement the ALU and upload your report.</p>",
          unlock_at: null,
          lock_at: null,
          points_possible: 25,
          grading_type: "points",
          submission_types: ["online_upload"],
          allowed_extensions: [".pdf", ".zip"],
          rubric: [
            {
              id: "correctness",
              description: "Correctness",
              long_description:
                '<p>Match the <a href="../pages/lab-4-style-guide">style guide</a>.</p>',
              points: 10,
              ratings: [
                {
                  description: "Excellent",
                  long_description:
                    "<p>Complete and accurate.</p><ul><li>Handles overflow cases</li><li>Includes waveform evidence</li></ul>",
                  points: 10,
                },
                {
                  description: "Needs work",
                  long_description:
                    "<table><tr><th>Issue</th><th>Impact</th></tr><tr><td>Missing edge cases</td><td>Deduction</td></tr></table>",
                  points: 5,
                },
              ],
            },
          ],
        };
      },
      async getModulesSafe() {
        return [];
      },
      async getModuleItemsSafe() {
        return [];
      },
      async getFilesSafe() {
        return [];
      },
      async getPagesSafe() {
        return [];
      },
      async getAnnouncementsSafe() {
        return [];
      },
      async getFrontPageSafe() {
        return null;
      },
      async getPageBySlugSafe() {
        return null;
      },
      skippedEndpoints: [] as string[],
      resetSkippedEndpoints() {},
    } as any;

    const result = await ingestCourse(
      course,
      client,
      {
        baseUrl: "https://canvas.example/api/v1",
        accessToken: "token",
      },
      { refresh: false }
    );

    assert.deepEqual(detailCalls, [42]);

    const assignmentExtract = await fs.readFile(
      path.join(result.coursePath, "extracted", "assignments", "42.txt"),
      "utf-8"
    );

    assert.match(assignmentExtract, /Implement the ALU and upload your report\./);
    assert.match(assignmentExtract, /Allowed file extensions: \.pdf, \.zip/);
    assert.match(assignmentExtract, /## Rubric/);
    assert.match(assignmentExtract, /### Correctness \(10 points\)/);
    assert.match(
      assignmentExtract,
      /style guide \(https:\/\/canvas\.example\/courses\/17\/pages\/lab-4-style-guide\)/
    );
    assert.match(assignmentExtract, /#### Rating: Excellent \(10 points\)/);
    assert.match(assignmentExtract, /Complete and accurate\./);
    assert.match(assignmentExtract, /- Handles overflow cases/);
    assert.match(assignmentExtract, /- Includes waveform evidence/);
    assert.match(assignmentExtract, /#### Rating: Needs work \(5 points\)/);
    assert.match(assignmentExtract, /Table:/);
    assert.match(
      assignmentExtract,
      /Issue: Missing edge cases \| Impact: Deduction/
    );
  });
});

test("ingestCourse follows links embedded in assignment rubrics", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const downloadUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input);
      downloadUrls.push(url);
      if (url === "https://canvas.example/courses/17/files/93/download?verifier=rubric") {
        return new Response("Rubric exemplar content.\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.edu/style-guide") {
        return new Response(
          "<html><head><title>External Style Guide</title></head><body><p>Use concise waveform captions.</p></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html" },
          }
        );
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [
            {
              id: 42,
              name: "Lab 4",
              due_at: "2026-04-30T23:59:00.000Z",
              html_url: "https://canvas.example/courses/17/assignments/42",
              course_id: course.id,
              has_submitted_submissions: false,
            },
          ];
        },
        async getAssignmentDetail() {
          return {
            id: 42,
            name: "Lab 4",
            due_at: "2026-04-30T23:59:00.000Z",
            html_url: "https://canvas.example/courses/17/assignments/42",
            course_id: course.id,
            has_submitted_submissions: false,
            description: null,
            unlock_at: null,
            lock_at: null,
            points_possible: 25,
            grading_type: "points",
            submission_types: ["online_upload"],
            allowed_extensions: [".pdf"],
            rubric: [
              {
                id: "correctness",
                description: "Correctness",
                long_description: [
                  '<p>Read the <a href="../pages/rubric-guide">rubric guide</a>.</p>',
                  '<p><a class="instructure_file_link" title="rubric-example.txt" href="https://canvas.example/courses/17/files/93?verifier=rubric">Rubric example</a></p>',
                  '<p><a href="https://example.edu/style-guide">external style guide</a></p>',
                ].join(""),
                points: 10,
                ratings: [],
              },
            ],
          };
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe(_courseId: number, slug: string) {
          if (slug !== "rubric-guide") {
            return null;
          }
          return {
            title: "Rubric Guide",
            body: "<p>Rubric guide says document every edge case.</p>",
            url: slug,
          };
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.ok(
        result.pages.some((page) => page.pageId === "rubric-guide"),
        "expected rubric-linked Canvas page to be fetched"
      );
      assert.ok(
        result.attachments.some(
          (attachment) =>
            attachment.originalFilename === "rubric-example.txt" &&
            attachment.sourceType === "assignment_linked" &&
            attachment.status === "downloaded"
        ),
        "expected rubric-linked Canvas file to be downloaded"
      );
      assert.ok(
        result.externalLinks?.some((link) =>
          link.sources.some((source) =>
            source.includes('assignment "Lab 4" rubric criterion "Correctness" details')
          )
        ),
        "expected rubric external link to be captured with rubric provenance"
      );
      assert.deepEqual(downloadUrls.sort(), [
        "https://canvas.example/courses/17/files/93/download?verifier=rubric",
        "https://example.edu/style-guide",
      ]);

      const pageExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "pages", "rubric-guide.txt"),
        "utf-8"
      );
      assert.match(pageExtract, /document every edge case/);

      const attachmentText = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "attachments",
          "assignments",
          "rubric-example.txt.txt"
        ),
        "utf-8"
      );
      assert.match(attachmentText, /Rubric exemplar content/);

      const externalLinkText = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "external-links",
          `${result.externalLinks?.[0]?.id}.txt`
        ),
        "utf-8"
      );
      assert.match(externalLinkText, /Use concise waveform captions/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse downloads assignment detail attachments that are not module files", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const downloadUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});

      downloadUrls.push(url);
      assert.equal(headers.get("Authorization"), "Bearer token");
      return new Response("Starter code details live here.\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [
            {
              id: 42,
              name: "Lab 4",
              due_at: "2026-04-30T23:59:00.000Z",
              html_url: "https://canvas.example/courses/17/assignments/42",
              course_id: course.id,
              has_submitted_submissions: false,
            },
          ];
        },
        async getAssignmentDetail() {
          return {
            id: 42,
            name: "Lab 4",
            due_at: "2026-04-30T23:59:00.000Z",
            html_url: "https://canvas.example/courses/17/assignments/42",
            course_id: course.id,
            has_submitted_submissions: false,
            description:
              '<p>Use the attached starter file. <a class="instructure_file_link" title="lab4-starter.txt" href="https://canvas.example/courses/17/files/77?wrap=1&verifier=abc">Starter mirror</a></p>',
            unlock_at: null,
            lock_at: null,
            points_possible: 25,
            grading_type: "points",
            submission_types: ["online_upload"],
            allowed_extensions: [".txt"],
            attachments: [
              {
                id: 77,
                display_name: "lab4-starter.txt",
                filename: "lab4-starter.txt",
                url: "https://canvas.example/files/77/download",
                content_type: "text/plain",
                size: 31,
              },
            ],
          };
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.attachments.length, 1);
      assert.deepEqual(downloadUrls, ["https://canvas.example/files/77/download"]);
      assert.equal(result.attachments[0]?.sourceType, "assignment_attachment");
      assert.equal(result.attachments[0]?.originalFilename, "lab4-starter.txt");
      assert.equal(result.attachments[0]?.canvasFileId, 77);
      assert.equal(result.attachments[0]?.status, "downloaded");

      const attachmentText = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "attachments",
          "assignments",
          "lab4-starter.txt.txt"
        ),
        "utf-8"
      );
      assert.match(attachmentText, /Starter code details live here/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse captures plain Canvas file links mixed with rich file links", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const downloadUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});

      downloadUrls.push(url);
      assert.equal(headers.get("Authorization"), "Bearer token");
      return new Response(`downloaded ${url}\n`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [
            {
              id: 42,
              name: "Lab 4",
              due_at: "2026-04-30T23:59:00.000Z",
              html_url: "https://canvas.example/courses/17/assignments/42",
              course_id: course.id,
              has_submitted_submissions: false,
              description: [
                "<p>Download both resources:</p>",
                '<p><a class="instructure_file_link" title="lab4-starter.txt" href="https://canvas.example/courses/17/files/77?wrap=1&amp;verifier=abc">Starter mirror</a></p>',
                "<p><a href='https://canvas.example/courses/17/files/88?verifier=plain'>plain-notes.txt</a></p>",
              ].join(""),
            },
          ];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.deepEqual(downloadUrls.sort(), [
        "https://canvas.example/courses/17/files/77/download?verifier=abc",
        "https://canvas.example/courses/17/files/88/download?verifier=plain",
      ]);
      assert.equal(result.assignments[0]?.descriptionLinkCount, 2);
      assert.deepEqual(
        result.attachments
          .map((attachment) => ({
            name: attachment.originalFilename,
            sourceType: attachment.sourceType,
            status: attachment.status,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        [
          {
            name: "lab4-starter.txt",
            sourceType: "assignment_linked",
            status: "downloaded",
          },
          {
            name: "plain-notes.txt",
            sourceType: "assignment_linked",
            status: "downloaded",
          },
        ]
      );

      const plainNotesText = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "attachments",
          "assignments",
          "plain-notes.txt.txt"
        ),
        "utf-8"
      );
      assert.match(plainNotesText, /downloaded .*files\/88\/download/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse downloads Canvas file URLs used as module URL items", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const downloadUrls: string[] = [];
    const metadataRequests: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});

      downloadUrls.push(url);
      assert.equal(headers.get("Authorization"), "Bearer token");
      return new Response("Timing worksheet content.\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [];
        },
        async getModulesSafe() {
          return [
            {
              id: 9,
              name: "Week 6",
              position: 1,
              items_count: 1,
              items_url: "",
            },
          ];
        },
        async getModuleItemsSafe() {
          return [
            {
              id: 91,
              title: "Timing Worksheet",
              type: "ExternalUrl",
              position: 1,
              external_url:
                "https://canvas.example/courses/17/files/202?wrap=1&verifier=module",
            },
          ];
        },
        async getFilesSafe() {
          return [];
        },
        async getFileSafe(fileId: number) {
          metadataRequests.push(fileId);
          return {
            id: fileId,
            display_name: "timing-worksheet.txt",
            filename: "timing-worksheet.txt",
            content_type: "text/plain",
            size: 26,
            url: `https://canvas.example/files/${fileId}/download`,
            updated_at: null,
            folder_id: null,
          };
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.deepEqual(metadataRequests, [202]);
      assert.deepEqual(downloadUrls, ["https://canvas.example/files/202/download"]);
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0]?.sourceType, "module_linked");
      assert.equal(result.attachments[0]?.canvasFileId, 202);
      assert.equal(result.attachments[0]?.originalFilename, "timing-worksheet.txt");
      assert.match(
        result.attachments[0]?.reason ?? "",
        /Canvas file URL in module "Week 6" item "Timing Worksheet"/
      );

      const worksheetText = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "attachments",
          "modules",
          "timing-worksheet.txt.txt"
        ),
        "utf-8"
      );
      assert.match(worksheetText, /Timing worksheet content/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse captures discussion thread clarifications and linked resources", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const pageBodies = new Map<
      string,
      { title: string; body: string; url: string }
    >([
      [
        "discussion-hub",
        {
          title: "Discussion Hub",
          body: "<p>General clarifications collected here.</p>",
          url: "discussion-hub",
        },
      ],
      [
        "overflow-followup",
        {
          title: "Overflow Follow-up",
          body: "<p>Signed overflow edge cases are explained here.</p>",
          url: "overflow-followup",
        },
      ],
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) =>
      new Response(`downloaded ${String(input)}`, { status: 200 });

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [
            {
              id: 9,
              title: "Lab 4 clarification thread",
              message:
                '<p>Start with the <a href="/courses/17/pages/discussion-hub">discussion hub</a>.</p>',
              context_code: "course_17",
              posted_at: "2026-04-02T09:00:00.000Z",
              last_reply_at: "2026-04-03T15:30:00.000Z",
              discussion_type: "threaded",
              read_state: "read",
              unread_count: 0,
              user_name: "Prof. Ada",
              html_url: "https://canvas.example/courses/17/discussion_topics/9",
              published: true,
              is_announcement: false,
              locked: false,
            },
          ];
        },
        async getDiscussionTopicViewSafe() {
          return {
            participants: [
              { id: 1, display_name: "Prof. Ada" },
              { id: 2, display_name: "Student One" },
            ],
            unread_entries: [],
            view: [
              {
                id: 101,
                user_id: 1,
                user_name: "Prof. Ada",
                message: [
                  '<p>Use signed overflow detection.</p>',
                  '<p>See the <a href="/courses/17/pages/overflow-followup">overflow follow-up</a> and <a class="instructure_file_link" title="clarification.pdf" href="https://canvas.example/courses/17/files/93?verifier=reply">clarification PDF</a>.</p>',
                ].join(""),
                created_at: "2026-04-03T15:30:00.000Z",
                updated_at: "2026-04-03T15:30:00.000Z",
                read_state: "read",
              },
            ],
            new_entries: [],
          };
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe(_courseId: number, slug: string) {
          return pageBodies.get(slug) ?? null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.discussions?.length, 1);
      assert.deepEqual(
        result.pages.map((page) => page.pageId).sort(),
        ["discussion-hub", "overflow-followup"]
      );
      assert.ok(
        result.attachments.some(
          (attachment) =>
            attachment.originalFilename === "clarification.pdf" &&
            attachment.status === "downloaded"
        )
      );

      const discussions = JSON.parse(
        await fs.readFile(
          path.join(result.coursePath, "discussions.json"),
          "utf-8"
        )
      ) as Array<{ title: string; threadEntryCount: number; participantCount: number }>;
      assert.equal(discussions[0]?.title, "Lab 4 clarification thread");
      assert.equal(discussions[0]?.threadEntryCount, 1);
      assert.equal(discussions[0]?.participantCount, 2);

      const discussionExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "discussions", "9.txt"),
        "utf-8"
      );
      assert.match(discussionExtract, /Lab 4 clarification thread/);
      assert.match(discussionExtract, /Use signed overflow detection/);
      assert.match(discussionExtract, /clarification PDF/);
      assert.match(
        discussionExtract,
        /overflow follow-up \(https:\/\/canvas\.example\/courses\/17\/pages\/overflow-followup\)/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse downloads files attached to announcements and discussion replies", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const downloadUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});

      downloadUrls.push(url);
      assert.equal(headers.get("Authorization"), "Bearer token");
      return new Response(`Downloaded body for ${url}\n`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [
            {
              id: 5,
              title: "Exam package",
              message: "<p>The review handout is attached below.</p>",
              context_code: "course_17",
              posted_at: "2026-04-01T10:00:00.000Z",
              last_reply_at: null,
              discussion_type: "side_comment",
              read_state: "read",
              unread_count: 0,
              user_name: "Prof. Ada",
              html_url: "https://canvas.example/courses/17/discussion_topics/5",
              published: true,
              is_announcement: true,
              locked: false,
              attachments: [
                {
                  id: 51,
                  display_name: "exam-review.txt",
                  filename: "exam-review.txt",
                  url: "https://canvas.example/files/51/download",
                  content_type: "text/plain",
                  size: 32,
                },
              ],
            },
          ];
        },
        async getDiscussionTopicsSafe() {
          return [
            {
              id: 9,
              title: "Lab clarification attachments",
              message: "<p>The starter patch is attached to my reply.</p>",
              context_code: "course_17",
              posted_at: "2026-04-02T09:00:00.000Z",
              last_reply_at: "2026-04-03T15:30:00.000Z",
              discussion_type: "threaded",
              read_state: "read",
              unread_count: 0,
              user_name: "Prof. Ada",
              html_url: "https://canvas.example/courses/17/discussion_topics/9",
              published: true,
              is_announcement: false,
              locked: false,
            },
          ];
        },
        async getDiscussionTopicViewSafe(_courseId: number, topicId: number) {
          if (topicId === 9) {
            return {
              participants: [{ id: 1, display_name: "Prof. Ada" }],
              unread_entries: [],
              view: [
                {
                  id: 101,
                  user_id: 1,
                  user_name: "Prof. Ada",
                  message: "<p>Use this patch for the starter files.</p>",
                  created_at: "2026-04-03T15:30:00.000Z",
                  updated_at: "2026-04-03T15:30:00.000Z",
                  read_state: "read",
                  attachment: {
                    id: 52,
                    display_name: "starter-patch.txt",
                    filename: "starter-patch.txt",
                    url: "https://canvas.example/files/52/download",
                    content_type: "text/plain",
                    size: 41,
                  },
                },
              ],
              new_entries: [],
            };
          }
          return {
            participants: [{ id: 1, display_name: "Prof. Ada" }],
            unread_entries: [],
            view: [],
            new_entries: [],
          };
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.deepEqual(downloadUrls.sort(), [
        "https://canvas.example/files/51/download",
        "https://canvas.example/files/52/download",
      ]);
      assert.equal(result.attachments.length, 2);
      assert.ok(
        result.attachments.some(
          (attachment) =>
            attachment.sourceType === "announcement_attachment" &&
            attachment.originalFilename === "exam-review.txt" &&
            attachment.reason === 'attached to announcement "Exam package"'
        )
      );
      assert.ok(
        result.attachments.some(
          (attachment) =>
            attachment.sourceType === "discussion_attachment" &&
            attachment.originalFilename === "starter-patch.txt" &&
            attachment.reason ===
              'attached to discussion reply in "Lab clarification attachments" by Prof. Ada'
        )
      );

      const announcementText = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "attachments",
          "announcements",
          "exam-review.txt.txt"
        ),
        "utf-8"
      );
      assert.match(announcementText, /Downloaded body/);

      const discussionText = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "attachments",
          "discussions",
          "starter-patch.txt.txt"
        ),
        "utf-8"
      );
      assert.match(discussionText, /Downloaded body/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse captures announcement thread replies in extracted text", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("", { status: 200, headers: { "content-type": "text/plain" } });

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [
            {
              id: 5,
              title: "Exam is now open book",
              message: "<p>Due to feedback, the midterm is open book.</p>",
              context_code: "course_17",
              posted_at: "2026-04-01T10:00:00.000Z",
              last_reply_at: "2026-04-02T14:00:00.000Z",
              discussion_type: "side_comment",
              read_state: "read",
              unread_count: 0,
              user_name: "Prof. Ada",
              html_url: "https://canvas.example/courses/17/discussion_topics/5",
              published: true,
              is_announcement: true,
              locked: false,
            },
          ];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getDiscussionTopicViewSafe(_courseId: number, topicId: number) {
          if (topicId === 5) {
            return {
              participants: [
                { id: 1, display_name: "Prof. Ada" },
                { id: 2, display_name: "Student Bob" },
              ],
              unread_entries: [],
              view: [
                {
                  id: 201,
                  user_id: 2,
                  user_name: "Student Bob",
                  message: "<p>Does this include the formula sheet?</p>",
                  created_at: "2026-04-01T12:00:00.000Z",
                  updated_at: "2026-04-01T12:00:00.000Z",
                  read_state: "read",
                },
                {
                  id: 202,
                  user_id: 1,
                  user_name: "Prof. Ada",
                  message: "<p>Yes, you can bring the formula sheet and any notes.</p>",
                  created_at: "2026-04-02T14:00:00.000Z",
                  updated_at: "2026-04-02T14:00:00.000Z",
                  read_state: "read",
                },
              ],
              new_entries: [],
            };
          }
          return { participants: [], unread_entries: [], view: [], new_entries: [] };
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.announcements?.length, 1);
      const entry = result.announcements![0];
      assert.equal(entry.threadEntryCount, 2);
      assert.equal(entry.participantCount, 2);

      const announcementExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "announcements", "5.txt"),
        "utf-8"
      );
      assert.match(announcementExtract, /Exam is now open book/);
      assert.match(announcementExtract, /midterm is open book/);
      assert.match(announcementExtract, /## Replies/);
      assert.match(announcementExtract, /Student Bob/);
      assert.match(announcementExtract, /Does this include the formula sheet/);
      assert.match(announcementExtract, /Prof\. Ada/);
      assert.match(announcementExtract, /you can bring the formula sheet/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse captures quiz instructions and linked resources", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const pageBodies = new Map<
      string,
      { title: string; body: string; url: string }
    >([
      [
        "quiz-review",
        {
          title: "Quiz Review",
          body: "<p>Focus on pipeline hazards and cache locality.</p>",
          url: "quiz-review",
        },
      ],
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});

      if (url === "https://public.example/quiz-prep") {
        assert.equal(headers.get("Authorization"), null);
        return new Response(
          "<html><body><h1>Quiz Prep Guide</h1><p>Review scoreboard timing.</p></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }
        );
      }

      if (url === "https://canvas.example/courses/17/files/94/download?verifier=quiz") {
        assert.equal(headers.get("Authorization"), "Bearer token");
        return new Response("Formula sheet: CPI and cache miss rate.\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getQuizzesSafe() {
          return [
            {
              id: 7,
              title: "Quiz 1 readiness check",
              html_url: "https://canvas.example/courses/17/quizzes/7",
              description: [
                "<h2>Instructions</h2>",
                '<p>Review the <a href="/courses/17/pages/quiz-review">quiz review page</a>, ',
                '<a class="instructure_file_link" title="formula-sheet.txt" href="https://canvas.example/courses/17/files/94?verifier=quiz">formula sheet</a>, ',
                'and <a href="https://public.example/quiz-prep">prep guide</a>.</p>',
              ].join(""),
              quiz_type: "assignment",
              due_at: "2026-04-15T23:59:00.000Z",
              unlock_at: "2026-04-10T12:00:00.000Z",
              lock_at: "2026-04-16T00:30:00.000Z",
              points_possible: 10,
              question_count: 12,
              time_limit: 30,
              allowed_attempts: 2,
              published: true,
              assignment_id: 700,
            },
          ];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe(_courseId: number, slug: string) {
          return pageBodies.get(slug) ?? null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.quizzes?.length, 1);
      assert.equal(result.quizzes?.[0]?.descriptionLinkCount, 1);
      assert.deepEqual(result.pages.map((page) => page.pageId), ["quiz-review"]);
      assert.ok(
        result.attachments.some(
          (attachment) =>
            attachment.sourceType === "quiz_linked" &&
            attachment.originalFilename === "formula-sheet.txt" &&
            attachment.status === "downloaded"
        )
      );
      assert.equal(result.externalLinks?.length, 1);
      assert.equal(result.externalLinks?.[0]?.title, "prep guide");
      assert.equal(result.externalLinks?.[0]?.contentStatus, "captured");
      assert.deepEqual(result.externalLinks?.[0]?.sources, [
        'quiz "Quiz 1 readiness check" description',
      ]);

      const quizzes = JSON.parse(
        await fs.readFile(path.join(result.coursePath, "quizzes.json"), "utf-8")
      ) as Array<{ title: string; dueAt: string | null; questionCount: number | null }>;
      assert.equal(quizzes[0]?.title, "Quiz 1 readiness check");
      assert.equal(quizzes[0]?.dueAt, "2026-04-15T23:59:00.000Z");
      assert.equal(quizzes[0]?.questionCount, 12);

      const quizExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "quizzes", "7.txt"),
        "utf-8"
      );
      assert.match(quizExtract, /## Key facts/);
      assert.match(quizExtract, /Due: 2026-04-15T23:59:00.000Z/);
      assert.match(quizExtract, /Points: 10/);
      assert.match(quizExtract, /Questions: 12/);
      assert.match(quizExtract, /Time limit: 30 minutes/);
      assert.match(
        quizExtract,
        /quiz review page \(https:\/\/canvas\.example\/courses\/17\/pages\/quiz-review\)/
      );

      const pageExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "pages", "quiz-review.txt"),
        "utf-8"
      );
      assert.match(pageExtract, /pipeline hazards and cache locality/);

      const attachmentExtract = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "attachments",
          "quizzes",
          "formula-sheet.txt.txt"
        ),
        "utf-8"
      );
      assert.match(attachmentExtract, /CPI and cache miss rate/);

      const externalExtract = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "external-links",
          `${result.externalLinks?.[0]?.id}.txt`
        ),
        "utf-8"
      );
      assert.match(externalExtract, /Review scoreboard timing/);
      assert.match(externalExtract, /quiz "Quiz 1 readiness check" description/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse captures calendar event descriptions and linked resources", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const pageBodies = new Map<
      string,
      { title: string; body: string; url: string }
    >([
      [
        "exam-review-plan",
        {
          title: "Exam Review Plan",
          body: "<p>Bring your pipeline timing questions to the review.</p>",
          url: "exam-review-plan",
        },
      ],
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});

      if (url === "https://public.example/exam-checklist") {
        assert.equal(headers.get("Authorization"), null);
        return new Response(
          "<html><body><h1>Exam Checklist</h1><p>Review cache associativity.</p></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }
        );
      }

      if (url === "https://canvas.example/courses/17/files/95/download?verifier=event") {
        assert.equal(headers.get("Authorization"), "Bearer token");
        return new Response("Review worksheet: branch prediction practice.\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getQuizzesSafe() {
          return [];
        },
        async getCalendarEventsSafe() {
          return [
            {
              id: 88,
              title: "Midterm review session",
              description: [
                '<p>Read the <a href="/courses/17/pages/exam-review-plan">review plan</a>, ',
                '<a class="instructure_file_link" title="review-worksheet.txt" href="https://canvas.example/courses/17/files/95?verifier=event">review worksheet</a>, ',
                'and <a href="https://public.example/exam-checklist">exam checklist</a>.</p>',
              ].join(""),
              start_at: "2026-04-20T18:00:00.000Z",
              end_at: "2026-04-20T19:30:00.000Z",
              all_day: false,
              location_name: "BA 1160",
              location_address: "40 St George St",
              context_code: "course_17",
              html_url: "https://canvas.example/calendar?event_id=88",
              workflow_state: "active",
            },
          ];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe(_courseId: number, slug: string) {
          return pageBodies.get(slug) ?? null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.calendarEvents?.length, 1);
      assert.equal(result.calendarEvents?.[0]?.descriptionLinkCount, 1);
      assert.deepEqual(result.pages.map((page) => page.pageId), [
        "exam-review-plan",
      ]);
      assert.ok(
        result.attachments.some(
          (attachment) =>
            attachment.sourceType === "calendar_event_linked" &&
            attachment.originalFilename === "review-worksheet.txt" &&
            attachment.status === "downloaded"
        )
      );
      assert.equal(result.externalLinks?.length, 1);
      assert.equal(result.externalLinks?.[0]?.title, "exam checklist");
      assert.equal(result.externalLinks?.[0]?.contentStatus, "captured");
      assert.deepEqual(result.externalLinks?.[0]?.sources, [
        'calendar event "Midterm review session" description',
      ]);

      const events = JSON.parse(
        await fs.readFile(
          path.join(result.coursePath, "calendar-events.json"),
          "utf-8"
        )
      ) as Array<{ title: string; startAt: string | null; locationName: string | null }>;
      assert.equal(events[0]?.title, "Midterm review session");
      assert.equal(events[0]?.startAt, "2026-04-20T18:00:00.000Z");
      assert.equal(events[0]?.locationName, "BA 1160");

      const eventExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "calendar-events", "88.txt"),
        "utf-8"
      );
      assert.match(eventExtract, /## Key facts/);
      assert.match(eventExtract, /Starts: 2026-04-20T18:00:00.000Z/);
      assert.match(eventExtract, /Location: BA 1160/);
      assert.match(eventExtract, /Address: 40 St George St/);
      assert.match(
        eventExtract,
        /review plan \(https:\/\/canvas\.example\/courses\/17\/pages\/exam-review-plan\)/
      );

      const pageExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "pages", "exam-review-plan.txt"),
        "utf-8"
      );
      assert.match(pageExtract, /pipeline timing questions/);

      const attachmentExtract = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "attachments",
          "calendar-events",
          "review-worksheet.txt.txt"
        ),
        "utf-8"
      );
      assert.match(attachmentExtract, /branch prediction practice/);

      const externalExtract = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "external-links",
          `${result.externalLinks?.[0]?.id}.txt`
        ),
        "utf-8"
      );
      assert.match(externalExtract, /Review cache associativity/);
      assert.match(externalExtract, /calendar event "Midterm review session" description/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse captures external resources linked from course content and module tools", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});

      if (url === "https://canvas.example/courses/17/external_tools/launch") {
        assert.equal(headers.get("Authorization"), "Bearer token");
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://public.example/shared-spec",
          },
        });
      }

      if (url === "https://public.example/shared-spec") {
        assert.equal(headers.get("Authorization"), null);
        return new Response(
          [
            "<html>",
            "<head>",
            "<title>Shared Lab Spec</title>",
            '<meta name="description" content="Shared ALU instructions.">',
            "</head>",
            "<body>",
            "<h1>Shared Lab Spec</h1>",
            "<p>Use signed overflow detection for the ALU.</p>",
            "</body>",
            "</html>",
          ].join(""),
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          }
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [
            {
              id: 1,
              name: "Homework 1",
              due_at: null,
              html_url: "https://canvas.example/courses/17/assignments/1",
              course_id: course.id,
              has_submitted_submissions: false,
              description:
                '<p>Read the <a href="https://public.example/shared-spec">shared lab spec</a>.</p>',
            },
          ];
        },
        async getModulesSafe() {
          return [
            {
              id: 9,
              name: "Week 4",
              position: 1,
              items_count: 1,
              items_url: "",
            },
          ];
        },
        async getModuleItemsSafe() {
          return [
            {
              id: 91,
              title: "Shared Lab Spec",
              type: "ExternalTool",
              position: 1,
              html_url: "https://canvas.example/courses/17/external_tools/launch",
            },
          ];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.externalLinks?.length, 1);
      assert.equal(result.externalLinks?.[0]?.title, "Shared Lab Spec");
      assert.equal(
        result.externalLinks?.[0]?.resolvedUrl,
        "https://public.example/shared-spec"
      );
      assert.equal(result.externalLinks?.[0]?.contentStatus, "captured");
      assert.equal(result.externalLinks?.[0]?.sourceCount, 2);

      const externalLinks = JSON.parse(
        await fs.readFile(
          path.join(result.coursePath, "external-links.json"),
          "utf-8"
        )
      ) as Array<{ title: string; sourceCount: number }>;
      assert.equal(externalLinks[0]?.title, "Shared Lab Spec");
      assert.equal(externalLinks[0]?.sourceCount, 2);

      const externalExtract = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "external-links",
          `${result.externalLinks?.[0]?.id}.txt`
        ),
        "utf-8"
      );
      assert.match(externalExtract, /Use signed overflow detection for the ALU/);
      assert.match(externalExtract, /assignment "Homework 1" description/);
      assert.match(externalExtract, /module "Week 4" item "Shared Lab Spec"/);
      assert.match(externalExtract, /Source URL: https:\/\/public\.example\/shared-spec/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse captures external URLs from course navigation tabs", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});

      if (url === "https://zoom.example/ece243-lab") {
        assert.equal(headers.get("Authorization"), null);
        return new Response(
          [
            "<html>",
            "<head><title>ECE243 Lab Room</title></head>",
            "<body>",
            "<h1>ECE243 Lab Room</h1>",
            "<p>Use this Zoom room for Friday lab help and office hours.</p>",
            "</body>",
            "</html>",
          ].join(""),
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          }
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getCourseTabsSafe() {
          return [
            {
              id: "context_external_tool_99",
              label: "Course Zoom",
              type: "external",
              hidden: false,
              visibility: "public",
              position: 4,
              html_url: "https://canvas.example/courses/17/external_tools/99",
              full_url: "https://zoom.example/ece243-lab",
            },
          ];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.tabs?.length, 1);
      assert.equal(result.tabs?.[0]?.label, "Course Zoom");
      assert.equal(result.externalLinks?.length, 1);
      assert.equal(result.externalLinks?.[0]?.url, "https://zoom.example/ece243-lab");
      assert.deepEqual(result.externalLinks?.[0]?.sources, [
        'course navigation tab "Course Zoom"',
      ]);

      const tabs = JSON.parse(
        await fs.readFile(path.join(result.coursePath, "tabs.json"), "utf-8")
      ) as Array<{ label: string; fullUrl: string | null }>;
      assert.equal(tabs[0]?.label, "Course Zoom");
      assert.equal(tabs[0]?.fullUrl, "https://zoom.example/ece243-lab");

      const tabExtract = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "course-tabs",
          "context_external_tool_99.txt"
        ),
        "utf-8"
      );
      assert.match(tabExtract, /# Course Zoom/);
      assert.match(tabExtract, /Full URL: https:\/\/zoom\.example\/ece243-lab/);

      const externalExtract = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "external-links",
          `${result.externalLinks?.[0]?.id}.txt`
        ),
        "utf-8"
      );
      assert.match(externalExtract, /Friday lab help and office hours/);
      assert.match(externalExtract, /course navigation tab "Course Zoom"/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse exports shared Google Docs links to readable text", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});

      if (
        url ===
        "https://docs.google.com/document/d/abc123/edit?usp=sharing"
      ) {
        assert.equal(headers.get("Authorization"), null);
        return new Response(
          [
            "<html>",
            "<head><title>Lab 4 Shared Notes - Google Docs</title></head>",
            "<body>",
            "<div>Google Docs viewer shell</div>",
            "</body>",
            "</html>",
          ].join(""),
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          }
        );
      }

      if (
        url ===
        "https://docs.google.com/document/d/abc123/export?format=txt"
      ) {
        assert.equal(headers.get("Authorization"), null);
        return new Response(
          [
            "Lab 4 Shared Notes",
            "",
            "Use the provided starter code.",
            "Document the overflow edge case in your analysis.",
          ].join("\n"),
          {
            status: 200,
            headers: {
              "content-type": "text/plain; charset=utf-8",
            },
          }
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [
            {
              id: 1,
              name: "Homework 1",
              due_at: null,
              html_url: "https://canvas.example/courses/17/assignments/1",
              course_id: course.id,
              has_submitted_submissions: false,
              description:
                '<p>Read the <a href="https://docs.google.com/document/d/abc123/edit?usp=sharing">shared notes</a>.</p>',
            },
          ];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.externalLinks?.length, 1);
      assert.equal(result.externalLinks?.[0]?.contentStatus, "captured");

      const externalExtract = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "external-links",
          `${result.externalLinks?.[0]?.id}.txt`
        ),
        "utf-8"
      );
      assert.match(externalExtract, /Lab 4 Shared Notes/);
      assert.match(externalExtract, /Use the provided starter code\./);
      assert.match(
        externalExtract,
        /Document the overflow edge case in your analysis\./
      );
      assert.doesNotMatch(externalExtract, /Google Docs viewer shell/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse exports shared Google Slides links to extracted deck text", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers((init?.headers as Record<string, string> | undefined) ?? {});

      if (
        url ===
        "https://docs.google.com/presentation/d/slides123/edit?usp=sharing"
      ) {
        assert.equal(headers.get("Authorization"), null);
        return new Response(
          [
            "<html>",
            "<head><title>Midterm Review - Google Slides</title></head>",
            "<body>",
            "<div>Google Slides viewer shell</div>",
            "</body>",
            "</html>",
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }
        );
      }

      if (
        url ===
        "https://docs.google.com/presentation/d/slides123/export/pptx"
      ) {
        assert.equal(headers.get("Authorization"), null);
        return new Response(
          buildZipBuffer([
            {
              name: "ppt/slides/slide1.xml",
              content:
                '<p:sld><a:p><a:r><a:t>Midterm Review</a:t></a:r></a:p><a:p><a:r><a:t>Pipeline hazards and forwarding paths.</a:t></a:r></a:p></p:sld>',
            },
            {
              name: "ppt/notesSlides/notesSlide1.xml",
              content:
                '<p:notes><a:p><a:r><a:t>Remind students to review cache associativity examples.</a:t></a:r></a:p></p:notes>',
            },
          ]),
          {
            status: 200,
            headers: {
              "content-type":
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            },
          }
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [
            {
              id: 1,
              name: "Homework 1",
              due_at: null,
              html_url: "https://canvas.example/courses/17/assignments/1",
              course_id: course.id,
              has_submitted_submissions: false,
              description:
                '<p>Review the <a href="https://docs.google.com/presentation/d/slides123/edit?usp=sharing">midterm review slides</a>.</p>',
            },
          ];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.externalLinks?.length, 1);
      assert.equal(result.externalLinks?.[0]?.contentStatus, "captured");

      const externalExtract = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "external-links",
          `${result.externalLinks?.[0]?.id}.txt`
        ),
        "utf-8"
      );
      assert.match(externalExtract, /# google-slides\.pptx/);
      assert.match(externalExtract, /## Slide 1/);
      assert.match(externalExtract, /Pipeline hazards and forwarding paths\./);
      assert.match(externalExtract, /## Speaker Notes 1/);
      assert.match(
        externalExtract,
        /review cache associativity examples/
      );
      assert.doesNotMatch(externalExtract, /Google Slides viewer shell/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse uses bounded concurrency for fallback module file metadata fetches", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    let activeFileMetadataRequests = 0;
    let maxFileMetadataRequests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) =>
      new Response(`downloaded ${String(input)}`, { status: 200 });

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
          };
        },
        async getAssignments() {
          return [];
        },
        async getModulesSafe() {
          return [
            {
              id: 1,
              name: "Module 1",
              position: 1,
              items_count: 3,
              items_url: "",
            },
            {
              id: 2,
              name: "Module 2",
              position: 2,
              items_count: 3,
              items_url: "",
            },
          ];
        },
        async getModuleItemsSafe(_courseId: number, moduleId: number) {
          return Array.from({ length: 3 }, (_, index) => ({
            id: moduleId * 100 + index,
            title: `Module file ${moduleId}-${index + 1}`,
            type: "File",
            position: index + 1,
            content_id: moduleId * 1000 + index + 1,
          }));
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        async getFileSafe(fileId: number) {
          activeFileMetadataRequests += 1;
          maxFileMetadataRequests = Math.max(
            maxFileMetadataRequests,
            activeFileMetadataRequests
          );
          await sleep(10);
          activeFileMetadataRequests -= 1;
          return {
            id: fileId,
            display_name: `module-file-${fileId}.txt`,
            filename: `module-file-${fileId}.txt`,
            content_type: "text/plain",
            size: 32,
            url: `https://canvas.example/files/${fileId}`,
            updated_at: null,
            folder_id: null,
          };
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.attachments.length, 6);
      assert.ok(maxFileMetadataRequests > 1);
      assert.ok(maxFileMetadataRequests <= 4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse captures assignment group grading breakdown", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const client = {
      async getCourseDetail() {
        return {
          id: course.id,
          name: course.name,
          course_code: course.courseCode,
          syllabus_body: null,
          start_at: null,
          end_at: null,
          term: null,
          html_url: "https://canvas.example/courses/17",
        };
      },
      async getAssignments() {
        return [
          { id: 1, name: "Lab 1", due_at: null, html_url: "https://canvas.example/courses/17/assignments/1", has_submitted_submissions: false, course_id: 17 },
          { id: 2, name: "Lab 2", due_at: null, html_url: "https://canvas.example/courses/17/assignments/2", has_submitted_submissions: false, course_id: 17 },
          { id: 3, name: "Midterm", due_at: null, html_url: "https://canvas.example/courses/17/assignments/3", has_submitted_submissions: false, course_id: 17 },
        ];
      },
      async getModulesSafe() {
        return [];
      },
      async getModuleItemsSafe() {
        return [];
      },
      async getFilesSafe() {
        return [];
      },
      async getPagesSafe() {
        return [];
      },
      async getAnnouncementsSafe() {
        return [];
      },
      async getDiscussionTopicsSafe() {
        return [];
      },
      async getFrontPageSafe() {
        return null;
      },
      async getPageBySlugSafe() {
        return null;
      },
      async getAssignmentGroupsSafe() {
        return [
          {
            id: 100,
            name: "Labs",
            group_weight: 30,
            assignments: [
              { id: 1, name: "Lab 1", due_at: null, points_possible: 10, omit_from_final_grade: false },
              { id: 2, name: "Lab 2", due_at: null, points_possible: 10, omit_from_final_grade: false },
            ],
          },
          {
            id: 101,
            name: "Exams",
            group_weight: 70,
            assignments: [
              { id: 3, name: "Midterm", due_at: null, points_possible: 100, omit_from_final_grade: false },
            ],
          },
        ];
      },
      skippedEndpoints: [] as string[],
      resetSkippedEndpoints() {},
    } as any;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("unexpected fetch during test");
    }) as any;

    try {
      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      assert.equal(result.gradingGroups?.length, 2);
      const labs = result.gradingGroups!.find((g) => g.name === "Labs");
      assert.ok(labs);
      assert.equal(labs.weight, 30);
      assert.equal(labs.assignmentCount, 2);
      assert.deepEqual(labs.assignmentNames, ["Lab 1", "Lab 2"]);

      const exams = result.gradingGroups!.find((g) => g.name === "Exams");
      assert.ok(exams);
      assert.equal(exams.weight, 70);
      assert.equal(exams.assignmentCount, 1);

      // Verify the extracted text was written
      const coursePath = result.coursePath;
      const breakdownText = await fs.readFile(
        path.join(coursePath, "extracted", "grading-breakdown.txt"),
        "utf-8"
      );
      assert.match(breakdownText, /Grading Breakdown/);
      assert.match(breakdownText, /Exams \(70%\)/);
      assert.match(breakdownText, /Labs \(30%\)/);
      assert.match(breakdownText, /Lab 1/);
      assert.match(breakdownText, /Midterm/);
      assert.match(breakdownText, /weighted \(total 100%\)/);

      // Verify the JSON index was written
      const jsonPath = path.join(coursePath, "grading-groups.json");
      const jsonContent = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
      assert.equal(jsonContent.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse captures quiz question bodies and their linked resources", async () => {
  await withTempCwd(async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://public.example/reference-chart") {
        return new Response(
          "<html><body><h1>ARM Reference Chart</h1><p>MOV, LDR, STR instructions.</p></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const client = {
        async getCourseDetail() {
          return {
            id: course.id,
            name: course.name,
            course_code: course.courseCode,
            syllabus_body: null,
            start_at: null,
            end_at: null,
            term: null,
            html_url: "https://canvas.example/courses/17",
          };
        },
        async getAssignments() {
          return [];
        },
        async getModulesSafe() {
          return [];
        },
        async getModuleItemsSafe() {
          return [];
        },
        async getFilesSafe() {
          return [];
        },
        async getPagesSafe() {
          return [];
        },
        async getQuizzesSafe() {
          return [
            {
              id: 9,
              title: "Midterm Practice",
              html_url: "https://canvas.example/courses/17/quizzes/9",
              description: "<p>Practice questions for the midterm.</p>",
              quiz_type: "practice_quiz",
              due_at: null,
              unlock_at: null,
              lock_at: null,
              points_possible: 0,
              question_count: 3,
              time_limit: null,
              allowed_attempts: -1,
              published: true,
              assignment_id: null,
            },
          ];
        },
        async getQuizQuestionsSafe(_courseId: number, quizId: number) {
          if (quizId !== 9) return [];
          return [
            {
              id: 101,
              quiz_id: 9,
              question_name: "Question 1",
              question_type: "multiple_choice_question",
              question_text:
                '<p>Given the <a href="https://public.example/reference-chart">ARM reference chart</a>, which instruction stores a register to memory?</p>',
              points_possible: 1,
              position: 1,
            },
            {
              id: 102,
              quiz_id: 9,
              question_name: "Question 2",
              question_type: "short_answer_question",
              question_text:
                "<p>Explain the difference between LDR and MOV.</p>",
              points_possible: 2,
              position: 2,
            },
          ];
        },
        async getAnnouncementsSafe() {
          return [];
        },
        async getDiscussionTopicsSafe() {
          return [];
        },
        async getFrontPageSafe() {
          return null;
        },
        async getPageBySlugSafe() {
          return null;
        },
        skippedEndpoints: [] as string[],
        resetSkippedEndpoints() {},
      } as any;

      const result = await ingestCourse(
        course,
        client,
        {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        },
        { refresh: false }
      );

      // Quiz question text should be in the extracted quiz file
      const quizExtract = await fs.readFile(
        path.join(result.coursePath, "extracted", "quizzes", "9.txt"),
        "utf-8"
      );
      assert.match(quizExtract, /## Questions/);
      assert.match(quizExtract, /### Question 1 \(1 pts\)/);
      assert.match(quizExtract, /ARM reference chart/);
      assert.match(quizExtract, /### Question 2 \(2 pts\)/);
      assert.match(quizExtract, /difference between LDR and MOV/);

      // External link from quiz question should be captured
      assert.equal(result.externalLinks?.length, 1);
      assert.match(result.externalLinks?.[0]?.title, /ARM [Rr]eference [Cc]hart/);
      assert.equal(result.externalLinks?.[0]?.contentStatus, "captured");
      assert.ok(
        result.externalLinks?.[0]?.sources?.some((source: string) =>
          source.includes("question")
        )
      );

      // Verify external link content was captured
      const externalExtract = await fs.readFile(
        path.join(
          result.coursePath,
          "extracted",
          "external-links",
          `${result.externalLinks?.[0]?.id}.txt`
        ),
        "utf-8"
      );
      assert.match(externalExtract, /MOV, LDR, STR instructions/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
