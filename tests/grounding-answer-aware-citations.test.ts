import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { Observation } from "../src/agent/observation.js";
import { verifyWorkspaceAnswer } from "../src/agent/verify.js";

// The question is phrased in the student's words ("hand it in on Saturday");
// the document that answers it uses the course's words ("late", "10% per
// day"). Citation relevance must consider the answer text too, or a read
// that plainly supports the answer is dropped as irrelevant.
const SYLLABUS = [
  "ECE243 Syllabus",
  "",
  "## Late policy",
  "",
  "All labs lose 10% per day late, to a maximum of three days. After three days the lab receives zero.",
  "",
  "## Academic integrity",
  "",
  "You may discuss approaches but every line of submitted code must be your own.",
].join("\n");

const LAB_HANDOUT = [
  "# Lab 4",
  "",
  "## Submission",
  "",
  "Hand in a single zip on Canvas by Friday at 11:59 PM. Anything received on Saturday or later is late.",
].join("\n");

const QUESTION = "What happens if I hand it in on Saturday?";
const ANSWER =
  "Late submissions lose 10% per day, to a maximum of three days; after three days the lab receives zero.";

function createReadObservation(content: string, title: string): Observation {
  return {
    tool: "read_file",
    status: "ok",
    summary: `Read ${title}.`,
    artifacts: [
      {
        artifactId: `workspace:extracted:${title}`,
        title,
        kind: "extracted",
        excerpt: content.slice(0, 80),
      },
    ],
    content,
  };
}

const loadedStub = { workupJson: null } as unknown as LoadedWorkspace;

test("before/after: a read that supports the answer but not the question's wording still counts as a direct read", () => {
  const verified = verifyWorkspaceAnswer({
    question: QUESTION,
    answer: ANSWER,
    observations: [createReadObservation(SYLLABUS, "syllabus.txt")],
    usedWorkup: false,
    loaded: loadedStub,
  });

  assert.equal(verified.confidence, "high", JSON.stringify(verified));
  assert.doesNotMatch(verified.note ?? "", /search evidence/);
  assert.deepEqual(
    verified.sources.map((source) => `${source.title} — ${source.section}`),
    ["syllabus.txt — Late policy"]
  );
});

test("before/after: a second read that only the answer draws on is still cited", () => {
  const verified = verifyWorkspaceAnswer({
    question: QUESTION,
    answer: ANSWER,
    observations: [
      createReadObservation(LAB_HANDOUT, "lab4.txt"),
      createReadObservation(SYLLABUS, "syllabus.txt"),
    ],
    usedWorkup: false,
    loaded: loadedStub,
  });

  assert.equal(verified.confidence, "high");
  const titles = verified.sources.map((source) => source.title);
  assert.ok(titles.includes("syllabus.txt"), `expected the syllabus to be cited, got ${titles.join(", ")}`);
  assert.ok(
    verified.sources.some((source) => source.title === "syllabus.txt" && source.section === "Late policy"),
    `expected the Late policy section, got ${JSON.stringify(verified.sources)}`
  );
});
