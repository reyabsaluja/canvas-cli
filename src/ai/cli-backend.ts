import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants as fsConstants, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, platform } from "node:os";
import { delimiter, join } from "node:path";
import { debug } from "../debug.js";
import { AIError } from "./errors.js";
import type { ToolDefinition } from "./provider.js";

/**
 * Shared plumbing for subscription backends that drive a vendor CLI
 * (GitHub Copilot, ChatGPT via Codex) as a child process and read its JSONL
 * event stream.
 */

export type SubscriptionProvider = "copilot" | "codex";

export interface CliBackendRequest {
  provider: SubscriptionProvider;
  model: string;
  effort?: string;
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  tools: ToolDefinition[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  onToolCall?: (name: string, input: Record<string, unknown>, result: string) => void;
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

/** Injection points for tests. */
export interface CliDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  findExecutable?: (name: string) => string | null;
  env?: NodeJS.ProcessEnv;
}

export const SUBSCRIPTION_PROVIDERS: Record<
  SubscriptionProvider,
  { binary: string; displayName: string; installHint: string; loginHint: string; experimental: boolean }
> = {
  copilot: {
    binary: "copilot",
    displayName: "GitHub Copilot",
    installHint: "Install the Copilot CLI with `npm install -g @github/copilot`.",
    loginHint: "Run `copilot login` to sign in with your GitHub account.",
    experimental: false,
  },
  codex: {
    binary: "codex",
    displayName: "ChatGPT (Codex)",
    installHint: "Install the Codex CLI with `npm install -g @openai/codex`.",
    loginHint: "Run `codex login` to sign in with your ChatGPT account.",
    experimental: true,
  },
};

export function isSubscriptionProvider(value: string | undefined | null): value is SubscriptionProvider {
  return value === "copilot" || value === "codex";
}

const EXTRA_BIN_DIRS = (): string[] => {
  const home = homedir();
  if (platform() === "win32") {
    const appData = process.env.APPDATA;
    return appData ? [join(appData, "npm")] : [];
  }
  return [
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
};

/** Locate an executable on PATH or in the usual npm/bun global bin directories. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const isWindows = platform() === "win32";
  const candidates = isWindows ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...EXTRA_BIN_DIRS()];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      try {
        accessSync(full, isWindows ? fsConstants.F_OK : fsConstants.X_OK);
        return full;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export interface CliRunOptions {
  command: string;
  args: string[];
  stdin?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  onLine: (line: string) => void;
  spawnImpl?: CliDeps["spawn"];
}

export interface CliRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
}

const STDERR_CAP = 16 * 1024;

/** Spawn a CLI, feed it stdin, and deliver each stdout line to `onLine`. */
export function runCliJsonl(options: CliRunOptions): Promise<CliRunResult> {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stderr = "";
    let buffered = "";
    let aborted = false;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const kill = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 2000);
    };

    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (options.abortSignal?.aborted) {
      onAbort();
    } else {
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    }

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, options.timeoutMs)
        : null;

    const finish = (result: CliRunResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      let index: number;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index).replace(/\r$/, "");
        buffered = buffered.slice(index + 1);
        if (line.trim()) {
          try {
            options.onLine(line);
          } catch (error) {
            debug("ai", `cli line handler threw: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < STDERR_CAP) {
        stderr += chunk.slice(0, STDERR_CAP - stderr.length);
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (buffered.trim()) {
        try {
          options.onLine(buffered.replace(/\r$/, ""));
        } catch {}
        buffered = "";
      }
      finish({ exitCode: code, signal, stderr, aborted, timedOut });
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Flatten a system prompt plus chat history into a single prompt. The vendor
 * CLIs take one prompt per run, so prior turns are replayed as a transcript.
 */
export function buildTranscriptPrompt(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>
): string {
  const parts: string[] = [];
  parts.push(
    "You are running inside canvas-cli, a terminal assistant for a student's Canvas LMS courses. " +
      "Follow the instructions below exactly. Use only the Canvas tools provided to you; do not run shell commands, " +
      "read or write files, or browse the web. Reply with the final answer only."
  );
  parts.push("");
  parts.push("# Instructions");
  parts.push(systemPrompt.trim());

  const history = messages.slice(0, -1);
  const current = messages[messages.length - 1];

  if (history.length > 0) {
    parts.push("");
    parts.push("# Conversation so far");
    for (const message of history) {
      const speaker = message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User";
      parts.push(`${speaker}: ${message.content.trim()}`);
      parts.push("");
    }
  }

  parts.push("");
  parts.push("# Current request");
  parts.push(current ? current.content.trim() : "");
  return parts.join("\n");
}

/** Create an empty working directory so the CLI cannot see the user's project. */
export function makeScratchDir(prefix: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), `canvas-cli-${prefix}-`));
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {}
    },
  };
}

export function missingCliError(provider: SubscriptionProvider): AIError {
  const info = SUBSCRIPTION_PROVIDERS[provider];
  return new AIError(`The ${info.displayName} CLI (\`${info.binary}\`) is not installed.`, "provider_unavailable", {
    setupHint: `${info.installHint} ${info.loginHint}`,
  });
}

/** Map a raw CLI failure message to a user-facing AIError. */
export function classifyCliFailure(
  provider: SubscriptionProvider,
  message: string,
  category?: string
): AIError {
  const info = SUBSCRIPTION_PROVIDERS[provider];
  const text = message.trim() || `${info.displayName} exited without a response.`;
  const lower = `${category ?? ""} ${text}`.toLowerCase();

  if (
    /\b401\b|unauthori[sz]ed|authentication|not logged in|no authentication|login required|please log in|sign in/.test(
      lower
    )
  ) {
    return new AIError(`${info.displayName} is not signed in.`, "auth", { setupHint: info.loginHint });
  }
  if (/\b403\b|authorization|forbidden|not permitted|no access|subscription/.test(lower)) {
    return new AIError(`${info.displayName} refused the request: ${truncate(text)}`, "auth", {
      setupHint: `Check that your plan includes ${info.displayName} access. ${info.loginHint}`,
    });
  }
  if (/\b429\b|rate.?limit|usage limit|quota|too many requests|credits/.test(lower)) {
    return new AIError(`${info.displayName} usage limit reached.`, "rate_limit", {
      retryAfterMs: 60_000,
      setupHint: "Wait for your plan's limit to reset or switch to an API key provider with /model.",
    });
  }
  if (/model.*(not found|unknown|unsupported|unavailable|invalid)|unsupported model|no such model/.test(lower)) {
    return new AIError(`${info.displayName} does not offer the selected model.`, "model_not_found", {
      setupHint: "Pick a different model with /model.",
    });
  }
  if (/enotfound|econnrefused|network|fetch failed|connection|timed out|timeout/.test(lower)) {
    return new AIError(`Could not reach ${info.displayName}.`, "network", {
      setupHint: "Check your network connection.",
    });
  }
  return new AIError(`${info.displayName} failed: ${truncate(text)}`, "unknown");
}

/** First informative line of a CLI error, trimmed for display. */
function truncate(text: string, max = 240): string {
  const firstLine =
    text
      .split("\n")
      .map((line) => line.replace(/^\S+\s+(ERROR|WARN)\s+\S+:\s*/, "").trim())
      .find((line) => line.length > 0) ?? "";
  const single = firstLine.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max)}...` : single;
}

export function safeJsonParse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
