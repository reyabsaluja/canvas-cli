import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import { appendObservation, createEmptyRunState } from "../src/agent/run-state.js";
import { verifyWorkspaceAnswer } from "../src/agent/verify.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { executeToolCallForTurn } from "../src/tui/chat-agent.js";
import { buildSystemPrompt } from "../src/tui/chat-agent/prompt.js";
import { buildChatTools } from "../src/tui/chat-agent/tool-defs.js";
import {
  buildReadModelText,
  MAX_DOC_TEXT,
} from "../src/tui/chat-agent/tool-execution.js";
import { createChatContext } from "../src/tui/services.js";

/**
 * A 60-page lecture deck the way the PDF extractor writes its sidecar: a
 * "## Page N" heading before every page, ~2.5k chars per page, so the whole
 * document is well past the default read window. Page 57 is the only page
 * that mentions the MESI protocol, which is what a search hit would cite.
 */
const PAGE_COUNT = 60;
const MESI_PAGE = 57;
const MESI_SENTENCE =
  "The MESI protocol keeps every cache line in one of the Modified, Exclusive, Shared, or Invalid states so that writes stay coherent across cores.";

function buildPageBody(page: number): string {
  const filler = `Slide ${page} of the lecture covers pipeline hazards, forwarding paths, and the branch predictor tables that were introduced last week. `;
  const lines: string[] = [];
  let length = 0;
  while (length < 2400) {
    lines.push(filler);
    length += filler.length;
  }
  if (page === MESI_PAGE) {
    lines.unshift(MESI_SENTENCE);
  }
  return lines.join("\n");
}

function buildDeck(): string {
  const parts: string[] = [];
  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    parts.push(`## Page ${page}\n${buildPageBody(page)}`);
  }
  return `${parts.join("\n\n")}\n`;
}

const HANDBOOK = `Course Handbook

Part 1: Late policy
Assignments lose 10% per day late, up to a maximum of three days. After that
the submission receives zero unless an extension was granted in writing.

Part 2: Academic integrity
You may discuss ideas with classmates, but every line of code you submit must
be your own work. Cite any reference material you consulted in your report.

Part 3: Regrade requests
Submit regrade requests through the course portal within one week of grades
being released. Include the specific rubric line you believe was misapplied.
`;

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-read-file-sections-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createWorkspace(tempDir: string): Promise<LoadedWorkspace> {
  const workspacePath = path.join(tempDir, "workspace");
  await fs.mkdir(path.join(workspacePath, "extracted"), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, "assignment.md"),
    "# Lab 5\nCache coherence on a multicore simulator.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "extracted", "lecture12.pdf.txt"),
    buildDeck(),
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "extracted", "handbook.txt"),
    HANDBOOK,
    "utf-8"
  );
  return {
    path: workspacePath,
    sessionSlug: "lab-5",
    assignmentId: 42,
    assignmentName: "Lab 5",
    courseId: 17,
    courseName: "ECE243",
    courseCode: "ECE243H1",
    preparedAt: "2026-03-20T09:00:00.000Z",
    workspaceState: "ready",
    assignmentMd: "# Lab 5\nCache coherence on a multicore simulator.\n",
    planMd: null,
    notesMd: null,
    workupJson: null,
    extractedFiles: [
      {
        name: "lecture12.pdf.txt",
        relativePath: path.join("extracted", "lecture12.pdf.txt"),
      },
      { name: "handbook.txt", relativePath: path.join("extracted", "handbook.txt") },
    ],
    extractedFileCache: new Map<string, string>(),
  };
}

function createContext(loaded: LoadedWorkspace) {
  return createChatContext({ provider: "anthropic", model: "test-model" }, loaded);
}

test("fixture: the deck is longer than the default read window and only page 57 mentions MESI", () => {
  const deck = buildDeck();
  assert.ok(deck.length > MAX_DOC_TEXT, `deck is ${deck.length} chars`);
  assert.equal(deck.split("MESI protocol").length - 1, 1);
  assert.ok(deck.indexOf("## Page 57") > MAX_DOC_TEXT);
});

test("read_file without a section keeps the default window but names every page and the cut-off", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const ctx = createContext(await createWorkspace(tempDir));
    const { result, deduped } = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "lecture12.pdf.txt" },
      ctx
    );

    assert.equal(deduped, false);
    assert.equal(result.observation.status, "ok");
    assert.ok(result.observation.content);
    assert.ok(result.observation.content!.length >= MAX_DOC_TEXT);
    assert.ok(result.observation.content!.length < buildDeck().length);
    // The whole-document read still does not reach page 57 ...
    assert.doesNotMatch(result.observation.content!, /MESI protocol/);
    // ... but the outline lists every page as a compressed run, not "and 36 more".
    assert.match(result.modelText, /Page 1–60/);
    assert.doesNotMatch(result.modelText, /and \d+ more/);
    // The cut-off names the pages that were left out and how to reach them.
    assert.match(result.modelText, /not included in this read/i);
    assert.match(result.modelText, /Page 57|Page 4\d–60|Page 5\d–60/);
    assert.match(result.modelText, /section/);
    assert.equal(result.observation.artifacts[0]?.sectionLabel ?? null, null);
  });
});

test("read_file with section \"Page 57\" returns that page in full with a section-level artifact ref", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const ctx = createContext(await createWorkspace(tempDir));
    const { result } = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "lecture12.pdf.txt", section: "Page 57" },
      ctx
    );

    assert.equal(result.observation.status, "ok");
    assert.match(result.observation.content ?? "", /MESI protocol/);
    assert.doesNotMatch(result.observation.content ?? "", /Slide 56 of/);
    assert.doesNotMatch(result.observation.content ?? "", /Slide 58 of/);
    assert.equal(result.observation.artifacts.length, 1);
    assert.equal(result.observation.artifacts[0]?.sectionLabel, "Page 57");
    assert.equal(result.observation.artifacts[0]?.title, "lecture12.pdf.txt");
    assert.match(result.observation.summary, /Page 57/);
    // The model text names the section, its neighbours, and how to cite it.
    assert.match(result.modelText, /\[Source: lecture12\.pdf\.txt \(extracted\) — Page 57\]/);
    assert.match(result.modelText, /Page 56/);
    assert.match(result.modelText, /Page 58/);
    assert.match(result.modelText, /lecture12\.pdf\.txt — Page 57/);
    assert.match(result.uiText, /MESI protocol/);
  });
});

test("read_file section lookup is forgiving: bare page numbers, case, 'p.' prefixes, and heading fragments", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const ctx = createContext(await createWorkspace(tempDir));

    for (const section of ["57", "page 57", "p. 57", "PAGE 57", "pg 57", "Page 57 (Part 2)"]) {
      const { result } = await executeToolCallForTurn(
        new Map(),
        "read_file",
        { filename: "lecture12.pdf.txt", section },
        ctx
      );
      assert.equal(result.observation.status, "ok", section);
      assert.equal(result.observation.artifacts[0]?.sectionLabel, "Page 57", section);
      assert.match(result.observation.content ?? "", /MESI protocol/, section);
    }

    // A numeric section on a page-numbered document must not match "Page 5"
    // when "Page 57" was asked for, and a heading fragment resolves on a
    // heading-based document.
    const { result: fragment } = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "handbook.txt", section: "academic integrity" },
      ctx
    );
    assert.equal(fragment.observation.status, "ok");
    assert.equal(
      fragment.observation.artifacts[0]?.sectionLabel,
      "Part 2: Academic integrity"
    );
    assert.match(fragment.observation.content ?? "", /every line of code/);
    assert.doesNotMatch(fragment.observation.content ?? "", /Late policy/);
  });
});

test("read_file with an unknown section falls back to the whole document and says so", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const ctx = createContext(await createWorkspace(tempDir));
    const { result } = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "handbook.txt", section: "Appendix Z" },
      ctx
    );

    assert.equal(result.observation.status, "ok");
    assert.match(result.modelText, /No section matching "Appendix Z"/);
    assert.match(result.modelText, /Part 1: Late policy/);
    assert.match(result.observation.content ?? "", /Late policy/);
    assert.match(result.observation.content ?? "", /Regrade requests/);
    assert.equal(result.observation.artifacts[0]?.sectionLabel ?? null, null);
  });
});

test("read_file with a char offset returns the window starting there", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const ctx = createContext(await createWorkspace(tempDir));
    const deck = buildDeck();
    const offset = deck.indexOf("## Page 55");
    const { result } = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "lecture12.pdf.txt", offset },
      ctx
    );

    assert.equal(result.observation.status, "ok");
    assert.match(result.observation.content ?? "", /^## Page 55/);
    assert.match(result.observation.content ?? "", /MESI protocol/);
    assert.match(result.modelText, new RegExp(`offset ${offset}`));
  });
});

test("a section read is not deduped against an earlier whole-document read in the same turn, and vice versa", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const ctx = createContext(await createWorkspace(tempDir));
    const turnToolCache = new Map();

    const whole = await executeToolCallForTurn(
      turnToolCache,
      "read_file",
      { filename: "lecture12.pdf.txt" },
      ctx
    );
    appendObservation(ctx.runState, whole.result.observation);
    assert.doesNotMatch(whole.result.observation.content ?? "", /MESI protocol/);

    const section = await executeToolCallForTurn(
      turnToolCache,
      "read_file",
      { filename: "lecture12.pdf.txt", section: "Page 57" },
      ctx
    );
    assert.equal(section.deduped, false);
    assert.match(section.result.observation.content ?? "", /MESI protocol/);
    appendObservation(ctx.runState, section.result.observation);

    const sectionAgain = await executeToolCallForTurn(
      turnToolCache,
      "read_file",
      { filename: "lecture12.pdf.txt", section: "page 57" },
      ctx
    );
    assert.equal(sectionAgain.deduped, true);

    // A later whole-document request must not be answered with only page 57.
    const wholeAgain = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "lecture12.pdf.txt" },
      ctx
    );
    assert.match(wholeAgain.result.observation.content ?? "", /^## Page 1\n/);
    assert.equal(wholeAgain.result.observation.artifacts[0]?.sectionLabel ?? null, null);
  });
});

test("a section read marks only that section as read, so the artifact is not treated as fully read", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const ctx = createContext(await createWorkspace(tempDir));
    const { result } = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "lecture12.pdf.txt", section: "Page 57" },
      ctx
    );
    const runState = createEmptyRunState();
    appendObservation(runState, result.observation);
    assert.equal(runState.observations.length, 1);
    assert.deepEqual(runState.readArtifactIds, []);

    const whole = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "handbook.txt" },
      ctx
    );
    appendObservation(runState, whole.result.observation);
    assert.deepEqual(runState.readArtifactIds, [
      whole.result.observation.artifacts[0]!.artifactId,
    ]);
  });
});

test("a section read produces a section-level citation without re-attribution", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const ctx = createContext(loaded);
    const { result } = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "lecture12.pdf.txt", section: "Page 57" },
      ctx
    );
    const verification = await verifyWorkspaceAnswer({
      question: "What does page 57 say about MESI?",
      answer:
        "Page 57 explains that the MESI protocol keeps every cache line in one of the Modified, Exclusive, Shared, or Invalid states so writes stay coherent across cores.",
      observations: [result.observation],
      loaded,
    });
    const source = verification.sources.find((entry) => entry.title === "lecture12.pdf.txt");
    assert.ok(source, JSON.stringify(verification.sources));
    assert.equal(source!.section, "Page 57");
  });
});

test("buildReadModelText compresses page runs and keeps non-page headings verbatim", () => {
  const paged = buildReadModelText(
    { title: "deck.pdf", kind: "attachment" },
    buildDeck()
  );
  assert.match(paged, /Sections in this document: Page 1–60\./);
  assert.match(paged, /"deck\.pdf — Page 1"/);

  const mixed = buildReadModelText(
    { title: "notes.txt", kind: "extracted" },
    [
      "## Page 1\n" + "Intro text that is long enough to count as a section body here.\n",
      "## Page 2\n" + "More text that is long enough to count as a section body here.\n",
      "## Page 3\n" + "Even more text that is long enough to count as a section body.\n",
      "## Appendix A\n" + "Appendix text that is long enough to count as a section body.\n",
      "## Page 9\n" + "Trailing text that is long enough to count as a section body.\n",
    ].join("\n")
  );
  assert.match(mixed, /Sections in this document: Page 1–3 \| Appendix A \| Page 9\./);
});

test("tool description and system prompt teach section reads after a search hit", () => {
  const tools = buildChatTools({
    cache: null,
    client: null,
    radar: null,
    courseId: null,
    assignments: [],
  } as any);
  const readFile = tools.find((tool) => tool.name === "read_file");
  assert.ok(readFile);
  assert.ok("section" in (readFile!.parameters.properties as Record<string, unknown>));
  assert.ok("offset" in (readFile!.parameters.properties as Record<string, unknown>));
  assert.match(readFile!.description, /120,000 characters/);
  assert.match(readFile!.description, /Page 57/);

  const prompt = buildSystemPrompt({
    aiConfig: { provider: "anthropic", model: "test-model" },
    loaded: {
      workspacePath: "/tmp/workspace",
      assignmentName: "Lab 5",
      courseName: "ECE243",
      courseCode: "ECE243H1",
      planMd: "",
      workupJson: null,
      extractedFiles: [],
      resourceFiles: [],
    },
    cache: null,
    client: null,
    config: null,
    courseId: null,
    conversationHistory: [],
    runState: createEmptyRunState(),
  } as any);
  assert.match(prompt, /section/);
  assert.match(prompt, /Page 57/);
});
