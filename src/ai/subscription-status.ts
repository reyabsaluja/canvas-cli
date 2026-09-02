import { spawn, spawnSync } from "node:child_process";
import { SUBSCRIPTION_PROVIDERS, findExecutable, type SubscriptionProvider } from "./cli-backend.js";

/**
 * Local checks for subscription providers: is the vendor CLI installed, and
 * does it look signed in. These never call the model, so they are cheap
 * enough for `login`, `/model`, `status`, and `/doctor`.
 */

export interface SubscriptionCliStatus {
  provider: SubscriptionProvider;
  displayName: string;
  installed: boolean;
  path: string | null;
  /** "unknown" when the CLI offers no offline way to tell. */
  loggedIn: boolean | "unknown";
  detail: string;
  installHint: string;
  loginHint: string;
}

export function checkSubscriptionCli(provider: SubscriptionProvider): SubscriptionCliStatus {
  const info = SUBSCRIPTION_PROVIDERS[provider];
  const path = findExecutable(info.binary);
  const base = {
    provider,
    displayName: info.displayName,
    installHint: info.installHint,
    loginHint: info.loginHint,
  };
  if (!path) {
    return { ...base, installed: false, path: null, loggedIn: false, detail: `\`${info.binary}\` not found on PATH` };
  }

  if (provider === "codex") {
    const result = spawnSync(path, ["login", "status"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status === 0 && !/not logged in/i.test(output)) {
      return { ...base, installed: true, path, loggedIn: true, detail: output || "logged in" };
    }
    return { ...base, installed: true, path, loggedIn: false, detail: output || "not logged in" };
  }

  // Copilot has no offline status command. Environment tokens are definitive;
  // otherwise the OAuth token lives in the OS credential store and we cannot
  // tell without making a request.
  const envToken = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (envToken) {
    return { ...base, installed: true, path, loggedIn: true, detail: "token from environment" };
  }
  return { ...base, installed: true, path, loggedIn: "unknown", detail: "sign-in state is checked on first use" };
}

/**
 * Run the vendor's interactive login in the foreground, sharing the terminal.
 * Resolves true when the command exits successfully.
 */
export function runSubscriptionLogin(provider: SubscriptionProvider): Promise<boolean> {
  const info = SUBSCRIPTION_PROVIDERS[provider];
  const path = findExecutable(info.binary);
  if (!path) return Promise.resolve(false);

  return new Promise((resolve) => {
    let wasRaw = false;
    try {
      wasRaw = Boolean(process.stdin.isRaw);
      process.stdin.setRawMode?.(false);
    } catch {}
    const child = spawn(path, ["login"], { stdio: "inherit" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      try {
        if (wasRaw) process.stdin.setRawMode?.(true);
      } catch {}
      resolve(code === 0);
    });
  });
}
