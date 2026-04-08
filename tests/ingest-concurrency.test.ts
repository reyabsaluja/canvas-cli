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
  } as any;

  const result = await fetchCourseContent(client, 17);

  assert.equal(result.modules.length, 6);
  assert.equal(result.fetchedPages.length, 6);
  assert.ok(maxModuleItemRequests > 1);
  assert.ok(maxModuleItemRequests <= 4);
  assert.ok(maxPageRequests > 1);
  assert.ok(maxPageRequests <= 4);
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
