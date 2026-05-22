import chalk from "chalk";
import { platform } from "node:os";
import { getActiveProfile } from "../config/env.js";
import { readStoredConfig, listProfiles } from "../config/store.js";
import { loadCredential } from "../config/credentials.js";
import { getConfigDir } from "../config/paths.js";

export async function statusCommand(): Promise<void> {
  const profile = getActiveProfile();
  const stored = readStoredConfig(profile);
  const hasToken = Boolean(
    process.env.CANVAS_ACCESS_TOKEN || loadCredential(profile, "canvas-token")
  );
  const baseUrl = process.env.CANVAS_BASE_URL || stored?.canvasBaseUrl;

  console.log(chalk.bold("\n  canvas-cli status\n"));
  console.log(`  Profile:      ${chalk.cyan(profile)}`);
  console.log(`  Canvas URL:   ${baseUrl ? chalk.green(baseUrl) : chalk.red("not set")}`);
  console.log(`  Access Token: ${hasToken ? chalk.green("configured") : chalk.red("not set")}`);

  if (stored?.aiProvider) {
    const model = stored.aiModel || "(default)";
    console.log(`  AI Provider:  ${chalk.green(stored.aiProvider)} (model: ${model})`);
  } else if (process.env.AI_PROVIDER) {
    console.log(`  AI Provider:  ${chalk.green(process.env.AI_PROVIDER)} (from env)`);
  } else {
    console.log(`  AI Provider:  ${chalk.dim("not configured")}`);
  }

  console.log(`  Config Dir:   ${chalk.dim(getConfigDir())}`);
  console.log(`  Credentials:  ${chalk.dim(platform() === "darwin" ? "macOS Keychain" : "file-based")}`);

  const profiles = listProfiles();
  if (profiles.length > 1) {
    console.log(`\n  All profiles: ${profiles.join(", ")}`);
  }

  if (!baseUrl || !hasToken) {
    console.log(chalk.yellow(`\n  Run ${chalk.bold("canvas-cli login")} to set up.`));
  }

  console.log();
}
