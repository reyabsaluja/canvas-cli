import test from "node:test";
import assert from "node:assert/strict";
import { createKeyParser } from "../src/tui/terminal.js";
import { getPinOverlayIndent, getVisibleInputSegment } from "../src/tui/workspace-input.js";

test("createKeyParser buffers split CSI sequences until complete", () => {
  const keys: string[] = [];
  const parser = createKeyParser((key) => keys.push(key));

  parser("\x1b");
  assert.deepEqual(keys, []);

  parser("[A");
  assert.deepEqual(keys, ["\x1b[A"]);
});

test("createKeyParser buffers split mouse sequences until complete", () => {
  const keys: string[] = [];
  const parser = createKeyParser((key) => keys.push(key));

  parser("\x1b[<64;42;7");
  assert.deepEqual(keys, []);

  parser("M");
  assert.deepEqual(keys, ["\x1b[<64;42;7M"]);
});

test("pin overlay indentation follows the visible input tail", () => {
  const boxWidth = 18;
  const input = "This is a long prompt that ends with @plan";
  const visible = getVisibleInputSegment(input, boxWidth).text;

  assert.ok(visible.includes("@"));
  assert.equal(getPinOverlayIndent(input, boxWidth), 1 + visible.indexOf("@"));
});
