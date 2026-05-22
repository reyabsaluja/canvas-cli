import { createRequire } from "node:module";
import { verticalPicker, horizontalPicker, BACK, C, type PickerOption } from "./login-picker.js";
import { promptSecret, promptLine, ESCAPED } from "./login-prompts.js";
import { getAiKeyName, getCredentialKey } from "./login-providers.js";
import { readStoredConfig, writeStoredConfig } from "../config/store.js";
import { getActiveProfile } from "../config/env.js";
import { loadCredential, storeCredential } from "../config/credentials.js";

const require = createRequire(import.meta.url);
const MODEL_CATALOG: Record<string, PickerOption[]> = require("../ai/models.json");

interface ModelGroup {
  label: string;
  provider: string;
  models: PickerOption[];
}

// Bedrock IDs per AWS docs: Opus 4.6 uses -v1 suffix, others do not.
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
  const titleLine = `${C.whiteBold("canvas-cli")} ${C.dim("·")} ${C.muted("model")}`;
  const textStart = 2;

  console.log();
  for (let i = 0; i < LOGO.length; i++) {
    const logoLine = LOGO[i]!;
    const pad = " ".repeat(Math.max(0, LOGO_WIDTH - [...logoLine].length));
    const textIdx = i - textStart;
    const rightText = textIdx === 0 ? "   " + titleLine : "";
    console.log("  " + C.primary(logoLine) + pad + rightText);
  }
  console.log();
}

function hideCursor(): void { process.stdout.write("\x1b[?25l"); }
function showCursor(): void { process.stdout.write("\x1b[?25h"); }

export async function modelCommand(): Promise<{ provider: string; model: string; effort: string } | null> {
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

    const hasEffort = selectedProvider !== "google";
    let effort = "";

    if (hasEffort) {
      clearScreen();
      printHeader();
      console.log(`  ${C.success("✓")} ${C.dim("Provider")}  ${C.muted(group.label)}`);
      console.log(`  ${C.success("✓")} ${C.dim("Model")}     ${C.muted(modelLabel)}\n`);

      const effortChoices = selectedProvider === "openai" ? EFFORT_OPTIONS_OPENAI : EFFORT_OPTIONS;
      const picked = await horizontalPicker("effort", effortChoices);
      if (picked === BACK || picked === null) return null;
      effort = picked;
    }

    const base = readStoredConfig(profile) ?? { canvasBaseUrl: "" };
    const updated = {
      ...base,
      aiProvider: selectedProvider,
      aiModel: finalModel,
      ...(hasEffort ? { aiEffort: effort } : {}),
    };
    if (!hasEffort) delete updated.aiEffort;
    writeStoredConfig(updated, profile);

    process.env.AI_PROVIDER = selectedProvider;
    process.env.AI_MODEL = finalModel;
    if (hasEffort) {
      process.env.AI_EFFORT = effort;
    } else {
      delete process.env.AI_EFFORT;
    }

    const effortSuffix = hasEffort ? ` ${C.dim(`(${effort} effort)`)}` : "";
    console.log(`\n  ${C.success("✓")} ${C.text(`Switched to ${modelLabel}`)}${effortSuffix}\n`);

    return { provider: selectedProvider, model: finalModel, effort };
  } finally {
    showCursor();
  }
}
