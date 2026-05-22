import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfigDir, getConfigFilePath } from "./paths.js";
import { debug } from "../debug.js";

export interface StoredConfig {
  canvasBaseUrl: string;
  aiProvider?: string;
  aiModel?: string;
}

export function readStoredConfig(profile: string = "default"): StoredConfig | null {
  const filePath = getConfigFilePath(profile);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as StoredConfig;
    debug("config", `Loaded config from ${filePath}`);
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredConfig(config: StoredConfig, profile: string = "default"): void {
  const filePath = getConfigFilePath(profile);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  debug("config", `Wrote config to ${filePath}`);
}

export function deleteStoredConfig(profile: string = "default"): boolean {
  const filePath = getConfigFilePath(profile);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    debug("config", `Deleted config at ${filePath}`);
    return true;
  }
  return false;
}

export function listProfiles(): string[] {
  const dir = getConfigDir();
  try {
    const files = readdirSync(dir);
    const profiles: string[] = [];
    for (const f of files) {
      if (f === "config.json") {
        profiles.push("default");
      } else {
        const match = f.match(/^config\.(.+)\.json$/);
        if (match) profiles.push(match[1]);
      }
    }
    return profiles;
  } catch {
    return [];
  }
}
