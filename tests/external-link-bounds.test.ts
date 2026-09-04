// These tests bind real local HTTP servers; they do not patch globalThis.fetch.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { captureExternalCourseLinks } from "../src/ingest/external-link-capture.js";

const config = {
  baseUrl: "https://canvas.example/api/v1",
  accessToken: "token",
};

async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function captureOptions(url: string, signal?: AbortSignal | null) {
  return {
    courseId: 17,
    courseHtmlUrl: "https://canvas.example/courses/17",
    modules: [],
    assignments: [],
    frontPageBody: `<p>See <a href="${url}">the reading</a>.</p>`,
    fetchedPages: [],
    syllabusBody: null,
    announcements: [],
    discussionThreads: [],
    config,
    signal,
  };
}

test("Ctrl-C during external-link capture aborts the in-flight request promptly", async () => {
  await withServer(
    () => {
      // Never respond: without an abort the request would run to the 30 s timeout.
    },
    async (baseUrl) => {
      const ac = new AbortController();
      const started = Date.now();
      setTimeout(() => ac.abort(), 20);

      await assert.rejects(
        captureExternalCourseLinks(captureOptions(`${baseUrl}/slow`, ac.signal)),
        (err: unknown) => err instanceof Error && err.name === "AbortError"
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2000, `expected the abort to surface quickly, took ${elapsed}ms`);
    }
  );
});

test("an external PDF larger than the body cap is recorded as metadata_only with a note naming the limit", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": "300000000",
      });
      // Stream a little of the body and then stall; the client must refuse it
      // from the declared size alone, not by draining 300 MB.
      res.write(Buffer.alloc(4096, 0x25));
    },
    async (baseUrl) => {
      const captured = await captureExternalCourseLinks(captureOptions(`${baseUrl}/big.pdf`));
      assert.equal(captured.length, 1);
      const [link] = captured;
      assert.equal(link!.entry.contentStatus, "metadata_only");
      assert.match(link!.text, /100 MB/, "the note must name the cap");
      assert.match(link!.text, /## Notes/);
    }
  );
});
