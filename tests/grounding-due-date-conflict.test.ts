import assert from "node:assert/strict";
import test from "node:test";
import { compareDueDates, describeDueDate } from "../src/work/generate-markdown.js";

const canvas = new Date(2026, 2, 27, 23, 59); // March 27, local time

test("before/after: a syllabus date that disagrees with Canvas is surfaced as a conflict", () => {
  const lines = describeDueDate(canvas, "March 20, 2026");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /\*\(Canvas\)\*/);
  assert.match(lines[1]!, /Due-date conflict.*March 20, 2026.*does not match Canvas/);
});

test("an agreeing document date is noted as matching, in any spelling", () => {
  for (const spelling of ["March 27", "Mar. 27, 2026", "27 March 2026", "2026-03-27", "3/27"]) {
    const lines = describeDueDate(canvas, spelling);
    assert.equal(lines.length, 1, spelling);
    assert.match(lines[0]!, /matches the syllabus\/schedule/, spelling);
  }
});

test("unparseable document dates are shown verbatim without claiming a conflict", () => {
  const lines = describeDueDate(canvas, "end of week 9");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /the syllabus\/schedule says "end of week 9"/);
  assert.equal(compareDueDates(canvas, "end of week 9"), "unknown");
});

test("Canvas-only, document-only and missing dates keep their previous wording", () => {
  assert.deepEqual(describeDueDate(canvas, null).map((l) => l.replace(/\d+:\d+ (AM|PM)/, "T")), ["**Due:** Fri, Mar 27, 2026, T"]);
  assert.deepEqual(describeDueDate(null, "April 3"), ["**Due:** April 3 *(inferred from syllabus/schedule)*"]);
  assert.deepEqual(describeDueDate(null, null), ["**Due:** not set on Canvas"]);
});
