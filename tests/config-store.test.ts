import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Set XDG_CONFIG_HOME before importing modules so they use the temp dir
const tempDir = mkdtempSync(join(tmpdir(), "canvas-cli-test-"));
process.env.XDG_CONFIG_HOME = tempDir;

const { readStoredConfig, writeStoredConfig, deleteStoredConfig, listProfiles } = await import("../src/config/store.js");
const { getConfigDir, getConfigFilePath } = await import("../src/config/paths.js");

describe("config paths", () => {
  test("uses XDG_CONFIG_HOME when set", () => {
    const dir = getConfigDir();
    assert.equal(dir, join(tempDir, "canvas-cli"));
  });

  test("default profile uses config.json", () => {
    const path = getConfigFilePath("default");
    assert.equal(path, join(tempDir, "canvas-cli", "config.json"));
  });

  test("named profile uses config.<name>.json", () => {
    const path = getConfigFilePath("school2");
    assert.equal(path, join(tempDir, "canvas-cli", "config.school2.json"));
  });
});

describe("config store", () => {
  beforeEach(() => {
    // Clean up between tests
    const dir = getConfigDir();
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    const dir = getConfigDir();
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  });

  test("readStoredConfig returns null when no config exists", () => {
    const result = readStoredConfig("default");
    assert.equal(result, null);
  });

  test("writeStoredConfig creates config file with correct content", () => {
    const config = { canvasBaseUrl: "https://school.instructure.com" };
    writeStoredConfig(config, "default");

    const filePath = getConfigFilePath("default");
    assert.ok(existsSync(filePath));

    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.deepEqual(content, config);
  });

  test("writeStoredConfig creates config directory with restrictive permissions", () => {
    writeStoredConfig({ canvasBaseUrl: "https://test.com" }, "default");
    const dir = getConfigDir();
    const stats = statSync(dir);
    assert.equal(stats.mode & 0o777, 0o700);
  });

  test("writeStoredConfig creates config file with restrictive permissions", () => {
    writeStoredConfig({ canvasBaseUrl: "https://test.com" }, "default");
    const filePath = getConfigFilePath("default");
    const stats = statSync(filePath);
    assert.equal(stats.mode & 0o777, 0o600);
  });

  test("readStoredConfig reads back written config", () => {
    const config = {
      canvasBaseUrl: "https://school.instructure.com",
      aiProvider: "openai",
      aiModel: "gpt-4o",
    };
    writeStoredConfig(config, "default");

    const result = readStoredConfig("default");
    assert.deepEqual(result, config);
  });

  test("deleteStoredConfig removes config file", () => {
    writeStoredConfig({ canvasBaseUrl: "https://test.com" }, "default");
    const deleted = deleteStoredConfig("default");
    assert.equal(deleted, true);
    assert.equal(readStoredConfig("default"), null);
  });

  test("deleteStoredConfig returns false when no config exists", () => {
    const deleted = deleteStoredConfig("nonexistent");
    assert.equal(deleted, false);
  });

  test("profiles are isolated from each other", () => {
    writeStoredConfig({ canvasBaseUrl: "https://school1.com" }, "school1");
    writeStoredConfig({ canvasBaseUrl: "https://school2.com" }, "school2");

    const s1 = readStoredConfig("school1");
    const s2 = readStoredConfig("school2");
    assert.equal(s1?.canvasBaseUrl, "https://school1.com");
    assert.equal(s2?.canvasBaseUrl, "https://school2.com");
  });

  test("listProfiles returns all profile names", () => {
    writeStoredConfig({ canvasBaseUrl: "https://default.com" }, "default");
    writeStoredConfig({ canvasBaseUrl: "https://school2.com" }, "school2");
    writeStoredConfig({ canvasBaseUrl: "https://work.com" }, "work");

    const profiles = listProfiles();
    assert.ok(profiles.includes("default"));
    assert.ok(profiles.includes("school2"));
    assert.ok(profiles.includes("work"));
  });

  test("listProfiles returns empty array when no config exists", () => {
    const profiles = listProfiles();
    assert.deepEqual(profiles, []);
  });
});

// Cleanup
process.on("exit", () => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch {}
});
