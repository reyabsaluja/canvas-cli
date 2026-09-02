// Tests that patch globalThis.fetch must run sequentially — do not add { concurrency: true }.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import { fetchCourseContent } from "../src/ingest/fetch-course-content.js";
import {
  buildFolderIndex,
  selectCourseFiles,
  MAX_COURSE_FILE_BYTES,
} from "../src/ingest/attachment-selection.js";
import type { SelectedAttachment } from "../src/ingest/attachment-selection.js";
import { downloadSelectedAttachments } from "../src/ingest/attachment-download.js";
import { renderIngestionSummary } from "../src/format/render-ingestion-summary.js";
import type { FileIndexEntry } from "../src/ingest/types.js";
import {
  createMockCanvasServer,
  startServer,
  stopServer,
  type MockFile,
  type MockServerData,
} from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData, CS101_MODULES } from "./helpers/fixtures.js";

async function withTempCwd(fn: (tempDir: string) => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-files-crawl-"));
  process.chdir(tempDir);
  try {
    await fn(tempDir);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const COURSE: Course = {
  id: 101,
  name: "Introduction to Computer Science",
  courseCode: "CS101",
  termName: "Spring 2026",
  isCurrent: true,
};

/**
 * Files-tab fixture: a mix of documents that only exist in Files (never in a
 * module or linked from HTML), a module-linked file, media, and an oversize
 * dataset. URLs are rewritten to the mock origin once the port is known.
 */
function buildFilesTabFixture(origin: string): MockFile[] {
  const url = (id: number) => `${origin}/files/${id}/download`;
  return [
    { id: 5001, display_name: "syllabus.pdf", filename: "syllabus.pdf", content_type: "application/pdf", size: 52400, url: url(5001), updated_at: null, folder_id: 1 },
    { id: 5002, display_name: "lab1-starter.zip", filename: "lab1-starter.zip", content_type: "application/zip", size: 12800, url: url(5002), updated_at: null, folder_id: 2 },
    { id: 5003, display_name: "Lecture 3 - Recursion.txt", filename: "Lecture 3 - Recursion.txt", content_type: "text/plain", size: 120, url: url(5003), updated_at: null, folder_id: 4 },
    { id: 5004, display_name: "week3-slides.pdf", filename: "week3-slides.pdf", content_type: "application/pdf", size: 900, url: url(5004), updated_at: null, folder_id: 4 },
    { id: 5005, display_name: "lecture-01.mp4", filename: "lecture-01.mp4", content_type: "video/mp4", size: 90_000_000, url: url(5005), updated_at: null, folder_id: 4 },
    { id: 5006, display_name: "dataset.csv", filename: "dataset.csv", content_type: "text/csv", size: MAX_COURSE_FILE_BYTES + 1, url: url(5006), updated_at: null, folder_id: 1 },
    { id: 5007, display_name: "readings.txt", filename: "readings.txt", content_type: "text/plain", size: 64, url: url(5007), updated_at: null, folder_id: 2 },
  ];
}

async function startFilesTabServer(
  mutate?: (data: MockServerData) => void
): Promise<{ data: MockServerData; config: Config; stop: () => Promise<void> }> {
  const data = buildDefaultServerData();
  // Module-link readings.txt so the crawl has to dedupe against module files.
  data.modules.set(101, [
    ...CS101_MODULES,
    {
      id: 12,
      name: "Week 3: Recursion",
      position: 3,
      items_count: 1,
      items_url: "",
      items: [{ id: 103, title: "Readings", type: "File", position: 1, content_id: 5007 }],
    },
  ]);
  data.fileContents = new Map([
    [5003, "Recursion: a function that calls itself. Base case first.\n"],
    [5007, "Read chapter 4 before lecture.\n"],
  ]);
  mutate?.(data);
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const origin = `http://127.0.0.1:${port}`;
  data.files.set(101, buildFilesTabFixture(origin));
  return {
    data,
    config: { baseUrl: `${origin}/api/v1`, accessToken: "test-token-valid" },
    stop: () => stopServer(server),
  };
}

test("ingestCourse crawls the Files tab and stores documents with their folder paths", async () => {
  const { config, stop } = await startFilesTabServer();
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      const crawl = result.ingestion.courseFiles;
      assert.ok(crawl, "ingestion.courseFiles summary is recorded");
      assert.equal(crawl.folders, 4);
      assert.equal(crawl.listed, 7);
      assert.equal(crawl.selected, 3, "zip, lecture notes, and slides are crawled");
      assert.equal(crawl.alreadySelected, 2, "syllabus (heuristic) and readings (module) are not duplicated");
      assert.equal(crawl.skippedUnsupported, 1, "mp4 is skipped");
      assert.equal(crawl.skippedTooLarge, 1, "oversize csv is skipped");
      assert.equal(crawl.downloaded, 3);
      assert.equal(crawl.failed, 0);

      const courseFiles = result.attachments.filter((a) => a.sourceType === "course_file");
      assert.deepEqual(
        courseFiles.map((a) => a.localPath).sort(),
        [
          "attachments/files/Labs/lab1-starter.zip",
          "attachments/files/Lectures/Week 3/Lecture 3 - Recursion.txt",
          "attachments/files/Lectures/Week 3/week3-slides.pdf",
        ]
      );
      const lectureNotes = courseFiles.find((a) => a.originalFilename === "Lecture 3 - Recursion.txt");
      assert.ok(lectureNotes);
      assert.equal(lectureNotes.status, "downloaded");
      assert.equal(lectureNotes.canvasFileId, 5003);
      assert.match(lectureNotes.reason, /Files folder "Lectures\/Week 3"/);

      // No file id is downloaded twice across selectors.
      const ids = result.attachments.map((a) => a.canvasFileId).filter((id) => id !== null);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(result.attachments.some((a) => a.sourceType === "module_linked" && a.canvasFileId === 5007));

      // Bytes landed on disk and the text sidecar exists for downstream search.
      const onDisk = await fs.readFile(path.join(result.coursePath, lectureNotes.localPath), "utf-8");
      assert.match(onDisk, /calls itself/);
      const sidecar = await fs.readFile(
        path.join(result.coursePath, "extracted", "attachments", "files", "Lectures", "Week 3", "Lecture 3 - Recursion.txt.txt"),
        "utf-8"
      );
      assert.match(sidecar, /Base case first/);

      // files.json carries the folder path; attachments.json carries the crawl entries.
      const filesJson = JSON.parse(
        await fs.readFile(path.join(result.coursePath, "files.json"), "utf-8")
      ) as FileIndexEntry[];
      assert.equal(filesJson.find((f) => f.id === 5003)?.folderPath, "Lectures/Week 3");
      assert.equal(filesJson.find((f) => f.id === 5001)?.folderPath, "");
      const attachmentsJson = JSON.parse(
        await fs.readFile(path.join(result.coursePath, "attachments.json"), "utf-8")
      ) as Array<{ sourceType: string }>;
      assert.equal(attachmentsJson.filter((a) => a.sourceType === "course_file").length, 3);
      const ingestionJson = JSON.parse(
        await fs.readFile(path.join(result.coursePath, "ingestion.json"), "utf-8")
      ) as { courseFiles?: { selected: number } };
      assert.equal(ingestionJson.courseFiles?.selected, 3);

      // Folder index is exposed on the result.
      assert.deepEqual(
        result.folders?.map((f) => f.path),
        ["", "Labs", "Lectures", "Lectures/Week 3"]
      );

      // Lecture discovery now sees Files-tab decks and notes.
      const lectureTitles = result.lectures.map((l) => l.title);
      assert.ok(lectureTitles.includes("Lecture 3 - Recursion.txt"), `lectures: ${lectureTitles.join(", ")}`);
      assert.ok(lectureTitles.includes("week3-slides.pdf"));
      const slides = result.lectures.find((l) => l.title === "week3-slides.pdf");
      assert.equal(slides?.lectureNumber, 3);
      assert.equal(slides?.contentType, "slides");
      assert.equal(slides?.source, "files: Lectures/Week 3");
      // Media is not downloaded, but a recording in the Files tab is still a lecture pointer.
      const recording = result.lectures.find((l) => l.title === "lecture-01.mp4");
      assert.equal(recording?.contentType, "video");
      assert.equal(recording?.lectureNumber, 1);

      // Summary shows a single crawl line instead of hundreds of file rows.
      const summary = renderIngestionSummary(result);
      assert.match(summary, /3 Files-tab documents crawled across 4 folders/);
      assert.ok(!summary.includes("Lecture 3 - Recursion.txt"), "crawl entries are not listed individually");
      assert.match(summary, /readings\.txt/);
    });
  } finally {
    await stop();
  }
});

test("Files-tab crawl degrades to flat paths when the folders endpoint returns 403", async () => {
  const { config, stop } = await startFilesTabServer((data) => {
    data.forbiddenPaths = [/\/courses\/\d+\/folders$/];
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const raw = await fetchCourseContent(client, 101);
      assert.equal(raw.folders.length, 0);
      assert.equal(raw.files.length, 7);
      assert.ok(
        raw.warnings.some((w) => /folders/.test(w)),
        `warnings mention folders: ${raw.warnings.join(" | ")}`
      );

      const result = await ingestCourse(COURSE, client, config, { refresh: false });
      const crawl = result.ingestion.courseFiles;
      assert.ok(crawl);
      assert.equal(crawl.folders, 0);
      assert.equal(crawl.selected, 3);
      assert.equal(crawl.downloaded, 3);

      const lectureNotes = result.attachments.find((a) => a.canvasFileId === 5003);
      assert.ok(lectureNotes);
      assert.equal(lectureNotes.localPath, "attachments/files/Lecture 3 - Recursion.txt");
      assert.equal(lectureNotes.reason, "course file in Files tab");
      assert.equal(result.files.find((f) => f.id === 5003)?.folderPath, null);
      assert.ok(result.lectures.some((l) => l.title === "Lecture 3 - Recursion.txt"));
      assert.equal(result.lectures.find((l) => l.title === "Lecture 3 - Recursion.txt")?.source, "files");
    });
  } finally {
    await stop();
  }
});

test("Files-tab crawl is a no-op when the Files API is blocked, without breaking module downloads", async () => {
  const { config, stop } = await startFilesTabServer((data) => {
    data.forbiddenPaths = [/\/courses\/\d+\/files$/, /\/courses\/\d+\/folders$/];
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });
      const crawl = result.ingestion.courseFiles;
      assert.ok(crawl);
      assert.deepEqual(crawl, {
        folders: 0,
        listed: 0,
        selected: 0,
        alreadySelected: 0,
        skippedUnsupported: 0,
        skippedTooLarge: 0,
        downloaded: 0,
        failed: 0,
      });
      assert.equal(result.attachments.filter((a) => a.sourceType === "course_file").length, 0);
      // Module items still resolve through GET /files/:id.
      const readings = result.attachments.find((a) => a.canvasFileId === 5007);
      assert.equal(readings?.status, "downloaded");
      assert.ok(!renderIngestionSummary(result).includes("Files-tab documents"));
    });
  } finally {
    await stop();
  }
});

test("selectCourseFiles dedupes against verifier URLs, reconstructs folder paths, and respects limits", () => {
  const folders = buildFolderIndex([
    { id: 1, name: "course files", full_name: "course files", parent_folder_id: null },
    { id: 2, name: "Readings", full_name: "", parent_folder_id: 1 },
    { id: 3, name: "Unit 2", full_name: "", parent_folder_id: 2 },
  ]);
  assert.deepEqual(folders.map((f) => f.path), ["", "Readings", "Readings/Unit 2"]);

  const file = (id: number, name: string, folderId: number, extra: Partial<FileIndexEntry> = {}): FileIndexEntry => ({
    id,
    displayName: name,
    filename: name,
    contentType: "application/pdf",
    size: 1000,
    url: `https://canvas.example/files/${id}/download?download_frd=1`,
    updatedAt: null,
    folderId,
    ...extra,
  });
  const files = [
    file(1, "chapter1.pdf", 3),
    file(2, "linked.pdf", 3),
    file(3, "poster.png", 2, { contentType: "image/png" }),
    file(4, "notes", 2, { contentType: "text/plain" }),
    file(5, "unknown.bin", 2, { contentType: "application/octet-stream" }),
  ];
  const alreadySelected: SelectedAttachment[] = [
    {
      sourceType: "assignment_linked",
      fileId: null,
      filename: "linked.pdf",
      downloadUrl: "https://canvas.example/courses/9/files/2/download?verifier=abc",
      reason: "linked",
      contentType: null,
      size: null,
      subfolder: "assignments",
    },
  ];

  const { selected, summary } = selectCourseFiles(files, folders, alreadySelected);
  assert.deepEqual(selected.map((s) => s.filename), ["notes", "chapter1.pdf"]);
  assert.equal(selected[0]?.subfolder, "files/Readings");
  assert.equal(selected[1]?.subfolder, "files/Readings/Unit 2");
  assert.equal(selected[1]?.sourceType, "course_file");
  assert.equal(summary.alreadySelected, 1, "file 2 recognised via /files/2 in the verifier URL");
  assert.equal(summary.skippedUnsupported, 2, "png and octet-stream skipped");
  assert.equal(summary.selected, 2);
});

test("downloadSelectedAttachments runs in parallel and preserves result order", async () => {
  await withTempCwd(async (tempDir) => {
    let active = 0;
    let maxActive = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return new Response(`body of ${String(input)}`, { status: 200 });
    };
    try {
      const attachments: SelectedAttachment[] = Array.from({ length: 10 }, (_, i) => ({
        sourceType: "course_file",
        fileId: i + 1,
        filename: `doc-${i + 1}.txt`,
        downloadUrl: `https://canvas.example/files/${i + 1}/download`,
        reason: "test",
        contentType: "text/plain",
        size: 10,
        subfolder: i % 2 === 0 ? "files/A" : "files/B",
      }));
      // A duplicate target path must be reported as skipped, not raced.
      attachments.push({ ...attachments[0]!, fileId: 99 });

      const progress: number[] = [];
      const results = await downloadSelectedAttachments(
        attachments,
        path.join(tempDir, "attachments"),
        { baseUrl: "https://canvas.example/api/v1", accessToken: "token" },
        null,
        (completed) => progress.push(completed)
      );

      assert.ok(maxActive > 1, "downloads overlap");
      assert.ok(maxActive <= 4, `bounded to 4, saw ${maxActive}`);
      assert.deepEqual(
        results.map((r) => r.canvasFileId),
        [...attachments.map((a) => a.fileId)]
      );
      assert.equal(results[0]?.status, "downloaded");
      assert.equal(results[0]?.localPath, "attachments/files/A/doc-1.txt");
      assert.equal(results[10]?.status, "skipped");
      assert.deepEqual(progress, Array.from({ length: 11 }, (_, i) => i + 1));
      const entries = await fs.readdir(path.join(tempDir, "attachments", "files", "A"));
      assert.ok(entries.every((e) => !e.endsWith(".tmp")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
