import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadSelectedAttachments } from "../src/ingest/attachment-download.js";
import { mapWithConcurrency } from "../src/ingest/concurrency.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import type { Course } from "../src/domain/models.js";
import type { SelectedAttachment } from "../src/ingest/attachment-selection.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempCwd(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-interrupt-")
  );
  process.chdir(tempDir);
  try {
    await fn(tempDir);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("mapWithConcurrency stops when signal is aborted", async () => {
  const ac = new AbortController();
  let completed = 0;

  const promise = mapWithConcurrency(
    [1, 2, 3, 4, 5, 6, 7, 8],
    2,
    async (item) => {
      await sleep(20);
      completed += 1;
      if (completed === 2) {
        ac.abort();
      }
      return item * 2;
    },
    ac.signal
  );

  await assert.rejects(promise, (err: Error) => err.name === "AbortError");
  assert.ok(completed <= 4, `Expected at most 4 completions but got ${completed}`);
});

test("mapWithConcurrency completes normally without signal", async () => {
  const results = await mapWithConcurrency(
    [1, 2, 3],
    2,
    async (item) => item * 2
  );
  assert.deepEqual(results, [2, 4, 6]);
});

test("mapWithConcurrency rejects immediately with pre-aborted signal", async () => {
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => item, ac.signal),
    (err: Error) => err.name === "AbortError"
  );
});

test("downloadSelectedAttachments stops on abort and cleans up temp files", async () => {
  await withTempCwd(async (tempDir) => {
    const attachmentsDir = path.join(tempDir, "attachments");
    const ac = new AbortController();
    let fetchCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      if (fetchCount === 2) {
        ac.abort();
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
      }
      await sleep(5);
      return new Response("file content", { status: 200 });
    };

    const attachments: SelectedAttachment[] = [
      {
        sourceType: "heuristic",
        fileId: 1,
        filename: "file1.pdf",
        downloadUrl: "https://example.com/file1.pdf",
        reason: "test",
        contentType: "application/pdf",
        size: 100,
        subfolder: "modules",
      },
      {
        sourceType: "heuristic",
        fileId: 2,
        filename: "file2.pdf",
        downloadUrl: "https://example.com/file2.pdf",
        reason: "test",
        contentType: "application/pdf",
        size: 100,
        subfolder: "modules",
      },
      {
        sourceType: "heuristic",
        fileId: 3,
        filename: "file3.pdf",
        downloadUrl: "https://example.com/file3.pdf",
        reason: "test",
        contentType: "application/pdf",
        size: 100,
        subfolder: "modules",
      },
    ];

    try {
      await assert.rejects(
        downloadSelectedAttachments(attachments, attachmentsDir, {
          baseUrl: "https://example.com/api/v1",
          accessToken: "token",
        }, ac.signal),
        (err: Error) => err.name === "AbortError"
      );

      // Verify no .tmp files are left behind
      const modulesDir = path.join(attachmentsDir, "modules");
      let tmpFiles: string[] = [];
      try {
        const entries = await fs.readdir(modulesDir);
        tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
      } catch {
        // Directory might not exist if aborted before first write
      }
      assert.equal(tmpFiles.length, 0, `Found stale .tmp files: ${tmpFiles.join(", ")}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("downloadSelectedAttachments skips already-downloaded files even with signal", async () => {
  await withTempCwd(async (tempDir) => {
    const attachmentsDir = path.join(tempDir, "attachments");
    const modulesDir = path.join(attachmentsDir, "modules");
    await fs.mkdir(modulesDir, { recursive: true });
    await fs.writeFile(path.join(modulesDir, "existing.pdf"), "cached");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("new content", { status: 200 });
    };

    try {
      const attachments: SelectedAttachment[] = [
        {
          sourceType: "heuristic",
          fileId: 1,
          filename: "existing.pdf",
          downloadUrl: "https://example.com/existing.pdf",
          reason: "test",
          contentType: "application/pdf",
          size: 100,
          subfolder: "modules",
        },
      ];

      const results = await downloadSelectedAttachments(
        attachments,
        attachmentsDir,
        { baseUrl: "https://example.com/api/v1", accessToken: "token" },
        null
      );

      assert.equal(results.length, 1);
      assert.equal(results[0]!.status, "skipped");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("downloadSelectedAttachments uses atomic write (temp then rename)", async () => {
  await withTempCwd(async (tempDir) => {
    const attachmentsDir = path.join(tempDir, "attachments");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("downloaded content", { status: 200 });
    };

    try {
      const attachments: SelectedAttachment[] = [
        {
          sourceType: "heuristic",
          fileId: 1,
          filename: "report.pdf",
          downloadUrl: "https://example.com/report.pdf",
          reason: "test",
          contentType: "application/pdf",
          size: 100,
          subfolder: "modules",
        },
      ];

      const results = await downloadSelectedAttachments(
        attachments,
        attachmentsDir,
        { baseUrl: "https://example.com/api/v1", accessToken: "token" }
      );

      assert.equal(results[0]!.status, "downloaded");

      // Final file should exist, no .tmp file
      const finalPath = path.join(attachmentsDir, "modules", "report.pdf");
      const tmpPath = finalPath + ".tmp";
      const content = await fs.readFile(finalPath, "utf-8");
      assert.equal(content, "downloaded content");

      await assert.rejects(fs.stat(tmpPath), { code: "ENOENT" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ingestCourse aborts cleanly on signal and leaves no partial state", async () => {
  await withTempCwd(async (tempDir) => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const ac = new AbortController();
    let downloadAttempts = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      downloadAttempts += 1;
      ac.abort();
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response("content", { status: 200 });
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
            { id: 1, name: "Module 1", position: 1, items_count: 1, items_url: "" },
          ];
        },
        async getModuleItemsSafe() {
          return [
            { id: 100, title: "Lecture Notes", type: "File", position: 1, content_id: 500 },
          ];
        },
        async getFilesSafe() {
          return [
            {
              id: 500,
              display_name: "notes.pdf",
              filename: "notes.pdf",
              content_type: "application/pdf",
              size: 1024,
              url: "https://canvas.example/files/500/download",
              updated_at: null,
              folder_id: null,
            },
          ];
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

      await assert.rejects(
        ingestCourse(course, client, {
          baseUrl: "https://canvas.example/api/v1",
          accessToken: "token",
        }, { refresh: false, signal: ac.signal }),
        (err: Error) => err.name === "AbortError"
      );

      // Check that no .tmp files are left in the course directory
      const coursePath = path.join(tempDir, ".canvas-cli", "courses", "ece243h1-17");
      let hasTmpFiles = false;
      try {
        const walkDir = async (dir: string): Promise<void> => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await walkDir(fullPath);
            } else if (entry.name.endsWith(".tmp")) {
              hasTmpFiles = true;
            }
          }
        };
        await walkDir(coursePath);
      } catch {
        // Directory may not exist if aborted very early
      }
      assert.equal(hasTmpFiles, false, "Found stale .tmp files after abort");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
