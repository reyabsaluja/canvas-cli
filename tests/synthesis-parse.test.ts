import assert from "node:assert/strict";
import test from "node:test";
import { parseSynthesisResponse } from "../src/work/synthesis.js";

const BASE_WORKUP = {
  overview: "Lab 4 asks the student to implement and explain a datapath.",
  deliverables: ["report.pdf", "starter.zip"],
  constraints: ["Submit before Friday"],
  relevant_resources: [
    {
      title: "lab4-spec.pdf",
      type: "pdf",
      location: "modules > Lab 4",
      why: "primary instructions",
    },
  ],
  recommended_read_order: ["lab4-spec.pdf", "rubric.pdf"],
  action_plan: [
    { step: 1, action: "Read the spec", detail: null },
    { step: 2, action: "Build the datapath", detail: "use the provided ALU" },
  ],
  uncertainties: [],
  due_date: "2026-04-27",
  confidence: "high",
  source_trace: [
    { conclusion: "ALU uses signed overflow", source: "lab4-spec.pdf" },
  ],
};

test("parseSynthesisResponse parses a well-formed response", () => {
  const raw = JSON.stringify(BASE_WORKUP);
  const parsed = parseSynthesisResponse(raw);
  assert.equal(parsed.overview, BASE_WORKUP.overview);
  assert.deepEqual(parsed.deliverables, BASE_WORKUP.deliverables);
  assert.equal(parsed.dueDate, "2026-04-27");
  assert.equal(parsed.confidence, "high");
  assert.equal(parsed.actionPlan.length, 2);
});

test("parseSynthesisResponse strips markdown fences", () => {
  const raw = "```json\n" + JSON.stringify(BASE_WORKUP) + "\n```";
  const parsed = parseSynthesisResponse(raw);
  assert.equal(parsed.overview, BASE_WORKUP.overview);
});

test("parseSynthesisResponse ignores trailing prose after the JSON object", () => {
  const raw = `${JSON.stringify(BASE_WORKUP)}\n\nHope that helps! Let me know if you'd like me to dig deeper.`;
  const parsed = parseSynthesisResponse(raw);
  assert.equal(parsed.overview, BASE_WORKUP.overview);
});

test("parseSynthesisResponse recovers from trailing commas in arrays and objects", () => {
  const raw = `{
    "overview": "test",
    "deliverables": ["a", "b",],
    "relevant_resources": [{"title":"x","type":"pdf","location":"l","why":"w",}],
    "action_plan": [],
    "uncertainties": [],
    "recommended_read_order": [],
    "constraints": [],
    "due_date": null,
    "confidence": "medium",
    "source_trace": [],
  }`;
  const parsed = parseSynthesisResponse(raw);
  assert.deepEqual(parsed.deliverables, ["a", "b"]);
  assert.equal(parsed.relevantResources[0]?.title, "x");
});

test("parseSynthesisResponse recovers from // line comments", () => {
  const raw = `{
    "overview": "test", // this is a comment
    "deliverables": ["a"],
    "constraints": [],
    "relevant_resources": [],
    "recommended_read_order": [],
    "action_plan": [],
    "uncertainties": [],
    "due_date": null,
    "confidence": "low",
    "source_trace": []
  }`;
  const parsed = parseSynthesisResponse(raw);
  assert.equal(parsed.overview, "test");
  assert.deepEqual(parsed.deliverables, ["a"]);
});

test("parseSynthesisResponse recovers a response truncated mid-array", () => {
  const raw = `{
    "overview": "Student should implement the datapath.",
    "deliverables": ["report.pdf", "starter.zip"],
    "constraints": ["use signed overflow detection"],
    "relevant_resources": [
      {"title":"lab4-spec.pdf","type":"pdf","location":"modules","why":"primary instructions"},
      {"title":"rubric.pdf","type":"pdf","location":"modules","why":"grading"},
      {"title":"partia`;
  const parsed = parseSynthesisResponse(raw);
  assert.equal(parsed.overview, "Student should implement the datapath.");
  assert.deepEqual(parsed.deliverables, ["report.pdf", "starter.zip"]);
  assert.equal(parsed.relevantResources.length, 2);
  assert.equal(parsed.relevantResources[0]?.title, "lab4-spec.pdf");
  assert.equal(parsed.relevantResources[1]?.title, "rubric.pdf");
});

test("parseSynthesisResponse recovers a response truncated mid-string inside an object", () => {
  const raw = `{
    "overview": "ok",
    "deliverables": ["a"],
    "constraints": [],
    "relevant_resources": [
      {"title":"spec.pdf","type":"pdf","location":"modules","why":"primary"},
      {"title":"rubric.pdf","type":"pdf","location":"modules","why":"grading crite`;
  const parsed = parseSynthesisResponse(raw);
  assert.equal(parsed.overview, "ok");
  assert.equal(parsed.relevantResources.length, 1);
  assert.equal(parsed.relevantResources[0]?.title, "spec.pdf");
});

test("parseSynthesisResponse recovers a response truncated at a top-level key", () => {
  const raw = `{
    "overview": "complete",
    "deliverables": ["one"],
    "constraints": ["x"],
    "relevant_resources": [],
    "recommended_read_order": [],
    "action_plan": [{"step":1,"action":"read"}],
    "uncertainties`;
  const parsed = parseSynthesisResponse(raw);
  assert.equal(parsed.overview, "complete");
  assert.deepEqual(parsed.deliverables, ["one"]);
  assert.equal(parsed.actionPlan[0]?.action, "read");
});

test("parseSynthesisResponse throws a SynthesisParseError for unrecoverable output", () => {
  assert.throws(
    () => parseSynthesisResponse("not json at all, no braces anywhere"),
    /Could not parse synthesis response/
  );
});
