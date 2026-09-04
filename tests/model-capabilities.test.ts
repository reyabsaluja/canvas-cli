import assert from "node:assert/strict";
import test from "node:test";
import {
  EFFORT_LEVELS,
  clampEffort,
  deriveModelDisplayName,
  getModelCapabilities,
  isEffortLevel,
  parseClaudeModel,
  supportedEffortLevels,
} from "../src/ai/model-capabilities.js";
import { DEFAULT_MODEL_BY_PROVIDER, formatModelName } from "../src/ai/provider.js";
import { effortPickerOptions } from "../src/commands/login-providers.js";
import catalogJson from "../src/ai/models.json" with { type: "json" };

const ALL = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH = ["low", "medium", "high", "max"];
const UP_TO_XHIGH = ["low", "medium", "high", "xhigh"];
const UP_TO_HIGH = ["low", "medium", "high"];

const catalog = Object.fromEntries(
  Object.entries(catalogJson).filter(([key]) => !key.startsWith("$") && !key.startsWith("_"))
) as Record<string, Array<{ label: string; value: string; description?: string }>>;

test("effort levels are the five-step scale and isEffortLevel matches exactly", () => {
  assert.deepEqual([...EFFORT_LEVELS], ALL);
  for (const level of ALL) assert.ok(isEffortLevel(level), level);
  assert.equal(isEffortLevel("turbo"), false);
  assert.equal(isEffortLevel("HIGH"), false);
  assert.equal(isEffortLevel(undefined), false);
});

test("parseClaudeModel reads every id style", () => {
  assert.deepEqual(parseClaudeModel("claude-fable-5-1"), { family: "fable", major: 5, minor: 1, preview: false });
  assert.deepEqual(parseClaudeModel("claude-opus-5"), { family: "opus", major: 5, minor: 0, preview: false });
  assert.deepEqual(parseClaudeModel("us.anthropic.claude-opus-4-8"), { family: "opus", major: 4, minor: 8, preview: false });
  assert.deepEqual(parseClaudeModel("global.anthropic.claude-sonnet-4-6"), { family: "sonnet", major: 4, minor: 6, preview: false });
  assert.deepEqual(parseClaudeModel("us.anthropic.claude-opus-4-6-v1"), { family: "opus", major: 4, minor: 6, preview: false });
  assert.deepEqual(parseClaudeModel("us.anthropic.claude-haiku-4-5-20251001-v1:0"), { family: "haiku", major: 4, minor: 5, preview: false });
  assert.deepEqual(parseClaudeModel("claude-haiku-4-5@20251001"), { family: "haiku", major: 4, minor: 5, preview: false });
  assert.deepEqual(parseClaudeModel("claude-sonnet-4-20250514"), { family: "sonnet", major: 4, minor: 0, preview: false });
  assert.deepEqual(parseClaudeModel("claude-opus-4-1-20250805"), { family: "opus", major: 4, minor: 1, preview: false });
  assert.deepEqual(parseClaudeModel("claude-3-5-haiku-20241022"), { family: "haiku", major: 3, minor: 5, preview: false });
  assert.deepEqual(parseClaudeModel("claude-mythos-preview"), { family: "mythos", major: null, minor: 0, preview: true });
  assert.equal(parseClaudeModel("gpt-5.6"), null);
  assert.equal(parseClaudeModel("us.amazon.nova-pro-v1:0"), null);
});

test("current Claude models use adaptive thinking with all five effort levels", () => {
  for (const model of [
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-mythos-preview",
  ]) {
    assert.deepEqual(getModelCapabilities("anthropic", model), { control: "adaptive", effortLevels: ALL }, model);
  }
  for (const model of ["us.anthropic.claude-fable-5-1", "global.anthropic.claude-opus-5", "eu.anthropic.claude-sonnet-5"]) {
    assert.deepEqual(getModelCapabilities("bedrock", model), { control: "adaptive", effortLevels: ALL }, model);
  }
});

test("Claude 4.6 is adaptive without xhigh; older Claude keeps extended-thinking budgets", () => {
  assert.deepEqual(getModelCapabilities("anthropic", "claude-opus-4-6"), { control: "adaptive", effortLevels: NO_XHIGH });
  assert.deepEqual(getModelCapabilities("anthropic", "claude-sonnet-4-6"), { control: "adaptive", effortLevels: NO_XHIGH });
  assert.deepEqual(getModelCapabilities("bedrock", "us.anthropic.claude-opus-4-6-v1"), { control: "adaptive", effortLevels: NO_XHIGH });
  for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-opus-4-5-20251101", "claude-sonnet-4-5", "claude-3-7-sonnet-20250219"]) {
    assert.deepEqual(getModelCapabilities("anthropic", model), { control: "extended", effortLevels: NO_XHIGH }, model);
  }
  assert.deepEqual(getModelCapabilities("bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0"), { control: "extended", effortLevels: NO_XHIGH });
});

test("OpenAI effort levels follow the model generation", () => {
  for (const model of ["gpt-6-astra", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.deepEqual(getModelCapabilities("openai", model), { control: "reasoning-effort", effortLevels: ALL }, model);
  }
  for (const model of ["gpt-5.5", "gpt-5.5-2026-04-23", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-pro"]) {
    assert.deepEqual(getModelCapabilities("openai", model), { control: "reasoning-effort", effortLevels: UP_TO_XHIGH }, model);
  }
  for (const model of ["gpt-5.2", "gpt-5.1-codex", "gpt-5", "o3", "gpt-4.1-mini"]) {
    assert.deepEqual(getModelCapabilities("openai", model), { control: "reasoning-effort", effortLevels: UP_TO_HIGH }, model);
  }
});

test("Gemini uses thinking levels; non-Claude Bedrock models use plain effort; CLIs pass through", () => {
  assert.deepEqual(getModelCapabilities("google", "gemini-3.8-flash"), { control: "thinking-level", effortLevels: UP_TO_HIGH });
  assert.deepEqual(getModelCapabilities("google", "gemini-3.1-pro-preview"), { control: "thinking-level", effortLevels: UP_TO_HIGH });
  assert.deepEqual(getModelCapabilities("bedrock", "us.amazon.nova-pro-v1:0"), { control: "reasoning-effort", effortLevels: UP_TO_HIGH });
  assert.deepEqual(getModelCapabilities("copilot", "auto"), { control: "cli", effortLevels: NO_XHIGH });
  assert.deepEqual(getModelCapabilities("codex", "default"), { control: "cli", effortLevels: ALL });
  assert.deepEqual(getModelCapabilities("nope", "x"), { control: "cli", effortLevels: [] });
});

test("clampEffort rounds up to the next supported level, else the highest", () => {
  assert.equal(clampEffort("xhigh", NO_XHIGH as never), "max");
  assert.equal(clampEffort("max", UP_TO_XHIGH as never), "xhigh");
  assert.equal(clampEffort("max", UP_TO_HIGH as never), "high");
  assert.equal(clampEffort("xhigh", UP_TO_HIGH as never), "high");
  assert.equal(clampEffort("low", UP_TO_HIGH as never), "low");
  assert.equal(clampEffort("medium", ALL as never), "medium");
  assert.equal(clampEffort("high", []), undefined);
});

test("effortPickerOptions offers exactly the levels the model supports", () => {
  assert.deepEqual(effortPickerOptions("anthropic", "claude-opus-5").map((o) => o.value), ALL);
  assert.deepEqual(effortPickerOptions("anthropic", "claude-sonnet-4-6").map((o) => o.value), NO_XHIGH);
  assert.deepEqual(effortPickerOptions("openai", "gpt-5.5").map((o) => o.value), UP_TO_XHIGH);
  assert.deepEqual(effortPickerOptions("google", "gemini-3.8-flash").map((o) => o.value), UP_TO_HIGH);
  assert.deepEqual(effortPickerOptions("bedrock", "us.anthropic.claude-sonnet-5").map((o) => o.value), ALL);
  for (const option of effortPickerOptions("codex", "default")) {
    assert.equal(option.label, option.value);
    assert.ok(option.description, option.value);
  }
});

test("deriveModelDisplayName reads names off the id", () => {
  assert.equal(deriveModelDisplayName("claude-fable-5-1"), "Fable 5.1");
  assert.equal(deriveModelDisplayName("claude-opus-5"), "Opus 5");
  assert.equal(deriveModelDisplayName("us.anthropic.claude-sonnet-5"), "Sonnet 5");
  assert.equal(deriveModelDisplayName("us.anthropic.claude-opus-4-6-v1"), "Opus 4.6");
  assert.equal(deriveModelDisplayName("us.anthropic.claude-haiku-4-5-20251001-v1:0"), "Haiku 4.5");
  assert.equal(deriveModelDisplayName("claude-mythos-preview"), "Mythos Preview");
  assert.equal(deriveModelDisplayName("gpt-5.6"), "GPT 5.6");
  assert.equal(deriveModelDisplayName("gpt-5.6-terra"), "GPT 5.6 Terra");
  assert.equal(deriveModelDisplayName("gpt-6-astra"), "GPT 6 Astra");
  assert.equal(deriveModelDisplayName("gpt-5.4-mini"), "GPT 5.4 Mini");
  assert.equal(deriveModelDisplayName("gpt-5.5-2026-04-23"), "GPT 5.5");
  assert.equal(deriveModelDisplayName("gemini-3.8-flash"), "Gemini 3.8 Flash");
  assert.equal(deriveModelDisplayName("gemini-3.5-flash-lite"), "Gemini 3.5 Flash Lite");
  assert.equal(deriveModelDisplayName("gemini-3.1-pro-preview"), "Gemini 3.1 Pro");
  assert.equal(deriveModelDisplayName("auto"), "Copilot auto");
  assert.equal(deriveModelDisplayName("default"), "Codex default");
  assert.equal(deriveModelDisplayName("my-org/custom-model"), "my-org/custom-model");
  assert.equal(formatModelName("claude-opus-5", "xhigh"), "Opus 5 · xhigh");
});

test("every catalog entry is well formed and recognised", () => {
  for (const [provider, models] of Object.entries(catalog)) {
    assert.ok(models.length > 0, provider);
    const seen = new Set<string>();
    for (const entry of models) {
      assert.ok(entry.label && entry.value && entry.description, `${provider}: ${JSON.stringify(entry)}`);
      assert.ok(!seen.has(entry.value), `${provider}: duplicate ${entry.value}`);
      seen.add(entry.value);
      if (provider === "anthropic" || provider === "openai" || provider === "google" || provider === "bedrock") {
        assert.notEqual(deriveModelDisplayName(entry.value), entry.value, `${provider}: unrecognised id ${entry.value}`);
        assert.ok(supportedEffortLevels(provider, entry.value).length >= 3, `${provider}: ${entry.value} effort levels`);
      }
    }
  }
});

test("every default model is in its provider's catalog", () => {
  for (const [provider, model] of Object.entries(DEFAULT_MODEL_BY_PROVIDER)) {
    assert.ok(
      catalog[provider]?.some((entry) => entry.value === model),
      `${provider} default ${model} missing from catalog`
    );
  }
});

test("Bedrock catalog ids parse to the same models as the Anthropic catalog", () => {
  const anthropicVersions = new Set(
    catalog.anthropic!.map((entry) => JSON.stringify(parseClaudeModel(entry.value)))
  );
  for (const entry of catalog.bedrock!) {
    assert.ok(anthropicVersions.has(JSON.stringify(parseClaudeModel(entry.value))), `bedrock ${entry.value} has no Anthropic twin`);
  }
});
