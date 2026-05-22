import { loadCredential } from "./credentials.js";
import { readStoredConfig } from "./store.js";
import { getActiveProfile } from "./env.js";
import { debug } from "../debug.js";

const CREDENTIAL_TO_ENV: Record<string, string> = {
  "openai-key": "OPENAI_API_KEY",
  "anthropic-key": "ANTHROPIC_API_KEY",
  "google-key": "GOOGLE_API_KEY",
  "aws-region": "AWS_REGION",
  "aws-access-key": "AWS_ACCESS_KEY_ID",
  "aws-secret-key": "AWS_SECRET_ACCESS_KEY",
};

export function loadStoredCredentialsToEnv(): void {
  const profile = getActiveProfile();
  const stored = readStoredConfig(profile);

  // Inject AI provider/model from stored config if not already in env
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

  // Inject API keys from credential store if not already in env
  for (const [credKey, envKey] of Object.entries(CREDENTIAL_TO_ENV)) {
    if (!process.env[envKey]) {
      const value = loadCredential(profile, credKey);
      if (value) {
        process.env[envKey] = value;
        debug("config", `Set ${envKey} from credential store`);
      }
    }
  }
}
