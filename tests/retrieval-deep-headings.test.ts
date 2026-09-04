import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { getExtractedPagePath } from "../src/enrich/course-documents.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { searchCourseArtifacts } from "../src/tui/course-retrieval.js";

// html-to-text and office-text emit headings down to `#####`/`######`
// (h5/h6, deep DOCX outline levels), so the splitter must treat them as
// section boundaries instead of folding them into the previous section.
const PAGE = [
  "# Lab 3 reference",
  "",
  "## Setup",
  "",
  "Install the toolchain and clone the starter repository before the first lab session.",
  "",
  "#### Board configuration",
  "",
  "Set the jumper to 3.3V mode before powering the board.",
  "",
  "##### Calibration thresholds",
  "",
  "The threshold voltage must be set to 1.8V so the comparator triggers reliably on the rising edge.",
  "",
  "##### Cache policy",
  "",
  "The cache exercise uses a write-back policy with LRU replacement across four ways.",
].join("\n");

test("before/after: h5 headings are section boundaries in course search", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-deep-headings-"));
  try {
    const coursePath = path.join(tempDir, "course");
    const filePath = getExtractedPagePath(coursePath, "lab3-reference");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, PAGE, "utf-8");
    const cache = {
      courseId: 17, coursePath, assignments: [], modules: [], files: [], syllabusCandidates: [], attachments: [], lectures: [], ingestion: null,
      pages: [{ pageId: "lab3-reference", title: "Lab 3 reference", htmlUrl: null, updatedAt: "2026-04-01T12:00:00.000Z", hasBody: true }],
    } as unknown as CourseCache;
    clearArtifactIndexCache();
    const [match] = await searchCourseArtifacts(cache, "threshold voltage", { limit: 3 });
    assert.ok(match, "page matches");
    assert.equal(match.passage?.section, "Calibration thresholds");
    const excerpt = match.passage?.excerpt ?? "";
    assert.doesNotMatch(excerpt, /cache exercise/, "the next h5 section is not folded in");
    assert.doesNotMatch(excerpt, /#####/, "heading markers do not leak into the passage");
  } finally {
    clearArtifactIndexCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
