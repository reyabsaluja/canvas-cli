import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractFileText, extractZip } from "../src/extract/extract-text.js";
import { unpackAttachmentZip } from "../src/ingest/attachment-extraction.js";
import type { DownloadedAttachmentEntry } from "../src/ingest/types.js";
import { buildZipBuffer } from "./helpers/build-zip.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-zip-nested-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * outer.zip
 *   level1.zip
 *     level2.zip
 *       level3.zip        <- depth 3: still read
 *         l3.md           "LEVEL3-MARKER"
 *         level4.zip      <- depth 4: skipped with a note
 *           deepest.md    "LEVEL4-MARKER"
 */
function buildFourDeepZip(): Buffer {
  const level4 = buildZipBuffer([{ name: "deepest.md", content: "LEVEL4-MARKER\n" }]);
  const level3 = buildZipBuffer([
    { name: "l3.md", content: "LEVEL3-MARKER\n" },
    { name: "level4.zip", content: level4 },
  ]);
  const level2 = buildZipBuffer([{ name: "level3.zip", content: level3 }]);
  const level1 = buildZipBuffer([{ name: "level2.zip", content: level2 }]);
  return buildZipBuffer([{ name: "level1.zip", content: level1 }]);
}

test("extractFileText extracts searchable text from zip files inside zips", async () => {
  await withTempDir(async (dir) => {
    const innerZip = buildZipBuffer([
      {
        name: "specs/lab-rubric.md",
        content: "# Lab Rubric\nNested archive says timing diagrams are required.\n",
      },
    ]);
    const outerZipPath = path.join(dir, "starter-bundle.zip");
    await fs.writeFile(
      outerZipPath,
      buildZipBuffer([
        { name: "README.md", content: "# Starter Bundle\nOpen the nested archive for the rubric.\n" },
        { name: "resources/rubric-pack.zip", content: innerZip },
      ])
    );

    const text = await extractFileText(outerZipPath, "starter-bundle.zip");

    assert.match(text, /ZIP: starter-bundle\.zip \(2 files\)/);
    assert.match(text, /^  resources\/rubric-pack\.zip \(\d+B\)$/m, "the inner zip is listed");
    assert.match(text, /--- resources\/rubric-pack\.zip ---\nZIP: resources\/rubric-pack\.zip \(1 files\)/);
    assert.match(text, /--- specs\/lab-rubric\.md ---/);
    assert.match(text, /Nested archive says timing diagrams are required\./);
  });
});

test("a zip nested four deep is read to depth 3 and the fourth level is skipped with a note", async () => {
  await withTempDir(async (dir) => {
    const zipPath = path.join(dir, "outer.zip");
    await fs.writeFile(zipPath, buildFourDeepZip());

    const text = await extractZip(zipPath, "outer.zip");

    assert.match(text, /LEVEL3-MARKER/, "content three zips down is still extracted");
    assert.doesNotMatch(text, /LEVEL4-MARKER/, "the fourth level must not be inflated");
    assert.match(text, /^\s+level4\.zip \(\d+B\)$/m, "the fourth-level zip is still listed");
    assert.match(text, /\[Skipped level4\.zip: nested more than 3 zips deep\]/);
  });
});

test("bytes inflated from a nested zip count toward the archive's total cap", async () => {
  await withTempDir(async (dir) => {
    const innerZip = buildZipBuffer([
      { name: "big.txt", content: `BIG-MARKER\n${"x".repeat(2000)}` },
    ]);
    const zipPath = path.join(dir, "outer.zip");
    await fs.writeFile(
      zipPath,
      buildZipBuffer([
        { name: "notes.txt", content: "NOTES-MARKER" },
        { name: "inner.zip", content: innerZip },
      ])
    );

    // 2500 B: notes.txt (12 B) + inner.zip (~2.1 KB) fit, but inflating big.txt
    // (2 KB) out of inner.zip would push the running total past the cap.
    const text = await extractZip(zipPath, "outer.zip", { maxTotalBytes: 2500 });

    assert.match(text, /--- notes\.txt ---\nNOTES-MARKER/);
    assert.match(text, /--- inner\.zip ---\nZIP: inner\.zip \(1 files\)/);
    assert.doesNotMatch(text, /BIG-MARKER/, "the nested entry must not be inflated past the shared cap");
    assert.match(text, /\[Read stopped: archive inflates past the 2 KB total cap\]/);
  });
});

test("unpackAttachmentZip unpacks nested zips into .unpacked trees and stops at depth 3", async () => {
  await withTempDir(async (coursePath) => {
    const zipDir = path.join(coursePath, "attachments", "modules");
    await fs.mkdir(zipDir, { recursive: true });
    await fs.writeFile(path.join(zipDir, "outer.zip"), buildFourDeepZip());

    const attachment: DownloadedAttachmentEntry = {
      sourceType: "module_linked",
      canvasFileId: 1,
      originalFilename: "outer.zip",
      localPath: "attachments/modules/outer.zip",
      contentType: "application/zip",
      size: 0,
      downloadUrl: "https://canvas.example/files/1/download",
      reason: "test",
      status: "downloaded",
    };

    const entries = await unpackAttachmentZip(coursePath, attachment);
    const names = entries.map((entry) => entry.entryName);

    assert.ok(names.includes("level1.zip"));
    assert.ok(names.includes("level1.zip.unpacked/level2.zip"));
    assert.ok(names.includes("level1.zip.unpacked/level2.zip.unpacked/level3.zip"));
    const l3 = entries.find(
      (entry) =>
        entry.entryName === "level1.zip.unpacked/level2.zip.unpacked/level3.zip.unpacked/l3.md"
    );
    assert.ok(l3, "a file three zips down is unpacked and addressable");
    assert.equal(l3.filename, "l3.md");
    assert.ok(l3.extractedTextPath, "the depth-3 file gets a text sidecar");
    assert.match(
      await fs.readFile(path.join(coursePath, l3.extractedTextPath), "utf-8"),
      /LEVEL3-MARKER/
    );
    assert.ok(
      names.includes("level1.zip.unpacked/level2.zip.unpacked/level3.zip.unpacked/level4.zip"),
      "the depth-4 zip itself is listed"
    );
    assert.ok(
      !names.some((name) => name.includes("level4.zip.unpacked/")),
      "nothing below depth 3 is unpacked"
    );
  });
});
