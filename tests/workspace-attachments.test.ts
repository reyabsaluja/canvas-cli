import assert from "node:assert/strict";
import test from "node:test";
import {
  extractLinkedFileFromUrl,
  extractLinkedFiles,
} from "../src/workspace/attachments.js";

test("extractLinkedFiles only accepts Canvas file links from the Canvas origin", () => {
  const files = extractLinkedFiles(
    [
      '<a class="instructure_file_link" title="evil.txt" href="https://attacker.example/files/123?verifier=steal">Evil</a>',
      '<a class="instructure_file_link" title="starter.txt" href="/courses/17/files/77?wrap=1&amp;verifier=abc">Starter</a>',
      '<iframe title="rubric.pdf" src="https://canvas.example/files/88?wrap=1"></iframe>',
    ].join(""),
    "https://canvas.example/api/v1"
  );

  assert.deepEqual(
    files.map((file) => ({
      title: file.title,
      url: file.url,
      downloadUrl: file.downloadUrl,
    })),
    [
      {
        title: "starter.txt",
        url: "https://canvas.example/courses/17/files/77?wrap=1&verifier=abc",
        downloadUrl: "https://canvas.example/courses/17/files/77/download?verifier=abc",
      },
      {
        title: "rubric.pdf",
        url: "https://canvas.example/files/88?wrap=1",
        downloadUrl: "https://canvas.example/files/88/download",
      },
    ]
  );
});

test("extractLinkedFileFromUrl rejects untrusted origins and missing Canvas base", () => {
  assert.equal(
    extractLinkedFileFromUrl(
      "https://attacker.example/courses/17/files/77",
      "evil.txt",
      "https://canvas.example/api/v1"
    ),
    null
  );
  assert.equal(
    extractLinkedFileFromUrl("/courses/17/files/77", "starter.txt"),
    null
  );
});
