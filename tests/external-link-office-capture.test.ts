// These tests bind real local HTTP servers; they do not patch globalThis.fetch.
import assert from "node:assert/strict";
import http from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import type { Config } from "../src/config/env.js";
import {
  buildGoogleWorkspaceExportRequest,
  captureExternalCourseLinks,
} from "../src/ingest/external-link-capture.js";
import { buildZipBuffer } from "./helpers/build-zip.js";

const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function makeDocx(bodyText: string): Buffer {
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:body>",
    `<w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p>`,
    "</w:body>",
    "</w:document>",
  ].join("");
  return buildZipBuffer([{ name: "word/document.xml", content: documentXml }]);
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
  return buildZipBuffer([{ name: "ppt/slides/slide1.xml", content: slideXml }]);
}

function makeXlsx(): Buffer {
  const workbook =
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Marks" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels =
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  const sheet =
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Weight</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Midterm</t></is></c><c r="B2"><v>0.35</v></c></row></sheetData></worksheet>';
  return buildZipBuffer([
    { name: "xl/workbook.xml", content: workbook },
    { name: "xl/_rels/workbook.xml.rels", content: rels },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ]);
}

function startServer(
  routes: Record<string, { contentType: string; body: Buffer }>
): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? "");
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
        requests,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

function startHangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const server = http.createServer(() => {
      // Intentionally leave the request open until the caller aborts it.
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

const config = { baseUrl: "https://canvas.example.com", accessToken: "tok" } as Config;

function baseOptions(
  overrides: Partial<Parameters<typeof captureExternalCourseLinks>[0]>
): Parameters<typeof captureExternalCourseLinks>[0] {
  return {
    courseId: 1,
    courseHtmlUrl: null,
    modules: [],
    assignments: [],
    frontPageBody: null,
    fetchedPages: [],
    syllabusBody: null,
    announcements: [],
    discussionThreads: [],
    config,
    ...overrides,
  };
}

function assignmentWithDescription(description: string) {
  return {
    id: 10,
    name: "HW3",
    html_url: "https://canvas.example.com/courses/1/assignments/10",
    description,
  } as any;
}

test("captureExternalCourseLinks extracts text from a .docx link", async () => {
  const server = await startServer({
    "/handout.docx": { contentType: DOCX_TYPE, body: makeDocx("Homework guidelines for week 3.") },
  });
  try {
    const result = await captureExternalCourseLinks(
      baseOptions({
        assignments: [assignmentWithDescription(`<a href="${server.url}/handout.docx">Handout</a>`)],
      })
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.entry.contentStatus, "captured");
    assert.ok(
      result[0]!.text.includes("Homework guidelines for week 3"),
      `Expected captured text to contain docx body, got: ${result[0]!.text.slice(0, 200)}`
    );
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks extracts text from a .pptx module link", async () => {
  const server = await startServer({
    "/slides.pptx": {
      contentType: PPTX_TYPE,
      body: makePptx("Lecture 5: Introduction to Sorting Algorithms"),
    },
  });
  try {
    const result = await captureExternalCourseLinks(
      baseOptions({
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
      })
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.entry.contentStatus, "captured");
    assert.ok(
      result[0]!.text.includes("Introduction to Sorting Algorithms"),
      `Expected captured text to contain slide content, got: ${result[0]!.text.slice(0, 200)}`
    );
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks extracts an .xlsx served without an extension by content type", async () => {
  const server = await startServer({
    "/download?id=9": { contentType: XLSX_TYPE, body: makeXlsx() },
  });
  try {
    const result = await captureExternalCourseLinks(
      baseOptions({
        syllabusBody: `<a href="${server.url}/download?id=9">Grade weights</a>`,
      })
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.entry.contentStatus, "captured");
    assert.match(result[0]!.text, /## Sheet: Marks/);
    assert.match(result[0]!.text, /Item: Midterm \| Weight: 0\.35/);
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks falls back to metadata_only for a corrupt Office document", async () => {
  const server = await startServer({
    "/broken.docx": { contentType: DOCX_TYPE, body: Buffer.from("this is not a valid zip") },
  });
  try {
    const result = await captureExternalCourseLinks(
      baseOptions({
        assignments: [assignmentWithDescription(`<a href="${server.url}/broken.docx">Broken doc</a>`)],
      })
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.entry.contentStatus, "metadata_only");
    assert.match(result[0]!.text, /Office document was reachable/);
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks aborts slow external link fetches", async () => {
  const server = await startHangingServer();
  const controller = new AbortController();
  try {
    const pending = captureExternalCourseLinks(
      baseOptions({
        assignments: [
          assignmentWithDescription(`<a href="${server.url}/never">Slow external resource</a>`),
        ],
        signal: controller.signal,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new DOMException("Aborted", "AbortError"));
    await assert.rejects(pending, { name: "AbortError" });
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
    const result = await captureExternalCourseLinks(
      baseOptions({
        frontPageBody: `<p>See policies below:</p><iframe src="${server.url}/embedded-doc" title="Course Policies"></iframe>`,
      })
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.entry.title, "Course Policies");
    assert.equal(result[0]!.entry.contentStatus, "captured");
    assert.ok(
      result[0]!.text.includes("Late submissions lose 10% per day"),
      `Expected captured text to contain iframe content, got: ${result[0]!.text.slice(0, 200)}`
    );
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks deduplicates an iframe and an anchor pointing to the same URL", async () => {
  const server = await startServer({
    "/resource": {
      contentType: "text/html",
      body: Buffer.from(
        "<html><head><title>Resource</title></head><body><p>Unique content here.</p></body></html>"
      ),
    },
  });
  try {
    const result = await captureExternalCourseLinks(
      baseOptions({
        frontPageBody: `<a href="${server.url}/resource">Link</a><iframe src="${server.url}/resource" title="Embed"></iframe>`,
      })
    );
    assert.equal(result.length, 1, "Duplicate iframe+anchor URL should be deduplicated");
    assert.equal(result[0]!.entry.contentStatus, "captured");
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
    const result = await captureExternalCourseLinks(
      baseOptions({
        courseHtmlUrl: "https://canvas.example.com/courses/1",
        fetchedPages: [
          {
            slug: "lecture-resources",
            title: "Lecture Resources",
            body: `<p>Slides:</p><iframe src="${server.url}/slides-preview" title="Lecture Slides"></iframe>`,
          },
        ],
      })
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.entry.title, "Lecture Slides");
    assert.ok(
      result[0]!.entry.sources.some((s: string) => s.includes("Lecture Resources")),
      `Expected source to reference the page, got: ${result[0]!.entry.sources}`
    );
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks captures media caption tracks (.vtt) as transcripts", async () => {
  const server = await startServer({
    "/lecture-captions.vtt": {
      contentType: "text/vtt",
      body: Buffer.from("WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nPipeline hazard walkthrough.\n"),
    },
  });
  try {
    const result = await captureExternalCourseLinks(
      baseOptions({
        frontPageBody: [
          '<video title="Lecture walkthrough">',
          `<track kind="captions" label="English" srclang="en" src="${server.url}/lecture-captions.vtt">`,
          "</video>",
        ].join(""),
      })
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.entry.title, "Captions: English (en)");
    assert.equal(result[0]!.entry.contentStatus, "captured");
    assert.ok(
      result[0]!.text.includes("Pipeline hazard walkthrough"),
      `Expected captured text to contain VTT transcript, got: ${result[0]!.text.slice(0, 200)}`
    );
    assert.deepEqual(result[0]!.entry.sources, ["front page"]);
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks reads .srt subtitles served with a subtitle content type", async () => {
  const server = await startServer({
    "/lecture.srt": {
      contentType: "application/x-subrip",
      body: Buffer.from("1\n00:00:00,000 --> 00:00:03,000\nBranch prediction recap.\n"),
    },
  });
  try {
    const result = await captureExternalCourseLinks(
      baseOptions({
        frontPageBody: `<audio src="${server.url}/lecture.mp3"><track kind="subtitles" src="${server.url}/lecture.srt"></audio>`,
      })
    );
    const srt = result.find((link) => link.entry.url.endsWith("/lecture.srt"));
    assert.ok(srt, "the subtitle track is captured");
    assert.equal(srt.entry.contentStatus, "captured");
    assert.match(srt.text, /Branch prediction recap/);
    assert.equal(srt.entry.title, "Subtitles");
  } finally {
    await server.close();
  }
});

test("captureExternalCourseLinks never fetches Canvas external-tool launch URLs but still captures ordinary external pages", async () => {
  // Canvas answers a tool launch URL with its login page even when the API
  // bearer token is attached, so fetching one would store login HTML under
  // the tool's title. The synthetic "Course tools and external links" page
  // already records the launch links; capture must leave them alone.
  const canvas = await startServer({
    "/courses/1/external_tools/77": {
      contentType: "text/html",
      body: Buffer.from(
        "<html><head><title>Log In to Canvas</title></head><body><form>Email / Password</form></body></html>"
      ),
    },
  });
  const external = await startServer({
    "/piazza-guide": {
      contentType: "text/html",
      body: Buffer.from(
        "<html><head><title>Piazza guide</title></head><body><p>Ask questions in the CS101 Piazza forum.</p></body></html>"
      ),
    },
  });
  try {
    const launchUrl = `${canvas.url}/courses/1/external_tools/77`;
    const result = await captureExternalCourseLinks(
      baseOptions({
        config: { baseUrl: `${canvas.url}/api/v1`, accessToken: "tok" } as Config,
        fetchedPages: [
          {
            slug: "course-tools",
            title: "Course tools and external links",
            body: `<ul><li><strong>Piazza</strong> (Q&amp;A forum) — <a href="${launchUrl}">${launchUrl}</a></li></ul>`,
          },
        ],
        syllabusBody: [
          '<p>Post questions on <a href="/courses/1/external_tools/77">Piazza</a>;',
          `the <a href="${external.url}/piazza-guide">Piazza guide</a> explains how.</p>`,
          `<iframe src="${canvas.url}/courses/1/external_tools/78?display=borderless"></iframe>`,
          `<a href="${canvas.url}/accounts/1/external_tools/5">Account-level tool</a>`,
        ].join(""),
        modules: [
          {
            name: "Week 1",
            items: [
              {
                type: "ExternalTool",
                title: "Piazza",
                externalUrl: null,
                htmlUrl: launchUrl,
                contentId: null,
              },
            ],
          } as any,
        ],
      })
    );
    assert.deepEqual(
      canvas.requests,
      [],
      "no launch URL on the Canvas origin may be requested"
    );
    assert.deepEqual(external.requests, ["/piazza-guide"]);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.entry.title, "Piazza guide");
    assert.equal(result[0]!.entry.contentStatus, "captured");
    assert.match(result[0]!.text, /Ask questions in the CS101 Piazza forum/);
    assert.ok(
      result.every((capture) => !/Log In to Canvas/.test(capture.text)),
      "login HTML must never be stored as captured text"
    );
  } finally {
    await canvas.close();
    await external.close();
  }
});

test("Google Docs, Slides and Sheets links map to their text, pptx and csv export URLs", () => {
  assert.deepEqual(
    buildGoogleWorkspaceExportRequest("https://docs.google.com/document/d/abc123/edit?usp=sharing"),
    {
      url: "https://docs.google.com/document/d/abc123/export?format=txt",
      filename: "google-doc.txt",
      label: "Google Doc",
    }
  );
  assert.deepEqual(
    buildGoogleWorkspaceExportRequest("https://docs.google.com/presentation/u/1/d/deck9/edit#slide=id.p"),
    {
      url: "https://docs.google.com/presentation/d/deck9/export/pptx",
      filename: "google-slides.pptx",
      label: "Google Slides",
    }
  );
  assert.deepEqual(
    buildGoogleWorkspaceExportRequest("https://docs.google.com/spreadsheets/d/sheet7/edit"),
    {
      url: "https://docs.google.com/spreadsheets/d/sheet7/export?format=csv",
      filename: "google-sheet.csv",
      label: "Google Sheet",
    }
  );
  assert.equal(buildGoogleWorkspaceExportRequest("https://docs.google.com/forms/d/f1/viewform"), null);
  assert.equal(buildGoogleWorkspaceExportRequest("https://drive.google.com/file/d/x/view"), null);
});
