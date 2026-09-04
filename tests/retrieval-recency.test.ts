import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { getExtractedAnnouncementPath } from "../src/enrich/course-documents.js";
import { clearArtifactIndexCache, loadArtifactIndex, recencyMultiplier, searchArtifactSections, searchArtifacts } from "../src/knowledge/artifact-index.js";

const DAY = 86_400_000;

test("recencyMultiplier rewards fresh posts, ignores old ones and other kinds", () => {
  const now = Date.parse("2026-09-04T00:00:00Z");
  const fresh = { kind: "announcement", metadata: { postedAt: "2026-09-03T12:00:00Z" } } as const;
  const stale = { kind: "announcement", metadata: { postedAt: "2026-01-01T12:00:00Z" } } as const;
  const page = { kind: "page", metadata: { postedAt: "2026-09-03T12:00:00Z" } } as const;
  assert.ok(recencyMultiplier(fresh as never, now) > 1.15);
  assert.equal(recencyMultiplier(stale as never, now), 1);
  assert.equal(recencyMultiplier(page as never, now), 1);
  assert.equal(recencyMultiplier(undefined, now), 1);
});

test("before/after: of two equally matching announcements, the newer one ranks first", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-recency-"));
  try {
    const coursePath = path.join(tempDir, "course");
    const body = "# Extension\n\nThe Lab 4 extension request form is now open; submit it before the deadline.\n";
    for (const id of [1, 2]) {
      const filePath = getExtractedAnnouncementPath(coursePath, id);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, body, "utf-8");
    }
    const now = Date.now();
    const cache = {
      courseId: 17,
      coursePath,
      assignments: [], modules: [], files: [], pages: [], syllabusCandidates: [], attachments: [], lectures: [], ingestion: null,
      announcements: [
        // Alphabetical order would put "A older" first; recency must win.
        { id: 1, title: "A older extension note", postedAt: new Date(now - 200 * DAY).toISOString(), htmlUrl: "https://x/1", userName: null, hasMessage: true, messageFileLinkCount: 0 },
        { id: 2, title: "B newer extension note", postedAt: new Date(now - 1 * DAY).toISOString(), htmlUrl: "https://x/2", userName: null, hasMessage: true, messageFileLinkCount: 0 },
      ],
    } as unknown as CourseCache;
    clearArtifactIndexCache();
    const index = await loadArtifactIndex({ cache });
    const docs = searchArtifacts(index, "lab 4 extension", { scope: "course", limit: 5 });
    assert.equal(docs[0]?.artifact.title, "B newer extension note", `got ${docs.map((d) => d.artifact.title).join(" > ")}`);
    const sections = searchArtifactSections(index, "lab 4 extension", { scope: "course", limit: 5 });
    assert.equal(sections[0]?.section.source, "B newer extension note");
  } finally {
    clearArtifactIndexCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
