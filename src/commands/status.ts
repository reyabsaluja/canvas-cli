import { getActiveProfile } from "../config/env.js";
import { readStoredConfig, listProfiles } from "../config/store.js";
import { loadCredential, getCredentialBackend } from "../config/credentials.js";
import { getConfigDir } from "../config/paths.js";
import { C } from "./login-picker.js";
import { isSubscriptionProvider, SUBSCRIPTION_PROVIDERS } from "../ai/provider.js";
import { normalizeAIProvider } from "../ai/provider-names.js";

interface StatusOptions {
  profile?: string;
}

export function statusCommand(options: StatusOptions = {}): void {
  const profile = options.profile || getActiveProfile();
  const stored = readStoredConfig(profile);
  const hasToken = Boolean(
    process.env.CANVAS_ACCESS_TOKEN || loadCredential(profile, "canvas-token")
  );
  const baseUrl = process.env.CANVAS_BASE_URL || stored?.canvasBaseUrl;

  const PAD = 15;
  const label = (s: string) => C.dim(s.padEnd(PAD));

  console.log(`\n  ${C.whiteBold("canvas-cli status")}\n`);
  console.log(`  ${label("Profile")}${C.primary(profile)}`);
  console.log(`  ${label("Canvas URL")}${baseUrl ? C.success(baseUrl) : C.error("not set")}`);
  console.log(`  ${label("Access Token")}${hasToken ? C.success("configured") : C.error("not set")}`);

  // What will actually run: AI_PROVIDER in the environment overrides the
  // saved provider, and the saved model only applies to the saved provider.
  const envProvider = normalizeAIProvider(process.env.AI_PROVIDER);
  const storedProvider = normalizeAIProvider(stored?.aiProvider);
  const provider = envProvider ?? storedProvider;
  if (process.env.AI_PROVIDER && !envProvider) {
    // An unrecognized value turns AI off rather than falling back.
    console.log(`  ${label("AI Provider")}${C.error(`unrecognized AI_PROVIDER "${process.env.AI_PROVIDER}" (AI is off)`)}`);
  } else if (provider) {
    const model =
      process.env.AI_MODEL ||
      (provider === storedProvider ? stored?.aiModel : undefined) ||
      "(default)";
    const source = envProvider ? ` ${C.dim("· from environment")}` : "";
    const viaCli = isSubscriptionProvider(provider)
      ? ` ${C.dim(`· subscription via \`${SUBSCRIPTION_PROVIDERS[provider].binary}\` CLI`)}`
      : "";
    console.log(`  ${label("AI Provider")}${C.success(provider)} ${C.dim(`(model: ${model})`)}${viaCli}${source}`);
  } else {
    console.log(`  ${label("AI Provider")}${C.dim("not configured")}`);
  }

  console.log(`  ${label("Config Dir")}${C.dim(getConfigDir())}`);
  const backend = getCredentialBackend(profile, "canvas-token");
  const credBackend = process.env.CANVAS_ACCESS_TOKEN
    ? "environment (CANVAS_ACCESS_TOKEN)"
    : backend === "keychain"
      ? "macOS Keychain"
      : backend === "file"
        ? "file-based (plaintext, 0600)"
        : "not stored";
  console.log(`  ${label("Credentials")}${C.dim(credBackend)}`);

  const profiles = listProfiles();
  if (profiles.length > 1) {
    console.log(`\n  ${label("All profiles")}${C.muted(profiles.join(", "))}`);
  }

  if (!baseUrl || !hasToken) {
    console.log(`\n  ${C.warm(`Run`)} ${C.whiteBold("canvas-cli login")} ${C.warm("to set up.")}`);
  }

  console.log();
}
