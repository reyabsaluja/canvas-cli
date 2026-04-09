import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLectureNumber,
  isLectureLikeTitle,
  classifyContentType,
  parseHtmlLinks,
  buildLectureIndex,
  handleLectureQuery,
} from "../src/tui/lecture-resources.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import type {
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
  DownloadedAttachmentEntry,
} from "../src/ingest/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCache(overrides: Partial<CourseCache> = {}): CourseCache {
  return {
    courseId: 1,
    coursePath: "/tmp/test-course",
    assignments: [],
    modules: [],
    files: [],
    pages: [],
    syllabusCandidates: [],
    attachments: [],
    ingestion: null,
    ...overrides,
  };
}

function makeModule(overrides: Partial<ModuleIndexEntry> = {}): ModuleIndexEntry {
  return {
    id: 1,
    name: "Week 1",
    position: 1,
    itemCount: 0,
    items: [],
    ...overrides,
  };
}

function makeFile(overrides: Partial<FileIndexEntry> = {}): FileIndexEntry {
  return {
    id: 100,
    displayName: "lecture1.pdf",
    filename: "lecture1.pdf",
    contentType: "application/pdf",
    size: 1000,
    url: "https://canvas.example.com/files/100/download",
    updatedAt: null,
    folderId: null,
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<DownloadedAttachmentEntry> = {}): DownloadedAttachmentEntry {
  return {
    sourceType: "module_linked",
    canvasFileId: null,
    originalFilename: "lecture1.pdf",
    localPath: "attachments/lecture1.pdf",
    contentType: "application/pdf",
    size: 1000,
    downloadUrl: "https://canvas.example.com/files/100/download",
    reason: "module linked",
    status: "downloaded",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractLectureNumber
// ---------------------------------------------------------------------------

test("extractLectureNumber: 'Lecture 13' returns 13", () => {
  assert.equal(extractLectureNumber("Lecture 13"), 13);
});

test("extractLectureNumber: 'lec7 slides' returns 7", () => {
  assert.equal(extractLectureNumber("lec7 slides"), 7);
});

test("extractLectureNumber: 'Lec-02-Recording' returns 2", () => {
  assert.equal(extractLectureNumber("Lec-02-Recording"), 2);
});

test("extractLectureNumber: 'Week 5 Materials' returns 5", () => {
  assert.equal(extractLectureNumber("Week 5 Materials"), 5);
});

test("extractLectureNumber: 'Class 10' returns 10", () => {
  assert.equal(extractLectureNumber("Class 10"), 10);
});

test("extractLectureNumber: 'Lecture.4.pdf' returns 4", () => {
  assert.equal(extractLectureNumber("Lecture.4.pdf"), 4);
});

test("extractLectureNumber: title with no lecture number returns null", () => {
  assert.equal(extractLectureNumber("Midterm Review"), null);
});

test("extractLectureNumber: 'lecture_15' returns 15", () => {
  assert.equal(extractLectureNumber("lecture_15"), 15);
});

// ---------------------------------------------------------------------------
// isLectureLikeTitle
// ---------------------------------------------------------------------------

test("isLectureLikeTitle: 'Lecture 13 Slides' is true", () => {
  assert.equal(isLectureLikeTitle("Lecture 13 Slides"), true);
});

test("isLectureLikeTitle: 'Recording from Feb 5' is true", () => {
  assert.equal(isLectureLikeTitle("Recording from Feb 5"), true);
});

test("isLectureLikeTitle: 'Lab 3 Submission' is false", () => {
  assert.equal(isLectureLikeTitle("Lab 3 Submission"), false);
});

test("isLectureLikeTitle: 'video-lec01' is true", () => {
  assert.equal(isLectureLikeTitle("video-lec01"), true);
});

test("isLectureLikeTitle: 'Slide Deck' is true", () => {
  assert.equal(isLectureLikeTitle("Slide Deck"), true);
});

test("isLectureLikeTitle: 'presentation materials' is true", () => {
  assert.equal(isLectureLikeTitle("presentation materials"), true);
});

// ---------------------------------------------------------------------------
// classifyContentType
// ---------------------------------------------------------------------------

test("classifyContentType: YouTube URL is video", () => {
  assert.equal(classifyContentType("https://youtube.com/watch?v=abc"), "video");
});

test("classifyContentType: youtu.be URL is video", () => {
  assert.equal(classifyContentType("https://youtu.be/abc123"), "video");
});

test("classifyContentType: Zoom URL is video", () => {
  assert.equal(classifyContentType("https://zoom.us/rec/share/abc"), "video");
});

test("classifyContentType: Panopto URL is video", () => {
  assert.equal(classifyContentType("https://school.hosted.panopto.com/Panopto/Pages/Viewer.aspx"), "video");
});

test("classifyContentType: .pdf filename is slides", () => {
  assert.equal(classifyContentType(null, "lecture13.pdf"), "slides");
});

test("classifyContentType: .pptx filename is slides", () => {
  assert.equal(classifyContentType(null, "slides.pptx"), "slides");
});

test("classifyContentType: .mp4 filename is video", () => {
  assert.equal(classifyContentType(null, "lecture.mp4"), "video");
});

test("classifyContentType: Canvas page URL is page", () => {
  assert.equal(classifyContentType("https://canvas.example.com/courses/1/pages/lecture-1"), "page");
});

test("classifyContentType: unknown returns unknown", () => {
  assert.equal(classifyContentType("https://example.com/something"), "unknown");
});

// ---------------------------------------------------------------------------
// parseHtmlLinks
// ---------------------------------------------------------------------------

test("parseHtmlLinks: extracts links from anchor tags", () => {
  const html = `
    <a href="https://youtube.com/watch?v=abc">Lecture 1 Video</a>
    <a href="https://example.com/slides.pdf">Lecture 1 Slides</a>
  `;
  const links = parseHtmlLinks(html);
  assert.equal(links.length, 2);
  assert.equal(links[0]!.href, "https://youtube.com/watch?v=abc");
  assert.equal(links[0]!.text, "Lecture 1 Video");
  assert.equal(links[1]!.href, "https://example.com/slides.pdf");
  assert.equal(links[1]!.text, "Lecture 1 Slides");
});

test("parseHtmlLinks: strips nested HTML tags from text", () => {
  const html = `<a href="https://example.com"><strong>Bold Link</strong></a>`;
  const links = parseHtmlLinks(html);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.text, "Bold Link");
});

test("parseHtmlLinks: handles empty href or text", () => {
  const html = `<a href="">Empty</a><a href="http://x.com"> </a>`;
  const links = parseHtmlLinks(html);
  assert.equal(links.length, 0);
});

test("parseHtmlLinks: can be called multiple times (lastIndex reset)", () => {
  const html = `<a href="http://a.com">A</a>`;
  const links1 = parseHtmlLinks(html);
  const links2 = parseHtmlLinks(html);
  assert.equal(links1.length, 1);
  assert.equal(links2.length, 1);
});

// ---------------------------------------------------------------------------
// buildLectureIndex
// ---------------------------------------------------------------------------

test("buildLectureIndex: extracts lecture from module ExternalUrl item", () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 10,
            title: "Lecture 1 Recording",
            type: "ExternalUrl",
            position: 1,
            contentId: null,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: "https://youtube.com/watch?v=abc",
          },
        ],
      }),
    ],
  });
  const lectures = buildLectureIndex(cache);
  assert.equal(lectures.length, 1);
  assert.equal(lectures[0]!.title, "Lecture 1 Recording");
  assert.equal(lectures[0]!.kind, "lecture video");
  assert.equal(lectures[0]!.target, "https://youtube.com/watch?v=abc");
});

test("buildLectureIndex: extracts lecture from module File item with download", () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 11,
            title: "Lecture 3 Slides.pdf",
            type: "File",
            position: 1,
            contentId: 200,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: null,
          },
        ],
      }),
    ],
    attachments: [
      makeAttachment({
        canvasFileId: 200,
        originalFilename: "Lecture 3 Slides.pdf",
        localPath: "attachments/Lecture 3 Slides.pdf",
        status: "downloaded",
      }),
    ],
  });
  const lectures = buildLectureIndex(cache);
  assert.equal(lectures.length, 1);
  assert.equal(lectures[0]!.kind, "lecture slides");
  assert.equal(lectures[0]!.targetType, "file");
  assert.ok(lectures[0]!.target.endsWith("Lecture 3 Slides.pdf"));
});

test("buildLectureIndex: extracts lecture from module File item without download (falls back to URL)", () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 12,
            title: "Lecture 5 Slides.pdf",
            type: "File",
            position: 1,
            contentId: 300,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: null,
          },
        ],
      }),
    ],
    files: [
      makeFile({ id: 300, displayName: "Lecture 5 Slides.pdf", url: "https://canvas.example.com/files/300/download" }),
    ],
  });
  const lectures = buildLectureIndex(cache);
  assert.equal(lectures.length, 1);
  assert.equal(lectures[0]!.targetType, "url");
  assert.equal(lectures[0]!.target, "https://canvas.example.com/files/300/download");
});

test("buildLectureIndex: extracts lecture from module Page item", () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 13,
            title: "Lecture 2 Notes",
            type: "Page",
            position: 1,
            contentId: null,
            pageUrl: "lecture-2-notes",
            htmlUrl: "https://canvas.example.com/courses/1/pages/lecture-2-notes",
            externalUrl: null,
          },
        ],
      }),
    ],
    pages: [
      {
        pageId: "lecture-2-notes",
        title: "Lecture 2 Notes",
        htmlUrl: "https://canvas.example.com/courses/1/pages/lecture-2-notes",
        updatedAt: null,
        hasBody: true,
      },
    ],
  });
  const lectures = buildLectureIndex(cache);
  assert.equal(lectures.length, 1);
  assert.equal(lectures[0]!.kind, "lecture page");
});

test("buildLectureIndex: extracts standalone files matching lecture patterns", () => {
  const cache = makeCache({
    files: [
      makeFile({ id: 400, displayName: "lec10-slides.pdf", filename: "lec10-slides.pdf" }),
      makeFile({ id: 401, displayName: "homework3.pdf", filename: "homework3.pdf" }),
    ],
  });
  const lectures = buildLectureIndex(cache);
  assert.equal(lectures.length, 1);
  assert.equal(lectures[0]!.title, "lec10-slides.pdf");
  assert.equal(lectures[0]!.kind, "lecture slides");
});

test("buildLectureIndex: deduplicates by target", () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 14,
            title: "Lecture 1 Video",
            type: "ExternalUrl",
            position: 1,
            contentId: null,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: "https://youtube.com/watch?v=abc",
          },
          {
            id: 15,
            title: "Lecture 1 Recording",
            type: "ExternalUrl",
            position: 2,
            contentId: null,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: "https://youtube.com/watch?v=abc",
          },
        ],
      }),
    ],
  });
  const lectures = buildLectureIndex(cache);
  assert.equal(lectures.length, 1);
});

test("buildLectureIndex: skips non-lecture module items", () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 16,
            title: "Homework 3",
            type: "ExternalUrl",
            position: 1,
            contentId: null,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: "https://example.com/hw3",
          },
        ],
      }),
    ],
  });
  const lectures = buildLectureIndex(cache);
  assert.equal(lectures.length, 0);
});

test("buildLectureIndex: skips standalone files that are not slides or video", () => {
  const cache = makeCache({
    files: [
      makeFile({ id: 500, displayName: "lecture1.zip", filename: "lecture1.zip", contentType: "application/zip" }),
    ],
  });
  const lectures = buildLectureIndex(cache);
  assert.equal(lectures.length, 0);
});

// ---------------------------------------------------------------------------
// handleLectureQuery
// ---------------------------------------------------------------------------

test("handleLectureQuery: returns missing when no cache", async () => {
  const result = await handleLectureQuery("", null);
  assert.equal(result.status, "missing");
  assert.ok(result.message.includes("No course cache"));
});

test("handleLectureQuery: empty query lists all lectures", async () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 20,
            title: "Lecture 1 Recording",
            type: "ExternalUrl",
            position: 1,
            contentId: null,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: "https://youtube.com/watch?v=abc",
          },
          {
            id: 21,
            title: "Lecture 2 Slides.pdf",
            type: "File",
            position: 2,
            contentId: 600,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: null,
          },
        ],
      }),
    ],
    files: [
      makeFile({ id: 600, displayName: "Lecture 2 Slides.pdf", url: "https://canvas.example.com/files/600" }),
    ],
  });
  const result = await handleLectureQuery("", cache);
  assert.equal(result.status, "listed");
  assert.ok(result.message.includes("Lectures"));
  assert.ok(result.message.includes("Lecture 1 Recording"));
  assert.ok(result.message.includes("Lecture 2 Slides.pdf"));
});

test("handleLectureQuery: returns missing when no lectures found", async () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 30,
            title: "Homework 1",
            type: "ExternalUrl",
            position: 1,
            contentId: null,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: "https://example.com/hw1",
          },
        ],
      }),
    ],
  });
  const result = await handleLectureQuery("1", cache);
  assert.equal(result.status, "missing");
  assert.ok(result.message.includes("No lecture content"));
});

test("handleLectureQuery: query that does not match shows available lectures", async () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 40,
            title: "Lecture 1 Video",
            type: "ExternalUrl",
            position: 1,
            contentId: null,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: "https://youtube.com/watch?v=abc",
          },
        ],
      }),
    ],
  });
  const result = await handleLectureQuery("99", cache);
  assert.equal(result.status, "missing");
  assert.ok(result.message.includes("No lecture matched"));
  assert.ok(result.message.includes("Available lectures"));
});

test("handleLectureQuery: search terms include lecture number aliases", () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 50,
            title: "Lecture 13 Recording",
            type: "ExternalUrl",
            position: 1,
            contentId: null,
            pageUrl: null,
            htmlUrl: null,
            externalUrl: "https://youtube.com/watch?v=abc13",
          },
        ],
      }),
    ],
  });
  const lectures = buildLectureIndex(cache);
  assert.equal(lectures.length, 1);
  const terms = lectures[0]!.searchTerms;
  assert.ok(terms.includes("13"));
  assert.ok(terms.includes("lecture 13"));
  assert.ok(terms.includes("lec 13"));
  assert.ok(terms.includes("lec13"));
});

test("buildLectureIndex: module fallback htmlUrl for items with no specific target", () => {
  const cache = makeCache({
    modules: [
      makeModule({
        items: [
          {
            id: 60,
            title: "Lecture 7 Materials",
            type: "ExternalTool",
            position: 1,
            contentId: null,
            pageUrl: null,
            htmlUrl: "https://canvas.example.com/courses/1/modules/items/60",
            externalUrl: null,
          },
        ],
      }),
    ],
  });
  const lectures = buildLectureIndex(cache);
  assert.equal(lectures.length, 1);
  assert.equal(lectures[0]!.target, "https://canvas.example.com/courses/1/modules/items/60");
});
