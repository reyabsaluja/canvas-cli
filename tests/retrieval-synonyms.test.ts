import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import { analyzeSearchQuery, clearArtifactIndexCache, loadArtifactIndex, searchArtifactSections, searchArtifacts } from "../src/knowledge/artifact-index.js";

async function withWorkspace(
  files: Record<string, string>,
  fn: (workspace: LoadedWorkspace) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-retrieval-synonyms-"));
  try {
    const workspacePath = path.join(tempDir, "workspace");
    await fs.mkdir(path.join(workspacePath, "extracted", "docs"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "assignment.md"), "# Assignment\nDo the lab.\n", "utf-8");
    const extractedFiles: Array<{ name: string; relativePath: string }> = [];
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(workspacePath, "extracted", "docs", name), content, "utf-8");
      extractedFiles.push({ name: `docs/${name}`, relativePath: path.join("extracted", "docs", name) });
    }
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
      extractedFiles,
      extractedFileCache: new Map<string, string>(),
    } as unknown as LoadedWorkspace;
    clearArtifactIndexCache();
    await fn(workspace);
  } finally {
    clearArtifactIndexCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const SYLLABUS = [
  "## Deadlines",
  "Labs must be handed in on Fridays by 11:59 PM through the course site. Late work loses ten percent per day.",
  "",
  "## Marking scheme",
  "Correctness is worth sixty percent, code style twenty percent, and the written report twenty percent.",
  "",
  "## Textbook",
  "Patterson and Hennessy, chapters one to four.",
  "",
].join("\n");

test("analyzeSearchQuery expands course vocabulary and keeps the original tokens first", () => {
  const analysis = analyzeSearchQuery("when is the lab due");
  assert.ok(analysis.tokens.includes("due"));
  assert.ok((analysis.expansions.get("due") ?? []).includes("deadlin"), `expected a deadline synonym, got ${JSON.stringify([...analysis.expansions])}`);
  assert.ok(!(analysis.expansions.get("due") ?? []).includes("due"));
});

test("before/after: 'when is it due' finds the Deadlines section and 'rubric' finds the marking scheme", async () => {
  await withWorkspace({ "syllabus.txt": SYLLABUS }, async (workspace) => {
    const index = await loadArtifactIndex({ workspace, cache: null });
    const dueHits = searchArtifactSections(index, "when is it due", { limit: 3 });
    assert.ok(dueHits.some((hit) => hit.section.section === "Deadlines"), `expected Deadlines, got ${dueHits.map((h) => h.section.section).join(", ")}`);
    const rubricHits = searchArtifactSections(index, "what is the rubric", { limit: 3 });
    assert.equal(rubricHits[0]?.section.section, "Marking scheme");
    const docHits = searchArtifacts(index, "rubric", { limit: 3 });
    assert.ok(docHits.some((hit) => hit.artifact.title.includes("syllabus")), "document-level search also benefits");
  });
});

test("before/after: 'how much is this worth' finds the Points section through the grade synonym group", async () => {
  await withWorkspace(
    {
      "lab5.txt": [
        "## Overview",
        "Build a timer-driven display and hand in the C source with a short report.",
        "",
        "## Points",
        "This lab counts for 100 points, 10% of the final grade.",
        "",
      ].join("\n"),
    },
    async (workspace) => {
      const index = await loadArtifactIndex({ workspace, cache: null });
      const hits = searchArtifactSections(index, "how much is this worth", { limit: 3 });
      assert.equal(hits[0]?.section.section, "Points", `expected Points first, got ${hits.map((h) => h.section.section).join(", ") || "no hits"}`);
    }
  );
});

test("starter code vocabulary maps template, skeleton, scaffold and boilerplate onto each other", () => {
  const expansions = analyzeSearchQuery("where is the starter code").expansions;
  const starter = expansions.get("starter") ?? [];
  assert.ok(starter.includes("templat") || starter.includes("template"), `expected a template synonym, got ${JSON.stringify([...expansions])}`);
  assert.ok(starter.includes("skeleton"), `expected skeleton, got ${JSON.stringify(starter)}`);
});

test("a direct match still outranks a synonym-only match", async () => {
  await withWorkspace(
    {
      "a.txt": "## Due dates\nEverything is due on Friday at noon.\n",
      "b.txt": "## Deadlines\nEverything must be in by Friday at noon.\n",
    },
    async (workspace) => {
      const index = await loadArtifactIndex({ workspace, cache: null });
      const hits = searchArtifactSections(index, "due", { limit: 5 });
      const labels = hits.map((hit) => hit.section.section);
      assert.equal(labels[0], "Due dates");
      assert.ok(labels.includes("Deadlines"), "synonym match is still returned");
    }
  );
});
