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

export function getActiveProfile(): string {
  return process.env.CANVAS_CLI_PROFILE || "default";
}

export function isConfigured(): boolean {
  const profile = getActiveProfile();
  const stored = readStoredConfig(profile);
  const baseUrl = process.env.CANVAS_BASE_URL || stored?.canvasBaseUrl;
  const token = process.env.CANVAS_ACCESS_TOKEN || loadCredential(profile, "canvas-token");
  return Boolean(baseUrl && token);
}

export function loadConfig(): Config {
  const profile = getActiveProfile();

  // Env vars always take precedence
  let baseUrl = process.env.CANVAS_BASE_URL;
  let accessToken = process.env.CANVAS_ACCESS_TOKEN;

  // Fall back to stored config + credentials.
  // StoredConfig.canvasBaseUrl is saved WITHOUT /api/v1 (normalizeUrl strips it
  // during login). We append /api/v1 here so the rest of the app gets a ready-to-use
  // API base URL. If someone manually edits config.json WITH /api/v1, the endsWith
  // guard prevents double-appending.
  if (!baseUrl || !accessToken) {
    const stored = readStoredConfig(profile);
    if (stored && !baseUrl) {
      const storedUrl = stored.canvasBaseUrl.replace(/\/+$/, "");
      baseUrl = storedUrl.endsWith("/api/v1") ? storedUrl : `${storedUrl}/api/v1`;
    }
    if (!accessToken) {
      const token = loadCredential(profile, "canvas-token");
      if (token) accessToken = token;
    }
  }

  if (!baseUrl) {
    throw new ConfigError(
      "Canvas URL is not configured.",
      "Run `canvas-cli login` to set up, or set CANVAS_BASE_URL in your environment."
    );
  }

  if (!accessToken) {
    throw new ConfigError(
      "Canvas access token is not configured.",
      "Run `canvas-cli login` to set up, or set CANVAS_ACCESS_TOKEN in your environment."
    );
  }

  debug("config", `CANVAS_BASE_URL: ${baseUrl.replace(/\/+$/, "")}`);
  debug("config", "CANVAS_ACCESS_TOKEN: ***");
  debug("config", `Profile: ${profile}`);
  debug("config", "Sensitive env vars present", maskEnvForDebug());

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    accessToken,
  };
}
