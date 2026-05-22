import { createRequire } from "node:module";
import { verticalPicker, horizontalPicker, BACK, C, type PickerOption } from "./login-picker.js";
import { promptSecret, promptLine, ESCAPED } from "./login-prompts.js";
import { getAiKeyName, getCredentialKey } from "./login-providers.js";
import { readStoredConfig, writeStoredConfig } from "../config/store.js";
import { getActiveProfile } from "../config/env.js";
import { loadCredential, storeCredential } from "../config/credentials.js";
import type { AIEffortLevel } from "../ai/provider.js";

const require = createRequire(import.meta.url);
const MODEL_CATALOG: Record<string, PickerOption[]> = require("../ai/models.json");

interface ModelGroup {
  label: string;
  provider: string;
  models: PickerOption[];
}

// Bedrock model IDs may include version suffixes; formatAIError surfaces the fix if one is wrong.
const BEDROCK_MODELS: PickerOption[] = [
  { label: "Claude Opus 4.7", value: "us.anthropic.claude-opus-4-7", description: "most capable" },
  { label: "Claude Opus 4.6", value: "us.anthropic.claude-opus-4-6-v1", description: "flagship" },
  { label: "Claude Sonnet 4.6", value: "us.anthropic.claude-sonnet-4-6", description: "balanced" },
];

const LOGO = [
  "⠀⠀⢀⣤⠀⠺⣿⣿⠗⠀⣠⣀⠀⠀",
  "⠀⣴⣿⠟⣀⠀⠰⡆⠀⢀⠻⣿⣧⠀",
  "⣠⡀⠀⠈⠛⠀⠀⠀⠀⠛⠃⠀⢀⣠",
  "⣿⣿⠰⠶⠀⠀⠀⠀⠀⠀⠰⠆⢾⣿",
  "⠙⠁⠀⢀⣤⠀⠀⠀⠀⣠⡄⠀⠈⠛",
  "⠀⠺⣿⣦⠉⠀⠰⠆⠀⠈⣱⣾⡿⠀",
  "⠀⠀⠈⠛⠀⣰⣾⣿⣦⠀⠙⠋⠀⠀",
];

const LOGO_WIDTH = Math.max(...LOGO.map((l) => [...l].length));

const PROVIDER_DISPLAY: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  bedrock: "AWS Bedrock",
};

const EFFORT_FILL: Record<string, string> = {
  low: "○",
  medium: "◔",
  high: "◑",
  max: "●",
};

interface CurrentConfig {
  provider: string | null;
  model: string | null;
  effort: string | null;
}

function readCurrentConfig(): CurrentConfig {
  const profile = getActiveProfile();
  const stored = readStoredConfig(profile);
  return {
    provider: stored?.aiProvider ?? process.env.AI_PROVIDER ?? null,
    model: stored?.aiModel ?? process.env.AI_MODEL ?? null,
    effort: stored?.aiEffort ?? process.env.AI_EFFORT ?? null,
  };
}

function resolveModelLabel(provider: string | null, modelId: string): string {
  if (provider === "bedrock") {
    const match = BEDROCK_MODELS.find((m) => m.value === modelId);
    if (match) return match.label;
  } else if (provider && MODEL_CATALOG[provider]) {
    const match = MODEL_CATALOG[provider]!.find((m: PickerOption) => m.value === modelId);
    if (match) return match.label;
  }
  return modelId;
}

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

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
  { label: "max", value: "max", description: "extended thinking" },
];

const EFFORT_OPTIONS_OPENAI: PickerOption[] = [
  { label: "low", value: "low" },
  { label: "medium", value: "medium" },
  { label: "high", value: "high" },
];

function printHeader(): void {
  const current = readCurrentConfig();
  const titleLine = `${C.whiteBold("canvas-cli")} ${C.dim("·")} ${C.muted("model")}`;

  const rightLines: string[] = [];
  rightLines.push(titleLine);
  rightLines.push("");

  if (current.model) {
    const label = resolveModelLabel(current.provider, current.model);
    const providerTag = current.provider
      ? C.dim(PROVIDER_DISPLAY[current.provider] ?? current.provider)
      : "";
    const effortTag = current.effort
      ? `  ${C.primary(EFFORT_FILL[current.effort] ?? "○")} ${C.dim(current.effort)}`
      : "";
    rightLines.push(`${C.muted("current")} ${C.white(label)}${effortTag}`);
    if (providerTag) rightLines.push(`        ${providerTag}`);
  } else {
    rightLines.push(`${C.dim("no model configured")}`);
  }

  const textStart = 1;
  console.log();
  for (let i = 0; i < LOGO.length; i++) {
    const logoLine = LOGO[i]!;
    const pad = " ".repeat(Math.max(0, LOGO_WIDTH - [...logoLine].length));
    const textIdx = i - textStart;
    const rightText = textIdx >= 0 && textIdx < rightLines.length
      ? "   " + rightLines[textIdx]!
      : "";
    console.log("  " + C.primary(logoLine) + pad + rightText);
  }
  console.log();
}

function hideCursor(): void { process.stdout.write("\x1b[?25l"); }
function showCursor(): void { process.stdout.write("\x1b[?25h"); }

type ModelResult = { provider: string; model: string; effort?: AIEffortLevel } | null;

export async function modelCommand(subcommand?: string): Promise<ModelResult> {
  const sub = subcommand?.toLowerCase();

  if (sub === "effort") return modelEffortSubcommand();
  if (sub === "key") return modelKeySubcommand();

  return modelFullFlow();
}

async function modelEffortSubcommand(): Promise<ModelResult> {
  hideCursor();
  try {
    const profile = getActiveProfile();
    const current = readCurrentConfig();

    if (!current.provider || !current.model) {
      clearScreen();
      printHeader();
      console.log(`  ${C.error("✗")} ${C.text("No model configured yet. Run")} ${C.muted("/model")} ${C.text("first.")}\n`);
      return null;
    }

    if (current.provider === "google") {
      clearScreen();
      printHeader();
      console.log(`  ${C.error("✗")} ${C.text("Effort levels are not supported for Google models.")}\n`);
      return null;
    }

    const modelLabel = resolveModelLabel(current.provider, current.model);
    const providerLabel = PROVIDER_DISPLAY[current.provider] ?? current.provider;

    clearScreen();
    printHeader();
    console.log(`  ${C.success("✓")} ${C.dim("Provider")}  ${C.muted(providerLabel)}`);
    console.log(`  ${C.success("✓")} ${C.dim("Model")}     ${C.muted(modelLabel)}\n`);

    const effortChoices = current.provider === "openai" ? EFFORT_OPTIONS_OPENAI : EFFORT_OPTIONS;
    const picked = await horizontalPicker("effort", effortChoices);
    if (picked === BACK || picked === null) return null;

    const effort = picked as AIEffortLevel;
    const base = readStoredConfig(profile) ?? { canvasBaseUrl: "" };
    writeStoredConfig({ ...base, aiEffort: effort }, profile);
    process.env.AI_EFFORT = effort;

    console.log(`\n  ${C.success("✓")} ${C.text("Effort set to")} ${C.white(effort)}\n`);

    return { provider: current.provider, model: current.model, effort };
  } finally {
    showCursor();
  }
}

async function modelKeySubcommand(): Promise<ModelResult> {
  hideCursor();
  try {
    const profile = getActiveProfile();
    const current = readCurrentConfig();

    if (!current.provider) {
      clearScreen();
      printHeader();
      console.log(`  ${C.error("✗")} ${C.text("No provider configured yet. Run")} ${C.muted("/model")} ${C.text("first.")}\n`);
      return null;
    }

    const providerLabel = PROVIDER_DISPLAY[current.provider] ?? current.provider;

    clearScreen();
    printHeader();
    showCursor();

    if (current.provider === "bedrock") {
      console.log(`  ${C.text("Rotate AWS credentials for")} ${C.white(providerLabel)}\n`);

      const region = await promptLine(`  ${C.dim("AWS Region (e.g., us-east-1):")} `);
      if (region === ESCAPED) return null;

      const accessKey = await promptSecret(`  ${C.dim("AWS Access Key ID:")} `);
      if (accessKey === ESCAPED) return null;

      const secretKey = await promptSecret(`  ${C.dim("AWS Secret Access Key:")} `);
      if (secretKey === ESCAPED) return null;

      storeCredential(profile, "aws-access-key", accessKey);
      storeCredential(profile, "aws-secret-key", secretKey);
      process.env.AWS_ACCESS_KEY_ID = accessKey;
      process.env.AWS_SECRET_ACCESS_KEY = secretKey;
      process.env.AWS_REGION = region;

      const base = readStoredConfig(profile) ?? { canvasBaseUrl: "" };
      writeStoredConfig({ ...base, awsRegion: region }, profile);

      console.log(`\n  ${C.success("✓")} ${C.text("AWS credentials updated")}\n`);
    } else {
      const envKey = getAiKeyName(current.provider);
      const credKey = getCredentialKey(current.provider);

      if (!envKey || !credKey) {
        console.log(`  ${C.error("✗")} ${C.text("No key rotation available for this provider.")}\n`);
        return null;
      }

      console.log(`  ${C.text("New API key for")} ${C.white(providerLabel)}\n`);

      const key = await promptSecret(`  ${C.dim(`${envKey}:`)} `);
      if (key === ESCAPED) return null;

      storeCredential(profile, credKey, key);
      process.env[envKey] = key;

      console.log(`\n  ${C.success("✓")} ${C.text("API key updated")}\n`);
    }

    return current.model
      ? { provider: current.provider, model: current.model, effort: current.effort as AIEffortLevel | undefined }
      : null;
  } finally {
    showCursor();
  }
}

async function modelFullFlow(): Promise<ModelResult> {
  hideCursor();
  try {
    const groups = buildModelGroups();

    const providerOptions: PickerOption[] = groups.map((g) => ({
      label: g.label,
      value: g.provider,
      description: `${g.models.length} models`,
    }));

    clearScreen();
    printHeader();

    const selectedProvider = await verticalPicker("Provider", providerOptions);
    if (selectedProvider === BACK || selectedProvider === null) return null;

    const group = groups.find((g) => g.provider === selectedProvider);
    if (!group) return null;

    const profile = getActiveProfile();

    if (selectedProvider === "bedrock") {
      const hasAccess = process.env.AWS_ACCESS_KEY_ID || loadCredential(profile, "aws-access-key");
      const hasSecret = process.env.AWS_SECRET_ACCESS_KEY || loadCredential(profile, "aws-secret-key");
      if (!hasAccess || !hasSecret) {
        clearScreen();
        printHeader();
        showCursor();
        console.log(`  ${C.success("✓")} ${C.dim("Provider")}  ${C.muted(group.label)}\n`);
        console.log(`  ${C.dim("AWS credentials required:")}\n`);

        const region = await promptLine(`  ${C.dim("AWS Region (e.g., us-east-1):")} `);
        if (region === ESCAPED) return null;

        const accessKey = await promptSecret(`  ${C.dim("AWS Access Key ID:")} `);
        if (accessKey === ESCAPED) return null;

        const secretKey = await promptSecret(`  ${C.dim("AWS Secret Access Key:")} `);
        if (secretKey === ESCAPED) return null;

        hideCursor();
        storeCredential(profile, "aws-access-key", accessKey);
        storeCredential(profile, "aws-secret-key", secretKey);
        process.env.AWS_ACCESS_KEY_ID = accessKey;
        process.env.AWS_SECRET_ACCESS_KEY = secretKey;
        process.env.AWS_REGION = region;

        const base = readStoredConfig(profile) ?? { canvasBaseUrl: "" };
        writeStoredConfig({ ...base, awsRegion: region }, profile);
      }
    } else {
      const envKey = getAiKeyName(selectedProvider);
      const credKey = getCredentialKey(selectedProvider);
      const hasKey = (envKey && process.env[envKey]) || (credKey && loadCredential(profile, credKey));
      if (!hasKey && envKey && credKey) {
        clearScreen();
        printHeader();
        showCursor();
        console.log(`  ${C.success("✓")} ${C.dim("Provider")}  ${C.muted(group.label)}\n`);
        console.log(`  ${C.dim(`Requires ${envKey}:`)}\n`);

        const key = await promptSecret(`  ${C.dim("→")} `);
        if (key === ESCAPED) return null;

        hideCursor();
        storeCredential(profile, credKey, key);
        process.env[envKey] = key;
      }
    }

    clearScreen();
    printHeader();
    console.log(`  ${C.success("✓")} ${C.dim("Provider")}  ${C.muted(group.label)}\n`);

    const modelOptions: PickerOption[] = [
      ...group.models,
      { label: "Custom…", value: "__custom__", description: "enter model ID" },
    ];
    const selectedModel = await verticalPicker("Model", modelOptions);
    if (selectedModel === BACK || selectedModel === null) return null;

    let finalModel = selectedModel;
    let modelLabel = group.models.find((m) => m.value === selectedModel)?.label ?? selectedModel;

    if (selectedModel === "__custom__") {
      showCursor();
      const custom = await promptLine(`  ${C.dim("Model ID:")} `);
      if (custom === ESCAPED || !custom.trim()) return null;
      hideCursor();
      finalModel = custom.trim();
      modelLabel = finalModel;
    }

    const supportsEffort = selectedProvider !== "google";
    let effort: AIEffortLevel | undefined;

    if (supportsEffort) {
      clearScreen();
      printHeader();
      console.log(`  ${C.success("✓")} ${C.dim("Provider")}  ${C.muted(group.label)}`);
      console.log(`  ${C.success("✓")} ${C.dim("Model")}     ${C.muted(modelLabel)}\n`);

      const effortChoices = selectedProvider === "openai" ? EFFORT_OPTIONS_OPENAI : EFFORT_OPTIONS;
      const picked = await horizontalPicker("effort", effortChoices);
      if (picked === BACK || picked === null) return null;
      effort = picked as AIEffortLevel;
    }

    const base = readStoredConfig(profile) ?? { canvasBaseUrl: "" };
    const updated: typeof base = { ...base, aiProvider: selectedProvider, aiModel: finalModel };
    if (effort) {
      updated.aiEffort = effort;
    } else {
      delete updated.aiEffort;
    }
    writeStoredConfig(updated, profile);

    process.env.AI_PROVIDER = selectedProvider;
    process.env.AI_MODEL = finalModel;
    if (effort) {
      process.env.AI_EFFORT = effort;
    } else {
      delete process.env.AI_EFFORT;
    }

    const effortSuffix = effort ? ` ${C.dim(`(${effort} effort)`)}` : "";
    console.log(`\n  ${C.success("✓")} ${C.text(`Switched to ${modelLabel}`)}${effortSuffix}\n`);

    return { provider: selectedProvider, model: finalModel, effort };
  } finally {
    showCursor();
  }
}
