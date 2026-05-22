import { createRequire } from "node:module";
import { verticalPicker, horizontalPicker, BACK, C, type PickerOption } from "./login-picker.js";
import { readStoredConfig, writeStoredConfig } from "../config/store.js";
import { getActiveProfile } from "../config/env.js";

const require = createRequire(import.meta.url);
const MODEL_CATALOG: Record<string, PickerOption[]> = require("../ai/models.json");

interface ModelGroup {
  label: string;
  provider: string;
  models: PickerOption[];
}

const BEDROCK_MODELS: PickerOption[] = [
  { label: "Claude Opus 4.7", value: "us.anthropic.claude-opus-4-7-20250219-v1:0", description: "most capable" },
  { label: "Claude Opus 4.6", value: "us.anthropic.claude-opus-4-6-20250414-v1:0", description: "flagship" },
  { label: "Claude Sonnet 4.6", value: "us.anthropic.claude-sonnet-4-6-20250414-v1:0", description: "balanced" },
  { label: "Claude Sonnet 4", value: "us.anthropic.claude-sonnet-4-20250514-v1:0", description: "previous gen" },
  { label: "Claude Haiku 4.5", value: "us.anthropic.claude-haiku-4-5-20251001-v1:0", description: "fastest" },
];

function buildModelGroups(): ModelGroup[] {
  const groups: ModelGroup[] = [];

  if (MODEL_CATALOG["openai"]) {
    groups.push({ label: "OpenAI", provider: "openai", models: MODEL_CATALOG["openai"] });
  }
  if (MODEL_CATALOG["anthropic"]) {
    groups.push({ label: "Anthropic", provider: "anthropic", models: MODEL_CATALOG["anthropic"] });
  }
  if (MODEL_CATALOG["google"]) {
    groups.push({ label: "Google", provider: "google", models: MODEL_CATALOG["google"] });
  }
  groups.push({ label: "AWS Bedrock", provider: "bedrock", models: BEDROCK_MODELS });

  return groups;
}

const EFFORT_OPTIONS: PickerOption[] = [
  { label: "low", value: "low" },
  { label: "medium", value: "medium" },
  { label: "high", value: "high" },
  { label: "max", value: "max" },
];

export async function modelCommand(): Promise<{ provider: string; model: string; effort: string } | null> {
  const groups = buildModelGroups();

  const providerOptions: PickerOption[] = groups.map((g) => ({
    label: g.label,
    value: g.provider,
    description: `${g.models.length} models`,
  }));

  console.log();
  const selectedProvider = await verticalPicker("Provider", providerOptions);
  if (selectedProvider === BACK || selectedProvider === null) return null;

  const group = groups.find((g) => g.provider === selectedProvider);
  if (!group) return null;

  console.log();
  const selectedModel = await verticalPicker("Model", group.models);
  if (selectedModel === BACK || selectedModel === null) return null;

  console.log();
  const effort = await horizontalPicker("effort", EFFORT_OPTIONS);
  if (effort === BACK || effort === null) return null;

  const profile = getActiveProfile();
  const existing = readStoredConfig(profile);
  if (existing) {
    writeStoredConfig({
      ...existing,
      aiProvider: selectedProvider,
      aiModel: selectedModel,
      aiEffort: effort,
    }, profile);
  }

  process.env.AI_PROVIDER = selectedProvider;
  process.env.AI_MODEL = selectedModel;
  process.env.AI_EFFORT = effort;

  const modelLabel = group.models.find((m) => m.value === selectedModel)?.label ?? selectedModel;
  console.log(`\n  ${C.success("✓")} ${C.text(`Switched to ${modelLabel}`)} ${C.dim(`(${effort} effort)`)}\n`);

  return { provider: selectedProvider, model: selectedModel, effort };
}
