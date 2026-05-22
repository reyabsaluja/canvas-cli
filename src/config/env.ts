import dotenv from "dotenv";
import { debug, maskEnvForDebug } from "../debug.js";
import { readStoredConfig } from "./store.js";
import { loadCredential } from "./credentials.js";

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

  // Fall back to stored config + credentials
  if (!baseUrl || !accessToken) {
    const stored = readStoredConfig(profile);
    if (stored && !baseUrl) {
      baseUrl = stored.canvasBaseUrl;
    }
    if (!accessToken) {
      const token = loadCredential(profile, "canvas-token");
      if (token) accessToken = token;
    }
  }

  if (!baseUrl) {
    console.error(
      "Error: Canvas URL is not configured.\nRun `canvas-cli login` to set up, or set CANVAS_BASE_URL in your environment."
    );
    process.exit(1);
  }

  if (!accessToken) {
    console.error(
      "Error: Canvas access token is not configured.\nRun `canvas-cli login` to set up, or set CANVAS_ACCESS_TOKEN in your environment."
    );
    process.exit(1);
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
