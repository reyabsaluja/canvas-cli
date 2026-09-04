import assert from "node:assert/strict";
import test from "node:test";
import type { Observation } from "../src/agent/observation.js";
import { buildStepReflectionNote } from "../src/agent/observation.js";
import { scoreObservationRelevance } from "../src/agent/observation-relevance.js";
import { questionNeedsMultipleSources } from "../src/agent/question-intent.js";

const LAB4_READ: Observation = {
  tool: "read_file",
  status: "ok",
  summary: "Read lab4.pdf.",
  artifacts: [
    {
      artifactId: "lab4",
      title: "lab4.pdf",
      kind: "attachment",
      excerpt: "Lab 4 is due Friday March 27 at 11:59 PM.",
    },
  ],
  content:
    "## Submission\nLab 4 is due Friday March 27 at 11:59 PM. Submit a zip on Canvas.\n",
};

test("questionNeedsMultipleSources treats multi-part questions as needing more than one source", () => {
  for (const question of [
    "When is Lab 4 due and how is it graded?",
    "What do I submit and where do I upload it?",
    "Explain the rubric and tell me what the late penalty is.",
    "Are both the report and the demo required?",
    "What is the late penalty? Also, when is the deadline?",
    // A joiner plus two evidence topics (due date + late policy) without a
    // second question word.
    "What are the due date and the late penalty for lab 4?",
    "I need the submission format, the grading weights, and the deadline.",
    // A comma between two distinct topics is a joiner.
    "what's the late penalty, and how many points is it worth",
    "Late penalty, submission format?",
    "Tell me both the late penalty and the deadline.",
  ]) {
    assert.equal(questionNeedsMultipleSources(question), true, question);
  }
});

test("questionNeedsMultipleSources leaves single-fact questions alone", () => {
  for (const question of [
    "when is lab 4 due?",
    "What is the late penalty?",
    "How is the report graded?",
    "Where do I upload the zip?",
    "Explain the branch hazard requirement in detail.",
    // "and" inside a single topic is not a second topic.
    "What is the due date and time?",
    // A comma or "and" that does not sit between two topics is not a joiner.
    "Hey, what's the late penalty in points?",
    "Please, when is lab 4 due?",
    "Is the late penalty 10% per day and is that per weekday?",
  ]) {
    assert.equal(questionNeedsMultipleSources(question), false, question);
  }
});

test("questionNeedsMultipleSources treats broad preparation questions as multi-source unless they target one fact", () => {
  for (const question of [
    "What do I need to know before starting Lab 4?",
    "What should I review before the midterm?",
    "How should I prepare for the demo?",
    "Anything I should study for the quiz?",
  ]) {
    assert.equal(questionNeedsMultipleSources(question), true, question);
  }
  for (const question of [
    "What should I know about the due date?",
    "What do I need to submit?",
    "How should I prepare the zip for submission?",
  ]) {
    assert.equal(questionNeedsMultipleSources(question), false, question);
  }
});

test("buildStepReflectionNote asks for a second source after one read of a multi-topic question", () => {
  const question = "When is Lab 4 due and how is it graded?";
  const note = buildStepReflectionNote({
    step: 1,
    maxSteps: 12,
    observation: LAB4_READ,
    groundedReadCount: 1,
    needsMultipleSources: questionNeedsMultipleSources(question),
  });
  assert.match(note, /read a second relevant source/i);
  assert.match(note, /1 grounded read/);

  const singleFactNote = buildStepReflectionNote({
    step: 1,
    maxSteps: 12,
    observation: LAB4_READ,
    groundedReadCount: 1,
    needsMultipleSources: questionNeedsMultipleSources("when is lab 4 due?"),
  });
  assert.doesNotMatch(singleFactNote, /read a second relevant source/i);
});

test("scoreObservationRelevance rewards a section label that names the question's topic", () => {
  const withoutSection: Observation = {
    tool: "search_course",
    status: "ok",
    summary: 'Found 1 course match for "policy".',
    artifacts: [
      {
        artifactId: "syllabus",
        title: "syllabus.pdf",
        kind: "attachment",
        excerpt: "Assignments handed in after the deadline lose 10% per day.",
      },
    ],
  };
  const withSection: Observation = {
    ...withoutSection,
    artifacts: [{ ...withoutSection.artifacts[0]!, sectionLabel: "Late Penalty" }],
  };

  const question = "late penalty";
  const baseline = scoreObservationRelevance(question, withoutSection);
  const boosted = scoreObservationRelevance(question, withSection);
  assert.ok(
    boosted > baseline,
    `expected the section label to raise relevance (${boosted} vs ${baseline})`
  );
  // A full-phrase match on the section label alone is enough to count the
  // observation as relevant even when the title and excerpt say nothing.
  assert.equal(baseline, 0);
  assert.ok(boosted >= 14);
});
