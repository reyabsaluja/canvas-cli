import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchCourseContent } from "../src/ingest/fetch-course-content.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import type { Course } from "../src/domain/models.js";

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
    assert.match(assignmentExtract, /Due: 2026-04-30T23:59:00.000Z/);
    assert.match(assignmentExtract, /Points: 25/);
    assert.match(assignmentExtract, /Submission types: online_upload/);
    assert.match(assignmentExtract, /Allowed file extensions: \.pdf, \.zip/);
    assert.match(assignmentExtract, /## Description/);
    assert.match(assignmentExtract, /Waveform screenshot/);
    assert.match(
      assignmentExtract,
      /lab spec \(https:\/\/canvas\.example\/courses\/17\/pages\/lab-4-spec\)/
    );
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
                  long_description: "Complete and accurate.",
                  points: 10,
                },
                {
                  description: "Needs work",
                  long_description: "Missing edge cases.",
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
    assert.match(
      assignmentExtract,
      /- Excellent \(10 points\): Complete and accurate\./
    );
    assert.match(
      assignmentExtract,
      /- Needs work \(5 points\): Missing edge cases\./
    );
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
