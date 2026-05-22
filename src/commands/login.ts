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

// Match the TUI color palette
const C = {
  primary: chalk.hex("#e82429"),
  primaryBold: chalk.hex("#e82429").bold,
  text: chalk.hex("#d4d4d4"),
  muted: chalk.hex("#a0a0a0"),
  dim: chalk.hex("#606060"),
  success: chalk.hex("#6ec86a"),
  error: chalk.hex("#ff6b6b"),
  warm: chalk.hex("#e8a86d"),
  white: chalk.hex("#ffffff"),
  whiteBold: chalk.hex("#ffffff").bold,
};

const LOGO = [
  "  ⠀⠀⢀⣤⠀⠺⣿⣿⠗⠀⣠⣀⠀⠀",
  "  ⠀⣴⣿⠟⣀⠀⠰⡆⠀⢀⠻⣿⣧⠀",
  "  ⣠⡀⠀⠈⠛⠀⠀⠀⠀⠛⠃⠀⢀⣠",
  "  ⣿⣿⠰⠶⠀⠀⠀⠀⠀⠀⠰⠆⢾⣿",
  "  ⠙⠁⠀⢀⣤⠀⠀⠀⠀⣠⡄⠀⠈⠛",
  "  ⠀⠺⣿⣦⠉⠀⠰⠆⠀⠈⣱⣾⡿⠀",
  "  ⠀⠀⠈⠛⠀⣰⣾⣿⣦⠀⠙⠋⠀⠀",
];

export async function loginCommand(options: LoginOptions): Promise<void> {
  const profile = options.profile || "default";

  // Header with logo
  console.log();
  for (const line of LOGO) {
    console.log("  " + C.primary(line));
  }
  console.log();
  console.log(`  ${C.whiteBold("canvas-cli")} ${C.dim("·")} ${C.muted("login")}`);
  if (profile !== "default") {
    console.log(`  ${C.dim("profile:")} ${C.warm(profile)}`);
  }
  console.log();

  const existing = readStoredConfig(profile);
  const existingToken = loadCredential(profile, "canvas-token");

  if (existing && existingToken) {
    console.log(`  ${C.dim("Existing config found:")} ${C.muted(existing.canvasBaseUrl)}`);
    const overwrite = await prompt(`  ${C.text("Overwrite?")} ${C.dim("(y/N)")} `);
    if (overwrite.toLowerCase() !== "y") {
      console.log(`\n  ${C.muted("Cancelled.")}\n`);
      return;
    }
    console.log();
  }

  // Step 1: Canvas base URL
  console.log(`  ${C.whiteBold("1")} ${C.dim("·")} ${C.text("Canvas URL")}`);
  console.log(`  ${C.dim("Your school's Canvas address (e.g., school.instructure.com)")}\n`);

  let baseUrl = await prompt(`  ${C.dim("→")} `);
  baseUrl = normalizeUrl(baseUrl);

  if (!baseUrl) {
    console.error(`\n  ${C.error("✗")} ${C.text("Canvas URL is required.")}\n`);
    process.exit(1);
  }

  // Step 2: Canvas access token
  console.log(`\n  ${C.whiteBold("2")} ${C.dim("·")} ${C.text("Access Token")}`);
  console.log(`  ${C.dim("Generate one at:")} ${C.muted(`${baseUrl}/profile/settings`)}`);
  console.log(`  ${C.dim("Click \"+ New Access Token\" and paste below.")}\n`);

  const shouldOpen = await prompt(`  ${C.dim("Open in browser?")} ${C.dim("(Y/n)")} `);
  if (shouldOpen.toLowerCase() !== "n") {
    openBrowser(`${baseUrl}/profile/settings`);
    console.log(`  ${C.dim("Opened. Paste your token when ready.")}\n`);
  }

  const token = await promptSecret(`  ${C.dim("→")} `);
  if (!token) {
    console.error(`\n  ${C.error("✗")} ${C.text("Access token is required.")}\n`);
    process.exit(1);
  }

  // Validate
  console.log(`\n  ${C.dim("Verifying...")}`);
  const valid = await validateCredentials(baseUrl, token);
  if (!valid.ok) {
    console.error(`\n  ${C.error("✗")} ${C.text(valid.error)}\n`);
    process.exit(1);
  }
  console.log(`  ${C.success("✓")} ${C.text("Connected as")} ${C.whiteBold(valid.userName)}`);

  // Step 3: AI provider (optional)
  console.log(`\n  ${C.whiteBold("3")} ${C.dim("·")} ${C.text("AI Provider")} ${C.dim("(optional)")}`);
  console.log(`  ${C.dim("Powers the 'ask' and 'work' commands.")}`);
  console.log(`  ${C.dim("Options: openai, anthropic, google, bedrock")}`);
  console.log(`  ${C.dim("Press Enter to skip.")}\n`);

  const aiProvider = await prompt(`  ${C.dim("→")} `);
  let aiModel = "";
  let aiKey = "";

  if (aiProvider) {
    aiModel = await prompt(`  ${C.dim("Model (Enter for default):")} `);

    const keyName = getAiKeyName(aiProvider);
    if (keyName) {
      console.log(`  ${C.dim(`Requires ${keyName}`)}`);
      aiKey = await promptSecret(`  ${C.dim("→")} `);
    }
  }

  // Save
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

  // Summary
  console.log();
  console.log(`  ${C.success("✓")} ${C.whiteBold("Setup complete")}`);
  console.log();
  console.log(`  ${C.dim("canvas")}    ${C.text(baseUrl)}`);
  if (aiProvider) {
    console.log(`  ${C.dim("ai")}        ${C.text(aiProvider)}${aiModel ? ` (${aiModel})` : ""}`);
  }
  console.log(`  ${C.dim("stored")}    ${C.muted(platform() === "darwin" ? "macOS Keychain" : getConfigDir())}`);

  if (profile !== "default") {
    console.log(`\n  ${C.dim("Use this profile:")} ${C.muted(`export CANVAS_CLI_PROFILE=${profile}`)}`);
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
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.exit(1);
      } else if (c === "" || c === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (c.charCodeAt(0) >= 32) {
        input += c;
        process.stdout.write("•");
      }
    };

    if (process.stdin.isTTY) {
      process.stdin.resume();
      process.stdin.on("data", onData);
    } else {
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
  } catch {}
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
