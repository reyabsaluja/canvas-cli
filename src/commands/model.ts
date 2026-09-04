import { verticalPicker, horizontalPicker, BACK, C, type PickerOption } from "./login-picker.js";
import { promptSecret, promptLine, ESCAPED } from "./login-prompts.js";
import { getAiKeyName, getCredentialKey, effortPickerOptions, catalogModels } from "./login-providers.js";
import { readStoredConfig, writeStoredConfig, defaultStoredConfig } from "../config/store.js";
import { getActiveProfile } from "../config/env.js";
import { loadCredential, storeCredential } from "../config/credentials.js";
import { isSubscriptionProvider, SUBSCRIPTION_PROVIDERS, isEffortLevel, deriveModelDisplayName, type AIEffortLevel } from "../ai/provider.js";
import { describeCodexModel } from "../ai/backends/codex-models.js";
import { checkSubscriptionCli } from "../ai/subscription-status.js";
import catalogJson from "../ai/models.json" with { type: "json" };

const MODEL_CATALOG: Record<string, PickerOption[]> = Object.fromEntries(
  Object.entries(catalogJson).filter(([k]) => !k.startsWith("$") && !k.startsWith("_"))
) as Record<string, PickerOption[]>;

interface ModelGroup {
  label: string;
  provider: string;
  models: PickerOption[];
}

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
  copilot: "GitHub Copilot",
  codex: "ChatGPT · Codex",
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
  // Codex: name the model the CLI's catalog says this id runs, even for a stored "default".
  if (provider === "codex" && describeCodexModel(modelId)) return deriveModelDisplayName(modelId);
  if (provider && MODEL_CATALOG[provider]) {
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

  if (MODEL_CATALOG["copilot"]) {
    groups.push({ label: "GitHub Copilot", provider: "copilot", models: MODEL_CATALOG["copilot"] });
  }
  const codexModels = catalogModels("codex");
  if (codexModels.length > 0) {
    groups.push({ label: "ChatGPT · Codex (experimental)", provider: "codex", models: codexModels });
  }
  if (MODEL_CATALOG["openai"]) {
    groups.push({ label: "OpenAI", provider: "openai", models: MODEL_CATALOG["openai"] });
  }
  if (MODEL_CATALOG["anthropic"]) {
    groups.push({ label: "Anthropic", provider: "anthropic", models: MODEL_CATALOG["anthropic"] });
  }
  if (MODEL_CATALOG["google"]) {
    groups.push({ label: "Google", provider: "google", models: MODEL_CATALOG["google"] });
  }
  if (MODEL_CATALOG["bedrock"]) {
    groups.push({ label: "AWS Bedrock", provider: "bedrock", models: MODEL_CATALOG["bedrock"] });
  }

  return groups;
}

async function promptBedrockCredentials(profile: string): Promise<boolean> {
  const region = await promptLine(`  ${C.dim("AWS Region (e.g., us-east-1):")} `);
  if (region === ESCAPED) return false;

  const accessKey = await promptSecret(`  ${C.dim("AWS Access Key ID:")} `);
  if (accessKey === ESCAPED) return false;

  const secretKey = await promptSecret(`  ${C.dim("AWS Secret Access Key:")} `);
  if (secretKey === ESCAPED) return false;

  storeCredential(profile, "aws-access-key", accessKey);
  storeCredential(profile, "aws-secret-key", secretKey);
  process.env.AWS_ACCESS_KEY_ID = accessKey;
  process.env.AWS_SECRET_ACCESS_KEY = secretKey;
  process.env.AWS_REGION = region;

  const base = readStoredConfig(profile) ?? defaultStoredConfig();
  writeStoredConfig({ ...base, awsRegion: region }, profile);
  return true;
}

function printHeader(): void {
  const current = readCurrentConfig();
  const titleLine = C.whiteBold("Select model");

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

    const effortChoices = effortPickerOptions(current.provider, current.model);
    if (effortChoices.length === 0) {
      clearScreen();
      printHeader();
      console.log(`  ${C.error("✗")} ${C.text("Effort levels are not supported for this model.")}\n`);
      return null;
    }

    const modelLabel = resolveModelLabel(current.provider, current.model);
    const providerLabel = PROVIDER_DISPLAY[current.provider] ?? current.provider;

    clearScreen();
    printHeader();
    console.log(`  ${C.success("✓")} ${C.dim("Provider")}  ${C.muted(providerLabel)}`);
    console.log(`  ${C.success("✓")} ${C.dim("Model")}     ${C.muted(modelLabel)}\n`);

    const picked = await horizontalPicker("effort", effortChoices);
    if (picked === BACK || picked === null) return null;

    const effort = picked as AIEffortLevel;
    const base = readStoredConfig(profile) ?? defaultStoredConfig();
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

    if (isSubscriptionProvider(current.provider)) {
      const binary = SUBSCRIPTION_PROVIDERS[current.provider].binary;
      console.log(`  ${C.text(`${providerLabel} uses your own login, not an API key.`)}`);
      console.log(`  ${C.dim(`Run \`${binary} login\` in your shell to sign in or switch accounts.`)}\n`);
      return null;
    }

    if (current.provider === "bedrock") {
      console.log(`  ${C.text("Rotate AWS credentials for")} ${C.white(providerLabel)}\n`);

      showCursor();
      const ok = await promptBedrockCredentials(profile);
      hideCursor();
      if (!ok) return null;

      console.log(`\n  ${C.success("✓")} ${C.text("AWS credentials updated")}\n`);
    } else {
      const envKey = getAiKeyName(current.provider);
      const credKey = getCredentialKey(current.provider);

      if (!envKey || !credKey) {
        console.log(`  ${C.error("✗")} ${C.text("No key rotation available for this provider.")}\n`);
        return null;
      }

      console.log(`  ${C.text("New API key for")} ${C.white(providerLabel)}\n`);

      showCursor();
      const key = await promptSecret(`  ${C.dim(`${envKey}:`)} `);
      if (key === ESCAPED) return null;
      hideCursor();

      storeCredential(profile, credKey, key);
      process.env[envKey] = key;

      console.log(`\n  ${C.success("✓")} ${C.text("API key updated")}\n`);
    }

    if (!current.model) return null;
    const effort = isEffortLevel(current.effort) ? current.effort : undefined;
    return { provider: current.provider, model: current.model, effort };
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

    if (isSubscriptionProvider(selectedProvider)) {
      const status = checkSubscriptionCli(selectedProvider);
      if (!status.installed) {
        clearScreen();
        printHeader();
        console.log(`  ${C.error("✗")} ${C.text(`${status.displayName} CLI not found.`)}`);
        console.log(`  ${C.dim(status.installHint)} ${C.dim(status.loginHint)}\n`);
        return null;
      }
      if (status.loggedIn === false) {
        clearScreen();
        printHeader();
        console.log(`  ${C.error("✗")} ${C.text(`${status.displayName} CLI is not signed in.`)}`);
        console.log(`  ${C.dim(status.loginHint)}\n`);
        return null;
      }
    } else if (selectedProvider === "bedrock") {
      const hasAccess = process.env.AWS_ACCESS_KEY_ID || loadCredential(profile, "aws-access-key");
      const hasSecret = process.env.AWS_SECRET_ACCESS_KEY || loadCredential(profile, "aws-secret-key");
      if (!hasAccess || !hasSecret) {
        clearScreen();
        printHeader();
        showCursor();
        console.log(`  ${C.success("✓")} ${C.dim("Provider")}  ${C.muted(group.label)}\n`);
        console.log(`  ${C.dim("AWS credentials required:")}\n`);

        const ok = await promptBedrockCredentials(profile);
        if (!ok) return null;
        hideCursor();
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
      {
        label: "Custom…",
        value: "__custom__",
        description: isSubscriptionProvider(selectedProvider)
          ? `model ID as accepted by ${SUBSCRIPTION_PROVIDERS[selectedProvider].binary}`
          : "enter model ID",
      },
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
      const trimmed = custom.trim();
      if (!/^[\w.\-/:]+$/.test(trimmed)) {
        console.log(`\n  ${C.error("✗")} ${C.text("Invalid model ID — only letters, digits, dots, hyphens, underscores, colons, and slashes are allowed.")}\n`);
        return null;
      }
      finalModel = trimmed;
      modelLabel = finalModel;
    }

    const effortChoices = effortPickerOptions(selectedProvider, finalModel);
    const supportsEffort = effortChoices.length > 0;
    let effort: AIEffortLevel | undefined;

    if (supportsEffort) {
      clearScreen();
      printHeader();
      console.log(`  ${C.success("✓")} ${C.dim("Provider")}  ${C.muted(group.label)}`);
      console.log(`  ${C.success("✓")} ${C.dim("Model")}     ${C.muted(modelLabel)}\n`);

      const picked = await horizontalPicker("effort", effortChoices);
      if (picked === BACK || picked === null) return null;
      effort = picked as AIEffortLevel;
    }

    const base = readStoredConfig(profile) ?? defaultStoredConfig();
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
