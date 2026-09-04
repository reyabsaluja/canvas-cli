import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasFileIdFromUrl,
  extractLinkedFileFromUrl,
  extractLinkedFiles,
} from "../src/workspace/attachments.js";

const BASE = "https://canvas.example/api/v1";

function summarize(files: ReturnType<typeof extractLinkedFiles>) {
  return files.map((file) => ({
    title: file.title,
    url: file.url,
    downloadUrl: file.downloadUrl,
  }));
}

test("extractLinkedFiles with a Canvas base keeps Canvas-origin file links from anchors and embeds and drops other hosts", () => {
  const files = extractLinkedFiles(
    [
      '<a class="instructure_file_link" title="evil.txt" href="https://attacker.example/files/123?verifier=steal">Evil</a>',
      '<a class="instructure_file_link" title="starter.txt" href="/courses/17/files/77?wrap=1&amp;verifier=abc">Starter</a>',
      '<iframe title="rubric.pdf" src="https://canvas.example/files/88?wrap=1"></iframe>',
    ].join(""),
    BASE
  );

  assert.deepEqual(summarize(files), [
    {
      title: "starter.txt",
      url: "https://canvas.example/courses/17/files/77?wrap=1&verifier=abc",
      downloadUrl: "https://canvas.example/courses/17/files/77/download?verifier=abc",
    },
    {
      title: "rubric.pdf",
      url: "https://canvas.example/files/88?wrap=1",
      downloadUrl: "https://canvas.example/files/88/download",
    },
  ]);
});

test("extractLinkedFiles finds Canvas files embedded through src, data, data-src and data-download-url", () => {
  const files = extractLinkedFiles(
    [
      '<embed src="/courses/17/files/101/preview" type="application/pdf" title="Week 1 notes.pdf">',
      '<object data="/courses/17/files/102?wrap=1" aria-label="Datasheet.pdf"></object>',
      '<img data-src="/courses/17/files/103/preview" alt="Circuit diagram.png">',
      '<div data-download-url="/courses/17/files/104/download?download_frd=1"></div>',
      '<img src="https://cdn.example/images/logo.png">',
    ].join(""),
    BASE
  );

  assert.deepEqual(summarize(files), [
    {
      title: "Week 1 notes.pdf",
      url: "https://canvas.example/courses/17/files/101/preview",
      downloadUrl: "https://canvas.example/courses/17/files/101/download",
    },
    {
      title: "Datasheet.pdf",
      url: "https://canvas.example/courses/17/files/102?wrap=1",
      downloadUrl: "https://canvas.example/courses/17/files/102/download",
    },
    {
      title: "Circuit diagram.png",
      url: "https://canvas.example/courses/17/files/103/preview",
      downloadUrl: "https://canvas.example/courses/17/files/103/download",
    },
    {
      title: "file-104",
      url: "https://canvas.example/courses/17/files/104/download?download_frd=1",
      downloadUrl: "https://canvas.example/courses/17/files/104/download?download_frd=1",
    },
  ]);
});

test("extractLinkedFiles dedups one file linked several ways and prefers the richest title", () => {
  const files = extractLinkedFiles(
    [
      '<a href="/courses/17/files/77?wrap=1">Download</a>',
      '<a class="instructure_file_link" title="lab2.pdf" href="https://canvas.example/courses/17/files/77/download?verifier=abc">lab2.pdf</a>',
      '<iframe src="/courses/17/files/77/preview"></iframe>',
    ].join(""),
    BASE
  );

  assert.equal(files.length, 1);
  assert.equal(files[0]!.title, "lab2.pdf");
});

test("extractLinkedFiles falls back to the anchor label, then file-<id>, when there is no title", () => {
  const files = extractLinkedFiles(
    [
      '<a href="/courses/17/files/1">Lecture 3 slides.pdf</a>',
      '<a href="/courses/17/files/2"><img src="x.png"></a>',
      '<a href="/courses/17/files/3">https://canvas.example/courses/17/files/3</a>',
    ].join(""),
    BASE
  );

  assert.deepEqual(
    files.map((file) => file.title),
    ["Lecture 3 slides.pdf", "file-2", "file-3"]
  );
});

test("extractLinkedFiles ignores Canvas links that are not files and non-http schemes", () => {
  const files = extractLinkedFiles(
    [
      '<a href="/courses/17/pages/week-1">Week 1</a>',
      '<a href="/courses/17/files">All files</a>',
      '<a href="/api/v1/courses/17/files/77">API</a>',
      '<a href="mailto:ta@example.edu">TA</a>',
      '<a href="#files/77">anchor</a>',
      '<a href="javascript:void(0)">js</a>',
    ].join(""),
    BASE
  );

  assert.deepEqual(files, []);
});

test("extractLinkedFiles without a base is permissive: absolute links of any host and relative Canvas paths are kept", () => {
  const files = extractLinkedFiles(
    [
      '<a class="instructure_file_link" title="starter.txt" href="https://other-canvas.example/courses/17/files/77?wrap=1&amp;verifier=abc">Starter</a>',
      '<a href="/courses/17/files/78?wrap=1">Handout</a>',
      '<iframe src="/files/79/preview" title="embedded.pdf"></iframe>',
      '<a href="/courses/17/pages/week-1">Not a file</a>',
      '<img src="cat.png">',
    ].join("")
  );

  assert.deepEqual(summarize(files), [
    {
      title: "starter.txt",
      url: "https://other-canvas.example/courses/17/files/77?wrap=1&verifier=abc",
      downloadUrl: "https://other-canvas.example/courses/17/files/77/download?verifier=abc",
    },
    {
      title: "Handout",
      url: "/courses/17/files/78?wrap=1",
      downloadUrl: "/courses/17/files/78/download",
    },
    {
      title: "embedded.pdf",
      url: "/files/79/preview",
      downloadUrl: "/files/79/download",
    },
  ]);
});

test("extractLinkedFileFromUrl resolves module item URLs that are really Canvas files", () => {
  assert.deepEqual(
    extractLinkedFileFromUrl("/courses/17/files/77?wrap=1", "Lab 2 handout", BASE),
    {
      title: "Lab 2 handout",
      url: "https://canvas.example/courses/17/files/77?wrap=1",
      downloadUrl: "https://canvas.example/courses/17/files/77/download",
    }
  );
  assert.deepEqual(
    extractLinkedFileFromUrl("https://canvas.example/files/88/download?download_frd=1", null, BASE),
    {
      title: "file-88",
      url: "https://canvas.example/files/88/download?download_frd=1",
      downloadUrl: "https://canvas.example/files/88/download?download_frd=1",
    }
  );
  // Off-origin with a base: dropped at extraction time.
  assert.equal(
    extractLinkedFileFromUrl("https://attacker.example/courses/17/files/77", "evil.txt", BASE),
    null
  );
  // Not a file URL at all.
  assert.equal(extractLinkedFileFromUrl("https://example.edu/reading.pdf", "Reading", BASE), null);
  assert.equal(extractLinkedFileFromUrl("https://canvas.example/courses/17/pages/x", null, BASE), null);
  // No base: relative Canvas-shaped paths are kept rather than silently dropped.
  assert.deepEqual(extractLinkedFileFromUrl("/courses/17/files/77", "starter.txt"), {
    title: "starter.txt",
    url: "/courses/17/files/77",
    downloadUrl: "/courses/17/files/77/download",
  });
});

test("canvasFileIdFromUrl reads the file id from Canvas file URLs only", () => {
  assert.equal(canvasFileIdFromUrl("https://canvas.example/courses/17/files/77?wrap=1", BASE), 77);
  assert.equal(canvasFileIdFromUrl("/files/88/download", BASE), 88);
  assert.equal(canvasFileIdFromUrl("https://attacker.example/files/77", BASE), null);
  assert.equal(canvasFileIdFromUrl("https://canvas.example/courses/17/modules/3", BASE), null);
  assert.equal(canvasFileIdFromUrl(null, BASE), null);
});
