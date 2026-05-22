import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { CanvasClient } from "../src/canvas/client.js";
import { CanvasApiError } from "../src/canvas/errors.js";
import type { Config } from "../src/config/env.js";

function create503Server(): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errors: [{ message: "Service Unavailable" }] }));
  });
}

function createConnectionRefusingConfig(): Config {
  return {
    baseUrl: "http://127.0.0.1:1/api/v1",
    accessToken: "test-token-valid",
  };
}

test("integration: Canvas API unavailable", async (t) => {
  await t.test("503 on fetchPaginated endpoints triggers safe fallback to empty array", async () => {
    const server = create503Server();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "test-token-valid",
    };

    const client = new CanvasClient(config, {
      maxRetries: 0,
      baseDelayMs: 10,
    });

    const modules = await client.getModulesSafe(101);
    assert.deepEqual(modules, []);

    const pages = await client.getPagesSafe(101);
    assert.deepEqual(pages, []);

    const files = await client.getFilesSafe(101);
    assert.deepEqual(files, []);

    assert.ok(client.skippedEndpoints.length > 0);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  await t.test("503 on non-safe endpoints throws after retries exhausted", async () => {
    const server = create503Server();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "test-token-valid",
    };

    const client = new CanvasClient(config, {
      maxRetries: 1,
      baseDelayMs: 10,
      maxDelayMs: 50,
      sleepFn: async () => {},
    });

    await assert.rejects(
      () => client.getCourses(),
      (err: unknown) => {
        assert.ok(err instanceof CanvasApiError);
        assert.equal(err.status, 503);
        return true;
      }
    );

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  await t.test("connection refused throws network error", async () => {
    const config = createConnectionRefusingConfig();

    const client = new CanvasClient(config, {
      maxRetries: 0,
      requestTimeoutMs: 1000,
    });

    await assert.rejects(
      () => client.getCourses(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });

  await t.test("safe endpoints return empty on connection refused", async () => {
    const config = createConnectionRefusingConfig();

    const client = new CanvasClient(config, {
      maxRetries: 0,
      requestTimeoutMs: 1000,
    });

    const file = await client.getFileSafe(123);
    assert.equal(file, null);

    const page = await client.getPageBySlugSafe(101, "anything");
    assert.equal(page, null);
  });

  await t.test("skippedEndpoints tracks which endpoints failed", async () => {
    const server = create503Server();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    const config: Config = {
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      accessToken: "test-token-valid",
    };

    const client = new CanvasClient(config, {
      maxRetries: 0,
      baseDelayMs: 10,
    });

    client.resetSkippedEndpoints();
    assert.equal(client.skippedEndpoints.length, 0);

    await client.getModulesSafe(1);
    await client.getFilesSafe(2);
    assert.equal(client.skippedEndpoints.length, 2);
    assert.ok(client.skippedEndpoints[0].includes("/modules"));
    assert.ok(client.skippedEndpoints[1].includes("/files"));

    client.resetSkippedEndpoints();
    assert.equal(client.skippedEndpoints.length, 0);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
