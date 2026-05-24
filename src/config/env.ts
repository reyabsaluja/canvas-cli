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
  const accessToken = envToken || storedToken || undefined;
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
