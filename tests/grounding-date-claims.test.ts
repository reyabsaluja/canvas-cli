import assert from "node:assert/strict";
import test from "node:test";
import { extractDateClaims, findUnsupportedAnswerClaims } from "../src/agent/verify.js";

const EVIDENCE = "## Submission\n\nLab 4 is due Friday March 27 at 11:59 PM. Style is worth 20 marks. Late work loses 10% per day.";

test("before/after: a wrong date is flagged even when its day number appears elsewhere in the evidence", () => {
  const claims = findUnsupportedAnswerClaims("Lab 4 is due March 20 at 11:59 PM.", EVIDENCE, "when is lab 4 due?");
  assert.deepEqual(claims, ["March 20"]);
});

test("the right date in any common spelling is supported", () => {
  for (const answer of ["due March 27", "due Mar. 27, 2026", "due 27 March", "due on the 27th of March", "due 3/27", "due 03/27/2026"]) {
    assert.deepEqual(findUnsupportedAnswerClaims(answer, EVIDENCE), [], answer);
  }
});

test("dates in the question are not re-checked, and non-date figures still are", () => {
  assert.deepEqual(findUnsupportedAnswerClaims("Yes, March 20 is fine.", EVIDENCE, "can I submit on March 20?"), []);
  const claims = findUnsupportedAnswerClaims("Due March 27; late work loses 15% per day.", EVIDENCE);
  assert.deepEqual(claims, ["15%"]);
});

test("extractDateClaims normalises spellings to month-day keys", () => {
  const keys = extractDateClaims("march 27, 27 march, 3/27, Sept 3 2026, 12/25").map((claim) => claim.key);
  assert.deepEqual(keys, ["3-27", "3-27", "3-27", "9-3", "12-25"]);
  assert.deepEqual(extractDateClaims("version 14/32 and 0/5"), []);
});
