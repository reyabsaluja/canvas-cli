import dotenv from "dotenv";
import { debug, maskEnvForDebug } from "../debug.js";

dotenv.config();

export interface Config {
  baseUrl: string;
  accessToken: string;
}

export function loadConfig(): Config {
  const baseUrl = process.env.CANVAS_BASE_URL;
  const accessToken = process.env.CANVAS_ACCESS_TOKEN;

  if (!baseUrl) {
    console.error(
      "Error: CANVAS_BASE_URL is not set.\nCreate a .env file with CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN.\nSee .env.example for reference."
    );
    process.exit(1);
  }

  if (!accessToken) {
    console.error(
      "Error: CANVAS_ACCESS_TOKEN is not set.\nCreate a .env file with CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN.\nSee .env.example for reference."
    );
    process.exit(1);
  }

  debug("config", `CANVAS_BASE_URL: ${baseUrl.replace(/\/+$/, "")}`);
  debug("config", "CANVAS_ACCESS_TOKEN: ***");
  debug("config", "Sensitive env vars present", maskEnvForDebug());

  // Strip trailing slash from base URL
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    accessToken,
  };
}
