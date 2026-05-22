import { join } from "node:path";
import { homedir } from "node:os";

export function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const base = xdgConfig || join(homedir(), ".config");
  return join(base, "canvas-cli");
}

export function getConfigFilePath(profile: string = "default"): string {
  if (profile === "default") {
    return join(getConfigDir(), "config.json");
  }
  return join(getConfigDir(), `config.${profile}.json`);
}
