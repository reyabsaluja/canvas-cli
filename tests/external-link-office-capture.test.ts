import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { captureExternalCourseLinks } from "../src/ingest/external-link-capture.js";
import { buildZipBuffer } from "./helpers/build-zip.js";
import type { Config } from "../src/config/env.js";

function makeDocx(bodyText: string): Buffer {
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:body>",
    `<w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p>`,
    "</w:body>",
    "</w:document>",
  ].join("");

  return buildZipBuffer([
    { name: "word/document.xml", content: documentXml },
  ]);
}

function makePptx(slideText: string): Buffer {
  const slideXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    "<p:cSld><p:spTree>",
    `<p:sp><p:txBody><a:p><a:r><a:t>${slideText}</a:t></a:r></a:p></p:txBody></p:sp>`,
    "</p:spTree></p:cSld>",
    "</p:sld>",
  ].join("");

  return buildZipBuffer([
    { name: "ppt/slides/slide1.xml", content: slideXml },
  ]);
}

function startServer(
  routes: Record<string, { contentType: string; body: Buffer }>
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url ?? ""];
      if (!route) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": route.contentType });
      res.end(route.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("captureExternalCourseLinks extracts text from a .docx link", async () => {
  const docxBody = makeDocx("Homework guidelines for week 3.");
  const server = await startServer({
    "/handout.docx": {
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      body: docxBody,
    },
  });

  try {
    const result = await captureExternalCourseLinks({
      courseId: 1,
      courseHtmlUrl: null,
      modules: [],
      assignments: [
        {
          id: 10,
          name: "HW3",
          html_url: "https://canvas.example.com/courses/1/assignments/10",
          description: `<a href="${server.url}/handout.docx">Handout</a>`,
        } as any,
      ],
      quizzes: [],
      calendarEvents: [],
      frontPageBody: null,
      fetchedPages: [],
      syllabusBody: null,
      announcementThreads: [],
      discussionThreads: [],
      config: { baseUrl: "https://canvas.example.com", accessToken: "tok" } as Config,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].entry.contentStatus, "captured");
    assert.ok(
      result[0].text.includes("Homework guidelines for week 3"),
      `Expected captured text to contain docx body, got: ${result[0].text.slice(0, 200)}`
    );
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks extracts text from a .pptx link", async () => {
  const pptxBody = makePptx("Lecture 5: Introduction to Sorting Algorithms");
  const server = await startServer({
    "/slides.pptx": {
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      body: pptxBody,
    },
  });

  try {
    const result = await captureExternalCourseLinks({
      courseId: 1,
      courseHtmlUrl: null,
      modules: [
        {
          name: "Week 5",
          items: [
            {
              type: "ExternalUrl",
              title: "Lecture Slides",
              externalUrl: `${server.url}/slides.pptx`,
              htmlUrl: null,
              contentId: null,
            },
          ],
        } as any,
      ],
      assignments: [],
      quizzes: [],
      calendarEvents: [],
      frontPageBody: null,
      fetchedPages: [],
      syllabusBody: null,
      announcementThreads: [],
      discussionThreads: [],
      config: { baseUrl: "https://canvas.example.com", accessToken: "tok" } as Config,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].entry.contentStatus, "captured");
    assert.ok(
      result[0].text.includes("Introduction to Sorting Algorithms"),
      `Expected captured text to contain slide content, got: ${result[0].text.slice(0, 200)}`
    );
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks falls back to metadata_only for corrupt Office document", async () => {
  const server = await startServer({
    "/broken.docx": {
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      body: Buffer.from("this is not a valid zip"),
    },
  });

  try {
    const result = await captureExternalCourseLinks({
      courseId: 1,
      courseHtmlUrl: null,
      modules: [],
      assignments: [
        {
          id: 20,
          name: "HW4",
          html_url: "https://canvas.example.com/courses/1/assignments/10",
          description: `<a href="${server.url}/broken.docx">Broken doc</a>`,
        } as any,
      ],
      quizzes: [],
      calendarEvents: [],
      frontPageBody: null,
      fetchedPages: [],
      syllabusBody: null,
      announcementThreads: [],
      discussionThreads: [],
      config: { baseUrl: "https://canvas.example.com", accessToken: "tok" } as Config,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].entry.contentStatus, "metadata_only");
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks captures URLs from iframe src attributes", async () => {
  const server = await startServer({
    "/embedded-doc": {
      contentType: "text/html",
      body: Buffer.from(
        "<html><head><title>Course Policies</title></head><body><p>Late submissions lose 10% per day.</p></body></html>"
      ),
    },
  });

  try {
    const result = await captureExternalCourseLinks({
      courseId: 1,
      courseHtmlUrl: null,
      modules: [],
      assignments: [],
      quizzes: [],
      calendarEvents: [],
      frontPageBody: `<p>See policies below:</p><iframe src="${server.url}/embedded-doc" title="Course Policies"></iframe>`,
      fetchedPages: [],
      syllabusBody: null,
      announcementThreads: [],
      discussionThreads: [],
      config: { baseUrl: "https://canvas.example.com", accessToken: "tok" } as Config,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].entry.title, "Course Policies");
    assert.equal(result[0].entry.contentStatus, "captured");
    assert.ok(
      result[0].text.includes("Late submissions lose 10% per day"),
      `Expected captured text to contain iframe content, got: ${result[0].text.slice(0, 200)}`
    );
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks deduplicates iframe and anchor pointing to same URL", async () => {
  const server = await startServer({
    "/resource": {
      contentType: "text/html",
      body: Buffer.from(
        "<html><head><title>Resource</title></head><body><p>Unique content here.</p></body></html>"
      ),
    },
  });

  try {
    const result = await captureExternalCourseLinks({
      courseId: 1,
      courseHtmlUrl: null,
      modules: [],
      assignments: [],
      quizzes: [],
      calendarEvents: [],
      frontPageBody: `<a href="${server.url}/resource">Link</a><iframe src="${server.url}/resource" title="Embed"></iframe>`,
      fetchedPages: [],
      syllabusBody: null,
      announcementThreads: [],
      discussionThreads: [],
      config: { baseUrl: "https://canvas.example.com", accessToken: "tok" } as Config,
    });

    assert.equal(result.length, 1, "Duplicate iframe+anchor URL should be deduplicated");
    assert.equal(result[0].entry.contentStatus, "captured");
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks captures iframe embeds from fetched pages", async () => {
  const server = await startServer({
    "/slides-preview": {
      contentType: "text/html",
      body: Buffer.from(
        "<html><head><title>Lecture Slides</title></head><body><p>Slide 1: Introduction to Algorithms</p></body></html>"
      ),
    },
  });

  try {
    const result = await captureExternalCourseLinks({
      courseId: 1,
      courseHtmlUrl: "https://canvas.example.com/courses/1",
      modules: [],
      assignments: [],
      quizzes: [],
      calendarEvents: [],
      frontPageBody: null,
      fetchedPages: [
        {
          slug: "lecture-resources",
          title: "Lecture Resources",
          body: `<p>Slides:</p><iframe src="${server.url}/slides-preview" title="Lecture Slides"></iframe>`,
        },
      ],
      syllabusBody: null,
      announcementThreads: [],
      discussionThreads: [],
      config: { baseUrl: "https://canvas.example.com", accessToken: "tok" } as Config,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].entry.title, "Lecture Slides");
    assert.ok(
      result[0].entry.sources.some((s: string) => s.includes("Lecture Resources")),
      `Expected source to reference the page, got: ${result[0].entry.sources}`
    );
  } finally {
    await server.close();
  }
});
