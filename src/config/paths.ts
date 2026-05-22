import { join } from "node:path";
import { homedir } from "node:os";

const VALID_PROFILE_NAME = /^[a-zA-Z0-9_-]+$/;

export function validateProfileName(profile: string): void {
  if (!VALID_PROFILE_NAME.test(profile)) {
    throw new Error(
      `Invalid profile name "${profile}". Only letters, numbers, hyphens, and underscores are allowed.`
    );
  }
}

export function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const base = xdgConfig || join(homedir(), ".config");
  return join(base, "canvas-cli");
}

export function getConfigFilePath(profile: string = "default"): string {
  validateProfileName(profile);
  if (profile === "default") {
    return join(getConfigDir(), "config.json");
  }
  return join(getConfigDir(), `config.${profile}.json`);
}
