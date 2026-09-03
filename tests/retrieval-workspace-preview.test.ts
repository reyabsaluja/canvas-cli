import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { searchWorkspaceKnowledge } from "../src/tui/workspace-knowledge.js";

// search_workspace renders `match.header` followed by `match.preview`
// verbatim (src/tui/chat-agent/tool-execution.ts), so the preview string is
// exactly what the model sees for a section.

const FILLER_SENTENCE =
  "Cache lines hold data copied from main memory and each core keeps its own private copy of the line. ";
const MESI_SENTENCE =
  "The MESI protocol marks every line Modified, Exclusive, Shared, or Invalid so the cores stay coherent.";

function buildSectionText(matchPosition: "start" | "end"): string {
  // ~2,700 chars: under the 3,000-char long-section split threshold, so the
  // artifact index keeps it as a single section.
  const filler = FILLER_SENTENCE.repeat(26);
  return matchPosition === "end"
    ? `${filler}${MESI_SENTENCE}\n`
    : `${MESI_SENTENCE} ${filler}\n`;
}

async function withWorkspace(
  sectionText: string,
  fn: (workspace: LoadedWorkspace) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-retrieval-preview-")
  );
  try {
    const workspacePath = path.join(tempDir, "workspace");
    await fs.mkdir(path.join(workspacePath, "extracted", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspacePath, "assignment.md"),
      "# Assignment\nDescribe the cache coherence design.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspacePath, "extracted", "docs", "coherence.txt"),
      sectionText,
      "utf-8"
    );
    const workspace: LoadedWorkspace = {
      path: workspacePath,
      sessionSlug: "lab-5",
      assignmentId: 43,
      assignmentName: "Lab 5",
      courseId: 17,
      courseName: "ECE243",
      courseCode: "ECE243H1",
      preparedAt: "2026-04-02T09:00:00.000Z",
      workspaceState: "ready",
      assignmentMd: await fs.readFile(
        path.join(workspacePath, "assignment.md"),
        "utf-8"
      ),
      planMd: null,
      notesMd: null,
      workupJson: null,
      extractedFiles: [
        {
          name: "docs/coherence.txt",
          relativePath: path.join("extracted", "docs", "coherence.txt"),
        },
      ],
      extractedFileCache: new Map<string, string>(),
    };
    clearArtifactIndexCache();
    await fn(workspace);
  } finally {
    clearArtifactIndexCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("search_workspace preview centres on a match deep in a long section", async () => {
  const text = buildSectionText("end");
  assert.ok(text.indexOf("MESI") > 2500, "fixture: match must sit after char 2500");

  await withWorkspace(text, async (workspace) => {
    const matches = await searchWorkspaceKnowledge(
      workspace,
      null,
      "MESI protocol",
      5
    );
    const match = matches.find((entry) =>
      entry.artifact.source.includes("coherence.txt")
    );
    assert.ok(match, "expected the coherence document to match");
    assert.match(match.header, /^--- .*coherence\.txt/);
    assert.ok(
      match.preview.includes("MESI protocol"),
      "preview should include the matching passage even when it sits late in the section"
    );
    assert.ok(
      match.preview.length >= 2000,
      "preview must not be shorter than the previous 2,000-char head slice"
    );
  });
});

test("search_workspace preview still renders from the start for an early match", async () => {
  const text = buildSectionText("start");

  await withWorkspace(text, async (workspace) => {
    const matches = await searchWorkspaceKnowledge(
      workspace,
      null,
      "MESI protocol",
      5
    );
    const match = matches.find((entry) =>
      entry.artifact.source.includes("coherence.txt")
    );
    assert.ok(match, "expected the coherence document to match");
    assert.ok(
      match.preview.startsWith("The MESI protocol"),
      "an early match should render the section from its start without a leading ellipsis"
    );
  });
});
