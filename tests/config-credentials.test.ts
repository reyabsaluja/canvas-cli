import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";

// Set XDG_CONFIG_HOME to temp dir for file-based fallback testing
const tempDir = mkdtempSync(join(tmpdir(), "canvas-cli-cred-test-"));
process.env.XDG_CONFIG_HOME = tempDir;
// Never touch the developer's real keychain from the test suite.
process.env.CANVAS_CLI_CREDENTIAL_BACKEND = "file";

const { storeCredential, loadCredential, deleteCredential, deleteAllCredentials } = await import("../src/config/credentials.js");
const { getConfigDir } = await import("../src/config/paths.js");

function keychainAvailable(): boolean {
  // Opt-in only: set CANVAS_CLI_TEST_KEYCHAIN=1 to exercise the real keychain locally.
  if (process.env.CANVAS_CLI_TEST_KEYCHAIN !== "1") return false;
  if (platform() !== "darwin") return false;
  if (process.env.CI) return false;
  try {
    execSync("security show-keychain-info login.keychain 2>/dev/null", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("credentials (file fallback)", () => {
  const testProfile = "test-file-creds";

  beforeEach(() => {
    // Ensure clean state
    deleteAllCredentials(testProfile);
  });

  afterEach(() => {
    deleteAllCredentials(testProfile);
  });

  if (keychainAvailable()) {
    test("stores and retrieves credential via keychain", () => {
      const testValue = `test-token-${Date.now()}`;
      storeCredential(testProfile, "canvas-token", testValue);
      const loaded = loadCredential(testProfile, "canvas-token");
      assert.equal(loaded, testValue);

      // Cleanup keychain
      deleteCredential(testProfile, "canvas-token");
    });

    test("deleteCredential removes from keychain", () => {
      const testValue = `delete-test-${Date.now()}`;
      storeCredential(testProfile, "canvas-token", testValue);
      const deleted = deleteCredential(testProfile, "canvas-token");
      assert.equal(deleted, true);

      const loaded = loadCredential(testProfile, "canvas-token");
      assert.equal(loaded, null);
    });
  }

  test("loadCredential returns null for non-existent credential", () => {
    const loaded = loadCredential("nonexistent-profile", "nonexistent-key");
    assert.equal(loaded, null);
  });

  test("deleteCredential returns false for non-existent credential", () => {
    const deleted = deleteCredential("nonexistent-profile", "nonexistent-key");
    assert.equal(deleted, false);
  });

  test("deleteAllCredentials removes all known credential keys", () => {
    storeCredential(testProfile, "canvas-token", "tok1");
    storeCredential(testProfile, "openai-key", "key1");

    deleteAllCredentials(testProfile);

    assert.equal(loadCredential(testProfile, "canvas-token"), null);
    assert.equal(loadCredential(testProfile, "openai-key"), null);
  });
});

// Cleanup
process.on("exit", () => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch {}
});
