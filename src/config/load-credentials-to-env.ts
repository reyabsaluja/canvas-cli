import { loadCredential } from "./credentials.js";
import { readStoredConfig } from "./store.js";
import { getActiveProfile } from "./env.js";
import { debug } from "../debug.js";

const PROVIDER_CREDENTIALS: Record<string, [credKey: string, envKey: string][]> = {
  openai: [["openai-key", "OPENAI_API_KEY"]],
  anthropic: [["anthropic-key", "ANTHROPIC_API_KEY"]],
  google: [["google-key", "GOOGLE_API_KEY"]],
  bedrock: [
    ["aws-access-key", "AWS_ACCESS_KEY_ID"],
    ["aws-secret-key", "AWS_SECRET_ACCESS_KEY"],
  ],
};

export function loadStoredCredentialsToEnv(): void {
  const profile = getActiveProfile();
  const stored = readStoredConfig(profile);

  if (stored?.aiProvider && !process.env.AI_PROVIDER) {
    process.env.AI_PROVIDER = stored.aiProvider;
    debug("config", `Set AI_PROVIDER from stored config: ${stored.aiProvider}`);
  }
  if (stored?.aiModel && !process.env.AI_MODEL) {
    process.env.AI_MODEL = stored.aiModel;
    debug("config", `Set AI_MODEL from stored config: ${stored.aiModel}`);
  }
  if (stored?.aiEffort && !process.env.AI_EFFORT) {
    process.env.AI_EFFORT = stored.aiEffort;
    debug("config", `Set AI_EFFORT from stored config: ${stored.aiEffort}`);
  }
  if (stored?.awsRegion && !process.env.AWS_REGION) {
    process.env.AWS_REGION = stored.awsRegion;
    debug("config", `Set AWS_REGION from stored config: ${stored.awsRegion}`);
  }

  const provider = process.env.AI_PROVIDER || stored?.aiProvider;
  const relevantCreds = provider ? PROVIDER_CREDENTIALS[provider] : undefined;
  if (!relevantCreds) return;

  for (const [credKey, envKey] of relevantCreds) {
    if (!process.env[envKey]) {
      const value = loadCredential(profile, credKey);
      if (value) {
        process.env[envKey] = value;
        debug("config", `Set ${envKey} from credential store`);
      }
    }
  }
}
