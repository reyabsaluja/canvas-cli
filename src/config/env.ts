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
  source: "env" | "stored" | null;
  profile: string;
}

export function resolveRawConfig(): ResolvedRawConfig {
  const profile = getActiveProfile();
  const stored = readStoredConfig(profile);
  const envBaseUrl = process.env.CANVAS_BASE_URL;
  const envToken = process.env.CANVAS_ACCESS_TOKEN;
  const baseUrl = envBaseUrl || stored?.canvasBaseUrl || undefined;
  const accessToken = envToken || loadCredential(profile, "canvas-token") || undefined;
  const source: ResolvedRawConfig["source"] = envBaseUrl ? "env" : stored ? "stored" : null;
  return { baseUrl, accessToken, source, profile };
}

export function getActiveProfile(): string {
  return process.env.CANVAS_CLI_PROFILE || "default";
}

export function isConfigured(): boolean {
  const raw = resolveRawConfig();
  return Boolean(raw.baseUrl && raw.accessToken);
}

export function loadConfig(): Config {
  const raw = resolveRawConfig();

  // StoredConfig.canvasBaseUrl is saved WITHOUT /api/v1 (normalizeUrl strips it
  // during login). We append /api/v1 here so the rest of the app gets a ready-to-use
  // API base URL. If someone manually edits config.json WITH /api/v1, the endsWith
  // guard prevents double-appending. Env vars are passed through as-is.
  let baseUrl: string | undefined;
  if (raw.baseUrl && raw.source === "stored") {
    const normalized = raw.baseUrl.replace(/\/+$/, "");
    baseUrl = normalized.endsWith("/api/v1") ? normalized : `${normalized}/api/v1`;
  } else {
    baseUrl = raw.baseUrl;
  }

  const accessToken = raw.accessToken;

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
  debug("config", `Profile: ${raw.profile}`);
  debug("config", "Sensitive env vars present", maskEnvForDebug());

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    accessToken,
  };
}
