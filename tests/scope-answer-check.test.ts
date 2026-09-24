import assert from "node:assert/strict";
import test from "node:test";
import { checkScopeAnswer, readableIsoDates } from "../src/tui/chat-assistant.js";

test("checkScopeAnswer: no note when the answer's dates and figures are in the evidence", () => {
  const evidence = ["Upcoming assignments:\n- Lab 3 — ECE221 — due Sep 25 at 11:59 PM — worth 15%"];
  assert.equal(checkScopeAnswer("Lab 3 is due Sep 25 and is worth 15%.", evidence, "when is lab 3 due"), null);
});

test("checkScopeAnswer: flags a date that appears nowhere the model was shown", () => {
  const evidence = ["- Lab 3 — ECE221 — due Sep 25 at 11:59 PM"];
  const note = checkScopeAnswer("Lab 3 is due Oct 2.", evidence, "when is lab 3 due");
  assert.match(note ?? "", /Oct(ober)? 2/);
});

test("checkScopeAnswer: accepts dates that only appear as ISO timestamps", () => {
  const evidence = ["- Lab 3 — ECE221 — 2026-09-25T12:00:00.000Z"];
  assert.equal(checkScopeAnswer("Lab 3 is due September 25.", evidence, "what's due"), null);
});

test("checkScopeAnswer: tool results and earlier turns count as evidence", () => {
  const evidence = ["Earlier: the midterm is on October 14.", '{"due_at":"2026-11-03T15:00:00Z"}'];
  assert.equal(checkScopeAnswer("Midterm Oct 14, project Nov 3.", evidence, "dates?"), null);
});

test("checkScopeAnswer: empty answer gets no note", () => {
  assert.equal(checkScopeAnswer("  ", [], "hi"), null);
});

test("readableIsoDates: a late deadline is spelled out on its UTC day too", () => {
  assert.match(readableIsoDates("2026-09-26T03:59:00Z"), /September 26, 2026/);
});

test("readableIsoDates: a bare date is that calendar day", () => {
  assert.equal(readableIsoDates("2026-03-20"), "March 20, 2026");
});
