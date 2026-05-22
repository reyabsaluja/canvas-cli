import { deleteStoredConfig, readStoredConfig } from "../config/store.js";
import { deleteAllCredentials } from "../config/credentials.js";
import { C } from "./login-picker.js";

interface LogoutOptions {
  profile?: string;
}

export async function logoutCommand(options: LogoutOptions): Promise<void> {
  const profile = options.profile || "default";

  const existing = readStoredConfig(profile);
  if (!existing) {
    console.log(`\n  ${C.warm(`No configuration found for profile "${profile}".`)}\n`);
    return;
  }

  deleteAllCredentials(profile);
  deleteStoredConfig(profile);

  console.log(`\n  ${C.success("✓")} ${C.text(`Logged out of profile "${profile}".`)}`);
  console.log(`  ${C.dim(`Removed config and credentials for: ${existing.canvasBaseUrl}`)}\n`);
}
