import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import chalk from "chalk";
import { writeStoredConfig, readStoredConfig } from "../config/store.js";
import { storeCredential, loadCredential } from "../config/credentials.js";
import { getConfigDir } from "../config/paths.js";

interface LoginOptions {
  profile?: string;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const profile = options.profile || "default";

  console.log(chalk.bold("\n  canvas-cli login\n"));
  console.log(`  Setting up profile: ${chalk.cyan(profile)}\n`);

  const existing = readStoredConfig(profile);
  const existingToken = loadCredential(profile, "canvas-token");

  if (existing && existingToken) {
    console.log(chalk.dim(`  You already have a configuration for this profile.`));
    console.log(chalk.dim(`  Canvas URL: ${existing.canvasBaseUrl}\n`));
    const overwrite = await prompt("  Overwrite existing configuration? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("\n  Login cancelled.\n");
      return;
    }
    console.log();
  }

  // Step 1: Canvas base URL
  console.log(chalk.bold("  Step 1: Canvas URL"));
  console.log(chalk.dim("  This is your school's Canvas address (e.g., https://school.instructure.com)\n"));

  let baseUrl = await prompt("  Canvas URL: ");
  baseUrl = normalizeUrl(baseUrl);

  if (!baseUrl) {
    console.error(chalk.red("\n  Error: Canvas URL is required.\n"));
    process.exit(1);
  }

  // Step 2: Canvas access token
  console.log(chalk.bold("\n  Step 2: Canvas Access Token"));
  console.log(chalk.dim("  You can generate a token in Canvas:"));
  console.log(chalk.dim(`  ${baseUrl}/profile/settings → "+ New Access Token"\n`));

  const shouldOpen = await prompt("  Open Canvas settings in your browser? (Y/n): ");
  if (shouldOpen.toLowerCase() !== "n") {
    openBrowser(`${baseUrl}/profile/settings`);
    console.log(chalk.dim("  Browser opened. Generate a token and paste it below.\n"));
  }

  const token = await promptSecret("  Access Token: ");
  if (!token) {
    console.error(chalk.red("\n  Error: Access token is required.\n"));
    process.exit(1);
  }

  // Validate the token by making a test request
  console.log(chalk.dim("\n  Verifying credentials..."));
  const valid = await validateCredentials(baseUrl, token);
  if (!valid.ok) {
    console.error(chalk.red(`\n  Error: ${valid.error}\n`));
    process.exit(1);
  }
  console.log(chalk.green(`  ✓ Connected as ${valid.userName}`));

  // Step 3: AI provider (optional)
  console.log(chalk.bold("\n  Step 3: AI Provider (optional)"));
  console.log(chalk.dim("  canvas-cli uses AI for the 'ask' and 'work' commands."));
  console.log(chalk.dim("  Supported: openai, anthropic, google, bedrock"));
  console.log(chalk.dim("  Press Enter to skip (you can set this later via env vars).\n"));

  const aiProvider = await prompt("  AI Provider: ");
  let aiModel = "";
  let aiKey = "";

  if (aiProvider) {
    aiModel = await prompt("  AI Model (press Enter for default): ");

    const keyName = getAiKeyName(aiProvider);
    if (keyName) {
      console.log(chalk.dim(`\n  To use ${aiProvider}, you need an API key.`));
      aiKey = await promptSecret(`  ${keyName}: `);
    }
  }

  // Save everything
  writeStoredConfig(
    {
      canvasBaseUrl: baseUrl,
      ...(aiProvider && { aiProvider }),
      ...(aiModel && { aiModel }),
    },
    profile
  );

  storeCredential(profile, "canvas-token", token);
  if (aiKey && aiProvider) {
    const credKey = getCredentialKey(aiProvider);
    if (credKey) {
      storeCredential(profile, credKey, aiKey);
    }
  }

  console.log(chalk.green("\n  ✓ Configuration saved!"));
  console.log(chalk.dim(`  Config: ${getConfigDir()}`));
  console.log(chalk.dim(`  Credentials: stored in ${platform() === "darwin" ? "macOS Keychain" : "encrypted file"}`));

  if (profile !== "default") {
    console.log(chalk.dim(`\n  To use this profile, set: export CANVAS_CLI_PROFILE=${profile}`));
  }

  console.log();
}

function normalizeUrl(url: string): string {
  url = url.trim();
  if (!url) return "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  return url.replace(/\/+$/, "");
}

async function validateCredentials(baseUrl: string, token: string): Promise<{ ok: true; userName: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/users/self`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (response.status === 401) {
      return { ok: false, error: "Invalid access token. Please check and try again." };
    }
    if (response.status === 404) {
      return { ok: false, error: "Canvas API not found at this URL. Please check your Canvas URL." };
    }
    if (!response.ok) {
      return { ok: false, error: `Canvas returned HTTP ${response.status}. Please check your URL and token.` };
    }

    const user = (await response.json()) as { name: string };
    return { ok: true, userName: user.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
      return { ok: false, error: "Could not connect to that URL. Please check and try again." };
    }
    return { ok: false, error: `Connection failed: ${message}` };
  }
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    let input = "";
    const onData = (char: Buffer) => {
      const c = char.toString();
      if (c === "\n" || c === "\r") {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        rl.close();
        resolve(input.trim());
      } else if (c === "") {
        // Ctrl+C
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.exit(1);
      } else if (c === "" || c === "\b") {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
        }
      } else {
        input += c;
        process.stdout.write("*");
      }
    };

    if (process.stdin.isTTY) {
      process.stdin.resume();
      process.stdin.on("data", onData);
    } else {
      // Non-TTY: just read a line
      rl.on("line", (line) => {
        rl.close();
        resolve(line.trim());
      });
    }
  });
}

function openBrowser(url: string): void {
  try {
    if (platform() === "darwin") {
      execSync(`open ${shellEscape(url)}`, { stdio: "ignore" });
    } else if (platform() === "linux") {
      execSync(`xdg-open ${shellEscape(url)}`, { stdio: "ignore" });
    } else if (platform() === "win32") {
      execSync(`start "" ${shellEscape(url)}`, { stdio: "ignore" });
    }
  } catch {
    // Silently fail — user can open manually
  }
}

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

function getAiKeyName(provider: string): string | null {
  switch (provider.toLowerCase()) {
    case "openai": return "OPENAI_API_KEY";
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "google": return "GOOGLE_API_KEY";
    default: return null;
  }
}

function getCredentialKey(provider: string): string | null {
  switch (provider.toLowerCase()) {
    case "openai": return "openai-key";
    case "anthropic": return "anthropic-key";
    case "google": return "google-key";
    default: return null;
  }
}
