import assert from "node:assert/strict";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";

const config = { baseUrl: "https://canvas.school.edu/api/v1", accessToken: "secret-token" };

function withFetch(stub: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("downloadFile never sends the token to a non-Canvas origin", async () => {
  let called = false;
  await withFetch(
    (async () => {
      called = true;
      return new Response("x");
    }) as typeof fetch,
    async () => {
      const client = new CanvasClient(config);
      assert.equal(await client.downloadFile("https://evil.example.com/files/1/download"), null);
      assert.equal(called, false);
    }
  );
});

test("downloadFile refuses a body over the download limit", async () => {
  await withFetch(
    (async () =>
      new Response("small body", {
        status: 200,
        headers: { "content-length": String(500 * 1024 * 1024) },
      })) as typeof fetch,
    async () => {
      const client = new CanvasClient(config);
      assert.equal(await client.downloadFile("https://canvas.school.edu/files/1/download"), null);
    }
  );
});

test("downloadFile returns the body for a Canvas file", async () => {
  await withFetch(
    (async () => new Response("lab handout", { status: 200 })) as typeof fetch,
    async () => {
      const client = new CanvasClient(config);
      const body = await client.downloadFile("https://canvas.school.edu/files/1/download");
      assert.equal(body?.toString(), "lab handout");
    }
  );
});
