import { spawn } from "node:child_process";
import { platform } from "node:os";
import { writeStoredConfig, readStoredConfig } from "../config/store.js";
import { storeCredential, loadCredential } from "../config/credentials.js";
import { getConfigDir } from "../config/paths.js";
import { verticalPicker, BACK, C } from "./login-picker.js";
import { promptLine, promptSecret, ESCAPED } from "./login-prompts.js";
import {
  runBedrockSteps,
  runStandardProviderSteps,
  runSubscriptionProviderSteps,
  getCredentialKey,
} from "./login-providers.js";
import { isSubscriptionProvider } from "../ai/provider.js";

interface LoginOptions {
  profile?: string;
}

const enum Step {
  URL = 1,
  TOKEN = 2,
  PROVIDER = 3,
  PROVIDER_CONFIG = 4,
  DONE = 100,
}

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

const ESC_HINT = C.dim("(esc to go back)");

function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("Error: `canvas-cli login` requires an interactive terminal.");
    process.exit(1);
  }

  const restoreTerminal = () => {
    try { process.stdin.setRawMode?.(false); } catch {}
  };
  process.on("exit", restoreTerminal);

  const profile = options.profile || "default";

  const banner = [
    "░█▀▀░█▀█░█▀█░█░█░█▀█░█▀▀",
    "░█░░░█▀█░█░█░▀▄▀░█▀█░▀▀█",
    "░▀▀▀░▀░▀░▀░▀░░▀░░▀░▀░▀▀▀",
  ];
  const profileLine = profile !== "default" ? `${C.dim("profile:")} ${C.warm(profile)}` : "";
  const rightLines = [
    ...banner.map((l) => C.primary(l)),
    "",
    C.whiteBold("Login") + (profileLine ? "  " + profileLine : ""),
  ];
  const textStart = 1;

  const printHeader = () => {
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
  };

  const printProgress = () => {
    if (baseUrl) {
      console.log(`  ${C.success("✓")} ${C.dim("Canvas URL")}   ${C.muted(baseUrl)}`);
    }
    if (userName) {
      console.log(`  ${C.success("✓")} ${C.dim("Connected as")} ${C.muted(userName)}`);
    }
    if (aiProvider) {
      console.log(`  ${C.success("✓")} ${C.dim("Provider")}    ${C.muted(aiProvider)}`);
    }
    if (baseUrl || userName || aiProvider) {
      console.log();
    }
  };

  const freshStep = () => {
    clearScreen();
    printHeader();
    printProgress();
  };

  clearScreen();
  printHeader();

  const existing = readStoredConfig(profile);
  const existingToken = loadCredential(profile, "canvas-token");

  if (existing && existingToken) {
    console.log(`  ${C.dim("Existing config found:")} ${C.muted(existing.canvasBaseUrl)}`);
    const overwrite = await promptLine(`  ${C.text("Overwrite?")} ${C.dim("(y/N)")} `);
    if (overwrite === ESCAPED || overwrite.toLowerCase() !== "y") {
      console.log(`\n  ${C.muted("Cancelled.")}\n`);
      return;
    }
    console.log();
  }

  let step: Step = Step.URL;
  let baseUrl = "";
  let apiBaseUrl = "";
  let token = "";
  let userName = "";
  let aiProvider = "";
  let aiModel = "";
  let aiEffort = "";
  let aiKey = "";
  let awsRegion = "";
  let awsAccessKey = "";
  let awsSecretKey = "";

  while (step >= Step.URL) {
    if (step === Step.URL) {
      freshStep();
      console.log(`  ${C.whiteBold("1")} ${C.dim("·")} ${C.text("Canvas URL")}  ${ESC_HINT}`);
      console.log(`  ${C.dim("Your school's Canvas address (e.g., school.instructure.com)")}\n`);

      const input = await promptLine(`  ${C.dim("→")} `);
      if (input === ESCAPED) {
        console.log(`\n  ${C.muted("Cancelled.")}\n`);
        return;
      }
      baseUrl = normalizeUrl(input);
      if (!baseUrl) {
        console.error(`\n  ${C.error("✗")} ${C.text("Invalid or missing Canvas URL. HTTPS is required (except localhost).")}\n`);
        continue;
      }
      apiBaseUrl = `${baseUrl}/api/v1`;
      step = Step.TOKEN;
    } else if (step === Step.TOKEN) {
      freshStep();
      console.log(`  ${C.whiteBold("2")} ${C.dim("·")} ${C.text("Access Token")}  ${ESC_HINT}`);
      console.log(`  ${C.dim("Generate one at:")} ${C.muted(`${baseUrl}/profile/settings`)}`);
      console.log(`  ${C.dim("Click \"+ New Access Token\" and paste below.")}\n`);

      const shouldOpen = await promptLine(`  ${C.dim("Open in browser?")} ${C.dim("(Y/n)")} `);
      if (shouldOpen === ESCAPED) {
        step = Step.URL;
        continue;
      }
      if (shouldOpen.toLowerCase() !== "n") {
        openBrowser(`${baseUrl}/profile/settings`);
        console.log(`  ${C.dim("Opened. Paste your token when ready.")}\n`);
      }

      const tokenInput = await promptSecret(`  ${C.dim("→")} `);
      if (tokenInput === ESCAPED) {
        step = Step.URL;
        continue;
      }
      if (!tokenInput) {
        console.error(`\n  ${C.error("✗")} ${C.text("Access token is required.")}\n`);
        continue;
      }

      console.log(`\n  ${C.dim("Verifying...")}`);
      const valid = await validateCredentials(apiBaseUrl, tokenInput);
      if (!valid.ok) {
        console.error(`  ${C.error("✗")} ${C.text(valid.error)}\n`);
        continue;
      }
      token = tokenInput;
      userName = valid.userName;
      step = Step.PROVIDER;
    } else if (step === Step.PROVIDER) {
      freshStep();
      console.log(`  ${C.whiteBold("3")} ${C.dim("·")} ${C.text("AI Provider")} ${C.dim("(optional)")}  ${ESC_HINT}`);
      console.log(`  ${C.dim("Powers chat, /quiz, /pdf and the other AI features.")}`);
      console.log(`  ${C.dim("Use ↑↓ to select, Enter to confirm, q/esc to go back.")}\n`);

      const result = await verticalPicker("Provider", [
        { label: "GitHub Copilot", value: "copilot", description: "your Copilot subscription, no API key" },
        { label: "ChatGPT via Codex", value: "codex", description: "your ChatGPT plan, experimental" },
        { label: "OpenAI", value: "openai", description: "API key" },
        { label: "Anthropic", value: "anthropic", description: "API key" },
        { label: "Google (Gemini)", value: "google", description: "API key" },
        { label: "AWS Bedrock", value: "bedrock", description: "AWS credentials" },
        { label: "Skip", value: "" },
      ]);

      if (result === BACK) {
        userName = "";
        step = Step.TOKEN;
        continue;
      }
      if (result === null) {
        console.log(`\n  ${C.muted("Cancelled.")}\n`);
        return;
      }

      aiProvider = result;
      if (!aiProvider) {
        step = Step.DONE;
        continue;
      }
      step = Step.PROVIDER_CONFIG;
    } else if (step === Step.PROVIDER_CONFIG) {
      freshStep();
      if (aiProvider === "bedrock") {
        const bedrockResult = await runBedrockSteps(freshStep);
        if (bedrockResult === ESCAPED) {
          aiProvider = "";
          step = Step.PROVIDER;
          continue;
        }
        awsRegion = bedrockResult.awsRegion;
        awsAccessKey = bedrockResult.awsAccessKey;
        awsSecretKey = bedrockResult.awsSecretKey;
        aiModel = bedrockResult.aiModel;
        aiEffort = bedrockResult.aiEffort;
      } else if (isSubscriptionProvider(aiProvider)) {
        const subResult = await runSubscriptionProviderSteps(aiProvider, freshStep);
        if (subResult === ESCAPED) {
          aiProvider = "";
          step = Step.PROVIDER;
          continue;
        }
        aiModel = subResult.aiModel;
        aiEffort = subResult.aiEffort;
      } else {
        const stdResult = await runStandardProviderSteps(aiProvider, freshStep);
        if (stdResult === ESCAPED) {
          aiProvider = "";
          step = Step.PROVIDER;
          continue;
        }
        aiKey = stdResult.aiKey;
        aiModel = stdResult.aiModel;
        aiEffort = stdResult.aiEffort;
      }
      step = Step.DONE;
    }

    if (step === Step.DONE) break;
  }

  if (step < Step.URL) {
    console.log(`\n  ${C.muted("Cancelled.")}\n`);
    return;
  }

  // Save
  const finalProvider = aiProvider || undefined;
  const finalModel = aiModel || undefined;
  const finalEffort = aiEffort || undefined;

  writeStoredConfig(
    {
      canvasBaseUrl: baseUrl,
      ...(finalProvider && { aiProvider: finalProvider }),
      ...(finalModel && { aiModel: finalModel }),
      ...(finalEffort && { aiEffort: finalEffort }),
      ...(awsRegion && { awsRegion }),
    },
    profile
  );

  const backend = storeCredential(profile, "canvas-token", token);
  if (aiKey && aiProvider) {
    const credKey = getCredentialKey(aiProvider);
    if (credKey) {
      storeCredential(profile, credKey, aiKey);
    }
  }
  if (aiProvider === "bedrock") {
    if (awsAccessKey) storeCredential(profile, "aws-access-key", awsAccessKey);
    if (awsSecretKey) storeCredential(profile, "aws-secret-key", awsSecretKey);
  }

  // Summary
  const storageLabel = backend === "keychain" ? "macOS Keychain" : getConfigDir();
  console.log();
  console.log(`  ${C.success("✓")} ${C.whiteBold("Setup complete")}`);
  console.log();
  console.log(`  ${C.dim("canvas")}    ${C.text(baseUrl)}`);
  if (finalProvider) {
    const modelStr = finalModel ? ` (${finalModel}${finalEffort ? `, ${finalEffort}` : ""})` : "";
    const subTag = isSubscriptionProvider(finalProvider) ? C.dim(" · subscription") : "";
    console.log(`  ${C.dim("ai")}        ${C.text(finalProvider)}${modelStr}${subTag}`);
  }
  console.log(`  ${C.dim("stored")}    ${C.muted(storageLabel)}`);

  if (profile !== "default") {
    console.log(`\n  ${C.dim("Use this profile:")} ${C.muted(`export CANVAS_CLI_PROFILE=${profile}`)}`);
  }

  console.log();
  process.removeListener("exit", restoreTerminal);
}


export function normalizeUrl(url: string): string {
  url = url.trim();
  if (!url) return "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/api\/v1$/, "");
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") return "";
    if (parsed.protocol === "http:" && parsed.hostname !== "localhost") return "";
  } catch {
    return "";
  }
  return url;
}

async function validateCredentials(baseUrl: string, token: string): Promise<{ ok: true; userName: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${baseUrl}/users/self`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
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

    const user = (await response.json()) as { name?: string };
    return { ok: true, userName: user?.name || "Unknown" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
      return { ok: false, error: "Could not connect to that URL. Please check and try again." };
    }
    return { ok: false, error: `Connection failed: ${message}` };
  }
}

function openBrowser(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    let cmd: string;
    let args: string[];
    if (platform() === "darwin") {
      cmd = "open";
      args = [parsed.href];
    } else if (platform() === "linux") {
      cmd = "xdg-open";
      args = [parsed.href];
    } else if (platform() === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", parsed.href];
    } else {
      console.log(`  ${C.dim("Open manually:")} ${C.muted(url)}`);
      return;
    }
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      console.log(`  ${C.dim("Could not open browser. Visit:")} ${C.muted(url)}`);
    });
    child.unref();
  } catch {
    console.log(`  ${C.dim("Could not open browser. Visit:")} ${C.muted(url)}`);
  }
}

