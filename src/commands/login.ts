import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import chalk from "chalk";
import { writeStoredConfig, readStoredConfig } from "../config/store.js";
import { storeCredential, loadCredential } from "../config/credentials.js";
import { getConfigDir } from "../config/paths.js";
import { verticalPicker, horizontalPicker, type PickerOption } from "./login-picker.js";

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
  "⠀⠀⢀⣤⠀⠺⣿⣿⠗⠀⣠⣀⠀⠀",
  "⠀⣴⣿⠟⣀⠀⠰⡆⠀⢀⠻⣿⣧⠀",
  "⣠⡀⠀⠈⠛⠀⠀⠀⠀⠛⠃⠀⢀⣠",
  "⣿⣿⠰⠶⠀⠀⠀⠀⠀⠀⠰⠆⢾⣿",
  "⠙⠁⠀⢀⣤⠀⠀⠀⠀⣠⡄⠀⠈⠛",
  "⠀⠺⣿⣦⠉⠀⠰⠆⠀⠈⣱⣾⡿⠀",
  "⠀⠀⠈⠛⠀⣰⣾⣿⣦⠀⠙⠋⠀⠀",
];

const LOGO_WIDTH = Math.max(...LOGO.map((l) => [...l].length));

export async function loginCommand(options: LoginOptions): Promise<void> {
  const profile = options.profile || "default";

  // Header with logo + title inline (like buildLogoBanner)
  const titleLine = `${C.whiteBold("canvas-cli")} ${C.dim("·")} ${C.muted("login")}`;
  const profileLine = profile !== "default" ? `${C.dim("profile:")} ${C.warm(profile)}` : "";
  const rightLines = [titleLine, profileLine].filter(Boolean);
  const textStart = 2; // which logo row the text starts on

  console.log();
  for (let i = 0; i < LOGO.length; i++) {
    const logoLine = LOGO[i]!;
    const pad = " ".repeat(Math.max(0, LOGO_WIDTH - [...logoLine].length));
    const textIdx = i - textStart;
    const rightText = textIdx >= 0 && textIdx < rightLines.length
      ? "   " + rightLines[textIdx]!
      : "";
    console.log("  " + C.primary(logoLine) + pad + rightText);
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

  // The client expects baseUrl to include /api/v1
  const apiBaseUrl = `${baseUrl}/api/v1`;

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
  const valid = await validateCredentials(apiBaseUrl, token);
  if (!valid.ok) {
    console.error(`\n  ${C.error("✗")} ${C.text(valid.error)}\n`);
    process.exit(1);
  }
  console.log(`  ${C.success("✓")} ${C.text("Connected as")} ${C.whiteBold(valid.userName)}`);

  // Step 3: AI provider (optional)
  console.log(`\n  ${C.whiteBold("3")} ${C.dim("·")} ${C.text("AI Provider")} ${C.dim("(optional)")}`);
  console.log(`  ${C.dim("Powers the 'ask' and 'work' commands.")}`);
  console.log(`  ${C.dim("Use ↑↓ to select, Enter to confirm, q to skip.")}\n`);

  const aiProvider = await verticalPicker("Provider", [
    { label: "OpenAI", value: "openai" },
    { label: "Anthropic", value: "anthropic" },
    { label: "Google (Gemini)", value: "google" },
    { label: "AWS Bedrock", value: "bedrock" },
    { label: "Skip", value: "" },
  ]);

  let aiModel = "";
  let aiEffort = "";
  let aiKey = "";
  let awsRegion = "";
  let awsAccessKey = "";
  let awsSecretKey = "";

  if (aiProvider) {
    // API Key(s) — right after provider
    if (aiProvider === "bedrock") {
      console.log(`\n  ${C.dim("AWS credentials for Bedrock:")}`);
      awsRegion = await prompt(`  ${C.dim("AWS Region (e.g., us-east-1):")} `);
      awsAccessKey = await promptSecret(`  ${C.dim("AWS Access Key ID:")} `);
      awsSecretKey = await promptSecret(`  ${C.dim("AWS Secret Access Key:")} `);
      console.log(`\n  ${C.dim("Enter the full Bedrock model ID:")}`);
      aiModel = await prompt(`  ${C.dim("→")} `);
    } else {
      const keyName = getAiKeyName(aiProvider);
      if (keyName) {
        console.log(`\n  ${C.dim(`Requires ${keyName}:`)}`);
        aiKey = await promptSecret(`  ${C.dim("→")} `);
      }

      // Model selection
      const models = getModelOptions(aiProvider);
      if (models.length > 0) {
        console.log();
        const selectedModel = await verticalPicker("Model", models);
        if (selectedModel) aiModel = selectedModel;
      }

      // Effort level (OpenAI + Anthropic only)
      if (aiProvider === "openai" || aiProvider === "anthropic") {
        console.log();
        const effort = await horizontalPicker("Effort", [
          { label: "low", value: "low" },
          { label: "medium", value: "medium" },
          { label: "high", value: "high" },
          { label: "max", value: "max" },
        ]);
        if (effort) {
          aiEffort = effort;
        }
      }
    }
  }

  // Save
  const finalProvider = aiProvider || undefined;
  const finalModel = aiModel || undefined;
  const finalEffort = aiEffort || undefined;

  writeStoredConfig(
    {
      canvasBaseUrl: apiBaseUrl,
      ...(finalProvider && { aiProvider: finalProvider }),
      ...(finalModel && { aiModel: finalModel }),
      ...(finalEffort && { aiEffort: finalEffort }),
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
  if (aiProvider === "bedrock") {
    if (awsRegion) storeCredential(profile, "aws-region", awsRegion);
    if (awsAccessKey) storeCredential(profile, "aws-access-key", awsAccessKey);
    if (awsSecretKey) storeCredential(profile, "aws-secret-key", awsSecretKey);
  }

  // Summary
  console.log();
  console.log(`  ${C.success("✓")} ${C.whiteBold("Setup complete")}`);
  console.log();
  console.log(`  ${C.dim("canvas")}    ${C.text(apiBaseUrl)}`);
  if (finalProvider) {
    const modelStr = finalModel ? ` (${finalModel}${finalEffort ? `, ${finalEffort}` : ""})` : "";
    console.log(`  ${C.dim("ai")}        ${C.text(finalProvider)}${modelStr}`);
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
  url = url.replace(/\/+$/, "");
  // Strip /api/v1 if user included it — we'll add it back ourselves
  url = url.replace(/\/api\/v1$/, "");
  return url;
}

async function validateCredentials(baseUrl: string, token: string): Promise<{ ok: true; userName: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${baseUrl}/users/self`, {
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

    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on("line", (line) => { rl.close(); resolve(line.trim()); });
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();

    let input = "";
    let dotCount = 0;

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    };

    const onData = (buf: Buffer) => {
      const str = buf.toString();
      for (const c of str) {
        const code = c.charCodeAt(0);
        if (c === "\r" || c === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(input.trim());
          return;
        }
        if (code === 3) {
          cleanup();
          process.exit(1);
        }
        if (code === 127 || code === 8) {
          if (input.length > 0) {
            input = input.slice(0, -1);
            if (dotCount > 0) {
              dotCount--;
              process.stdout.write("\b \b");
            }
          }
        } else if (code >= 32) {
          input += c;
          dotCount++;
          process.stdout.write("•");
        }
      }
    };

    process.stdin.on("data", onData);
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

function getModelOptions(provider: string): PickerOption[] {
  switch (provider) {
    case "openai":
      return [
        { label: "o3", value: "o3", description: "best reasoning" },
        { label: "o4-mini", value: "o4-mini", description: "fast reasoning" },
        { label: "gpt-4.1", value: "gpt-4.1", description: "flagship GPT" },
        { label: "gpt-4.1-mini", value: "gpt-4.1-mini", description: "fast + capable" },
        { label: "gpt-4.1-nano", value: "gpt-4.1-nano", description: "fastest" },
      ];
    case "anthropic":
      return [
        { label: "Claude Opus 4", value: "claude-opus-4-0-20250514", description: "most capable" },
        { label: "Claude Sonnet 4", value: "claude-sonnet-4-20250514", description: "balanced" },
        { label: "Claude Haiku 3.5", value: "claude-haiku-3-5-20241022", description: "fastest" },
      ];
    case "google":
      return [
        { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro-preview-05-06", description: "reasoning + large context" },
        { label: "Gemini 2.5 Flash", value: "gemini-2.5-flash-preview-04-17", description: "fast + reasoning" },
        { label: "Gemini 2.0 Flash", value: "gemini-2.0-flash", description: "fast general purpose" },
      ];
    default:
      return [];
  }
}
