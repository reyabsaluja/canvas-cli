import { platform } from "node:os";
import { getActiveProfile } from "../config/env.js";
import { readStoredConfig, listProfiles } from "../config/store.js";
import { loadCredential } from "../config/credentials.js";
import { getConfigDir } from "../config/paths.js";
import { C } from "./login-picker.js";

interface StatusOptions {
  profile?: string;
}

export async function statusCommand(options: StatusOptions = {}): Promise<void> {
  const profile = options.profile || getActiveProfile();
  const stored = readStoredConfig(profile);
  const hasToken = Boolean(
    process.env.CANVAS_ACCESS_TOKEN || loadCredential(profile, "canvas-token")
  );
  const baseUrl = process.env.CANVAS_BASE_URL || stored?.canvasBaseUrl;

  const label = (s: string) => C.dim(s.padEnd(14));

  console.log(`\n  ${C.whiteBold("canvas-cli status")}\n`);
  console.log(`  ${label("Profile")}${C.primary(profile)}`);
  console.log(`  ${label("Canvas URL")}${baseUrl ? C.success(baseUrl) : C.error("not set")}`);
  console.log(`  ${label("Access Token")}${hasToken ? C.success("configured") : C.error("not set")}`);

  if (stored?.aiProvider) {
    const model = stored.aiModel || "(default)";
    console.log(`  ${label("AI Provider")}${C.success(stored.aiProvider)} ${C.dim(`(model: ${model})`)}`);
  } else if (process.env.AI_PROVIDER) {
    console.log(`  ${label("AI Provider")}${C.success(process.env.AI_PROVIDER)} ${C.dim("(from env)")}`);
  } else {
    console.log(`  ${label("AI Provider")}${C.dim("not configured")}`);
  }

  console.log(`  ${label("Config Dir")}${C.dim(getConfigDir())}`);
  console.log(`  ${label("Credentials")}${C.dim(platform() === "darwin" ? "macOS Keychain" : "file-based")}`);

  const profiles = listProfiles();
  if (profiles.length > 1) {
    console.log(`\n  ${label("All profiles")}${C.muted(profiles.join(", "))}`);
  }

  if (!baseUrl || !hasToken) {
    console.log(`\n  ${C.warm(`Run`)} ${C.whiteBold("canvas-cli login")} ${C.warm("to set up.")}`);
  }

  console.log();
}
