import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, unlinkSync, existsSync, openSync, writeSync, closeSync, chmodSync, constants as fsConstants } from "node:fs";
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
  "aws-access-key",
  "aws-secret-key",
] as const;

export type StorageBackend = "keychain" | "file";

const cache = new Map<string, string | null>();
const backendCache = new Map<string, StorageBackend | null>();

function cacheKey(profile: string, key: string): string {
  return `${profile}\0${key}`;
}

function credentialFilePath(profile: string, key: string): string {
  return join(getConfigDir(), "credentials", `${profile}.${key}`);
}

function keychainAccount(profile: string, key: string): string {
  return `${profile}/${key}`;
}

/**
 * Whether the OS keychain should be used. Only macOS has a supported secret
 * store; `CANVAS_CLI_CREDENTIAL_BACKEND=file` forces the plaintext-file
 * backend everywhere (used by tests and by users who prefer not to touch the
 * keychain).
 */
export function keychainAvailable(): boolean {
  if (process.env.CANVAS_CLI_CREDENTIAL_BACKEND === "file") return false;
  return platform() === "darwin";
}

function writeCredentialFile(profile: string, key: string, value: string): void {
  const dir = join(getConfigDir(), "credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = credentialFilePath(profile, key);
  const fd = openSync(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
  writeSync(fd, value);
  closeSync(fd);
  // O_CREAT mode only applies to newly created files; tighten pre-existing ones too.
  try {
    chmodSync(filePath, 0o600);
  } catch {}
}

function removeCredentialFile(profile: string, key: string): boolean {
  const filePath = credentialFilePath(profile, key);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

// macOS `security add-generic-password -w` requires the secret as a CLI arg,
// making it momentarily visible in `ps`. This is a known limitation of the
// Security.framework CLI — the exposure window is sub-millisecond and no
// stdin-based alternative exists for generic passwords.
export function storeCredential(profile: string, key: string, value: string): StorageBackend {
  validateProfileName(profile);
  if (value.includes("\0")) {
    throw new Error(`Credential value for "${key}" contains a null byte`);
  }
  const ck = cacheKey(profile, key);
  if (keychainAvailable()) {
    try {
      const account = keychainAccount(profile, key);
      try {
        execFileSync("security", ["delete-generic-password", "-s", SERVICE_NAME, "-a", account], { stdio: "ignore" });
      } catch {}
      execFileSync("security", ["add-generic-password", "-s", SERVICE_NAME, "-a", account, "-w", value], { stdio: "ignore" });
      // Verify the write for the primary credential to catch silent truncation
      if (key === "canvas-token") {
        const readBack = execFileSync(
          "security",
          ["find-generic-password", "-s", SERVICE_NAME, "-a", account, "-w"],
          { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
        ).trim();
        if (readBack !== value) {
          throw new Error("Keychain read-back mismatch");
        }
      }
      debug("config", `Stored credential in keychain: ${key} (profile: ${profile})`);
      cache.set(ck, value);
      backendCache.set(ck, "keychain");
      // The keychain is the single source of truth: remove any stale plaintext
      // copy left behind by an earlier file-backend write so the "stored in
      // macOS Keychain" claim is accurate.
      try {
        if (removeCredentialFile(profile, key)) {
          debug("config", `Removed stale plaintext credential file for ${key}`);
        }
      } catch {}
      return "keychain";
    } catch {
      debug("config", "Keychain storage failed, falling back to file");
    }
  }

  // Fallback: plaintext file with 0600 permissions. On non-macOS systems there
  // is no OS-level secret store; a compromised user session can read these.
  writeCredentialFile(profile, key, value);
  cache.set(ck, value);
  backendCache.set(ck, "file");
  debug("config", `Stored credential in file: ${credentialFilePath(profile, key)}`);
  return "file";
}

export function loadCredential(profile: string, key: string): string | null {
  validateProfileName(profile);
  const ck = cacheKey(profile, key);
  if (cache.has(ck)) {
    return cache.get(ck) ?? null;
  }

  let value: string | null = null;
  let backend: StorageBackend | null = null;

  if (keychainAvailable()) {
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
        backend = "keychain";
      }
    } catch {
      // Not found in keychain, try file fallback
    }
  }

  if (!value) {
    const filePath = credentialFilePath(profile, key);
    try {
      value = readFileSync(filePath, "utf-8").trim();
      backend = "file";
      debug("config", `Loaded credential from file: ${key} (profile: ${profile})`);
    } catch {
      value = null;
    }
  }

  cache.set(ck, value);
  backendCache.set(ck, value ? backend : null);
  return value;
}

/**
 * Report where a credential is actually stored, or null when it is absent.
 * Use this (not the platform) when telling the user how their secret is kept.
 */
export function getCredentialBackend(profile: string, key: string): StorageBackend | null {
  const ck = cacheKey(profile, key);
  if (!backendCache.has(ck)) {
    loadCredential(profile, key);
  }
  return backendCache.get(ck) ?? null;
}

export function deleteCredential(profile: string, key: string): boolean {
  validateProfileName(profile);
  let deleted = false;

  if (keychainAvailable()) {
    try {
      execFileSync("security", ["delete-generic-password", "-s", SERVICE_NAME, "-a", keychainAccount(profile, key)], { stdio: "ignore" });
      deleted = true;
    } catch {}
  }

  if (removeCredentialFile(profile, key)) {
    deleted = true;
  }

  cache.delete(cacheKey(profile, key));
  backendCache.delete(cacheKey(profile, key));

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
  backendCache.clear();
}
