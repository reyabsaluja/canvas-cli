import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { getConfigDir, validateProfileName } from "./paths.js";
import { debug } from "../debug.js";

const SERVICE_NAME = "canvas-cli";

export const ALL_CREDENTIAL_KEYS = [
  "canvas-token",
  "openai-key",
  "anthropic-key",
  "google-key",
  "aws-region",
  "aws-access-key",
  "aws-secret-key",
] as const;

const cache = new Map<string, string | null>();

function cacheKey(profile: string, key: string): string {
  return `${profile}\0${key}`;
}

function credentialFilePath(profile: string, key: string): string {
  return join(getConfigDir(), "credentials", `${profile}.${key}`);
}

function keychainAccount(profile: string, key: string): string {
  return `${profile}/${key}`;
}

export type StorageBackend = "keychain" | "file";

export function storeCredential(profile: string, key: string, value: string): StorageBackend {
  validateProfileName(profile);
  if (value.includes("\0")) {
    throw new Error(`Credential value for "${key}" contains a null byte`);
  }
  if (platform() === "darwin") {
    try {
      const account = keychainAccount(profile, key);
      try {
        execFileSync("security", ["delete-generic-password", "-s", SERVICE_NAME, "-a", account], { stdio: "ignore" });
      } catch {}
      execFileSync("security", ["add-generic-password", "-s", SERVICE_NAME, "-a", account, "-w", value], { stdio: "ignore" });
      debug("config", `Stored credential in keychain: ${key} (profile: ${profile})`);
      cache.set(cacheKey(profile, key), value);
      return "keychain";
    } catch {
      debug("config", "Keychain storage failed, falling back to file");
    }
  }

  // Fallback: store in a file with restrictive permissions
  const filePath = credentialFilePath(profile, key);
  const dir = join(getConfigDir(), "credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, value, { mode: 0o600 });
  cache.set(cacheKey(profile, key), value);
  debug("config", `Stored credential in file: ${filePath}`);
  return "file";
}

export function loadCredential(profile: string, key: string): string | null {
  validateProfileName(profile);
  const ck = cacheKey(profile, key);
  if (cache.has(ck)) {
    return cache.get(ck) ?? null;
  }

  let value: string | null = null;

  if (platform() === "darwin") {
    try {
      const result = execFileSync(
        "security",
        ["find-generic-password", "-s", SERVICE_NAME, "-a", keychainAccount(profile, key), "-w"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
      );
      const trimmed = result.trim();
      if (trimmed) {
        debug("config", `Loaded credential from keychain: ${key} (profile: ${profile})`);
        value = trimmed;
      }
    } catch {
      // Not found in keychain, try file fallback
    }
  }

  if (!value) {
    const filePath = credentialFilePath(profile, key);
    try {
      value = readFileSync(filePath, "utf-8").trim();
      debug("config", `Loaded credential from file: ${key} (profile: ${profile})`);
    } catch {
      value = null;
    }
  }

  cache.set(ck, value);
  return value;
}

export function deleteCredential(profile: string, key: string): boolean {
  validateProfileName(profile);
  let deleted = false;

  if (platform() === "darwin") {
    try {
      execFileSync("security", ["delete-generic-password", "-s", SERVICE_NAME, "-a", keychainAccount(profile, key)], { stdio: "ignore" });
      deleted = true;
    } catch {}
  }

  const filePath = credentialFilePath(profile, key);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    deleted = true;
  }

  cache.delete(cacheKey(profile, key));

  if (deleted) {
    debug("config", `Deleted credential: ${key} (profile: ${profile})`);
  }
  return deleted;
}

export function deleteAllCredentials(profile: string): void {
  for (const key of ALL_CREDENTIAL_KEYS) {
    deleteCredential(profile, key);
  }
}

export function clearCredentialCache(): void {
  cache.clear();
}
