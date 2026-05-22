import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "canvas-cli-model-test-"));
process.env.XDG_CONFIG_HOME = tempDir;
process.env.CANVAS_PROFILE = "default";

const { modelCommand } = await import("../src/commands/model.js");
const { writeStoredConfig } = await import("../src/config/store.js");

const ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_EFFORT",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function withEnv(env: Record<string, string>, fn: () => Promise<void> | void) {
  return async () => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(env)) {
      process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
        else delete process.env[k];
      }
    }
  };
}

// Suppress stdout from the command's clearScreen/printHeader
const originalWrite = process.stdout.write.bind(process.stdout);
const originalLog = console.log;
beforeEach(() => {
  process.stdout.write = () => true;
  console.log = () => {};
});
afterEach(() => {
  process.stdout.write = originalWrite;
  console.log = originalLog;
});

describe("modelCommand dispatch", () => {
  test(
    "effort subcommand returns null when no provider configured",
    withEnv({}, async () => {
      const result = await modelCommand("effort");
      assert.equal(result, null);
    })
  );

  test(
    "effort subcommand is case-insensitive",
    withEnv({}, async () => {
      const result = await modelCommand("EFFORT");
      assert.equal(result, null);
    })
  );

  test(
    "key subcommand returns null when no provider configured",
    withEnv({}, async () => {
      const result = await modelCommand("key");
      assert.equal(result, null);
    })
  );

  test(
    "key subcommand is case-insensitive",
    withEnv({}, async () => {
      const result = await modelCommand("KEY");
      assert.equal(result, null);
    })
  );

  test(
    "effort subcommand returns null for google provider",
    withEnv(
      { AI_PROVIDER: "google", GOOGLE_API_KEY: "test", AI_MODEL: "gemini-3.5-flash" },
      async () => {
        writeStoredConfig(
          { canvasBaseUrl: "", aiProvider: "google", aiModel: "gemini-3.5-flash" },
          "default"
        );
        const result = await modelCommand("effort");
        assert.equal(result, null);
      }
    )
  );
});
