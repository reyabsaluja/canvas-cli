import assert from "node:assert/strict";
import test from "node:test";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { formatCourseArtifactMatchLine, searchCourseArtifacts } from "../src/tui/course-retrieval.js";

test("before/after: lecture recordings are course search hits with an openable URL", async () => {
  const cache = {
    courseId: 17, coursePath: "/nonexistent/course", assignments: [], modules: [], files: [], pages: [], syllabusCandidates: [], attachments: [], ingestion: null,
    lectures: [
      { title: "Lecture 5 recording", url: "https://www.youtube.com/embed/abc123", contentType: "video", source: "page: Week 5", lectureNumber: 5, topic: "Caches" },
      { title: "Lecture 6 slides", url: "https://canvas.example/files/77/download", contentType: "slides", source: "module: Week 6", lectureNumber: 6, topic: "Virtual memory" },
    ],
  } as unknown as CourseCache;
  clearArtifactIndexCache();
  try {
    const matches = await searchCourseArtifacts(cache, "lecture 5 recording", { limit: 3 });
    assert.equal(matches[0]?.artifact.kind, "lecture", `got ${matches.map((m) => `${m.artifact.kind}:${m.artifact.title}`).join(" > ")}`);
    assert.equal(matches[0]?.artifact.title, "Lecture 5 recording");
    assert.equal(matches[0]?.artifact.metadata.url, "https://www.youtube.com/embed/abc123");
    assert.match(formatCourseArtifactMatchLine(matches[0]!), /^\[lecture\] Lecture 5 recording/);
    const byTopic = await searchCourseArtifacts(cache, "virtual memory slides", { limit: 3 });
    assert.equal(byTopic[0]?.artifact.title, "Lecture 6 slides", "topic text is indexed too");
  } finally {
    clearArtifactIndexCache();
  }
});
