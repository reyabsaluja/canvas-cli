import assert from "node:assert/strict";
import test from "node:test";
import { discoverLectures, extractEmbeddedMedia } from "../src/ingest/lecture-discovery.js";

const WEEK5_PAGE = {
  slug: "week-5",
  title: "Week 5",
  body: [
    "<h2>Week 5: Caches</h2>",
    '<p>Watch before class:</p>',
    '<iframe title="Lecture 5 recording" src="https://www.youtube.com/embed/abc123?rel=0" width="560" height="315" allowfullscreen></iframe>',
    '<p>Panopto backup:</p>',
    '<iframe src="https://utoronto.hosted.panopto.com/Panopto/Pages/Embed.aspx?id=9f2e" allow="autoplay"></iframe>',
    '<video controls data-title="Cache demo"><source src="/courses/17/files/501/download?verifier=x" type="video/mp4"></video>',
    '<a class="instructure_video_link" href="/courses/17/media_objects/m-77/">Office hours clip</a>',
    '<iframe src="https://calendar.google.com/calendar/embed?src=x"></iframe>',
  ].join("\n"),
};

test("before: link-only discovery finds nothing in a page whose recordings are embedded", () => {
  const anchorsOnly = WEEK5_PAGE.body.replace(/<iframe[\s\S]*?<\/iframe>/gi, "").replace(/<video[\s\S]*?<\/video>/gi, "");
  const entries = discoverLectures([], [], null, [{ ...WEEK5_PAGE, body: anchorsOnly }], null, []);
  assert.equal(entries.filter((entry) => entry.contentType === "video" && /youtube|panopto/.test(entry.url)).length, 0);
});

test("embedded recordings become video lecture entries with titles, hosts, and lecture numbers", () => {
  const entries = discoverLectures([], [], null, [WEEK5_PAGE], null, []);
  const youtube = entries.find((entry) => entry.url.includes("youtube.com/embed/abc123"));
  assert.ok(youtube, "YouTube iframe captured");
  assert.equal(youtube.title, "Lecture 5 recording");
  assert.equal(youtube.contentType, "video");
  assert.equal(youtube.lectureNumber, 5);
  assert.equal(youtube.source, "page: Week 5");

  const panopto = entries.find((entry) => entry.url.includes("panopto.com"));
  assert.ok(panopto, "untitled Panopto iframe captured");
  assert.equal(panopto.title, "Week 5 — Panopto recording");
  assert.equal(panopto.lectureNumber, 5, "lecture number inferred from the page title");

  const demo = entries.find((entry) => entry.url.includes("/files/501/download"));
  assert.ok(demo, "<video><source> captured");
  assert.equal(demo.title, "Cache demo");

  const clip = entries.find((entry) => entry.url.includes("/media_objects/m-77/"));
  assert.ok(clip, "Canvas media anchor captured");
  assert.equal(clip.title, "Office hours clip");

  assert.ok(!entries.some((entry) => entry.url.includes("calendar.google.com")), "non-media iframes are ignored");
});

test("extraHtml bodies (announcements, assignments) are scanned too, and duplicates collapse", () => {
  const announcement = {
    title: "Lecture 3 recording posted",
    source: "announcement: Lecture 3 recording posted",
    body: '<p>Here it is:</p><iframe src="https://www.youtube.com/embed/lec3"></iframe>',
  };
  const entries = discoverLectures([], [], null, [], null, [], [announcement, announcement]);
  const hits = entries.filter((entry) => entry.url.includes("youtube.com/embed/lec3"));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.lectureNumber, 3);
  assert.equal(hits[0]!.source, "announcement: Lecture 3 recording posted");
});

test("extractEmbeddedMedia skips javascript/data URLs and protocol-relative sources get https", () => {
  const html = '<iframe src="//player.vimeo.com/video/1"></iframe><iframe src="javascript:void(0)"></iframe>';
  const entries = extractEmbeddedMedia(html, "page: X", "Week 2");
  assert.deepEqual(entries.map((entry) => entry.url), ["https://player.vimeo.com/video/1"]);
  assert.equal(entries[0]!.lectureNumber, 2);
});
