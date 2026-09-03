import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { getExtractedPagePath } from "../src/enrich/course-documents.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { searchCourseArtifacts } from "../src/tui/course-retrieval.js";

const OTHER_TOPICS = [
  "Amdahl's law and speedup estimates for parallel programs.",
  "Two's complement arithmetic and overflow detection.",
  "Single-cycle datapath control signals.",
  "Virtual memory, page tables and TLB lookups.",
  "Interrupts, exceptions and the precise exception model.",
  "Branch prediction with saturating counters.",
];

function longSyllabus(): string {
  const lines = ["# Course syllabus", "", "## Overview", "", "This course covers computer organization."];
  for (let week = 1; week <= 12; week += 1) {
    lines.push("", `## Week ${week}`, "", `${OTHER_TOPICS[week % OTHER_TOPICS.length]} `.repeat(6));
  }
  // The syllabus mentions every query word exactly once, spread out.
  lines.push("", "## Topics list", "", "Also: cache design; coherence in multiprocessors; a protocol overview.");
  return lines.join("\n");
}

function week6Page(): string {
  return [
    "# Week 6",
    "",
    "## Cache coherence",
    "",
    "The MESI cache coherence protocol keeps cache lines consistent. Coherence protocol transitions are on slide 12; the protocol handles cache writes with invalidations.",
  ].join("\n");
}

test("before/after: the focused page outranks a long syllabus that merely mentions every query word", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-course-rerank-"));
  try {
    const coursePath = path.join(tempDir, "course");
    for (const [slug, body] of [["course-syllabus", longSyllabus()], ["week-6", week6Page()]] as const) {
      const filePath = getExtractedPagePath(coursePath, slug);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, body, "utf-8");
    }
    const cache = {
      courseId: 17,
      coursePath,
      assignments: [],
      modules: [],
      files: [],
      pages: [
        { pageId: "course-syllabus", title: "Course syllabus", htmlUrl: null, updatedAt: "2026-04-01T12:00:00.000Z", hasBody: true },
        { pageId: "week-6", title: "Week 6", htmlUrl: null, updatedAt: "2026-04-01T12:00:00.000Z", hasBody: true },
      ],
      syllabusCandidates: [],
      attachments: [],
      lectures: [],
      ingestion: null,
    } as unknown as CourseCache;
    clearArtifactIndexCache();

    const matches = await searchCourseArtifacts(cache, "cache coherence protocol", { limit: 5 });
    assert.equal(matches.length, 2, "both documents contain every query word");
    assert.equal(matches[0]?.artifact.title, "Week 6", `expected the focused page first, got ${matches.map((m) => m.artifact.title).join(" > ")}`);
  } finally {
    clearArtifactIndexCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
