import { createRequire } from "node:module";
import { verticalPicker, horizontalPicker, BACK, C, type PickerOption } from "./login-picker.js";
import { promptLine, promptSecret, ESCAPED } from "./login-prompts.js";

const require = createRequire(import.meta.url);
const modelsJson: Record<string, PickerOption[]> = require("../ai/models.json");
const MODEL_CATALOG: Record<string, PickerOption[]> = Object.fromEntries(
  Object.entries(modelsJson).filter(([k]) => !k.startsWith("$") && !k.startsWith("_"))
);

const ESC_HINT = C.dim("(esc to go back)");

export interface BedrockResult {
  awsRegion: string;
  awsAccessKey: string;
  awsSecretKey: string;
  aiModel: string;
  aiEffort: string;
}

export async function runBedrockSteps(freshStep: () => void): Promise<BedrockResult | typeof ESCAPED> {
  let subStep = 1;
  let awsRegion = "";
  let awsAccessKey = "";
  let awsSecretKey = "";
  let aiModel = "";
  let aiEffort = "";

  while (subStep >= 1) {
    if (subStep === 1) {
      freshStep();
      console.log(`  ${C.dim("AWS credentials for Bedrock:")}  ${ESC_HINT}\n`);
      const region = await promptLine(`  ${C.dim("AWS Region (e.g., us-east-1):")} `);
      if (region === ESCAPED) return ESCAPED;
      awsRegion = region;
      subStep = 2;
    } else if (subStep === 2) {
      const accessKey = await promptSecret(`  ${C.dim("AWS Access Key ID:")} `);
      if (accessKey === ESCAPED) { subStep = 1; continue; }
      awsAccessKey = accessKey;
      subStep = 3;
    } else if (subStep === 3) {
      const secretKey = await promptSecret(`  ${C.dim("AWS Secret Access Key:")} `);
      if (secretKey === ESCAPED) { subStep = 2; continue; }
      awsSecretKey = secretKey;
      subStep = 4;
    } else if (subStep === 4) {
      console.log(`\n  ${C.dim("Enter the full Bedrock model ID:")}  ${ESC_HINT}`);
      const model = await promptLine(`  ${C.dim("→")} `);
      if (model === ESCAPED) { subStep = 3; continue; }
      aiModel = model;
      subStep = 5;
    } else if (subStep === 5) {
      console.log();
      const effort = await horizontalPicker("Effort", [
        { label: "low", value: "low" },
        { label: "medium", value: "medium" },
        { label: "high", value: "high" },
        { label: "max", value: "max" },
      ]);
      if (effort === BACK) { subStep = 4; continue; }
      if (effort === null) { subStep = 4; continue; }
      aiEffort = effort;
      break;
    }
  }

  return { awsRegion, awsAccessKey, awsSecretKey, aiModel, aiEffort };
}

export interface StandardResult {
  aiKey: string;
  aiModel: string;
  aiEffort: string;
}

export async function runStandardProviderSteps(provider: string, freshStep: () => void): Promise<StandardResult | typeof ESCAPED> {
  let subStep = 1;
  let aiKey = "";
  let aiModel = "";
  let aiEffort = "";

  const keyName = getAiKeyName(provider);
  const models = getModelOptions(provider);
  const hasEffort = provider === "openai" || provider === "anthropic";

  while (subStep >= 1) {
    if (subStep === 1) {
      freshStep();
      if (keyName) {
        console.log(`  ${C.dim(`Requires ${keyName}:`)}  ${ESC_HINT}\n`);
        const key = await promptSecret(`  ${C.dim("→")} `);
        if (key === ESCAPED) return ESCAPED;
        aiKey = key;
      }
      subStep = 2;
    } else if (subStep === 2) {
      if (models.length > 0) {
        console.log();
        const selectedModel = await verticalPicker("Model", models);
        if (selectedModel === BACK) { subStep = 1; continue; }
        if (selectedModel === null) { subStep = 1; continue; }
        if (selectedModel === "__custom__") {
          const custom = await promptLine(`\n  ${C.dim("Model ID →")} `);
          if (custom === ESCAPED) { continue; }
          aiModel = custom;
        } else {
          aiModel = selectedModel;
        }
      }
      subStep = 3;
    } else if (subStep === 3) {
      if (hasEffort) {
        console.log();
        const effort = await horizontalPicker("Effort", [
          { label: "low", value: "low" },
          { label: "medium", value: "medium" },
          { label: "high", value: "high" },
          { label: "max", value: "max" },
        ]);
        if (effort === BACK) { subStep = 2; continue; }
        if (effort === null) { subStep = 2; continue; }
        aiEffort = effort;
      }
      break;
    }
  }

  return { aiKey, aiModel, aiEffort };
}

export function getAiKeyName(provider: string): string | null {
  switch (provider.toLowerCase()) {
    case "openai": return "OPENAI_API_KEY";
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "google": return "GOOGLE_API_KEY";
    default: return null;
  }
}

export function getCredentialKey(provider: string): string | null {
  switch (provider.toLowerCase()) {
    case "openai": return "openai-key";
    case "anthropic": return "anthropic-key";
    case "google": return "google-key";
    default: return null;
  }
}

export function getModelOptions(provider: string): PickerOption[] {
  const models = MODEL_CATALOG[provider];
  if (!models || models.length === 0) return [];
  return [...models, { label: "Custom", value: "__custom__", description: "enter model ID" }];
}
