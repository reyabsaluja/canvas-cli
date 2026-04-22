import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ContentChunk, LoadedWorkspace } from "../src/ask/types.js";
import { parseWorkspaceAnswerResponse } from "../src/ask/answer.js";
import { renderWorkspaceAnswer } from "../src/ask/render.js";
import {
  buildWorkspaceRetrievalContext,
  retrieveRelevant,
} from "../src/ask/retrieve.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { stripAnsi } from "../src/tui/screen.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-workspace-retrieval-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createWorkspace(
  tempDir: string
): Promise<LoadedWorkspace> {
  const workspacePath = path.join(tempDir, "workspace");
  await fs.mkdir(path.join(workspacePath, "extracted", "docs"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(workspacePath, "assignment.md"),
    "# Assignment\nImplement the datapath and capture the waveform.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "plan.md"),
    "# Plan\nCapture the waveform before writing the analysis.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "notes.md"),
    "# Notes\nWatch for repeated stall cycles.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "workup.json"),
    JSON.stringify(
      {
        overview: "Use the extracted reference and assignment brief together.",
        deliverables: ["Waveform screenshot", "Short analysis"],
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "extracted", "docs", "reference.txt"),
    "The waveform must show stall cycles around the branch hazard before the pipeline recovers.\n",
    "utf-8"
  );

  return {
    path: workspacePath,
    sessionSlug: "lab-4",
    assignmentId: 42,
    assignmentName: "Lab 4",
    courseId: 17,
    courseName: "ECE243",
    courseCode: "ECE243H1",
    preparedAt: "2026-04-02T09:00:00.000Z",
    workspaceState: "ready",
    assignmentMd: await fs.readFile(
      path.join(workspacePath, "assignment.md"),
      "utf-8"
    ),
    planMd: await fs.readFile(path.join(workspacePath, "plan.md"), "utf-8"),
    notesMd: await fs.readFile(path.join(workspacePath, "notes.md"), "utf-8"),
    workupJson: JSON.parse(
      await fs.readFile(path.join(workspacePath, "workup.json"), "utf-8")
    ) as Record<string, unknown>,
    extractedFiles: [
      {
        name: "docs/reference.txt",
        relativePath: path.join("extracted", "docs", "reference.txt"),
      },
    ],
    extractedFileCache: new Map<string, string>(),
  };
}

test("workspace retrieval uses shared artifact ranking and metadata", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspace = await createWorkspace(tempDir);

    const retrievalContext = await buildWorkspaceRetrievalContext(workspace);
    assert.ok(retrievalContext.chunks.length > 0);

    const relevant = retrieveRelevant("branch hazard waveform", retrievalContext, 3);
    assert.ok(relevant.length > 0);
    assert.equal(relevant[0]?.source, "extracted/docs/reference.txt");
    assert.equal(relevant[0]?.section, "Full text");
    assert.ok(relevant[0]?.sectionId);
    assert.ok(relevant[0]?.artifactId);
    assert.match(relevant[0]?.excerpt ?? "", /branch hazard/);
    assert.ok((relevant[0]?.score ?? 0) > 0);
  });
});

test("workspace retrieval prefers exact section headings over noisier repeated body mentions", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspacePath = path.join(tempDir, "workspace");
    await fs.mkdir(path.join(workspacePath, "extracted", "docs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspacePath, "assignment.md"),
      [
        "# Assignment",
        "",
        "## Description",
        "",
        Array.from({ length: 40 }, () => "due date reminder").join(" "),
        "",
        "## Due date",
        "",
        "The report is due on April 10 at 11:59 PM.",
      ].join("\n"),
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspacePath, "plan.md"),
      "# Plan\nCapture the waveform before writing the analysis.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspacePath, "notes.md"),
      "# Notes\nWatch for repeated stall cycles.\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspacePath, "workup.json"),
      JSON.stringify(
        {
          overview: "Use the extracted reference and assignment brief together.",
          deliverables: ["Waveform screenshot", "Short analysis"],
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(workspacePath, "extracted", "docs", "reference.txt"),
      "The waveform must show stall cycles around the branch hazard before the pipeline recovers.\n",
      "utf-8"
    );

    const workspace: LoadedWorkspace = {
      path: workspacePath,
      sessionSlug: "lab-4",
      assignmentId: 42,
      assignmentName: "Lab 4",
      courseId: 17,
      courseName: "ECE243",
      courseCode: "ECE243H1",
      preparedAt: "2026-04-02T09:00:00.000Z",
      workspaceState: "ready",
      assignmentMd: await fs.readFile(
        path.join(workspacePath, "assignment.md"),
        "utf-8"
      ),
      planMd: await fs.readFile(path.join(workspacePath, "plan.md"), "utf-8"),
      notesMd: await fs.readFile(path.join(workspacePath, "notes.md"), "utf-8"),
      workupJson: JSON.parse(
        await fs.readFile(path.join(workspacePath, "workup.json"), "utf-8")
      ) as Record<string, unknown>,
      extractedFiles: [
        {
          name: "docs/reference.txt",
          relativePath: path.join("extracted", "docs", "reference.txt"),
        },
      ],
      extractedFileCache: new Map<string, string>(),
    };

    const retrievalContext = await buildWorkspaceRetrievalContext(workspace);
    const relevant = retrieveRelevant("due date", retrievalContext, 3);

    assert.equal(relevant[0]?.source, "assignment.md");
    assert.equal(relevant[0]?.section, "Due date");
    assert.match(relevant[0]?.text ?? "", /April 10 at 11:59 PM/);
  });
});

test("workspace answer parsing resolves source ids back to canonical sources", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspace = await createWorkspace(tempDir);

    const retrievalContext = await buildWorkspaceRetrievalContext(workspace);
    const relevant = retrieveRelevant("branch hazard waveform", retrievalContext, 2);
    const primary = relevant[0];
    assert.ok(primary?.sectionId);

    const answer = parseWorkspaceAnswerResponse(
      "What evidence should I capture?",
      JSON.stringify({
        answer: "Capture a waveform that shows the branch hazard stall cycles.",
        bullet_points: ["Include the stall cycles before recovery."],
        source_ids: [`ref:${primary?.sectionId}`],
        confidence: "high",
      }),
      relevant
    );

    assert.equal(answer.sources.length, 1);
    assert.equal(answer.sources[0]?.title, "extracted/docs/reference.txt");
    assert.equal(answer.sources[0]?.kind, "extracted");
    assert.match(answer.sources[0]?.excerpt ?? "", /branch hazard/);
    assert.equal(answer.confidence, "high");
  });
});

test("workspace answers preserve and render section-level source labels", () => {
  const context: ContentChunk[] = [
    {
      source: "assignment.md",
      section: "Requirements",
      text: "Include a waveform screenshot and a short analysis.",
      excerpt: "Include a waveform screenshot and a short analysis.",
      kind: "assignment",
      sectionId: "assignment-section-1",
    },
  ];

  const answer = parseWorkspaceAnswerResponse(
    "What should I include?",
    JSON.stringify({
      answer: "Include a waveform screenshot and a short analysis.",
      bullet_points: ["Submit both items together."],
      source_ids: ["ref:assignment-section-1"],
      confidence: "high",
    }),
    context
  );

  assert.deepEqual(answer.sources, [
    {
      title: "assignment.md",
      kind: "assignment",
      section: "Requirements",
      excerpt: "Include a waveform screenshot and a short analysis.",
    },
  ]);
  assert.equal(answer.verificationNote, null);

  const rendered = stripAnsi(renderWorkspaceAnswer(answer));
  assert.match(rendered, /assignment\.md — Requirements \[assignment\]/);
});

test("workspace answer rendering shows verification notes separately from the answer body", () => {
  const rendered = stripAnsi(
    renderWorkspaceAnswer({
      question: "What does the branch hazard section mention?",
      answer: "It mentions the branch hazard section.",
      bulletPoints: [],
      sources: [
        {
          title: "docs/reference.txt",
          kind: "extracted",
          section: "Branch hazard walkthrough",
          excerpt: "The waveform must show stall cycles around the branch hazard.",
        },
      ],
      confidence: "medium",
      verificationNote:
        "This answer is based on matched search evidence, not a full document read. Use the cited source for exact wording.",
    })
  );

  assert.match(rendered, /Grounding/);
  assert.match(rendered, /matched search evidence, not a full document read/i);
  assert.match(rendered, /docs\/reference\.txt — Branch hazard walkthrough \[extracted\]/);
});
