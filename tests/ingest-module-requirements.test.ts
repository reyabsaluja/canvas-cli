import assert from "node:assert/strict";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { fetchCourseContent } from "../src/ingest/fetch-course-content.js";
import { normalizeCourseContent } from "../src/ingest/normalize-content.js";
import { clearArtifactIndexCache, describeModuleRequirements, loadArtifactIndex, searchArtifacts } from "../src/knowledge/artifact-index.js";
import { createMockCanvasServer, startServer, stopServer } from "./helpers/mock-canvas-server.js";
import { buildDefaultServerData } from "./helpers/fixtures.js";

test("before/after: module prerequisites and completion requirements are captured and searchable", async () => {
  const server = createMockCanvasServer(buildDefaultServerData());
  const port = await startServer(server);
  const config: Config = { baseUrl: `http://127.0.0.1:${port}/api/v1`, accessToken: "test-token-valid" };
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    const normalized = normalizeCourseContent(raw);
    const week2 = normalized.modules.find((m) => m.id === 11)!;
    assert.deepEqual(week2.prerequisiteModuleIds, [10]);
    assert.equal(week2.requireSequentialProgress, true);
    assert.deepEqual(week2.items[0]?.completionRequirement, { type: "must_view", minScore: null });

    clearArtifactIndexCache();
    const cache = {
      courseId: 101, coursePath: "/nonexistent/course", assignments: [], files: [], pages: [], syllabusCandidates: [], attachments: [], lectures: [], ingestion: null,
      modules: normalized.modules,
    } as unknown as CourseCache;
    const index = await loadArtifactIndex({ cache });
    const hits = searchArtifacts(index, "unlocks after completing Week 1", { scope: "course", kinds: ["module"], limit: 3 });
    assert.equal(hits[0]?.artifact.title, "Week 2: Variables", `got ${hits.map((h) => h.artifact.title).join(" > ")}`);
    const sectionText = index.sections.filter((section) => section.artifactId === hits[0]!.artifact.id).map((section) => section.text).join("\n");
    assert.match(sectionText, /Requirements: unlocks after completing Week 1: Getting Started; items must be completed in order; to complete this module: view Variables Lecture Notes\./);
  } finally {
    clearArtifactIndexCache();
    await stopServer(server);
  }
});

test("describeModuleRequirements renders scores, dates and unknown prerequisite ids", () => {
  const text = describeModuleRequirements(
    {
      unlockAt: "2026-10-01T00:00:00Z",
      prerequisiteModuleIds: [3, 99],
      items: [
        { title: "Quiz 1", completionRequirement: { type: "min_score", minScore: 8 } },
        { title: "Lab 1", completionRequirement: { type: "must_submit", minScore: null } },
        { title: "Slides", completionRequirement: null },
      ],
    },
    new Map([[3, "Week 3"]])
  );
  assert.equal(text, "Requirements: unlocks after completing Week 3 and module 99; opens on 2026-10-01T00:00:00Z; to complete this module: score at least 8 on Quiz 1, submit Lab 1.");
  assert.equal(describeModuleRequirements({ items: [{ title: "x" }] }, new Map()), "");
});
