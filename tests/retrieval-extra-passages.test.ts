import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { getExtractedPagePath } from "../src/enrich/course-documents.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { formatCourseArtifactMatchLine, searchCourseArtifacts } from "../src/tui/course-retrieval.js";

const SYLLABUS = [
  "# Course syllabus",
  "",
  "## Overview",
  "",
  "This course covers computer organization from gates to caches.",
  "",
  "## Late policy",
  "",
  "Late submissions receive a late penalty of ten percent per day for up to three days.",
  "",
  "## Extensions",
  "",
  "Extensions waive the late penalty only when requested before the deadline with documentation.",
  "",
  "## Textbook",
  "",
  "Patterson and Hennessy.",
].join("\n");

test("before/after: a course hit lists the other sections that also match, not just the best one", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-extra-passages-"));
  try {
    const coursePath = path.join(tempDir, "course");
    const filePath = getExtractedPagePath(coursePath, "syllabus");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, SYLLABUS, "utf-8");
    const cache = {
      courseId: 17, coursePath, assignments: [], modules: [], files: [], syllabusCandidates: [], attachments: [], lectures: [], ingestion: null,
      pages: [{ pageId: "syllabus", title: "Course syllabus", htmlUrl: null, updatedAt: "2026-04-01T12:00:00.000Z", hasBody: true }],
    } as unknown as CourseCache;
    clearArtifactIndexCache();
    const [match] = await searchCourseArtifacts(cache, "late penalty", { limit: 3 });
    assert.ok(match, "syllabus matches");
    const labels = [match.passage?.section, ...match.morePassages.map((p) => p.section)];
    assert.ok(labels.includes("Late policy") && labels.includes("Extensions"), `expected both sections, got ${labels.join(" | ")}`);
    assert.ok(!labels.includes("Textbook"), "unrelated sections are not listed");
    const line = formatCourseArtifactMatchLine(match);
    assert.match(line, /also — (Late policy|Extensions):/);
  } finally {
    clearArtifactIndexCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
