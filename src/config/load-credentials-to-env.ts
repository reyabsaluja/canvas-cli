import { loadCredential } from "./credentials.js";
import { readStoredConfig } from "./store.js";
import { getActiveProfile } from "./env.js";
import { debug } from "../debug.js";
import { normalizeAIProvider } from "../ai/provider-names.js";

const PROVIDER_CREDENTIALS: Record<string, [credKey: string, envKey: string][]> = {
  openai: [["openai-key", "OPENAI_API_KEY"]],
  anthropic: [["anthropic-key", "ANTHROPIC_API_KEY"]],
  google: [["google-key", "GOOGLE_API_KEY"]],
  bedrock: [
    ["aws-access-key", "AWS_ACCESS_KEY_ID"],
    ["aws-secret-key", "AWS_SECRET_ACCESS_KEY"],
  ],
};

let aiCredentialsLoaded = false;

/** Environment variables whose value came from the credential store, not the user's environment. */
const envKeysFromStore = new Set<string>();

/** True when `envKey` was filled in from the credential store by this process. */
export function isEnvKeyFromStore(envKey: string): boolean {
  return envKeysFromStore.has(envKey);
}

/**
 * Loads non-secret config values (provider, model, effort, region) from the
 * stored config file into env vars. This is fast (file read only, no keychain).
 * AI API keys are deferred to ensureAICredentials() to avoid blocking keychain
 * calls on commands that don't use AI.
 */
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

  aiCredentialsLoaded = false;
  envKeysFromStore.clear();
}

/**
 * Loads AI provider API keys from the credential store (keychain/file) into
 * env vars. Called lazily on first AI provider use to avoid blocking keychain
 * access on commands that don't need AI (e.g. `ingest`, or the TUI before the
 * first chat turn).
 */
export function ensureAICredentials(): void {
  if (aiCredentialsLoaded) return;
  aiCredentialsLoaded = true;

  const profile = getActiveProfile();
  const stored = readStoredConfig(profile);
  // Keys are stored under the canonical name, so "gemini", "Anthropic", or
  // "aws-bedrock" must find them too.
  const provider = normalizeAIProvider(process.env.AI_PROVIDER || stored?.aiProvider);
  const relevantCreds = provider ? PROVIDER_CREDENTIALS[provider] : undefined;
  if (!relevantCreds) return;

  for (const [credKey, envKey] of relevantCreds) {
    if (!process.env[envKey]) {
      const value = loadCredential(profile, credKey);
      if (value) {
        process.env[envKey] = value;
        envKeysFromStore.add(envKey);
        debug("config", `Set ${envKey} from credential store`);
      }
    }
  }
}
