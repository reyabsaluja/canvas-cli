import assert from "node:assert/strict";
import test from "node:test";
import { extractInlinePins } from "../src/tui/pins.js";
import { getActivePinPartial, getPinOverlayIndent } from "../src/tui/workspace-input.js";

const options = [{ label: "lab3_handout_pdf", title: "Lab3 handout.pdf", path: "/x", kind: "file" }] as any;

test("an email address is not read as a pin", () => {
  const result = extractInlinePins("email ta@uni.edu about the extension", options);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.resolved, []);
  assert.equal(result.cleanInput, "email ta@uni.edu about the extension");
});

test("a pin at the start of a word still resolves", () => {
  const result = extractInlinePins("summarize @lab3 please", options);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.cleanInput, "summarize please");
});

test("autocomplete only opens for an @ that starts a word", () => {
  assert.equal(getActivePinPartial("mail ta@uni"), null);
  assert.equal(getActivePinPartial("read @lab"), "lab");
  assert.equal(getActivePinPartial("@"), "");
  assert.equal(getPinOverlayIndent("read @lab", 80), 1 + "read ".length);
});
