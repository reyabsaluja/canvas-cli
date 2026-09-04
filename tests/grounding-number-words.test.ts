import assert from "node:assert/strict";
import test from "node:test";
import { findUnsupportedAnswerClaims, spellOutNumbersToDigits } from "../src/agent/verify.js";

test("spellOutNumbersToDigits converts figures that carry a unit and leaves prose alone", () => {
  assert.equal(spellOutNumbersToDigits("Late work loses ten percent per day for up to three days."), "Late work loses 10 percent per day for up to 3 days.");
  assert.equal(spellOutNumbersToDigits("worth twenty-five marks and twenty five points"), "worth 25 marks and 25 points");
  assert.equal(spellOutNumbersToDigits("one of the labs is optional; fifteen minutes each"), "one of the labs is optional; 15 minutes each");
  assert.equal(spellOutNumbersToDigits("two hundred words"), "200 words");
});

test("before/after: a spelled-out figure is checked against numeric evidence and vice versa", () => {
  const evidence = "## Late policy\n\nLate submissions lose 10% per day. Reports are capped at 200 words.";
  assert.deepEqual(findUnsupportedAnswerClaims("Late work loses ten percent per day.", evidence), []);
  assert.deepEqual(findUnsupportedAnswerClaims("Late work loses fifteen percent per day.", evidence), ["15 percent"]);
  const spelledEvidence = "## Late policy\n\nLate submissions lose ten percent per day.";
  assert.deepEqual(findUnsupportedAnswerClaims("Late work loses 10% per day.", spelledEvidence), []);
  assert.deepEqual(findUnsupportedAnswerClaims("Late work loses 12% per day.", spelledEvidence), ["12%"]);
});
