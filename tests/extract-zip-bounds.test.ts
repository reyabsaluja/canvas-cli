import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  ZipEntryTooLargeError,
  extractFileText,
  extractZip,
  readZipEntryBounded,
  unpackZipToDirectory,
} from "../src/extract/extract-text.js";
import { writeZipEntryBounded } from "../src/extract/zip-bounds.js";
import { buildZipBuffer, type ZipFixtureEntry } from "./helpers/build-zip.js";

const HUGE_BYTES = 101 * 1024 * 1024; // one megabyte past the 100 MB per-entry cap

async function withZip(
  entries: ZipFixtureEntry[],
  fn: (zipPath: string, dir: string) => Promise<void>,
  zipName = "archive.zip"
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-zip-bounds-"));
  try {
    const zipPath = path.join(dir, zipName);
    await fs.writeFile(zipPath, buildZipBuffer(entries));
    await fn(zipPath, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(root, full));
    }
  };
  await walk(root);
  return out.sort();
}

test(
  "a 101 MB entry is listed with its size but its body is skipped with a note; the rest of the zip is still read",
  { timeout: 60_000 },
  async () => {
    const entries: ZipFixtureEntry[] = [
      { name: "huge.txt", content: Buffer.alloc(HUGE_BYTES, 0), method: "deflate" },
      { name: "notes.txt", content: "END-MARKER" },
    ];
    const zipBytes = buildZipBuffer(entries);
    assert.ok(zipBytes.length < 2 * 1024 * 1024, `fixture must be small on disk, got ${zipBytes.length}`);

    await withZip(entries, async (zipPath, dir) => {
      const text = await extractZip(zipPath, "archive.zip");
      assert.match(text, /^  huge\.txt \(103424KB\)$/m, "huge.txt must still appear in the listing with its size");
      assert.match(text, /\[Skipped huge\.txt: inflates past the 100 MB per-file cap\]/);
      assert.match(text, /END-MARKER/, "the small entry after the huge one must still be read");
      assert.doesNotMatch(text, /--- huge\.txt ---/, "the huge entry's body must not be inflated into the summary");

      const dest = path.join(dir, "unpacked");
      const unpacked = await unpackZipToDirectory(zipPath, dest);
      assert.deepEqual(
        unpacked.map((entry) => entry.entryName),
        ["notes.txt"],
        "only the entry within the cap is unpacked"
      );
      assert.deepEqual(await listFilesRecursive(dest), ["notes.txt"], "no .tmp-* or partial files may be left behind");
      assert.equal(await fs.readFile(path.join(dest, "notes.txt"), "utf-8"), "END-MARKER");
    });
  }
);

test("entry-count limit: bodies stop after maxEntries, names are still listed, and the summary notes the stop", async () => {
  const entries: ZipFixtureEntry[] = Array.from({ length: 5 }, (_, i) => ({
    name: `file${i + 1}.txt`,
    content: `BODY-${i + 1}`,
  }));
  await withZip(entries, async (zipPath, dir) => {
    const dest = path.join(dir, "unpacked");
    const unpacked = await unpackZipToDirectory(zipPath, dest, { maxEntries: 3 });
    assert.equal(unpacked.length, 3, "unpack stops after maxEntries entries");
    assert.deepEqual(await listFilesRecursive(dest), ["file1.txt", "file2.txt", "file3.txt"]);

    const text = await extractZip(zipPath, "many.zip", { maxEntries: 3 });
    assert.match(text, /\[Read stopped after 3 entries\]/, "the summary must say why the rest was not read");
    for (let i = 1; i <= 5; i += 1) {
      assert.match(text, new RegExp(`^  file${i}\\.txt \\(\\d+B\\)$`, "m"), `file${i}.txt must still be listed`);
    }
    assert.match(text, /BODY-3/);
    assert.doesNotMatch(text, /BODY-4/, "bodies past the entry cap must not be read");
  });
});

test("total-bytes limit: reading stops once the archive inflates past maxTotalBytes", async () => {
  const entries: ZipFixtureEntry[] = Array.from({ length: 4 }, (_, i) => ({
    name: `part${i + 1}.txt`,
    content: `PART-${i + 1}-${"x".repeat(1000)}`,
  }));
  await withZip(entries, async (zipPath, dir) => {
    const dest = path.join(dir, "unpacked");
    const unpacked = await unpackZipToDirectory(zipPath, dest, { maxTotalBytes: 2500 });
    assert.equal(unpacked.length, 2, "two ~1 KB entries fit inside a 2.5 KB total cap; the third does not");
    assert.deepEqual(await listFilesRecursive(dest), ["part1.txt", "part2.txt"]);

    const text = await extractZip(zipPath, "parts.zip", { maxTotalBytes: 2500 });
    assert.match(text, /PART-2-/);
    assert.doesNotMatch(text, /PART-3-/);
    assert.match(text, /\[Read stopped: archive inflates past the .* total cap\]/);
  });
});

test(
  "a .docx whose word/document.xml inflates past the cap returns an error string instead of throwing",
  { timeout: 60_000 },
  async () => {
    const entries: ZipFixtureEntry[] = [
      { name: "[Content_Types].xml", content: "<Types/>" },
      { name: "word/document.xml", content: Buffer.alloc(HUGE_BYTES, 0x20), method: "deflate" },
    ];
    await withZip(
      entries,
      async (zipPath) => {
        const text = await extractFileText(zipPath, "big.docx");
        assert.match(text, /^\[Error reading "big\.docx":/, "the container must be refused, not silently parsed");
        assert.match(text, /100 MB/, "the message must name the cap");
      },
      "big.docx"
    );
  }
);

test("an Office container with more parts, or more inflated XML, than the archive caps allow is refused with an error string", async () => {
  const documentXml =
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello from the document part</w:t></w:r></w:p></w:body></w:document>';
  const entries: ZipFixtureEntry[] = [
    { name: "[Content_Types].xml", content: "<Types/>" },
    { name: "word/document.xml", content: documentXml },
    // Six ~1 KB XML parts the reader would otherwise inflate one after another.
    ...Array.from({ length: 6 }, (_, i) => ({
      name: `word/extra${i + 1}.xml`,
      content: `<extra>${"x".repeat(1000)}</extra>`,
    })),
  ];
  await withZip(
    entries,
    async (zipPath) => {
      assert.match(
        await extractFileText(zipPath, "many.docx"),
        /Hello from the document part/,
        "inside the default caps the document reads normally"
      );

      const overTotal = await extractFileText(zipPath, "many.docx", { maxTotalBytes: 2500 });
      assert.match(overTotal, /^\[Error reading "many\.docx":/, "the container must be refused, not partially parsed");
      assert.match(overTotal, /total cap/);
      assert.doesNotMatch(overTotal, /Hello from the document part/);

      const overCount = await extractFileText(zipPath, "many.docx", { maxEntries: 3 });
      assert.match(overCount, /^\[Error reading "many\.docx":/);
      assert.match(overCount, /more than 3/);
    },
    "many.docx"
  );
});

test("the streamed byte count refuses an entry that under-declares its size, before the whole body is inflated", async () => {
  // yauzl only reports a size mismatch after inflating everything (and not at
  // all for archives whose sizes it is unsure of), so the reader must stop on
  // its own count. Fake an entry that declares 10 bytes but streams 64 KB.
  let chunksServed = 0;
  const fakeEntry = {
    filename: "liar.txt",
    uncompressedSize: 10,
    async openReadStream() {
      return Readable.from(
        (async function* () {
          for (let i = 0; i < 64; i += 1) {
            chunksServed += 1;
            yield Buffer.alloc(1024, 0x41);
          }
        })()
      ) as unknown as NodeJS.ReadableStream;
    },
  };

  await assert.rejects(
    readZipEntryBounded(fakeEntry, 4096),
    (err: unknown) => err instanceof ZipEntryTooLargeError && /liar\.txt/.test(err.message)
  );
  assert.ok(chunksServed < 64, `must stop early, served ${chunksServed} of 64 chunks`);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-zip-bounds-"));
  try {
    const target = path.join(dir, "liar.txt");
    await assert.rejects(writeZipEntryBounded(fakeEntry, target, 4096), ZipEntryTooLargeError);
    assert.deepEqual(await listFilesRecursive(dir), [], "the partial .tmp-* file must be removed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
