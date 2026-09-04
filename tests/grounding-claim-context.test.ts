import assert from "node:assert/strict";
import test from "node:test";
import {
  collectUnsupportedRequirementClaims,
  findContextuallyUnsupportedClaims,
} from "../src/agent/claim-context.js";
import { findUnsupportedAnswerClaims } from "../src/agent/verify.js";

const SCHEDULE = "## Schedule\n\nLab 3 is due March 20 at 11:59 PM.\nLab 4 is due March 27 at 11:59 PM.";

test("before/after: a date borrowed from a neighbouring lab is flagged, naming the anchored figure", () => {
  const claims = findUnsupportedAnswerClaims("Lab 4 is due March 20.", SCHEDULE, "when is lab 4 due?");
  assert.equal(claims.length, 1);
  assert.match(claims[0]!, /March 20/);
  assert.match(claims[0]!, /March 27/);
  assert.match(claims[0]!, /Lab 4/i);
});

test("the figure the anchored line actually carries is not flagged", () => {
  assert.deepEqual(findUnsupportedAnswerClaims("Lab 4 is due March 27.", SCHEDULE, "when is lab 4 due?"), []);
  // The anchor may come from the question alone.
  assert.deepEqual(findUnsupportedAnswerClaims("It is due March 27 at 11:59 PM.", SCHEDULE, "when is lab 4 due?"), []);
  // Filenames anchor too.
  assert.deepEqual(
    findUnsupportedAnswerClaims("lab4.pdf says March 27.", "lab3.pdf: due March 20\nlab4.pdf: due March 27"),
    []
  );
  assert.equal(
    findUnsupportedAnswerClaims("lab4.pdf says March 20.", "lab3.pdf: due March 20\nlab4.pdf: due March 27").length,
    1
  );
});

test("evidence with a single date never triggers the anchor check", () => {
  const single = "## Schedule\n\nLab 3 is due March 20 at 11:59 PM. Lab 4 is worth 10% of the grade.";
  assert.deepEqual(findContextuallyUnsupportedClaims("Lab 4 is due March 20.", single, "when is lab 4 due?"), []);
  assert.deepEqual(findUnsupportedAnswerClaims("Lab 4 is due March 20.", single, "when is lab 4 due?"), []);
});

test("competing quantities are anchored the same way as dates", () => {
  const weights = "Lab 3 is worth 10% of the grade.\nLab 4 is worth 15% of the grade.";
  const wrong = findUnsupportedAnswerClaims("Lab 4 is worth 10% of the grade.", weights, "how much is lab 4 worth?");
  assert.equal(wrong.length, 1);
  assert.match(wrong[0]!, /10%/);
  assert.match(wrong[0]!, /15%/);
  assert.deepEqual(findUnsupportedAnswerClaims("Lab 4 is worth 15% of the grade.", weights, "how much is lab 4 worth?"), []);
});

test("an answer that lists both labs with their own dates is supported", () => {
  assert.deepEqual(
    findUnsupportedAnswerClaims("Lab 3 is due March 20 and Lab 4 is due March 27.", SCHEDULE, "when are the labs due?"),
    []
  );
});

test("an anchored line without any figure of that kind does not flag the claim", () => {
  const evidence = "Lab 4: build the timer.\nLab 3 is due March 20.\nThe final report is due March 27.";
  assert.deepEqual(findContextuallyUnsupportedClaims("Lab 4 is due March 27.", evidence, "when is lab 4 due?"), []);
});

test("a must claim is flagged when every overlapping evidence clause only says may", () => {
  const claims = collectUnsupportedRequirementClaims(
    "You must include a waveform in the report.",
    "You may include a waveform in the report. Submit the report as a PDF."
  );
  assert.equal(claims.length, 1);
  assert.match(claims[0]!, /must include a waveform/i);
  assert.match(claims[0]!, /may/);
  assert.match(
    findUnsupportedAnswerClaims("You must include a waveform in the report.", "You may include a waveform in the report.")[0] ?? "",
    /may/
  );
});

test("requirement claims backed by a strong or imperative evidence clause pass", () => {
  assert.deepEqual(
    collectUnsupportedRequirementClaims("You must include a waveform.", "Include a waveform screenshot in the report."),
    []
  );
  assert.deepEqual(
    collectUnsupportedRequirementClaims("You must include a waveform.", "A waveform is required. You may also include a schematic."),
    []
  );
  // No overlapping evidence clause: nothing to contradict, nothing flagged.
  assert.deepEqual(collectUnsupportedRequirementClaims("You must include a waveform.", "Late work loses 10% per day."), []);
  // A hedged answer clause is not a strong claim.
  assert.deepEqual(
    collectUnsupportedRequirementClaims("You may need to include a waveform.", "You may include a waveform."),
    []
  );
});
