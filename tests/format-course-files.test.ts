import assert from "node:assert/strict";
import test from "node:test";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { formatCourseFilesList } from "../src/tui/format-course-files.js";

function makeCache(
  partial: Partial<Pick<CourseCache, "attachments" | "files">>
): CourseCache {
  return {
    courseId: 1,
    coursePath: "/tmp/course",
    assignments: [],
    modules: [],
    files: partial.files ?? [],
    pages: [],
    syllabusCandidates: [],
    attachments: partial.attachments ?? [],
    lectures: [],
    ingestion: null,
  };
}

test("formatCourseFilesList renders only the table and footer", () => {
  const output = formatCourseFilesList(
    makeCache({
      attachments: [
        makeAttachment("lab2.zip", 2048),
        makeAttachment("lab1_rubric.pdf", 512),
      ],
    })
  );

  assert.match(output, /^\| Name \| Type \| Size \|/);
  assert.match(output, /\| lab1_rubric\.pdf \| \*\*PDF\*\* \| 512 B \|/);
  assert.match(output, /Use `\/open <name>` to open a file\.$/);
  assert.doesNotMatch(output, /\*\*Files\*\*/);
  assert.doesNotMatch(output, /\*\*PDF\*\* 1/);
  assert.doesNotMatch(output, /Downloaded attachments/i);
});

test("formatCourseFilesList sorts rows naturally by filename", () => {
  const output = formatCourseFilesList(
    makeCache({
      attachments: [
        makeAttachment("lab10.zip"),
        makeAttachment("lab2.zip"),
        makeAttachment("lab1.zip"),
      ],
    })
  );

  const lab1 = output.indexOf("lab1.zip");
  const lab2 = output.indexOf("lab2.zip");
  const lab10 = output.indexOf("lab10.zip");
  assert.ok(lab1 >= 0 && lab2 > lab1 && lab10 > lab2);
});

test("formatCourseFilesList omits canvas index section when empty", () => {
  const output = formatCourseFilesList(
    makeCache({
      attachments: [makeAttachment("notes.pdf")],
      files: [],
    })
  );

  assert.doesNotMatch(output, /Canvas index/i);
});

function makeAttachment(filename: string, size = 100) {
  return {
    sourceType: "important_file" as const,
    canvasFileId: 1,
    originalFilename: filename,
    localPath: `attachments/${filename}`,
    contentType: "application/octet-stream",
    size,
    downloadUrl: "https://example.com/file",
    reason: "test",
    status: "downloaded" as const,
  };
}
