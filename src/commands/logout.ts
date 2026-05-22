import chalk from "chalk";
import { deleteStoredConfig, readStoredConfig } from "../config/store.js";
import { deleteAllCredentials } from "../config/credentials.js";

interface LogoutOptions {
  profile?: string;
}

export async function logoutCommand(options: LogoutOptions): Promise<void> {
  const profile = options.profile || "default";

  const existing = readStoredConfig(profile);
  if (!existing) {
    console.log(chalk.yellow(`\n  No configuration found for profile "${profile}".\n`));
    return;
  }

  deleteAllCredentials(profile);
  deleteStoredConfig(profile);

  console.log(chalk.green(`\n  ✓ Logged out of profile "${profile}".`));
  console.log(chalk.dim(`  Removed config and credentials for: ${existing.canvasBaseUrl}\n`));
}
