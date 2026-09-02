import { readFileSync, mkdirSync, unlinkSync, existsSync, readdirSync, openSync, writeSync, closeSync, chmodSync, constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { getConfigDir, getConfigFilePath, validateProfileName } from "./paths.js";
import { debug } from "../debug.js";

export interface StoredConfig {
  /** Human-facing base URL without /api/v1 (e.g. "https://school.instructure.com"). loadConfig() appends /api/v1 at runtime. */
  canvasBaseUrl: string;
  aiProvider?: string;
  aiModel?: string;
  aiEffort?: string;
  awsRegion?: string;
}

export function defaultStoredConfig(): StoredConfig {
  return { canvasBaseUrl: "" };
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
  const fd = openSync(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
  writeSync(fd, JSON.stringify(config, null, 2) + "\n");
  closeSync(fd);
  // O_CREAT mode only applies to new files; tighten pre-existing looser files too.
  try {
    chmodSync(filePath, 0o600);
  } catch {}
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
    const files = readdirSync(dir).filter(
      (f) => f === "config.json" || /^config\.[a-zA-Z0-9_-]+\.json$/.test(f)
    );
    const profiles: string[] = [];
    for (const f of files) {
      if (f === "config.json") {
        profiles.push("default");
      } else {
        const match = f.match(/^config\.([a-zA-Z0-9_-]+)\.json$/);
        if (match?.[1]) {
          try {
            validateProfileName(match[1]);
            profiles.push(match[1]);
          } catch {}
        }
      }
    }
    return profiles;
  } catch {
    return [];
  }
}
