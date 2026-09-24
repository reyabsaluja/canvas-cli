import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadSelectedAttachments } from "../src/ingest/attachment-download.js";

const config = { baseUrl: "https://canvas.example/api/v1", accessToken: "t" };

const attachment = (size: number | null) => ({
  sourceType: "module_linked" as const,
  fileId: 1,
  filename: "lab.pdf",
  downloadUrl: "https://canvas.example/files/1/download",
  reason: "test",
  contentType: "application/pdf",
  size,
  subfolder: "modules",
});

async function run(
  existing: string | null,
  selections: ReturnType<typeof attachment>[],
  refresh: boolean
): Promise<{ statuses: string[]; fetches: number; content: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-refresh-"));
  const file = path.join(dir, "modules", "lab.pdf");
  if (existing !== null) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, existing);
  }
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response("fresh", { status: 200 });
  }) as typeof fetch;
  try {
    const results = await downloadSelectedAttachments(selections, dir, config, null, null, { refresh });
    return { statuses: results.map((r) => r.status), fetches, content: await fs.readFile(file, "utf8") };
  } finally {
    globalThis.fetch = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("an unchanged file on disk is kept", async () => {
  const r = await run("old", [attachment(3)], false);
  assert.deepEqual(r.statuses, ["skipped"]);
  assert.equal(r.fetches, 0);
  assert.equal(r.content, "old");
});

test("a file Canvas reports at a different size is downloaded again", async () => {
  const r = await run("old", [attachment(5)], false);
  assert.deepEqual(r.statuses, ["downloaded"]);
  assert.equal(r.content, "fresh");
});

test("refresh downloads an existing file again, once per run", async () => {
  const r = await run("old", [attachment(3), attachment(3)], true);
  assert.equal(r.fetches, 1);
  assert.equal(r.content, "fresh");
});
