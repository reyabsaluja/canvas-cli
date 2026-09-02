import dotenv from "dotenv";
import { debug, maskEnvForDebug } from "../debug.js";
import { readStoredConfig } from "./store.js";
import { loadCredential } from "./credentials.js";
import { ConfigError } from "../errors.js";

dotenv.config();

export interface Config {
  baseUrl: string;
  accessToken: string;
}

export interface ResolvedRawConfig {
  baseUrl: string | undefined;
  accessToken: string | undefined;
  urlSource: "env" | "stored" | "none";
  profile: string;
  credentialError?: Error;
}

export function resolveRawConfig(): ResolvedRawConfig {
  const profile = getActiveProfile();
  const stored = readStoredConfig(profile);
  const envBaseUrl = process.env.CANVAS_BASE_URL;
  const envToken = process.env.CANVAS_ACCESS_TOKEN;
  // Treat empty-string canvasBaseUrl as missing (user hasn't completed setup)
  const baseUrl = envBaseUrl || stored?.canvasBaseUrl || undefined;
  let storedToken: string | null = null;
  let credentialError: Error | undefined;
  try {
    storedToken = loadCredential(profile, "canvas-token");
  } catch (err) {
    credentialError = err instanceof Error ? err : new Error(String(err));
  }
  let accessToken = envToken || storedToken || undefined;
  if (envBaseUrl && !envToken && storedToken) {
    // A CANVAS_BASE_URL from the environment (e.g. a .env in the cwd) must never
    // be paired with the stored token: that would let any directory redirect the
    // real credential to an attacker-controlled host.
    accessToken = undefined;
    credentialError = new ConfigError(
      "CANVAS_BASE_URL is set in the environment, but the access token would come from the stored credential store.",
      "Set CANVAS_ACCESS_TOKEN alongside CANVAS_BASE_URL, or unset CANVAS_BASE_URL (check for a .env file in the current directory) to use the stored login."
    );
  }
  const urlSource: ResolvedRawConfig["urlSource"] = envBaseUrl ? "env" : stored?.canvasBaseUrl ? "stored" : "none";
  return { baseUrl, accessToken, urlSource, profile, credentialError };
}

export function getActiveProfile(): string {
  return process.env.CANVAS_CLI_PROFILE || "default";
}

export function resolveApiUrl(raw: ResolvedRawConfig): string | undefined {
  if (!raw.baseUrl) return undefined;
  if (raw.urlSource === "stored") {
    const normalized = raw.baseUrl.replace(/\/+$/, "");
    return normalized.endsWith("/api/v1") ? normalized : `${normalized}/api/v1`;
  }
  return raw.baseUrl.replace(/\/+$/, "");
}

export function isConfigured(): boolean {
  const raw = resolveRawConfig();
  return Boolean(raw.baseUrl && raw.accessToken);
}

export function loadConfig(): Config {
  const raw = resolveRawConfig();
  const baseUrl = resolveApiUrl(raw);
  const accessToken = raw.accessToken;

  if (!baseUrl) {
    throw new ConfigError(
      "Canvas URL is not configured.",
      "Run `canvas-cli login` to set up, or set CANVAS_BASE_URL in your environment."
    );
  }

  if (!accessToken) {
    if (raw.credentialError instanceof ConfigError) {
      throw raw.credentialError;
    }
    if (raw.credentialError) {
      throw new ConfigError(
        `Failed to load credentials: ${raw.credentialError.message}`,
        "Your system credential store may be corrupted or inaccessible. Try running `canvas-cli login` to re-save your token."
      );
    }
    throw new ConfigError(
      "Canvas access token is not configured.",
      "Run `canvas-cli login` to set up, or set CANVAS_ACCESS_TOKEN in your environment."
    );
  } else if (raw.credentialError) {
    debug("config", `Credential store error (using env fallback): ${raw.credentialError.message}`);
  }

  debug("config", `CANVAS_BASE_URL: ${baseUrl.replace(/\/+$/, "")}`);
  debug("config", "CANVAS_ACCESS_TOKEN: ***");
  debug("config", `Profile: ${raw.profile}`);
  debug("config", "Sensitive env vars present", maskEnvForDebug());

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    accessToken,
  };
}
