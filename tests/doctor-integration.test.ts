import { test, describe, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../src/tui/doctor.js";

describe("runDoctor integration", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CANVAS_BASE_URL = "https://canvas.example.edu/api/v1";
    process.env.CANVAS_ACCESS_TOKEN = "12345~AbcDef";
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AI_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    mock.restoreAll();
  });

  test("all checks pass when Canvas API responds 200", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response(JSON.stringify({ name: "Test User", id: 42 }), {
        status: 200,
        headers: { "X-Rate-Limit-Remaining": "500" },
      });
    });

    const output = await runDoctor();
    assert.match(output, /✓ \*\*Configuration\*\*/);
    assert.match(output, /✓ \*\*Canvas token\*\*/);
    assert.match(output, /✓ \*\*Token format\*\*/);
    assert.match(output, /✓ \*\*Canvas API\*\*/);
    assert.match(output, /Test User/);
    assert.match(output, /rate limit remaining: 500/);
    assert.match(output, /All checks passed/);
  });

  test("reports failure when Canvas API returns 401", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response("Unauthorized", { status: 401 });
    });

    const output = await runDoctor();
    assert.match(output, /✗ \*\*Canvas API\*\*/);
    assert.match(output, /401 Unauthorized/);
    assert.match(output, /1 issue found/);
  });

  test("reports failure when no config is present", async () => {
    delete process.env.CANVAS_BASE_URL;
    delete process.env.CANVAS_ACCESS_TOKEN;
    process.env.CANVAS_CLI_PROFILE = "__doctor_test_nonexistent__";

    const output = await runDoctor();
    assert.match(output, /✗ \*\*Configuration\*\*/);
    assert.match(output, /No stored config/);
  });

  test("reports missing token when only URL is set", async () => {
    delete process.env.CANVAS_ACCESS_TOKEN;
    process.env.CANVAS_CLI_PROFILE = "__doctor_test_nonexistent__";

    const output = await runDoctor();
    assert.match(output, /✓ \*\*Configuration\*\*/);
    assert.match(output, /✗ \*\*Canvas token\*\*/);
    assert.match(output, /No token found/);
  });

  test("reports connection timeout", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("TimeoutError: signal timed out");
    });

    const output = await runDoctor();
    assert.match(output, /✗ \*\*Canvas API\*\*/);
    assert.match(output, /timed out/);
  });

  test("skips AI provider when not configured", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response(JSON.stringify({ name: "User", id: 1 }), {
        status: 200,
      });
    });

    const output = await runDoctor();
    assert.match(output, /– \*\*AI provider\*\*/);
    assert.match(output, /Not configured/);
  });
});
