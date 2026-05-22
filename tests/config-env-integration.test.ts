import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "canvas-cli-env-test-"));
process.env.XDG_CONFIG_HOME = tempDir;

// Save original env
const originalEnv = { ...process.env };

const { writeStoredConfig, deleteStoredConfig } = await import("../src/config/store.js");
const { storeCredential, deleteAllCredentials } = await import("../src/config/credentials.js");
const { loadConfig } = await import("../src/config/env.js");
const { loadStoredCredentialsToEnv } = await import("../src/config/load-credentials-to-env.js");

function resetEnv() {
  delete process.env.CANVAS_BASE_URL;
  delete process.env.CANVAS_ACCESS_TOKEN;
  delete process.env.CANVAS_CLI_PROFILE;
  delete process.env.AI_PROVIDER;
  delete process.env.AI_MODEL;
  delete process.env.AI_EFFORT;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.AWS_REGION;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
}

describe("loadConfig integration", () => {
  const profile = "default";

  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    resetEnv();
    deleteAllCredentials(profile);
    try { deleteStoredConfig(profile); } catch {}
    Object.assign(process.env, originalEnv);
  });

  test("env vars take precedence over stored config", () => {
    writeStoredConfig({ canvasBaseUrl: "https://stored.com" }, profile);
    storeCredential(profile, "canvas-token", "stored-token");

    process.env.CANVAS_BASE_URL = "https://env.com";
    process.env.CANVAS_ACCESS_TOKEN = "env-token";

    const config = loadConfig();
    assert.equal(config.baseUrl, "https://env.com");
    assert.equal(config.accessToken, "env-token");
  });

  test("falls back to stored config when env vars missing", () => {
    writeStoredConfig({ canvasBaseUrl: "https://stored.com" }, profile);
    storeCredential(profile, "canvas-token", "stored-token");

    const config = loadConfig();
    assert.equal(config.baseUrl, "https://stored.com/api/v1");
    assert.equal(config.accessToken, "stored-token");
  });

  test("strips trailing slash and appends /api/v1 from stored base URL", () => {
    writeStoredConfig({ canvasBaseUrl: "https://stored.com///" }, profile);
    storeCredential(profile, "canvas-token", "tok");

    const config = loadConfig();
    assert.equal(config.baseUrl, "https://stored.com/api/v1");
  });

  test("does not double-append /api/v1 if already present in stored config", () => {
    writeStoredConfig({ canvasBaseUrl: "https://stored.com/api/v1" }, profile);
    storeCredential(profile, "canvas-token", "tok");

    const config = loadConfig();
    assert.equal(config.baseUrl, "https://stored.com/api/v1");
  });
});

describe("loadStoredCredentialsToEnv", () => {
  const profile = "default";

  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    resetEnv();
    deleteAllCredentials(profile);
    Object.assign(process.env, originalEnv);
  });

  test("injects AI provider from stored config", () => {
    writeStoredConfig({ canvasBaseUrl: "https://test.com", aiProvider: "anthropic", aiModel: "claude-sonnet-4-20250514" }, profile);

    loadStoredCredentialsToEnv();

    assert.equal(process.env.AI_PROVIDER, "anthropic");
    assert.equal(process.env.AI_MODEL, "claude-sonnet-4-20250514");
  });

  test("does not overwrite existing env vars", () => {
    writeStoredConfig({ canvasBaseUrl: "https://test.com", aiProvider: "anthropic" }, profile);
    process.env.AI_PROVIDER = "openai";

    loadStoredCredentialsToEnv();

    assert.equal(process.env.AI_PROVIDER, "openai");
  });

  test("injects API keys from credential store", () => {
    writeStoredConfig({ canvasBaseUrl: "https://test.com" }, profile);
    storeCredential(profile, "openai-key", "sk-test123");

    loadStoredCredentialsToEnv();

    assert.equal(process.env.OPENAI_API_KEY, "sk-test123");
  });
});

// Cleanup
process.on("exit", () => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch {}
});
