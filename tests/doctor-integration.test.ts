import { test, describe, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../src/tui/doctor.js";

describe("runDoctor integration", () => {
  const originalEnv = { ...process.env };

  function restoreEnv() {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  }

  beforeEach(() => {
    process.env.CANVAS_BASE_URL = "https://canvas.example.edu/api/v1";
    process.env.CANVAS_ACCESS_TOKEN = "12345~AbcDef";
    process.env.CANVAS_CLI_PROFILE = "doctor-integration-test";
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AI_PROVIDER;
  });

  afterEach(() => {
    restoreEnv();
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

  test("reports redirect as SSO failure", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://sso.example.edu/login" },
      });
    });

    const output = await runDoctor();
    assert.match(output, /✗ \*\*Canvas API\*\*/);
    assert.match(output, /Redirected/);
    assert.match(output, /SSO/);
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

  test("reports AI provider failure when key is invalid (401)", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-invalid-key";

    mock.method(globalThis, "fetch", async (url: string | URL) => {
      if (String(url).includes("canvas.example.edu")) {
        return new Response(JSON.stringify({ name: "User", id: 1 }), {
          status: 200,
        });
      }
      return new Response("Unauthorized", { status: 401 });
    });

    const output = await runDoctor();
    assert.match(output, /✓ \*\*AI config\*\*/);
    assert.match(output, /✗ \*\*AI provider\*\*/);
    assert.match(output, /invalid or revoked/);
  });

  test("reports AI provider pass when key is valid", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-valid-key";

    mock.method(globalThis, "fetch", async (url: string | URL) => {
      if (String(url).includes("canvas.example.edu")) {
        return new Response(JSON.stringify({ name: "User", id: 1 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const output = await runDoctor();
    assert.match(output, /✓ \*\*AI config\*\*/);
    assert.match(output, /✓ \*\*AI provider\*\*/);
    assert.match(output, /openai key is valid/);
  });
});
