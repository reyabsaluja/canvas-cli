import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { getConfigDir } from "./paths.js";
import { debug } from "../debug.js";

const SERVICE_NAME = "canvas-cli";

function credentialFilePath(profile: string, key: string): string {
  return join(getConfigDir(), "credentials", `${profile}.${key}`);
}

function keychainAccount(profile: string, key: string): string {
  return `${profile}/${key}`;
}

export function storeCredential(profile: string, key: string, value: string): void {
  if (platform() === "darwin") {
    try {
      // Delete existing entry first (ignore errors if it doesn't exist)
      try {
        execSync(
          `security delete-generic-password -s ${shellEscape(SERVICE_NAME)} -a ${shellEscape(keychainAccount(profile, key))}`,
          { stdio: "ignore" }
        );
      } catch {}
      execSync(
        `security add-generic-password -s ${shellEscape(SERVICE_NAME)} -a ${shellEscape(keychainAccount(profile, key))} -w ${shellEscape(value)}`,
        { stdio: "ignore" }
      );
      debug("config", `Stored credential in keychain: ${key} (profile: ${profile})`);
      return;
    } catch {
      debug("config", "Keychain storage failed, falling back to file");
    }
  }

  // Fallback: store in a file with restrictive permissions
  const filePath = credentialFilePath(profile, key);
  const dir = join(getConfigDir(), "credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, value, { mode: 0o600 });
  debug("config", `Stored credential in file: ${filePath}`);
}

export function loadCredential(profile: string, key: string): string | null {
  if (platform() === "darwin") {
    try {
      const result = execSync(
        `security find-generic-password -s ${shellEscape(SERVICE_NAME)} -a ${shellEscape(keychainAccount(profile, key))} -w`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
      );
      const value = result.trim();
      if (value) {
        debug("config", `Loaded credential from keychain: ${key} (profile: ${profile})`);
        return value;
      }
    } catch {
      // Not found in keychain, try file fallback
    }
  }

  // Fallback: read from file
  const filePath = credentialFilePath(profile, key);
  try {
    const value = readFileSync(filePath, "utf-8").trim();
    debug("config", `Loaded credential from file: ${key} (profile: ${profile})`);
    return value;
  } catch {
    return null;
  }
}

export function deleteCredential(profile: string, key: string): boolean {
  let deleted = false;

  if (platform() === "darwin") {
    try {
      execSync(
        `security delete-generic-password -s ${shellEscape(SERVICE_NAME)} -a ${shellEscape(keychainAccount(profile, key))}`,
        { stdio: "ignore" }
      );
      deleted = true;
    } catch {}
  }

  const filePath = credentialFilePath(profile, key);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    deleted = true;
  }

  if (deleted) {
    debug("config", `Deleted credential: ${key} (profile: ${profile})`);
  }
  return deleted;
}

export function deleteAllCredentials(profile: string): void {
  deleteCredential(profile, "canvas-token");
  deleteCredential(profile, "openai-key");
  deleteCredential(profile, "anthropic-key");
  deleteCredential(profile, "google-key");
}

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
