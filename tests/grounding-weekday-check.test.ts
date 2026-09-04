import assert from "node:assert/strict";
import test from "node:test";
import { checkWeekdayNextToDate, extractDateClaims, findUnsupportedAnswerClaims } from "../src/agent/verify.js";

const EVIDENCE = "## Submission\n\nLab 4 is due March 27, 2026 at 11:59 PM.";

test("before/after: a wrong weekday beside a supported date is flagged", () => {
  const claims = findUnsupportedAnswerClaims("Lab 4 is due Thursday March 27 at 11:59 PM.", EVIDENCE);
  assert.equal(claims.length, 1, JSON.stringify(claims));
  assert.match(claims[0]!, /Thursday March 27 \(March 27, 2026 is a Friday\)/);
});

test("the correct weekday in any spelling passes, and no weekday means no check", () => {
  for (const answer of ["due Friday March 27", "due Fri., March 27, 2026", "due on March 27 (Friday)", "due March 27 at noon"]) {
    assert.deepEqual(findUnsupportedAnswerClaims(answer, EVIDENCE), [], answer);
  }
});

test("checkWeekdayNextToDate uses the claim's own year before the evidence's", () => {
  const [claim] = extractDateClaims("march 27, 2025");
  // March 27, 2025 was a Thursday.
  assert.equal(checkWeekdayNextToDate("due thursday march 27, 2025", claim!, [2026]), null);
  assert.match(checkWeekdayNextToDate("due friday march 27, 2025", claim!, [2026]) ?? "", /is a Thursday/);
});
