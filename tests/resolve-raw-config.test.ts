import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "canvas-cli-resolve-test-"));
process.env.XDG_CONFIG_HOME = tempDir;

const originalEnv = { ...process.env };

const { writeStoredConfig } = await import("../src/config/store.js");
const { resolveRawConfig, resolveApiUrl } = await import("../src/config/env.js");

function resetEnv() {
  delete process.env.CANVAS_BASE_URL;
  delete process.env.CANVAS_ACCESS_TOKEN;
  delete process.env.CANVAS_CLI_PROFILE;
}

describe("resolveRawConfig", () => {
  beforeEach(() => resetEnv());
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("returns env values when CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN are set", () => {
    process.env.CANVAS_BASE_URL = "https://canvas.test.edu/api/v1";
    process.env.CANVAS_ACCESS_TOKEN = "99~Token";

    const raw = resolveRawConfig();
    assert.equal(raw.baseUrl, "https://canvas.test.edu/api/v1");
    assert.equal(raw.accessToken, "99~Token");
    assert.equal(raw.urlSource, "env");
    assert.equal(raw.credentialError, undefined);
  });

  test("returns undefined when no config exists", () => {
    process.env.CANVAS_CLI_PROFILE = "resolve-test-missing";

    const raw = resolveRawConfig();
    assert.equal(raw.baseUrl, undefined);
    assert.equal(raw.accessToken, undefined);
    assert.equal(raw.urlSource, "none");
  });

  test("uses stored config when env is not set", () => {
    process.env.CANVAS_CLI_PROFILE = "resolve-test-stored";
    writeStoredConfig({
      canvasBaseUrl: "https://stored.canvas.edu",
      aiProvider: undefined,
      aiModel: undefined,
    }, "resolve-test-stored");

    const raw = resolveRawConfig();
    assert.equal(raw.baseUrl, "https://stored.canvas.edu");
    assert.equal(raw.urlSource, "stored");
  });

  test("env takes precedence over stored config", () => {
    process.env.CANVAS_CLI_PROFILE = "resolve-test-precedence";
    process.env.CANVAS_BASE_URL = "https://env.canvas.edu/api/v1";
    writeStoredConfig({
      canvasBaseUrl: "https://stored.canvas.edu",
      aiProvider: undefined,
      aiModel: undefined,
    }, "resolve-test-precedence");

    const raw = resolveRawConfig();
    assert.equal(raw.baseUrl, "https://env.canvas.edu/api/v1");
    assert.equal(raw.urlSource, "env");
  });

  test("returns default profile when CANVAS_CLI_PROFILE is not set", () => {
    const raw = resolveRawConfig();
    assert.equal(raw.profile, "default");
  });

  test("returns custom profile when CANVAS_CLI_PROFILE is set", () => {
    process.env.CANVAS_CLI_PROFILE = "work";
    const raw = resolveRawConfig();
    assert.equal(raw.profile, "work");
  });
});

describe("resolveApiUrl", () => {
  test("returns undefined when baseUrl is undefined", () => {
    const result = resolveApiUrl({ baseUrl: undefined, accessToken: undefined, urlSource: "none", profile: "default" });
    assert.equal(result, undefined);
  });

  test("appends /api/v1 to stored URL without it", () => {
    const result = resolveApiUrl({ baseUrl: "https://canvas.edu", accessToken: "t", urlSource: "stored", profile: "default" });
    assert.equal(result, "https://canvas.edu/api/v1");
  });

  test("does not double-append /api/v1 to stored URL that already has it", () => {
    const result = resolveApiUrl({ baseUrl: "https://canvas.edu/api/v1", accessToken: "t", urlSource: "stored", profile: "default" });
    assert.equal(result, "https://canvas.edu/api/v1");
  });

  test("strips trailing slash from stored URL before appending", () => {
    const result = resolveApiUrl({ baseUrl: "https://canvas.edu/", accessToken: "t", urlSource: "stored", profile: "default" });
    assert.equal(result, "https://canvas.edu/api/v1");
  });

  test("returns env URL as-is (stripped of trailing slash)", () => {
    const result = resolveApiUrl({ baseUrl: "https://canvas.edu/api/v1/", accessToken: "t", urlSource: "env", profile: "default" });
    assert.equal(result, "https://canvas.edu/api/v1");
  });

  test("does not append /api/v1 to env URL", () => {
    const result = resolveApiUrl({ baseUrl: "https://canvas.edu", accessToken: "t", urlSource: "env", profile: "default" });
    assert.equal(result, "https://canvas.edu");
  });
});
