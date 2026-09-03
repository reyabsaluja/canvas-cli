import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractZip } from "../src/extract/extract-text.js";
import { buildZipBuffer } from "./helpers/build-zip.js";

async function withZip(entries: Array<{ name: string; content: Buffer | string }>, fn: (zipPath: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-zip-caps-"));
  try {
    const zipPath = path.join(dir, "lab4.zip");
    await fs.writeFile(zipPath, buildZipBuffer(entries));
    await fn(zipPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("before/after: a 60k-character handout inside a zip is no longer cut at 30k", async () => {
  const body = `${"Part 1 setup instructions. ".repeat(2000)}\n## Part 9: Submission\nSubmit lab4.tar.gz by Friday.`;
  assert.ok(body.length > 50_000, "fixture must exceed the old caps");
  await withZip([{ name: "lab4/handout.md", content: body }], async (zipPath) => {
    const text = await extractZip(zipPath, "lab4.zip");
    assert.match(text, /Submit lab4\.tar\.gz by Friday\./, "the tail of the handout must survive");
    assert.doesNotMatch(text, /Text truncated/);
  });
});

test("an entry past the per-file cap says how much was omitted instead of cutting silently", async () => {
  const huge = "x".repeat(130_000) + " END-MARKER";
  await withZip([{ name: "notes.txt", content: huge }], async (zipPath) => {
    const text = await extractZip(zipPath, "big.zip");
    assert.match(text, /\[Text truncated: \d+ more characters of notes\.txt omitted/);
    assert.doesNotMatch(text, /END-MARKER/);
  });
});
