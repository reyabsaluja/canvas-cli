import assert from "node:assert/strict";
import test from "node:test";
import { getAIConfig, formatModelName, classifyAIError, isAIProviderError, AIError } from "../src/ai/provider.js";

const KEYS = ["AI_PROVIDER", "AI_MODEL", "AI_EFFORT", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"];

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Keep the credential store out of it.
  const savedBackend = process.env.CANVAS_CLI_CREDENTIAL_BACKEND;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.CANVAS_CLI_CREDENTIAL_BACKEND = "file";
  process.env.XDG_CONFIG_HOME = "/nonexistent/canvas-cli-test";
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (savedBackend === undefined) delete process.env.CANVAS_CLI_CREDENTIAL_BACKEND;
    else process.env.CANVAS_CLI_CREDENTIAL_BACKEND = savedBackend;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  }
}

test("getAIConfig accepts copilot without any API key", () => {
  withEnv({ AI_PROVIDER: "copilot", AI_EFFORT: "high" }, () => {
    assert.deepEqual(getAIConfig(), { provider: "copilot", model: "auto", effort: "high" });
  });
});

test("getAIConfig accepts codex and its aliases without any API key", () => {
  withEnv({ AI_PROVIDER: "codex" }, () => {
    assert.deepEqual(getAIConfig(), { provider: "codex", model: "default" });
  });
  withEnv({ AI_PROVIDER: "chatgpt", AI_MODEL: "gpt-5.4-codex" }, () => {
    assert.deepEqual(getAIConfig(), { provider: "codex", model: "gpt-5.4-codex" });
  });
  withEnv({ AI_PROVIDER: "github-copilot" }, () => {
    assert.equal(getAIConfig()?.provider, "copilot");
  });
});

test("subscription providers are never auto-detected; API keys still win when AI_PROVIDER is unset", () => {
  withEnv({}, () => {
    assert.equal(getAIConfig(), null);
  });
  withEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }, () => {
    assert.equal(getAIConfig()?.provider, "anthropic");
  });
});

test("an explicit API-key provider is unchanged by the subscription additions", () => {
  withEnv({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test", AI_MODEL: "claude-sonnet-4-6", AI_EFFORT: "medium" }, () => {
    assert.deepEqual(getAIConfig(), { provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" });
  });
  withEnv({ AI_PROVIDER: "openai" }, () => {
    assert.equal(getAIConfig(), null, "openai without a key must still be rejected");
  });
});

test("formatModelName labels the subscription defaults", () => {
  assert.equal(formatModelName("auto", "high"), "Copilot auto · high");
  assert.equal(formatModelName("default"), "Codex default");
});

test("classifyAIError passes AIError through and isAIProviderError recognises it", () => {
  const error = new AIError("nope", "auth", { setupHint: "run login" });
  assert.equal(classifyAIError(error), error);
  assert.equal(isAIProviderError(error), true);
  assert.equal(error.userMessage, "nope run login");
});
