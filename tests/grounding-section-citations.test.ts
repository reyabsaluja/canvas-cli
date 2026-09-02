import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { Observation } from "../src/agent/observation.js";
import {
  attributeAnswerToSections,
  selectSupportingExcerpt,
  selectSupportingSections,
  splitDocumentIntoSections,
  verifyWorkspaceAnswer,
} from "../src/agent/verify.js";
import { clearArtifactIndexCache } from "../src/knowledge/artifact-index.js";
import { executeToolCallForTurn } from "../src/tui/chat-agent.js";
import { buildReadModelText } from "../src/tui/chat-agent/tool-execution.js";
import { createChatContext } from "../src/tui/services.js";

/**
 * Realistic text as it comes out of a lab handout PDF: numbered headings,
 * "Part N" headings, an ALL-CAPS heading, a colon-terminated title, and a
 * preamble before the first heading.
 */
const LAB_HANDOUT = `ECE243 Lab 4: Interrupts and Timers
Winter 2026

This lab builds on the polling-based timer you wrote in Lab 3. You will move the
timer logic into an interrupt service routine and drive the HEX displays from it.

1. Learning objectives
By the end of this lab you should be able to configure the ARM generic interrupt
controller, write an interrupt service routine in C, and reason about interrupt
latency on the DE1-SoC.

Part 1: Configuring the private timer
Set the private timer load register at address 0xFFFEC600 to 200,000,000 so that
it counts one second at the 200 MHz clock. Enable the I (interrupt) bit in the
control register before you start the timer.

Part 2: The interrupt service routine
Your ISR must clear the timer interrupt flag by writing 1 to the interrupt status
register at 0xFFFEC60C. If you do not clear the flag, the ISR will be re-entered
immediately and the board will appear to hang. Keep the ISR short: increment a
global counter and return.

Part 3: Driving the HEX displays
Decode the global counter into seven-segment codes and write them to the HEX3-0
register at 0xFF200020. Only the main loop should touch the displays; the ISR
must not write to HEX3-0 directly.

SUBMISSION
Submit a single zip file named lab4_<studentnumber>.zip containing your C source
and a two-page PDF report. The zip is due on Canvas by Friday March 27 at 11:59 PM.
Late submissions lose 10% per day.

Grading:
The demo is worth 60% and the report is worth 40%. The TA will check that the
counter keeps time to within one second over a two-minute run.
`;

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-grounding-section-citations-")
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
    "# Lab 4\nInterrupts and timers on the DE1-SoC.\n",
    "utf-8"
  );
  await fs.writeFile(
    path.join(workspacePath, "extracted", "lab4.txt"),
    LAB_HANDOUT,
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
    preparedAt: "2026-03-20T09:00:00.000Z",
    workspaceState: "ready",
    assignmentMd: "# Lab 4\nInterrupts and timers on the DE1-SoC.\n",
    planMd: null,
    notesMd: null,
    workupJson: null,
    extractedFiles: [
      { name: "lab4.txt", relativePath: path.join("extracted", "lab4.txt") },
    ],
    extractedFileCache: new Map<string, string>(),
  };
}

function createReadObservation(content: string, title = "lab4.txt"): Observation {
  return {
    tool: "read_file",
    status: "ok",
    summary: `Read ${title}.`,
    artifacts: [
      {
        artifactId: `workspace:extracted:${title}`,
        title,
        kind: "extracted",
        excerpt: "ECE243 Lab 4: Interrupts and Timers Winter 2026 This lab builds on the polling-based timer",
      },
    ],
    content,
  };
}

const loadedStub = {
  workupJson: null,
} as unknown as LoadedWorkspace;

test("splitDocumentIntoSections recognises the heading styles found in extracted lab handouts", () => {
  const sections = splitDocumentIntoSections(LAB_HANDOUT);
  const labels = sections.map((section) => section.label);

  assert.deepEqual(labels, [
    null,
    "1. Learning objectives",
    "Part 1: Configuring the private timer",
    "Part 2: The interrupt service routine",
    "Part 3: Driving the HEX displays",
    "SUBMISSION",
    "Grading",
  ]);
  assert.match(sections[0]?.text ?? "", /polling-based timer you wrote in Lab 3/);
  assert.match(sections[3]?.text ?? "", /0xFFFEC60C/);
  assert.match(sections[5]?.text ?? "", /Friday March 27/);
  // Positions follow document order so citations can be sorted for the reader.
  assert.deepEqual(
    sections.map((section) => section.position),
    [0, 1, 2, 3, 4, 5, 6]
  );
});

test("splitDocumentIntoSections treats markdown, bold, and underlined headings as sections and ignores list items", () => {
  const markdown = [
    "# Overview",
    "This assignment asks you to build a small compiler front end for a toy language.",
    "",
    "Requirements",
    "------------",
    "1. Read the language specification carefully before you start.",
    "2. Your lexer must reject any identifier longer than 32 characters.",
    "",
    "**What to hand in**",
    "A tarball containing lexer.c, parser.c, and a short README describing your design.",
  ].join("\n");

  const sections = splitDocumentIntoSections(markdown);
  assert.deepEqual(
    sections.map((section) => section.label),
    ["Overview", "Requirements", "What to hand in"]
  );
  assert.match(sections[1]?.text ?? "", /longer than 32 characters/);
  assert.equal(splitDocumentIntoSections("Just one flat paragraph with no headings at all.").length, 1);
  assert.equal(splitDocumentIntoSections("Just one flat paragraph with no headings at all.")[0]?.label, null);
});

test("selectSupportingSections ranks the sections that carry the answer's claims", () => {
  const sections = splitDocumentIntoSections(LAB_HANDOUT);
  const answer =
    "Your ISR has to clear the timer interrupt flag by writing 1 to the interrupt status register at 0xFFFEC60C; otherwise the ISR is re-entered immediately and the board appears to hang. Keep it short: increment a global counter and return.";

  const supporting = selectSupportingSections(answer, sections);
  assert.equal(supporting[0]?.label, "Part 2: The interrupt service routine");
  assert.ok(
    !supporting.some((section) => section.label === "SUBMISSION"),
    "unrelated sections are not cited"
  );
});

test("attributeAnswerToSections turns a full-document read into section-level sources with supporting excerpts", () => {
  const answer = [
    "Submit one zip named lab4_<studentnumber>.zip with your C source and a two-page PDF report.",
    "It is due on Canvas Friday March 27 at 11:59 PM, and late work loses 10% per day.",
    "Grading is split 60% demo and 40% report, and the TA checks that the counter keeps time to within one second over two minutes.",
  ].join(" ");

  const sources = attributeAnswerToSections(answer, LAB_HANDOUT, {
    title: "lab4.txt",
    kind: "extracted",
    excerpt: "ECE243 Lab 4: Interrupts and Timers",
  });

  assert.deepEqual(
    sources.map((source) => source.section),
    ["SUBMISSION", "Grading"]
  );
  assert.match(sources[0]?.excerpt ?? "", /lab4_<studentnumber>\.zip/);
  assert.match(sources[1]?.excerpt ?? "", /60%|within one second/);
  for (const source of sources) {
    assert.equal(source.title, "lab4.txt");
    assert.equal(source.kind, "extracted");
    assert.doesNotMatch(
      source.excerpt ?? "",
      /Interrupts and Timers Winter 2026/,
      "the excerpt is the supporting passage, not the document's opening"
    );
  }
});

test("attributeAnswerToSections falls back to a document-level source when nothing in a sectioned document supports the answer", () => {
  const sources = attributeAnswerToSections(
    "The syllabus says the final exam is cumulative and open-book.",
    LAB_HANDOUT,
    { title: "lab4.txt", kind: "extracted", excerpt: "ECE243 Lab 4" }
  );
  assert.deepEqual(sources, []);
});

test("selectSupportingExcerpt picks the sentence that supports the answer", () => {
  const excerpt = selectSupportingExcerpt(
    "Write 200,000,000 into the load register at 0xFFFEC600 for a one-second tick.",
    splitDocumentIntoSections(LAB_HANDOUT)[2]?.text ?? ""
  );
  assert.match(excerpt ?? "", /0xFFFEC600/);
  assert.ok((excerpt ?? "").length <= 160);
});

test("verifyWorkspaceAnswer cites the specific sections of a read document instead of just its title", () => {
  const verified = verifyWorkspaceAnswer({
    question: "What do I have to submit for lab 4 and how is it graded?",
    answer:
      "Submit a single zip named lab4_<studentnumber>.zip containing your C source and a two-page PDF report, due on Canvas Friday March 27 at 11:59 PM (late submissions lose 10% per day). The demo is worth 60% and the report 40%; the TA checks the counter keeps time to within one second over a two-minute run.",
    observations: [createReadObservation(LAB_HANDOUT)],
    usedWorkup: false,
    loaded: loadedStub,
  });

  assert.equal(verified.ok, true);
  assert.equal(verified.confidence, "high");
  assert.equal(verified.note, null);
  assert.deepEqual(
    verified.sources.map((source) => `${source.title} — ${source.section}`),
    ["lab4.txt — SUBMISSION", "lab4.txt — Grading"]
  );
  assert.match(verified.sources[0]?.excerpt ?? "", /lab4_<studentnumber>\.zip|Friday March 27/);
});

test("verifyWorkspaceAnswer synthesises sections across two read documents in one answer", () => {
  const syllabus = [
    "ECE243 Syllabus",
    "",
    "Late policy",
    "-----------",
    "All labs lose 10% per day late, to a maximum of three days. After three days the lab receives zero.",
    "",
    "Academic integrity",
    "------------------",
    "You may discuss approaches but every line of submitted code must be your own.",
  ].join("\n");

  const verified = verifyWorkspaceAnswer({
    question: "Compare the lab handout's late penalty with what the syllabus says about late labs.",
    answer:
      "Both agree on 10% per day: the lab handout says late submissions lose 10% per day, and the syllabus adds that labs lose 10% per day to a maximum of three days, after which the lab receives zero.",
    observations: [
      createReadObservation(LAB_HANDOUT),
      createReadObservation(syllabus, "syllabus.txt"),
    ],
    usedWorkup: false,
    loaded: loadedStub,
  });

  assert.equal(verified.confidence, "high");
  assert.deepEqual(
    verified.sources.map((source) => `${source.title} — ${source.section}`),
    ["lab4.txt — SUBMISSION", "syllabus.txt — Late policy"]
  );
  assert.equal(verified.note, null);
});

test("verifyWorkspaceAnswer keeps document-level citations for unsectioned reads and search-provided section labels", () => {
  const flatRead = verifyWorkspaceAnswer({
    question: "What must the waveform show?",
    answer: "The waveform must show the stall cycles around the branch hazard.",
    observations: [
      {
        tool: "read_file",
        status: "ok",
        summary: "Read docs/reference.txt.",
        artifacts: [
          {
            artifactId: "artifact-1",
            title: "docs/reference.txt",
            kind: "extracted",
            excerpt: "The waveform must show stall cycles around the branch hazard.",
          },
        ],
        content: "The waveform must show stall cycles around the branch hazard.",
      },
    ],
    usedWorkup: false,
    loaded: loadedStub,
  });
  assert.deepEqual(flatRead.sources, [
    {
      title: "docs/reference.txt",
      kind: "extracted",
      excerpt: "The waveform must show stall cycles around the branch hazard.",
    },
  ]);

  const searchOnly = verifyWorkspaceAnswer({
    question: "What does the branch hazard section mention?",
    answer: "It mentions the stall cycles around the branch hazard.",
    observations: [
      {
        tool: "search_workspace",
        status: "ok",
        summary: "Found a workspace match for branch hazard.",
        artifacts: [
          {
            artifactId: "artifact-1",
            title: "docs/reference.txt",
            kind: "extracted",
            excerpt: "The waveform must show stall cycles around the branch hazard.",
            sectionLabel: "Branch hazard walkthrough",
          },
        ],
      },
    ],
    usedWorkup: false,
    loaded: loadedStub,
  });
  assert.equal(searchOnly.sources[0]?.section, "Branch hazard walkthrough");
  assert.equal(searchOnly.confidence, "medium");
});

test("verifyWorkspaceAnswer falls back to the document when a sectioned read does not support the answer wording", () => {
  const verified = verifyWorkspaceAnswer({
    question: "What does the lab 4 handout say?",
    answer: "",
    observations: [createReadObservation(LAB_HANDOUT)],
    usedWorkup: false,
    loaded: loadedStub,
  });

  // An empty answer attributes against the question; "lab 4 handout" only
  // matches the preamble weakly, so the citation stays at document level.
  assert.ok(verified.sources.length >= 1);
  assert.equal(verified.sources[0]?.title, "lab4.txt");
  assert.equal(verified.missing.includes("source"), false);
});

test("buildReadModelText frames a read with its source and section outline so the model can cite sections", () => {
  const framed = buildReadModelText(
    { title: "lab4.txt", kind: "extracted" },
    LAB_HANDOUT
  );

  assert.match(framed, /^\[Source: lab4\.txt \(extracted\)\]/);
  assert.match(
    framed,
    /Sections in this document: 1\. Learning objectives \| Part 1: Configuring the private timer \| Part 2: The interrupt service routine \| Part 3: Driving the HEX displays \| SUBMISSION \| Grading\./
  );
  assert.match(framed, /name the section you drew from/);
  assert.ok(framed.endsWith(LAB_HANDOUT), "the full content follows the header untouched");

  const flat = buildReadModelText(
    { title: "notes.txt", kind: "notes" },
    "A single paragraph with no headings."
  );
  assert.match(flat, /^\[Source: notes\.txt \(notes\)\]/);
  assert.doesNotMatch(flat, /Sections in this document/);
  assert.equal(buildReadModelText(undefined, "raw"), "raw");
});

test("read_file returns section-framed text to the model while the UI and observation keep the raw document", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const loaded = await createWorkspace(tempDir);
    const ctx = createChatContext(
      { provider: "anthropic", model: "test-model" },
      loaded
    );

    const read = await executeToolCallForTurn(
      new Map(),
      "read_file",
      { filename: "lab4.txt" },
      ctx
    );

    assert.equal(read.result.observation.status, "ok");
    assert.match(read.result.modelText, /^\[Source: lab4\.txt \(extracted\)\]/);
    assert.match(read.result.modelText, /Part 2: The interrupt service routine \|/);
    assert.match(read.result.modelText, /0xFFFEC60C/);
    assert.doesNotMatch(read.result.uiText, /^\[Source:/);
    assert.equal(read.result.observation.content, LAB_HANDOUT);

    const verified = verifyWorkspaceAnswer({
      question: "How do I set up the private timer?",
      answer:
        "Set the private timer load register at 0xFFFEC600 to 200,000,000 so it counts one second at 200 MHz, and enable the I bit in the control register before starting the timer.",
      observations: [read.result.observation],
      usedWorkup: false,
      loaded,
    });
    assert.deepEqual(
      verified.sources.map((source) => source.section),
      ["Part 1: Configuring the private timer"]
    );
    assert.match(verified.sources[0]?.excerpt ?? "", /0xFFFEC600/);
  });
});
