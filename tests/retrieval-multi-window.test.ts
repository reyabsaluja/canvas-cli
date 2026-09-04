import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { getExtractedPagePath } from "../src/enrich/course-documents.js";
import { buildMatchExcerpt, clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { searchCourseArtifacts } from "../src/tui/course-retrieval.js";
import { buildSectionPreview, searchWorkspaceKnowledge } from "../src/tui/workspace-knowledge.js";

// A long section that mentions the query phrase several times, far apart.
// A single query-centred window shows one mention and hides the others,
// which is exactly where the "50% cap" and the extension rule live.
const FILLER =
  "Submissions are uploaded through the course site as a single archive and the grader runs them on the lab machines. ";
const MENTION_ONE =
  "Late penalty: submissions lose 10% per day for the first three days after the deadline.";
const MENTION_TWO =
  "After three days the late penalty caps at 50% of the lab grade and the work is still marked.";
const MENTION_THREE =
  "Extensions waive the late penalty only when documentation is provided before the deadline.";

function buildProbe(fillerRepeats: number): string {
  const filler = FILLER.repeat(fillerRepeats);
  return `${MENTION_ONE} ${filler}${MENTION_TWO} ${filler}${MENTION_THREE}`;
}

const SIX_K = buildProbe(27);
// Under the 3,000-char long-section split so the index keeps it whole.
const SECTION = buildProbe(11);

test("before/after: buildMatchExcerpt appends the next-best clusters after the primary window", () => {
  assert.ok(SIX_K.length > 6000, `fixture: ${SIX_K.length} chars`);
  const primaryOnly = SIX_K.slice(0, 240);
  const passage = buildMatchExcerpt(SIX_K, "late penalty", 240);
  assert.match(passage, /10% per day/);
  assert.match(passage, /50%/, `240-char passage hides the cap: ${passage}`);
  // The primary window is the head of the text, exactly as before.
  const [primary] = passage.split(" … ");
  assert.ok(primaryOnly.startsWith((primary ?? "").replace(/\.\.\.$/, "").trimEnd()), `primary window changed: ${primary}`);

  const preview = buildSectionPreview(SIX_K, "late penalty");
  assert.match(preview, /10% per day/);
  assert.match(preview, /50%/);
  assert.match(preview, /documentation is provided/, `2400-char preview hides the extension rule: ${preview.slice(-400)}`);
});

test("before/after: the search_course passage shows both the per-day rate and the cap", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-multi-window-"));
  try {
    const coursePath = path.join(tempDir, "course");
    const filePath = getExtractedPagePath(coursePath, "syllabus");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, ["# Course syllabus", "", "## Late policy", "", SECTION, "", "## Textbook", "", "Patterson and Hennessy."].join("\n"), "utf-8");
    const cache = {
      courseId: 17, coursePath, assignments: [], modules: [], files: [], syllabusCandidates: [], attachments: [], lectures: [], ingestion: null,
      pages: [{ pageId: "syllabus", title: "Course syllabus", htmlUrl: null, updatedAt: "2026-04-01T12:00:00.000Z", hasBody: true }],
    } as unknown as CourseCache;
    clearArtifactIndexCache();
    const [match] = await searchCourseArtifacts(cache, "late penalty", { limit: 3 });
    assert.ok(match, "syllabus matches");
    assert.equal(match.passage?.section, "Late policy");
    const excerpt = match.passage?.excerpt ?? "";
    assert.match(excerpt, /10% per day/);
    assert.match(excerpt, /50%/, `passage hides the cap: ${excerpt}`);
  } finally {
    clearArtifactIndexCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("before/after: the search_workspace preview shows every mention of the query in a long section", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-multi-window-ws-"));
  try {
    const workspacePath = path.join(tempDir, "workspace");
    await fs.mkdir(path.join(workspacePath, "extracted", "docs"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "assignment.md"), "# Assignment\nDo the lab.\n", "utf-8");
    await fs.writeFile(path.join(workspacePath, "extracted", "docs", "syllabus.txt"), `## Late policy\n${SIX_K}\n`, "utf-8");
    const workspace = {
      path: workspacePath,
      sessionSlug: "lab-5",
      assignmentId: 43,
      assignmentName: "Lab 5",
      courseId: 17,
      courseName: "ECE243",
      courseCode: "ECE243H1",
      preparedAt: "2026-04-02T09:00:00.000Z",
      workspaceState: "ready",
      assignmentMd: "# Assignment\nDo the lab.\n",
      planMd: null,
      notesMd: null,
      workupJson: null,
      extractedFiles: [{ name: "docs/syllabus.txt", relativePath: path.join("extracted", "docs", "syllabus.txt") }],
      extractedFileCache: new Map<string, string>(),
    } as unknown as LoadedWorkspace;
    clearArtifactIndexCache();
    const matches = await searchWorkspaceKnowledge(workspace, null, "late penalty", 5);
    const match = matches.find((entry) => entry.artifact.source.includes("syllabus.txt"));
    assert.ok(match, "syllabus matches");
    assert.match(match.preview, /10% per day/);
    assert.ok(match.preview.length >= 2000, "primary preview is not shortened");
    assert.match(match.preview, /50%/, `preview hides the cap`);
    assert.match(match.preview, /documentation is provided/, `preview hides the extension rule`);
  } finally {
    clearArtifactIndexCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
